import {
    canvasToBlobAsync,
    estimateSizeBytes,
    exportCanvasToRasterBlob,
    formatBytes,
    getFormatLabel,
    getRasterExtension,
    getScaledDimensions
} from '../raster-utils.js?v=r-78ade4c03db6e3a2';
import {
    ADJUSTMENT_KEYS,
    DEFAULT_ADJUSTMENTS,
    applyAdjustmentsToImageData,
    getFilterPreset,
    isNeutralAdjustments,
    matchFilterPreset,
    normalizeAdjustments
} from '../shared/image-adjust.js?v=r-78ade4c03db6e3a2';

// Live preview never renders above this edge length. Sliders re-run the whole
// adjustment pass on every debounced tick, so a 6000px source would otherwise
// stall the main thread; exports always run at full resolution.
const PREVIEW_MAX_EDGE = 1100;
const PREVIEW_DEBOUNCE_MS = 110;
const ESTIMATE_DEBOUNCE_MS = 240;
const WEBP_QUALITY = 0.9;
const MIN_CROP_EDGE = 8;

// WEBP lives here rather than in raster-utils.js because only this tab offers
// it today; the shared helpers stay untouched for the other tabs.
const WEBP_ALPHA_FORMATS = new Set(['png', 'tga', 'webp']);

function supportsAlphaForRasterFormat(format) {
    return WEBP_ALPHA_FORMATS.has(format);
}

function getRasterFormatExtension(format) {
    return format === 'webp' ? 'webp' : getRasterExtension(format);
}

function getRasterFormatLabel(format) {
    return format === 'webp' ? 'WEBP' : getFormatLabel(format);
}

function resolvePreserveAlpha(format, preserveAlpha) {
    return supportsAlphaForRasterFormat(format) ? !!preserveAlpha : false;
}

function encodeRasterCanvas(canvas, format, preserveAlpha) {
    if (format === 'webp') return canvasToBlobAsync(canvas, 'image/webp', WEBP_QUALITY);
    return exportCanvasToRasterBlob(canvas, format, preserveAlpha);
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

export function createRasterTabController({
    state,
    elements,
    downloadBlob,
    getImageBaseName,
    hasSingleImageLoaded
}) {
    /**
     * The single source of truth for every edit this tab applies. The export
     * pipeline runs strictly as:
     *   crop (source pixel coords) → transforms → scale → adjustments → encode
     * and the live preview runs the identical function at a reduced target
     * size, so what the canvas shows is exactly what the download contains.
     */
    const edit = {
        rotation: 0,          // 0 | 90 | 180 | 270, clockwise
        flipH: false,
        flipV: false,
        crop: null,           // { x, y, width, height } in source pixels, or null for the full frame
        adjustments: { ...DEFAULT_ADJUSTMENTS }
    };

    const channelDataCache = {
        red: null,
        green: null,
        blue: null,
        alpha: null
    };
    const sizeEstimateCache = new Map();
    let sizeEstimateRequestId = 0;
    let estimateTimer = null;
    let previewTimer = null;

    let previewCanvas = null;
    let activeChannel = 'rgb';

    // Crop mode works in "display space": the full source after transforms but
    // before any crop, so the user can widen an existing crop as well as shrink
    // it. Committing converts the rect back to source pixel coordinates.
    let cropMode = false;
    let cropSpace = null;       // { width, height } of the transformed full source
    let cropDisplayRect = null; // { x, y, width, height } inside cropSpace
    let cropDrag = null;

    const domCache = new Map();
    function dom(id) {
        if (!domCache.has(id)) domCache.set(id, document.getElementById(id));
        return domCache.get(id);
    }
    function previewContainer() {
        return dom('rgba-preview-canvas')?.parentElement || null;
    }

    // ── Geometry ────────────────────────────────────────────────────────────

    function isQuarterTurned() {
        return edit.rotation === 90 || edit.rotation === 270;
    }

    function getSourceDimensions() {
        if (elements.sourceImage?.naturalWidth && elements.sourceImage?.naturalHeight) {
            return { width: elements.sourceImage.naturalWidth, height: elements.sourceImage.naturalHeight };
        }
        if (state.tracedata?.width && state.tracedata?.height) {
            return { width: state.tracedata.width, height: state.tracedata.height };
        }
        return null;
    }

    function getFullSourceRect() {
        const dims = getSourceDimensions();
        if (!dims) return null;
        return { x: 0, y: 0, width: dims.width, height: dims.height };
    }

    /** The committed crop, clamped to the current source, or the full frame. */
    function getCropRect() {
        const dims = getSourceDimensions();
        if (!dims) return null;
        if (!edit.crop) return { x: 0, y: 0, width: dims.width, height: dims.height };

        const x = clamp(Math.round(edit.crop.x), 0, Math.max(0, dims.width - 1));
        const y = clamp(Math.round(edit.crop.y), 0, Math.max(0, dims.height - 1));
        const width = clamp(Math.round(edit.crop.width), 1, dims.width - x);
        const height = clamp(Math.round(edit.crop.height), 1, dims.height - y);
        return { x, y, width, height };
    }

    /** Post-crop, post-rotation size — the base the export scale multiplies. */
    function getBaseDimensions() {
        const crop = getCropRect();
        if (!crop) return null;
        return isQuarterTurned()
            ? { width: crop.height, height: crop.width }
            : { width: crop.width, height: crop.height };
    }

    function getTransformedSize(rect) {
        return isQuarterTurned()
            ? { width: rect.height, height: rect.width }
            : { width: rect.width, height: rect.height };
    }

    /**
     * Maps a point from source pixel space into the transformed display space.
     * Flips are applied inside the source frame, then the quarter turn.
     */
    function mapSourcePointToDisplay(x, y, sourceWidth, sourceHeight) {
        const px = edit.flipH ? sourceWidth - x : x;
        const py = edit.flipV ? sourceHeight - y : y;
        switch (edit.rotation) {
            case 90: return { x: sourceHeight - py, y: px };
            case 180: return { x: sourceWidth - px, y: sourceHeight - py };
            case 270: return { x: py, y: sourceWidth - px };
            default: return { x: px, y: py };
        }
    }

    /** Exact inverse of mapSourcePointToDisplay. */
    function mapDisplayPointToSource(x, y, sourceWidth, sourceHeight) {
        let px;
        let py;
        switch (edit.rotation) {
            case 90: px = y; py = sourceHeight - x; break;
            case 180: px = sourceWidth - x; py = sourceHeight - y; break;
            case 270: px = sourceWidth - y; py = x; break;
            default: px = x; py = y; break;
        }
        return {
            x: edit.flipH ? sourceWidth - px : px,
            y: edit.flipV ? sourceHeight - py : py
        };
    }

    function normalizeRectFromCorners(a, b) {
        return {
            x: Math.min(a.x, b.x),
            y: Math.min(a.y, b.y),
            width: Math.abs(b.x - a.x),
            height: Math.abs(b.y - a.y)
        };
    }

    function mapSourceRectToDisplay(rect, dims) {
        const a = mapSourcePointToDisplay(rect.x, rect.y, dims.width, dims.height);
        const b = mapSourcePointToDisplay(rect.x + rect.width, rect.y + rect.height, dims.width, dims.height);
        return normalizeRectFromCorners(a, b);
    }

    function mapDisplayRectToSource(rect, dims) {
        const a = mapDisplayPointToSource(rect.x, rect.y, dims.width, dims.height);
        const b = mapDisplayPointToSource(rect.x + rect.width, rect.y + rect.height, dims.width, dims.height);
        return normalizeRectFromCorners(a, b);
    }

    // ── Render pipeline ─────────────────────────────────────────────────────

    function applyTransformToContext(ctx, width, height) {
        switch (edit.rotation) {
            case 90: ctx.translate(height, 0); ctx.rotate(Math.PI / 2); break;
            case 180: ctx.translate(width, height); ctx.rotate(Math.PI); break;
            case 270: ctx.translate(0, width); ctx.rotate(-Math.PI / 2); break;
            default: break;
        }
        if (edit.flipH) {
            ctx.translate(width, 0);
            ctx.scale(-1, 1);
        }
        if (edit.flipV) {
            ctx.translate(0, height);
            ctx.scale(1, -1);
        }
    }

    /**
     * Runs crop → transforms → scale → adjustments and returns the canvas.
     * `target` is the post-rotation output size.
     */
    function renderPipelineCanvas({ crop, target, preserveAlpha, withAdjustments = true }) {
        const source = elements.sourceImage;
        if (!source || !crop || !target) return null;

        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(target.width));
        canvas.height = Math.max(1, Math.round(target.height));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) return null;

        if (preserveAlpha) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

        // The draw happens in the pre-rotation frame, so a quarter turn swaps
        // which canvas axis the source width lands on.
        const drawWidth = isQuarterTurned() ? canvas.height : canvas.width;
        const drawHeight = isQuarterTurned() ? canvas.width : canvas.height;

        ctx.save();
        applyTransformToContext(ctx, drawWidth, drawHeight);
        ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, drawWidth, drawHeight);
        ctx.restore();

        if (withAdjustments && !isNeutralAdjustments(edit.adjustments)) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            applyAdjustmentsToImageData(imageData, edit.adjustments);
            ctx.putImageData(imageData, 0, 0);
        }

        return canvas;
    }

    function renderExportCanvas(target, preserveAlpha) {
        return renderPipelineCanvas({ crop: getCropRect(), target, preserveAlpha });
    }

    // ── Preview ─────────────────────────────────────────────────────────────

    function buildPreviewCanvas() {
        // While framing a crop the preview shows the whole transformed source so
        // the crop box can be dragged outward again.
        const crop = cropMode ? getFullSourceRect() : getCropRect();
        if (!crop) return null;

        const base = getTransformedSize(crop);
        const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(base.width, base.height));
        const target = {
            width: Math.max(1, Math.round(base.width * scale)),
            height: Math.max(1, Math.round(base.height * scale))
        };
        return renderPipelineCanvas({ crop, target, preserveAlpha: true });
    }

    function displayChannel(channel) {
        const canvas = dom('rgba-preview-canvas');
        if (!canvas || !previewCanvas) return;

        canvas.width = previewCanvas.width;
        canvas.height = previewCanvas.height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        if (channel === 'rgb') {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(previewCanvas, 0, 0);
            return;
        }

        if (!channelDataCache[channel]) {
            const sourceCtx = previewCanvas.getContext('2d', { willReadFrequently: true });
            const source = sourceCtx.getImageData(0, 0, previewCanvas.width, previewCanvas.height);
            const offset = channel === 'green' ? 1 : channel === 'blue' ? 2 : channel === 'alpha' ? 3 : 0;
            const channelData = ctx.createImageData(previewCanvas.width, previewCanvas.height);
            const from = source.data;
            const into = channelData.data;
            for (let i = 0; i < from.length; i += 4) {
                const value = from[i + offset];
                into[i] = value;
                into[i + 1] = value;
                into[i + 2] = value;
                into[i + 3] = 255;
            }
            channelDataCache[channel] = channelData;
        }

        ctx.putImageData(channelDataCache[channel], 0, 0);
    }

    function setActiveChannel(channel) {
        activeChannel = channel;
        document.querySelectorAll('#tab-raster .rgba-channel-tab').forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.channel === channel);
        });
        displayChannel(channel);
    }

    function refreshPreview() {
        if (!hasSingleImageLoaded()) return;
        if (!elements.sourceImage?.complete || !elements.sourceImage?.naturalWidth) return;

        previewCanvas = buildPreviewCanvas();
        channelDataCache.red = null;
        channelDataCache.green = null;
        channelDataCache.blue = null;
        channelDataCache.alpha = null;
        displayChannel(activeChannel);
        if (cropMode) renderCropBox();
    }

    function schedulePreviewRefresh() {
        if (previewTimer) clearTimeout(previewTimer);
        previewTimer = setTimeout(() => {
            previewTimer = null;
            refreshPreview();
        }, PREVIEW_DEBOUNCE_MS);
    }

    /** Called after any edit: repaint, re-estimate, and refresh the readouts. */
    function onEditChanged({ immediate = false } = {}) {
        if (immediate) {
            if (previewTimer) clearTimeout(previewTimer);
            previewTimer = null;
            refreshPreview();
        } else {
            schedulePreviewRefresh();
        }
        updateExportScaleDisplay();
    }

    // ── Size estimates ──────────────────────────────────────────────────────

    function getEditSignature() {
        const crop = getCropRect();
        return [
            edit.rotation,
            edit.flipH ? 1 : 0,
            edit.flipV ? 1 : 0,
            crop ? `${crop.x},${crop.y},${crop.width},${crop.height}` : 'full',
            ADJUSTMENT_KEYS.map((key) => edit.adjustments[key]).join(',')
        ].join('|');
    }

    function getEstimateCacheKey(targetDims, format, preserveAlpha) {
        return [
            state.originalImageUrl || 'image',
            state.originalImageSize || 0,
            elements.sourceImage?.naturalWidth || 0,
            elements.sourceImage?.naturalHeight || 0,
            targetDims?.width || 0,
            targetDims?.height || 0,
            getEditSignature(),
            format,
            preserveAlpha ? 1 : 0
        ].join('|');
    }

    function getEstimateTargets() {
        const alpha = !!state.preserveAlpha;
        return [
            { element: elements.sizeEstJpg, format: 'jpg', preserveAlpha: false },
            { element: elements.sizeEstPng, format: 'png', preserveAlpha: alpha },
            { element: dom('size-est-webp'), format: 'webp', preserveAlpha: alpha },
            { element: elements.sizeEstTga, format: 'tga', preserveAlpha: alpha }
        ].filter((config) => config.element);
    }

    function clearSizeEstimates() {
        getEstimateTargets().forEach(({ element }) => {
            element.textContent = '—';
        });
    }

    async function runSizeEstimates(targetDims, requestId) {
        const configs = getEstimateTargets();
        // One render per alpha mode, reused by every format that shares it.
        const canvasByAlpha = new Map();
        const canvasFor = (preserveAlpha) => {
            if (!canvasByAlpha.has(preserveAlpha)) {
                canvasByAlpha.set(preserveAlpha, renderExportCanvas(targetDims, preserveAlpha));
            }
            return canvasByAlpha.get(preserveAlpha);
        };

        const results = await Promise.all(configs.map(async (config) => {
            const cacheKey = getEstimateCacheKey(targetDims, config.format, config.preserveAlpha);
            if (sizeEstimateCache.has(cacheKey)) {
                return { ...config, bytes: sizeEstimateCache.get(cacheKey) };
            }
            try {
                const canvas = canvasFor(config.preserveAlpha);
                if (!canvas) throw new Error('Pipeline canvas unavailable.');
                const blob = await encodeRasterCanvas(canvas, config.format, config.preserveAlpha);
                sizeEstimateCache.set(cacheKey, blob.size);
                return { ...config, bytes: blob.size };
            } catch (error) {
                console.warn(`Falling back to approximate ${getRasterFormatLabel(config.format)} estimate.`, error);
                // estimateSizeBytes has no WEBP factor; JPG is the closest curve.
                const approximateFormat = config.format === 'webp' ? 'jpg' : config.format;
                return {
                    ...config,
                    bytes: estimateSizeBytes(targetDims.width, targetDims.height, approximateFormat, config.preserveAlpha)
                };
            }
        }));

        if (requestId !== sizeEstimateRequestId) return;
        results.forEach(({ element, bytes }) => {
            element.textContent = formatBytes(bytes);
        });
    }

    function updateSizeEstimates(targetDims) {
        if (estimateTimer) {
            clearTimeout(estimateTimer);
            estimateTimer = null;
        }

        if (!targetDims || !elements.sourceImage?.complete || !elements.sourceImage?.naturalWidth) {
            clearSizeEstimates();
            return;
        }

        const requestId = ++sizeEstimateRequestId;
        getEstimateTargets().forEach((config) => {
            const cacheKey = getEstimateCacheKey(targetDims, config.format, config.preserveAlpha);
            config.element.textContent = sizeEstimateCache.has(cacheKey)
                ? formatBytes(sizeEstimateCache.get(cacheKey))
                : 'Estimating...';
        });

        estimateTimer = setTimeout(() => {
            estimateTimer = null;
            void runSizeEstimates(targetDims, requestId);
        }, ESTIMATE_DEBOUNCE_MS);
    }

    // ── Readouts ────────────────────────────────────────────────────────────

    function updateExportScaleDisplay() {
        const dims = getBaseDimensions();
        if (!dims) {
            if (elements.exportSizeCurrent) elements.exportSizeCurrent.textContent = '—';
            if (elements.exportSizeTarget) elements.exportSizeTarget.textContent = '—';
            updateSizeEstimates(null);
            return;
        }

        const target = getScaledDimensions(dims, state.exportScale);

        if (elements.exportSizeCurrent) {
            elements.exportSizeCurrent.textContent = `${dims.width}×${dims.height}px`;
        }
        if (elements.exportSizeTarget) {
            elements.exportSizeTarget.textContent = `${target.width}×${target.height}px`;
        }

        const exportScaleDisplay = dom('export-scale-display');
        if (exportScaleDisplay) {
            exportScaleDisplay.textContent = `(${state.exportScale}%)`;
        }

        // The metadata strip tracks the working image, so a rotate or a crop is
        // reflected here immediately.
        const originalDims = dom('original-dims');
        if (originalDims) {
            originalDims.textContent = `${dims.width}×${dims.height}`;
        }

        const originalAspect = dom('original-aspect');
        if (originalAspect) {
            const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
            const divisor = gcd(dims.width, dims.height) || 1;
            originalAspect.textContent = `${dims.width / divisor}:${dims.height / divisor}`;
        }

        const originalFormat = dom('original-format');
        if (originalFormat) {
            originalFormat.textContent = state.originalImageFormat || '—';
        }

        const originalFileSize = dom('original-file-size');
        if (originalFileSize) {
            originalFileSize.textContent = state.originalImageSize ? formatBytes(state.originalImageSize) : '—';
        }

        updateSizeEstimates(target);
    }

    function setExportScale(scale) {
        state.exportScale = Math.min(500, Math.max(1, Math.round(scale)));
        elements.resizeChips.forEach((chip) => {
            chip.classList.toggle('active', parseInt(chip.dataset.scale, 10) === state.exportScale);
        });
        updateExportScaleDisplay();
    }

    // ── Transforms ──────────────────────────────────────────────────────────

    function applyTransformMutation(mutate, message) {
        if (!hasSingleImageLoaded()) return;
        const dims = getSourceDimensions();
        if (!dims) return;

        // A live crop box lives in display space, so translate it back to source
        // pixels, change the transform, and re-derive it in the new space.
        const pendingSourceRect = cropMode && cropDisplayRect && cropSpace
            ? mapDisplayRectToSource(cropDisplayRect, dims)
            : null;

        mutate();

        if (cropMode) {
            cropSpace = getTransformedSize({ width: dims.width, height: dims.height });
            const rect = pendingSourceRect || getCropRect();
            cropDisplayRect = mapSourceRectToDisplay(rect, dims);
        }

        if (elements.statusText && message) elements.statusText.textContent = message;
        onEditChanged({ immediate: true });
    }

    function rotateBy(degrees) {
        const nextRotation = (edit.rotation + degrees + 360) % 360;
        applyTransformMutation(() => {
            edit.rotation = nextRotation;
        }, nextRotation === 0 ? 'Rotation reset to the original orientation.' : `Rotated to ${nextRotation}°.`);
    }

    function toggleFlip(axis) {
        applyTransformMutation(() => {
            if (axis === 'h') edit.flipH = !edit.flipH;
            else edit.flipV = !edit.flipV;
        }, axis === 'h' ? 'Flipped horizontally.' : 'Flipped vertically.');
    }

    function revertGeometry() {
        if (!hasSingleImageLoaded()) return;
        edit.rotation = 0;
        edit.flipH = false;
        edit.flipV = false;
        edit.crop = null;
        setCropMode(false);
        if (elements.statusText) elements.statusText.textContent = 'Crop and transforms reverted.';
        onEditChanged({ immediate: true });
    }

    // ── Crop ────────────────────────────────────────────────────────────────

    /** Places the overlay exactly over the drawn canvas content box. */
    function syncCropOverlayGeometry() {
        const container = previewContainer();
        const canvas = dom('rgba-preview-canvas');
        const overlay = dom('raster-crop-overlay');
        if (!container || !canvas || !overlay) return null;

        const containerRect = container.getBoundingClientRect();
        const canvasRect = canvas.getBoundingClientRect();
        if (!canvasRect.width || !canvasRect.height || !canvas.width || !canvas.height) return null;

        // The canvas is object-fit: contain inside its own box; derive the real
        // painted rectangle so the crop box can never drift onto letterboxing.
        const fit = Math.min(canvasRect.width / canvas.width, canvasRect.height / canvas.height);
        const width = canvas.width * fit;
        const height = canvas.height * fit;
        const left = canvasRect.left - containerRect.left + (canvasRect.width - width) / 2;
        const top = canvasRect.top - containerRect.top + (canvasRect.height - height) / 2;

        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
        return { width, height };
    }

    function renderCropBox() {
        const geometry = syncCropOverlayGeometry();
        const box = dom('raster-crop-box');
        if (!geometry || !box || !cropDisplayRect || !cropSpace) return;

        const scaleX = geometry.width / cropSpace.width;
        const scaleY = geometry.height / cropSpace.height;
        box.style.left = `${cropDisplayRect.x * scaleX}px`;
        box.style.top = `${cropDisplayRect.y * scaleY}px`;
        box.style.width = `${cropDisplayRect.width * scaleX}px`;
        box.style.height = `${cropDisplayRect.height * scaleY}px`;

        const readout = dom('raster-crop-readout');
        if (readout) {
            readout.textContent = `${Math.round(cropDisplayRect.width)} × ${Math.round(cropDisplayRect.height)}`;
        }
    }

    function setCropMode(active) {
        const nextActive = !!active && hasSingleImageLoaded();
        const wasActive = cropMode;
        cropMode = nextActive;

        const toggle = dom('raster-crop-toggle');
        if (toggle) {
            toggle.classList.toggle('active', cropMode);
            toggle.setAttribute('aria-pressed', String(cropMode));
        }
        const actions = dom('raster-crop-actions');
        if (actions) actions.classList.toggle('hidden', !cropMode);
        const overlay = dom('raster-crop-overlay');
        if (overlay) {
            overlay.classList.toggle('hidden', !cropMode);
            overlay.setAttribute('aria-hidden', String(!cropMode));
        }

        if (cropMode) {
            const dims = getSourceDimensions();
            if (dims) {
                cropSpace = getTransformedSize({ width: dims.width, height: dims.height });
                cropDisplayRect = mapSourceRectToDisplay(getCropRect(), dims);
            }
            setActiveChannel('rgb');
        } else {
            cropDrag = null;
        }

        if (cropMode !== wasActive) refreshPreview();
    }

    function pointerToCropSpace(event) {
        const overlay = dom('raster-crop-overlay');
        if (!overlay || !cropSpace) return null;
        const rect = overlay.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
            x: clamp((event.clientX - rect.left) / rect.width * cropSpace.width, 0, cropSpace.width),
            y: clamp((event.clientY - rect.top) / rect.height * cropSpace.height, 0, cropSpace.height)
        };
    }

    function onCropPointerDown(event) {
        if (!cropMode || !cropSpace) return;
        const point = pointerToCropSpace(event);
        if (!point) return;

        const handle = event.target?.dataset?.handle || null;
        const box = dom('raster-crop-box');
        const onBox = !handle && box && box.contains(event.target);

        if (handle) {
            cropDrag = { mode: 'resize', handle, origin: { ...cropDisplayRect } };
        } else if (onBox) {
            cropDrag = { mode: 'move', origin: { ...cropDisplayRect }, start: point };
        } else {
            // Dragging on bare canvas draws a brand new box from that corner.
            cropDrag = { mode: 'draw', start: point };
            cropDisplayRect = { x: point.x, y: point.y, width: 0, height: 0 };
            renderCropBox();
        }

        event.preventDefault();
        try {
            event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
            // Pointer capture is a convenience; dragging still works without it.
        }
    }

    function onCropPointerMove(event) {
        if (!cropMode || !cropDrag || !cropSpace) return;
        const point = pointerToCropSpace(event);
        if (!point) return;
        event.preventDefault();

        if (cropDrag.mode === 'draw') {
            cropDisplayRect = normalizeRectFromCorners(cropDrag.start, point);
        } else if (cropDrag.mode === 'move') {
            const dx = point.x - cropDrag.start.x;
            const dy = point.y - cropDrag.start.y;
            cropDisplayRect = {
                x: clamp(cropDrag.origin.x + dx, 0, cropSpace.width - cropDrag.origin.width),
                y: clamp(cropDrag.origin.y + dy, 0, cropSpace.height - cropDrag.origin.height),
                width: cropDrag.origin.width,
                height: cropDrag.origin.height
            };
        } else {
            const origin = cropDrag.origin;
            let left = origin.x;
            let top = origin.y;
            let right = origin.x + origin.width;
            let bottom = origin.y + origin.height;

            if (cropDrag.handle.includes('w')) left = Math.min(point.x, right - MIN_CROP_EDGE);
            if (cropDrag.handle.includes('e')) right = Math.max(point.x, left + MIN_CROP_EDGE);
            if (cropDrag.handle.includes('n')) top = Math.min(point.y, bottom - MIN_CROP_EDGE);
            if (cropDrag.handle.includes('s')) bottom = Math.max(point.y, top + MIN_CROP_EDGE);

            cropDisplayRect = {
                x: clamp(left, 0, cropSpace.width),
                y: clamp(top, 0, cropSpace.height),
                width: clamp(right - left, MIN_CROP_EDGE, cropSpace.width),
                height: clamp(bottom - top, MIN_CROP_EDGE, cropSpace.height)
            };
        }

        renderCropBox();
    }

    function onCropPointerUp(event) {
        if (!cropDrag) return;
        cropDrag = null;
        try {
            event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
            // Nothing to release when capture was never granted.
        }

        // A stray tap should not collapse the crop to nothing.
        if (cropDisplayRect && (cropDisplayRect.width < MIN_CROP_EDGE || cropDisplayRect.height < MIN_CROP_EDGE)) {
            const dims = getSourceDimensions();
            if (dims) cropDisplayRect = mapSourceRectToDisplay(getCropRect(), dims);
            renderCropBox();
        }
    }

    function applyCrop() {
        const dims = getSourceDimensions();
        if (!dims || !cropDisplayRect || !cropSpace) {
            setCropMode(false);
            return;
        }

        const sourceRect = mapDisplayRectToSource(cropDisplayRect, dims);
        const x = clamp(Math.round(sourceRect.x), 0, Math.max(0, dims.width - 1));
        const y = clamp(Math.round(sourceRect.y), 0, Math.max(0, dims.height - 1));
        const width = clamp(Math.round(sourceRect.width), 1, dims.width - x);
        const height = clamp(Math.round(sourceRect.height), 1, dims.height - y);

        edit.crop = (x === 0 && y === 0 && width === dims.width && height === dims.height)
            ? null
            : { x, y, width, height };

        setCropMode(false);
        if (elements.statusText) {
            const base = getBaseDimensions();
            elements.statusText.textContent = base
                ? `Cropped to ${base.width}×${base.height}.`
                : 'Crop applied.';
        }
        onEditChanged({ immediate: true });
    }

    // ── Adjustments ─────────────────────────────────────────────────────────

    function getAdjustSliders() {
        return document.querySelectorAll('#tab-raster [data-adjust]');
    }

    function syncAdjustmentUi() {
        getAdjustSliders().forEach((slider) => {
            const key = slider.dataset.adjust;
            if (!(key in edit.adjustments)) return;
            slider.value = String(edit.adjustments[key]);
        });
        document.querySelectorAll('#tab-raster [data-adjust-value]').forEach((output) => {
            const key = output.dataset.adjustValue;
            if (!(key in edit.adjustments)) return;
            const value = edit.adjustments[key];
            output.textContent = value > 0 ? `+${value}` : `${value}`;
            output.classList.toggle('is-active', value !== 0);
        });

        const activePreset = matchFilterPreset(edit.adjustments);
        document.querySelectorAll('#tab-raster [data-preset]').forEach((chip) => {
            chip.classList.toggle('active', chip.dataset.preset === activePreset);
        });

        const reset = dom('raster-adjust-reset');
        if (reset) reset.disabled = isNeutralAdjustments(edit.adjustments);
    }

    function setAdjustments(next, { immediate = false } = {}) {
        edit.adjustments = normalizeAdjustments(next);
        syncAdjustmentUi();
        onEditChanged({ immediate });
    }

    // ── Export ──────────────────────────────────────────────────────────────

    async function saveRaster(type = 'png') {
        if (!elements.sourceImage || !hasSingleImageLoaded()) {
            elements.statusText.textContent = 'No image loaded.';
            return;
        }

        const dims = getBaseDimensions();
        if (!dims) return;

        const target = getScaledDimensions(dims, state.exportScale);
        const preserveAlpha = resolvePreserveAlpha(type, state.preserveAlpha);

        try {
            const canvas = renderExportCanvas(target, preserveAlpha);
            if (!canvas) throw new Error('Could not build the export canvas.');
            const blob = await encodeRasterCanvas(canvas, type, preserveAlpha);
            downloadBlob(blob, `${getImageBaseName()}_${target.width}x${target.height}.${getRasterFormatExtension(type)}`);
            const alphaNote = preserveAlpha && (type === 'tga' || type === 'webp') ? ' Includes alpha.' : '';
            elements.statusText.textContent = `Saved ${getRasterFormatLabel(type)} at ${target.width}×${target.height}.${alphaNote}`;
        } catch (error) {
            console.error('Raster export failed:', error);
            elements.statusText.textContent = 'Failed to export image.';
        }
    }

    // ── Lifecycle ───────────────────────────────────────────────────────────

    function syncRasterEmptyState() {
        const emptyState = dom('raster-empty-state');
        const content = dom('raster-content');
        const originalPreview = dom('raster-original-preview');
        const originalImg = dom('raster-original-img');
        const hasImage = hasSingleImageLoaded();
        if (emptyState) emptyState.classList.toggle('hidden', hasImage);
        if (content) content.classList.toggle('hidden', !hasImage);
        if (originalPreview) originalPreview.classList.toggle('hidden', !hasImage);
        if (originalImg && hasImage && elements.sourceImage?.src) {
            originalImg.src = elements.sourceImage.src;
        }
    }

    function resetEditState() {
        edit.rotation = 0;
        edit.flipH = false;
        edit.flipV = false;
        edit.crop = null;
        edit.adjustments = { ...DEFAULT_ADJUSTMENTS };
        sizeEstimateCache.clear();
        setCropMode(false);
        syncAdjustmentUi();
    }

    function onSourceImageLoaded() {
        if (elements.saveResizedPngBtn) elements.saveResizedPngBtn.disabled = false;
        if (elements.saveResizedJpgBtn) elements.saveResizedJpgBtn.disabled = false;
        if (elements.saveResizedTgaBtn) elements.saveResizedTgaBtn.disabled = false;
        const webpBtn = dom('save-resized-webp-btn');
        if (webpBtn) webpBtn.disabled = false;

        resetEditState();
        syncRasterEmptyState();
        refreshPreview();
        updateExportScaleDisplay();
    }

    function onTabActivated() {
        syncRasterEmptyState();
        if (hasSingleImageLoaded()) {
            refreshPreview();
            updateExportScaleDisplay();
        }
    }

    function bindEvents() {
        elements.resizeChips.forEach((chip) => {
            chip.addEventListener('click', () => {
                const scale = parseInt(chip.dataset.scale, 10);
                if (!isNaN(scale)) setExportScale(scale);
            });
        });

        if (elements.applyCustomResizeBtn) {
            elements.applyCustomResizeBtn.addEventListener('click', () => {
                const val = parseInt(elements.resizeCustomInput.value, 10);
                if (!isNaN(val)) setExportScale(val);
            });
        }

        if (elements.saveResizedPngBtn) elements.saveResizedPngBtn.addEventListener('click', () => saveRaster('png'));
        if (elements.saveResizedJpgBtn) elements.saveResizedJpgBtn.addEventListener('click', () => saveRaster('jpg'));
        if (elements.saveResizedTgaBtn) elements.saveResizedTgaBtn.addEventListener('click', () => saveRaster('tga'));
        const saveWebpBtn = dom('save-resized-webp-btn');
        if (saveWebpBtn) saveWebpBtn.addEventListener('click', () => saveRaster('webp'));

        document.querySelectorAll('#tab-raster .rgba-channel-tab').forEach((tab) => {
            tab.addEventListener('click', () => setActiveChannel(tab.dataset.channel));
        });

        // Transforms
        dom('raster-rotate-ccw')?.addEventListener('click', () => rotateBy(-90));
        dom('raster-rotate-cw')?.addEventListener('click', () => rotateBy(90));
        dom('raster-flip-h')?.addEventListener('click', () => toggleFlip('h'));
        dom('raster-flip-v')?.addEventListener('click', () => toggleFlip('v'));
        dom('raster-edit-reset')?.addEventListener('click', revertGeometry);

        // Crop
        dom('raster-crop-toggle')?.addEventListener('click', () => setCropMode(!cropMode));
        dom('raster-crop-cancel')?.addEventListener('click', () => setCropMode(false));
        dom('raster-crop-apply')?.addEventListener('click', applyCrop);

        const overlay = dom('raster-crop-overlay');
        if (overlay) {
            overlay.addEventListener('pointerdown', onCropPointerDown);
            overlay.addEventListener('pointermove', onCropPointerMove);
            overlay.addEventListener('pointerup', onCropPointerUp);
            overlay.addEventListener('pointercancel', onCropPointerUp);
        }

        window.addEventListener('resize', () => {
            if (cropMode) renderCropBox();
        });

        // Adjustments
        getAdjustSliders().forEach((slider) => {
            slider.addEventListener('input', () => {
                const key = slider.dataset.adjust;
                setAdjustments({ ...edit.adjustments, [key]: Number(slider.value) });
            });
        });

        document.querySelectorAll('#tab-raster [data-preset]').forEach((chip) => {
            chip.addEventListener('click', () => {
                setAdjustments(getFilterPreset(chip.dataset.preset), { immediate: true });
                if (elements.statusText) {
                    elements.statusText.textContent = `Applied the ${chip.textContent.trim()} filter.`;
                }
            });
        });

        dom('raster-adjust-reset')?.addEventListener('click', () => {
            setAdjustments(DEFAULT_ADJUSTMENTS, { immediate: true });
        });

        const preserveAlphaPng = dom('preserve-alpha-png');
        const preserveAlphaTga = dom('preserve-alpha-tga');
        const preserveAlphaWebp = dom('preserve-alpha-webp');
        const alphaToggles = [preserveAlphaPng, preserveAlphaTga, preserveAlphaWebp].filter(Boolean);

        alphaToggles.forEach((toggle) => {
            toggle.checked = state.preserveAlpha;
            toggle.addEventListener('change', () => {
                // Unchanged semantics: the checkboxes drive one shared setting
                // and any of them being on keeps alpha in the pipeline.
                state.preserveAlpha = alphaToggles.some((other) => other.checked);
                updateExportScaleDisplay();
            });
        });

        syncAdjustmentUi();
    }

    return {
        bindEvents,
        onSourceImageLoaded,
        onTabActivated,
        setExportScale,
        updateExportScaleDisplay
    };
}
