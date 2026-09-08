import { createZipFile } from '../export3d.js?v=r-afbde72383fa3b50';
import {
    canvasToBlobAsync,
    estimateSizeBytes,
    exportCanvasToRasterBlob,
    formatBytes,
    getBulkFolderName,
    getBulkRelativePath,
    getFormatLabel,
    getImageFormat,
    IMPORTABLE_IMAGE_PROMPT,
    getRasterExtension,
    getScaledDimensions,
    getSortedBulkFiles,
    isSupportedBulkFile,
    loadImageElementFromFile,
    sanitizeFileComponent,
    supportsAlphaForFormat
} from '../raster-utils.js?v=r-afbde72383fa3b50';
import {
    ADJUSTMENT_KEYS,
    ADJUSTMENT_RANGES,
    DEFAULT_ADJUSTMENTS,
    FILTER_PRESET_LABELS,
    FILTER_PRESET_ORDER,
    applyAdjustmentsToImageData,
    getFilterPreset,
    isNeutralAdjustments,
    matchFilterPreset,
    normalizeAdjustments
} from '../shared/image-adjust.js?v=r-afbde72383fa3b50';

// ── Export formats ─────────────────────────────────────────────────────────
// WEBP is wrapped locally rather than pushed into raster-utils.js, matching the
// pattern the Raster and PDF tabs already use: the shared helpers stay on the
// png/jpg/tga triple their other consumers depend on.
const WEBP_QUALITY = 0.9;
const WEBP_MIME = 'image/webp';

function bulkSupportsAlpha(format) {
    return format === 'webp' ? true : supportsAlphaForFormat(format);
}

function bulkExtension(format) {
    return format === 'webp' ? 'webp' : getRasterExtension(format);
}

function bulkFormatLabel(format) {
    return format === 'webp' ? 'WEBP' : getFormatLabel(format);
}

function resolveBulkPreserveAlpha(format, preserveAlpha) {
    return bulkSupportsAlpha(format) ? !!preserveAlpha : false;
}

/** Thrown when the browser cannot produce the requested container at all. */
class BulkFormatUnsupportedError extends Error {}

let webpSupportProbe = null;

/**
 * Encodes a 1×1 canvas once per session and checks the container the browser
 * actually handed back. `canvas.toBlob` silently falls back to PNG on engines
 * without a WEBP encoder, so without this check a ZIP could ship PNG bytes
 * inside `.webp` filenames.
 */
function probeWebpSupport() {
    if (!webpSupportProbe) {
        webpSupportProbe = (async () => {
            try {
                const probe = document.createElement('canvas');
                probe.width = 1;
                probe.height = 1;
                const blob = await canvasToBlobAsync(probe, WEBP_MIME, WEBP_QUALITY);
                return !!blob && String(blob.type).toLowerCase() === WEBP_MIME;
            } catch {
                return false;
            }
        })();
    }
    return webpSupportProbe;
}

async function encodeBulkCanvas(canvas, format, preserveAlpha) {
    if (format !== 'webp') {
        return exportCanvasToRasterBlob(canvas, format, preserveAlpha);
    }

    const blob = await canvasToBlobAsync(canvas, WEBP_MIME, WEBP_QUALITY);
    if (!blob || String(blob.type).toLowerCase() !== WEBP_MIME) {
        throw new BulkFormatUnsupportedError(
            'This browser could not encode WEBP — it returned a different image type. Choose PNG, JPG, or TGA instead.'
        );
    }
    return blob;
}

// ── HEIC / HEIF intake ─────────────────────────────────────────────────────
// The decoder lives behind a lazy dynamic import so the ~1.4 MB wasm payload is
// only fetched when a HEIC file is actually part of the batch. The sets below
// mirror the sniffing in modules/shared/heic.js purely to decide whether to take
// that branch — browsers routinely report an empty `type` for HEIC, so the
// extension is the primary signal here too, and the authoritative answer still
// comes from the module's own isHeicFile().
const HEIC_EXTENSIONS = new Set(['heic', 'heif', 'heics', 'heifs', 'hif']);
const HEIC_MIME_TYPES = new Set([
    'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence',
    'image/heix', 'image/heim', 'image/heis', 'image/hevc', 'image/hevx'
]);

const BULK_INPUT_ACCEPT = [
    'image/*',
    '.png', '.jpg', '.jpeg', '.jfif', '.webp', '.gif', '.bmp', '.avif',
    '.svg', '.ico', '.tif', '.tiff', '.heic', '.heif', '.heics', '.heifs', '.hif'
].join(',');

/** Cheap pre-flight so the dynamic import only runs for plausible HEIC files. */
function looksLikeHeicFile(file) {
    if (!file) return false;
    const mimeType = String(file.type || '').toLowerCase().split(';')[0].trim();
    if (mimeType && HEIC_MIME_TYPES.has(mimeType)) return true;
    const extension = String(file.name || '').match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase() || '';
    return HEIC_EXTENSIONS.has(extension);
}

let heicModulePromise = null;
function loadHeicModule() {
    if (!heicModulePromise) {
        // A failed load clears the cache so a later batch can retry.
        heicModulePromise = import('../shared/heic.js?v=r-afbde72383fa3b50')
            .catch((error) => {
                heicModulePromise = null;
                throw error;
            });
    }
    return heicModulePromise;
}

/**
 * Returns a decoded canvas, or `null` when the shared module says the file is
 * not really HEIC (so the caller can fall back to the normal `<img>` path).
 * Throws with a per-file message when decoding genuinely fails.
 */
async function decodeHeicSource(file) {
    let heic;
    try {
        heic = await loadHeicModule();
    } catch (error) {
        console.warn('HEIC decoder module failed to load.', error);
        throw new Error(`HEIC support could not be loaded for ${file.name}.`);
    }

    if (typeof heic?.isHeicFile === 'function' && !heic.isHeicFile(file)) {
        return null;
    }
    if (typeof heic?.decodeHeicToCanvas !== 'function') {
        throw new Error(`HEIC decoding is unavailable for ${file.name}.`);
    }

    let canvas;
    try {
        canvas = await heic.decodeHeicToCanvas(file);
    } catch (error) {
        console.warn('HEIC decode failed:', file.name, error);
        throw new Error(`Could not decode HEIC file ${file.name}: ${error?.message || 'unknown decoder error'}.`);
    }

    if (!canvas || !canvas.width || !canvas.height) {
        throw new Error(`HEIC file ${file.name} decoded to an empty image.`);
    }
    return canvas;
}

/**
 * One intake path for every source in the batch. Resolves to something
 * `drawImage` accepts plus a cleanup for any object URL it created.
 */
async function loadBulkImageSource(file) {
    if (looksLikeHeicFile(file)) {
        const canvas = await decodeHeicSource(file);
        if (canvas) return { source: canvas, cleanup: () => {} };
    }
    const { img, cleanup } = await loadImageElementFromFile(file);
    return { source: img, cleanup };
}

async function loadBulkImageMetrics(file) {
    const { source, cleanup } = await loadBulkImageSource(file);
    try {
        return {
            width: source.naturalWidth || source.width,
            height: source.naturalHeight || source.height
        };
    } finally {
        cleanup();
    }
}

function isBulkImportableFile(file) {
    return isSupportedBulkFile(file) || looksLikeHeicFile(file);
}

// The live preview never renders above this edge length; exports always run at
// the real target size. Sliders re-run the whole adjustment pass per tick.
const PREVIEW_MAX_EDGE = 720;
const PREVIEW_DEBOUNCE_MS = 110;

export function createBulkTabController({
    state,
    elements,
    showLoader,
    syncWorkspaceView,
    downloadBlob
}) {
    const bulkEstimateCache = new Map();
    let bulkEstimateJobId = 0;

    /**
     * One shared transform + adjustment state applied identically to every
     * image in the batch. The export pipeline runs
     *   decode → transform → resize/fit → adjustments → encode
     * and the preview runs the same function at a reduced target size.
     */
    const bulkEdit = {
        rotation: 0,          // 0 | 90 | 180 | 270, clockwise
        flipH: false,
        flipV: false,
        adjustments: { ...DEFAULT_ADJUSTMENTS }
    };

    const domCache = new Map();
    function dom(id) {
        if (!domCache.has(id)) domCache.set(id, document.getElementById(id));
        return domCache.get(id);
    }

    const adjustSliders = new Map();
    const adjustOutputs = new Map();
    let presetChips = [];

    let previewTimer = null;
    let previewToken = 0;
    let previewSource = null;    // { source, cleanup }
    let previewSourceKey = '';

    // ── Geometry ────────────────────────────────────────────────────────────

    function isQuarterTurned() {
        return bulkEdit.rotation === 90 || bulkEdit.rotation === 270;
    }

    /** Post-transform dimensions — what the resize modes actually operate on. */
    function getTransformedDims(width, height) {
        return isQuarterTurned()
            ? { width: height, height: width }
            : { width, height };
    }

    function isTransformNeutral() {
        return bulkEdit.rotation === 0 && !bulkEdit.flipH && !bulkEdit.flipV;
    }

    /**
     * Rotation and flips are baked into the destination context. `width` and
     * `height` are the destination rect measured *before* the quarter turn.
     */
    function applyTransformToContext(ctx, width, height) {
        switch (bulkEdit.rotation) {
            case 90: ctx.translate(height, 0); ctx.rotate(Math.PI / 2); break;
            case 180: ctx.translate(width, height); ctx.rotate(Math.PI); break;
            case 270: ctx.translate(0, width); ctx.rotate(-Math.PI / 2); break;
            default: break;
        }
        if (bulkEdit.flipH) {
            ctx.translate(width, 0);
            ctx.scale(-1, 1);
        }
        if (bulkEdit.flipV) {
            ctx.translate(0, height);
            ctx.scale(1, -1);
        }
    }

    /**
     * Renders one batch image: transform → contain/cover/stretch fit → colour.
     * The fit maths runs on the *transformed* source size, so a 90° rotation
     * letterboxes against the swapped edge rather than the original one.
     */
    function renderBulkCanvas(source, target, preserveAlpha, adjustments) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(target.width));
        canvas.height = Math.max(1, Math.round(target.height));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('This browser did not provide a 2D canvas context.');

        if (preserveAlpha) {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
        } else {
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }

        ctx.imageSmoothingEnabled = true;
        if ('imageSmoothingQuality' in ctx) ctx.imageSmoothingQuality = 'high';

        const sourceWidth = source.naturalWidth || source.width;
        const sourceHeight = source.naturalHeight || source.height;

        if (sourceWidth > 0 && sourceHeight > 0) {
            const view = getTransformedDims(sourceWidth, sourceHeight);
            let destWidth = canvas.width;
            let destHeight = canvas.height;
            let destX = 0;
            let destY = 0;

            const fitMode = target.fitMode;
            if (fitMode === 'contain' || fitMode === 'cover') {
                const scale = fitMode === 'contain'
                    ? Math.min(canvas.width / view.width, canvas.height / view.height)
                    : Math.max(canvas.width / view.width, canvas.height / view.height);
                destWidth = view.width * scale;
                destHeight = view.height * scale;
                destX = (canvas.width - destWidth) / 2;
                destY = (canvas.height - destHeight) / 2;
            }

            // The draw happens in the pre-rotation frame, so a quarter turn
            // swaps which destination axis the source width lands on.
            const drawWidth = isQuarterTurned() ? destHeight : destWidth;
            const drawHeight = isQuarterTurned() ? destWidth : destHeight;

            ctx.save();
            ctx.translate(destX, destY);
            applyTransformToContext(ctx, drawWidth, drawHeight);
            ctx.drawImage(source, 0, 0, drawWidth, drawHeight);
            ctx.restore();
        }

        // Neutral sliders skip the pixel pass entirely.
        if (adjustments && !isNeutralAdjustments(adjustments)) {
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            applyAdjustmentsToImageData(imageData, adjustments);
            ctx.putImageData(imageData, 0, 0);
        }

        return canvas;
    }

    async function renderBulkBlob(source, target, format, preserveAlpha) {
        const canvas = renderBulkCanvas(source, target, preserveAlpha, bulkEdit.adjustments);
        return encodeBulkCanvas(canvas, format, preserveAlpha);
    }

    // ── Naming ──────────────────────────────────────────────────────────────

    function createBulkListCell(label, primary, secondary = '') {
        const cell = document.createElement('div');
        cell.className = 'bulk-list-cell';
        cell.dataset.label = label;

        const primaryText = document.createElement('span');
        primaryText.className = 'bulk-list-primary';
        primaryText.textContent = primary;
        cell.appendChild(primaryText);

        if (secondary) {
            const secondaryText = document.createElement('span');
            secondaryText.className = 'bulk-list-secondary';
            secondaryText.textContent = secondary;
            cell.appendChild(secondaryText);
        }

        return cell;
    }

    function getBulkSourceFileName(entry) {
        const sourcePath = entry.relativePath
            || entry.file?.webkitRelativePath
            || entry.file?.name
            || entry.name
            || 'image';
        const pathParts = String(sourcePath).split(/[\\/]/).filter(Boolean);
        return pathParts[pathParts.length - 1] || 'image';
    }

    function buildBulkExportFileName(entry, index) {
        const ext = bulkExtension(state.bulk.exportFormat);
        if (state.bulk.keepOriginalNames) {
            const baseName = sanitizeFileComponent(getBulkSourceFileName(entry), 'image');
            return `${baseName}.${ext}`;
        }
        const rawName = state.bulk.outputName.trim() || state.bulk.folderName || entry.name;
        const baseName = sanitizeFileComponent(rawName, 'image');
        return `${baseName}_${index}.${ext}`;
    }

    function buildBulkExportFileNames(entries) {
        const usedNames = new Set();

        return entries.map((entry, index) => {
            const preferredName = buildBulkExportFileName(entry, index + 1);
            const extensionIndex = preferredName.lastIndexOf('.');
            const stem = extensionIndex > 0 ? preferredName.slice(0, extensionIndex) : preferredName;
            const extension = extensionIndex > 0 ? preferredName.slice(extensionIndex) : '';
            let exportName = preferredName;
            let duplicateNumber = 2;

            while (usedNames.has(exportName.toLocaleLowerCase())) {
                exportName = `${stem}_${duplicateNumber}${extension}`;
                duplicateNumber += 1;
            }

            usedNames.add(exportName.toLocaleLowerCase());
            return exportName;
        });
    }

    function computeBulkTarget(entry) {
        if (state.bulk.resizeMode === 'fixed') {
            return {
                width: Math.max(1, Math.round(state.bulk.targetWidth)),
                height: Math.max(1, Math.round(state.bulk.targetHeight)),
                fitMode: state.bulk.fitMode
            };
        }
        // Scale mode multiplies the *transformed* size, so a rotated batch
        // keeps the same pixel count with the axes swapped.
        return getScaledDimensions(
            getTransformedDims(entry.width, entry.height),
            state.bulk.exportScale
        );
    }

    // ── Estimates ───────────────────────────────────────────────────────────

    /** Every edit that changes output bytes has to invalidate the cache. */
    function getEditSignature() {
        const normalized = normalizeAdjustments(bulkEdit.adjustments);
        return [
            bulkEdit.rotation,
            bulkEdit.flipH ? 1 : 0,
            bulkEdit.flipV ? 1 : 0,
            ...ADJUSTMENT_KEYS.map((key) => normalized[key])
        ].join(',');
    }

    function getBulkEstimateCacheKey(entry, target, format, preserveAlpha) {
        return [
            entry.relativePath,
            entry.size,
            entry.width,
            entry.height,
            entry.file?.lastModified || 0,
            target.width,
            target.height,
            target.fitMode || '',
            format,
            preserveAlpha ? 1 : 0,
            getEditSignature()
        ].join('|');
    }

    async function getBulkAccurateEstimate(entry, target, format, preserveAlpha) {
        const cacheKey = getBulkEstimateCacheKey(entry, target, format, preserveAlpha);
        if (bulkEstimateCache.has(cacheKey)) {
            return bulkEstimateCache.get(cacheKey);
        }

        const { source, cleanup } = await loadBulkImageSource(entry.file);
        try {
            const blob = await renderBulkBlob(source, target, format, preserveAlpha);
            bulkEstimateCache.set(cacheKey, blob.size);
            return blob.size;
        } finally {
            cleanup();
        }
    }

    function formatEstimatedBytes(bytes) {
        return typeof bytes === 'number' ? formatBytes(bytes) : 'Estimating...';
    }

    function updateBulkTotalsDisplay(originalBytes) {
        const resolvedItems = state.bulk.previewItems.filter((entry) => typeof entry.estimatedBytes === 'number');
        const allResolved = resolvedItems.length === state.bulk.previewItems.length;

        if (!state.bulk.previewItems.length) {
            state.bulk.totals = {
                originalBytes,
                estimatedBytes: 0,
                savedBytes: 0,
                savedPercent: 0
            };
            if (elements.bulkEstOriginal) elements.bulkEstOriginal.textContent = '—';
            if (elements.bulkEstOutput) elements.bulkEstOutput.textContent = '—';
            if (elements.bulkTotalSaved) elements.bulkTotalSaved.textContent = '—';
            if (elements.bulkTotalSavedPercent) elements.bulkTotalSavedPercent.textContent = '—';
            return;
        }

        if (!allResolved) {
            state.bulk.totals = {
                originalBytes,
                estimatedBytes: 0,
                savedBytes: 0,
                savedPercent: 0
            };
            if (elements.bulkEstOriginal) elements.bulkEstOriginal.textContent = 'Estimating...';
            if (elements.bulkEstOutput) elements.bulkEstOutput.textContent = 'Estimating...';
            if (elements.bulkTotalSaved) {
                elements.bulkTotalSaved.textContent = `Estimating ${resolvedItems.length}/${state.bulk.previewItems.length}`;
            }
            if (elements.bulkTotalSavedPercent) {
                elements.bulkTotalSavedPercent.textContent = 'Calculating actual output sizes';
            }
            return;
        }

        const estimatedBytes = resolvedItems.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
        const savedBytes = originalBytes - estimatedBytes;
        const savedPercent = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;

        state.bulk.totals = {
            originalBytes,
            estimatedBytes,
            savedBytes,
            savedPercent
        };

        if (elements.bulkEstOriginal) elements.bulkEstOriginal.textContent = formatBytes(Math.abs(savedBytes));
        if (elements.bulkEstOutput) elements.bulkEstOutput.textContent = formatBytes(estimatedBytes);

        if (elements.bulkTotalSaved) {
            if (savedBytes > 0) {
                elements.bulkTotalSaved.textContent = `Saved ${formatBytes(savedBytes)}`;
            } else if (savedBytes < 0) {
                elements.bulkTotalSaved.textContent = `Larger by ${formatBytes(Math.abs(savedBytes))}`;
            } else {
                elements.bulkTotalSaved.textContent = 'No size change';
            }
        }

        if (elements.bulkTotalSavedPercent) {
            if (savedBytes > 0) {
                elements.bulkTotalSavedPercent.textContent = `${savedPercent.toFixed(1)}% smaller overall`;
            } else if (savedBytes < 0) {
                elements.bulkTotalSavedPercent.textContent = `${Math.abs(savedPercent).toFixed(1)}% larger overall`;
            } else {
                elements.bulkTotalSavedPercent.textContent = '0.0% difference';
            }
        }
    }

    async function hydrateBulkEstimates(jobId, format, preserveAlpha) {
        for (const item of state.bulk.previewItems) {
            if (jobId !== bulkEstimateJobId) return;
            if (typeof item.estimatedBytes === 'number') continue;

            try {
                item.estimatedBytes = await getBulkAccurateEstimate(item, item.target, format, preserveAlpha);
            } catch (error) {
                console.warn(`Falling back to approximate ${bulkFormatLabel(format)} bulk estimate for ${item.name}.`, error);
                // estimateSizeBytes has no WEBP curve; JPG is the closest one.
                const approximateFormat = format === 'webp' ? 'jpg' : format;
                item.estimatedBytes = estimateSizeBytes(item.target.width, item.target.height, approximateFormat, preserveAlpha);
            }

            if (jobId !== bulkEstimateJobId) return;
            updateBulkTotalsDisplay(state.bulk.files.reduce((sum, entry) => sum + entry.size, 0));
            renderBulkPreviewList();
            renderSelectedPreviewDetails();
        }
    }

    // ── Selection ───────────────────────────────────────────────────────────

    function getSelectedPreviewItem() {
        if (state.bulk.selectedPreviewIndex < 0) return null;
        return state.bulk.previewItems[state.bulk.selectedPreviewIndex] || null;
    }

    function syncSelectedPreviewIndex() {
        if (!state.bulk.previewItems.length) {
            state.bulk.selectedPreviewIndex = -1;
            return;
        }

        if (
            state.bulk.selectedPreviewIndex < 0
            || state.bulk.selectedPreviewIndex >= state.bulk.previewItems.length
        ) {
            state.bulk.selectedPreviewIndex = 0;
        }
    }

    function renderSelectedPreviewDetails() {
        const selectedItem = getSelectedPreviewItem();
        const formatLabel = bulkFormatLabel(state.bulk.exportFormat);

        if (elements.bulkSelectedChip) {
            elements.bulkSelectedChip.textContent = selectedItem
                ? `${state.bulk.selectedPreviewIndex + 1} / ${state.bulk.previewItems.length}`
                : 'No selection';
        }

        if (elements.bulkSelectedFormat) {
            elements.bulkSelectedFormat.textContent = formatLabel;
        }

        if (!selectedItem) {
            if (elements.bulkSelectedName) elements.bulkSelectedName.textContent = 'No file selected';
            if (elements.bulkSelectedPath) {
                elements.bulkSelectedPath.textContent = state.bulk.folderName
                    ? 'This folder does not have a selectable preview item yet.'
                    : 'Choose a folder from the left sidebar to begin.';
            }
            if (elements.bulkSelectedExportName) elements.bulkSelectedExportName.textContent = '—';
            if (elements.bulkSelectedOriginalDims) elements.bulkSelectedOriginalDims.textContent = '—';
            if (elements.bulkSelectedOriginalSize) elements.bulkSelectedOriginalSize.textContent = '—';
            if (elements.bulkSelectedOutputDims) elements.bulkSelectedOutputDims.textContent = '—';
            if (elements.bulkSelectedEstSize) elements.bulkSelectedEstSize.textContent = '—';
            if (elements.bulkSelectedOutputFormat) elements.bulkSelectedOutputFormat.textContent = '—';
            return;
        }

        if (elements.bulkSelectedName) elements.bulkSelectedName.textContent = selectedItem.name;
        if (elements.bulkSelectedPath) {
            elements.bulkSelectedPath.textContent = selectedItem.relativePath !== selectedItem.name
                ? selectedItem.relativePath
                : 'Top-level file';
        }
        if (elements.bulkSelectedExportName) elements.bulkSelectedExportName.textContent = selectedItem.exportName;
        if (elements.bulkSelectedOriginalDims) {
            elements.bulkSelectedOriginalDims.textContent = `${selectedItem.width}×${selectedItem.height}px`;
        }
        if (elements.bulkSelectedOriginalSize) {
            elements.bulkSelectedOriginalSize.textContent = formatBytes(selectedItem.size);
        }
        if (elements.bulkSelectedOutputDims) {
            elements.bulkSelectedOutputDims.textContent = `${selectedItem.target.width}×${selectedItem.target.height}px`;
        }
        if (elements.bulkSelectedEstSize) {
            elements.bulkSelectedEstSize.textContent = formatEstimatedBytes(selectedItem.estimatedBytes);
        }
        if (elements.bulkSelectedOutputFormat) {
            elements.bulkSelectedOutputFormat.textContent = formatLabel;
        }
    }

    // ── Live preview canvas ─────────────────────────────────────────────────

    function getPreviewSourceKey(item) {
        if (!item) return '';
        return [item.relativePath, item.size, item.file?.lastModified || 0].join('|');
    }

    function releasePreviewSource() {
        if (previewSource) {
            try {
                previewSource.cleanup();
            } catch {
                // A already-revoked object URL is not worth surfacing.
            }
        }
        previewSource = null;
        previewSourceKey = '';
    }

    /** Decodes the selected file once and reuses it across slider ticks. */
    async function ensurePreviewSource(item) {
        const key = getPreviewSourceKey(item);
        if (key && key === previewSourceKey && previewSource) return previewSource;
        releasePreviewSource();
        if (!item) return null;
        const loaded = await loadBulkImageSource(item.file);
        previewSource = loaded;
        previewSourceKey = key;
        return loaded;
    }

    function setPreviewNote(message) {
        const canvas = dom('bulk-preview-canvas');
        const note = dom('bulk-preview-note');
        if (canvas) canvas.classList.add('hidden');
        if (note) {
            note.classList.remove('hidden');
            note.textContent = message;
        }
    }

    async function renderSelectedPreviewCanvas() {
        const canvas = dom('bulk-preview-canvas');
        if (!canvas) return;

        const token = ++previewToken;
        const item = getSelectedPreviewItem();

        if (!item) {
            releasePreviewSource();
            setPreviewNote('Select an image to preview the batch edits.');
            return;
        }

        try {
            const loaded = await ensurePreviewSource(item);
            if (token !== previewToken) return;
            if (!loaded) {
                setPreviewNote('Preview is unavailable for this file.');
                return;
            }

            const preserveAlpha = resolveBulkPreserveAlpha(state.bulk.exportFormat, state.bulk.preserveAlpha);
            // Downscale the export target so a slider drag stays responsive.
            const scale = Math.min(1, PREVIEW_MAX_EDGE / Math.max(item.target.width, item.target.height));
            const target = {
                width: Math.max(1, Math.round(item.target.width * scale)),
                height: Math.max(1, Math.round(item.target.height * scale)),
                fitMode: item.target.fitMode
            };

            const rendered = renderBulkCanvas(loaded.source, target, preserveAlpha, bulkEdit.adjustments);
            if (token !== previewToken) return;

            canvas.width = rendered.width;
            canvas.height = rendered.height;
            const ctx = canvas.getContext('2d');
            if (ctx) {
                ctx.clearRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(rendered, 0, 0);
            }
            canvas.classList.remove('hidden');
            const note = dom('bulk-preview-note');
            if (note) note.classList.add('hidden');
        } catch (error) {
            if (token !== previewToken) return;
            console.warn('Bulk preview render failed:', item.name, error);
            setPreviewNote(error?.message || `Could not preview ${item.name}.`);
        }
    }

    function schedulePreviewRender({ immediate = false } = {}) {
        if (previewTimer) {
            clearTimeout(previewTimer);
            previewTimer = null;
        }
        if (immediate) {
            void renderSelectedPreviewCanvas();
            return;
        }
        previewTimer = setTimeout(() => {
            previewTimer = null;
            void renderSelectedPreviewCanvas();
        }, PREVIEW_DEBOUNCE_MS);
    }

    // ── Lists ───────────────────────────────────────────────────────────────

    function renderBulkSourceList() {
        if (!elements.bulkSourceList) return;
        elements.bulkSourceList.replaceChildren();

        if (!state.bulk.files.length) {
            const empty = document.createElement('div');
            empty.className = 'bulk-empty-state';
            empty.textContent = state.bulk.folderName
                ? `No compatible images were found. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`
                : `Choose a folder from the left sidebar to see compatible images. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`;
            elements.bulkSourceList.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.bulk.files.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'bulk-list-row';
            row.appendChild(createBulkListCell('Name', entry.name, entry.relativePath !== entry.name ? entry.relativePath : ''));
            row.appendChild(createBulkListCell('Resolution', `${entry.width}×${entry.height}px`));
            row.appendChild(createBulkListCell('File Size', formatBytes(entry.size)));
            row.appendChild(createBulkListCell('Format', entry.format));
            fragment.appendChild(row);
        });

        elements.bulkSourceList.appendChild(fragment);
    }

    function renderBulkPreviewList() {
        if (!elements.bulkPreviewList) return;
        elements.bulkPreviewList.replaceChildren();

        if (!state.bulk.previewItems.length) {
            const empty = document.createElement('div');
            empty.className = 'bulk-empty-state';
            empty.textContent = state.bulk.folderName
                ? 'No bulk preview is available for this folder.'
                : 'Choose a folder from the left sidebar to preview bulk output.';
            elements.bulkPreviewList.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.bulk.previewItems.forEach((entry, index) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'bulk-list-row bulk-result-row bulk-result-button';
            row.classList.toggle('is-selected', index === state.bulk.selectedPreviewIndex);
            row.appendChild(createBulkListCell('Image', entry.name, entry.relativePath !== entry.name ? entry.relativePath : entry.exportName));
            row.appendChild(createBulkListCell('Result', `${entry.target.width}×${entry.target.height}px`, entry.exportName));
            row.appendChild(createBulkListCell('Estimated', formatEstimatedBytes(entry.estimatedBytes), bulkFormatLabel(state.bulk.exportFormat)));
            row.addEventListener('click', () => {
                state.bulk.selectedPreviewIndex = index;
                renderBulkPreviewList();
                renderSelectedPreviewDetails();
                schedulePreviewRender({ immediate: true });
            });
            fragment.appendChild(row);
        });

        elements.bulkPreviewList.appendChild(fragment);
    }

    function updateBulkAlphaVisibility() {
        if (!elements.bulkAlphaToggle || !elements.bulkPreserveAlphaCheckbox) return;

        const supportsAlpha = bulkSupportsAlpha(state.bulk.exportFormat);
        elements.bulkAlphaToggle.classList.toggle('hidden', !supportsAlpha);
        elements.bulkPreserveAlphaCheckbox.disabled = !supportsAlpha;
    }

    function setExportScale(scale) {
        state.bulk.exportScale = Math.min(500, Math.max(1, Math.round(scale)));
        state.bulk.resizeMode = 'scale';
        elements.bulkResizeChips.forEach((chip) => {
            chip.classList.toggle('active', parseInt(chip.dataset.scale, 10) === state.bulk.exportScale);
        });
        updatePreview();
    }

    function setResizeMode(mode) {
        state.bulk.resizeMode = mode === 'fixed' ? 'fixed' : 'scale';
        updatePreview();
    }

    function syncResizeModeUI() {
        if (elements.bulkResizeModeTabs) {
            elements.bulkResizeModeTabs.forEach((tab) => {
                tab.classList.toggle('active', tab.dataset.mode === state.bulk.resizeMode);
            });
        }
        if (elements.bulkResizePanels) {
            elements.bulkResizePanels.forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset.modePanel !== state.bulk.resizeMode);
            });
        }
        if (elements.bulkTargetWidthInput && document.activeElement !== elements.bulkTargetWidthInput) {
            elements.bulkTargetWidthInput.value = state.bulk.targetWidth;
        }
        if (elements.bulkTargetHeightInput && document.activeElement !== elements.bulkTargetHeightInput) {
            elements.bulkTargetHeightInput.value = state.bulk.targetHeight;
        }
        if (elements.bulkFitModeSelect) {
            elements.bulkFitModeSelect.value = state.bulk.fitMode;
        }
    }

    // ── Batch edit controls ─────────────────────────────────────────────────

    function describeTransform() {
        if (isTransformNeutral()) return 'No transform';
        const parts = [];
        if (bulkEdit.rotation) parts.push(`${bulkEdit.rotation}°`);
        if (bulkEdit.flipH) parts.push('Flip H');
        if (bulkEdit.flipV) parts.push('Flip V');
        return parts.join(' · ');
    }

    function syncTransformUI() {
        const readout = dom('bulk-transform-readout');
        if (readout) readout.textContent = describeTransform();

        const flipH = dom('bulk-flip-h');
        if (flipH) {
            flipH.classList.toggle('active', bulkEdit.flipH);
            flipH.setAttribute('aria-pressed', String(bulkEdit.flipH));
        }
        const flipV = dom('bulk-flip-v');
        if (flipV) {
            flipV.classList.toggle('active', bulkEdit.flipV);
            flipV.setAttribute('aria-pressed', String(bulkEdit.flipV));
        }

        const reset = dom('bulk-transform-reset');
        if (reset) reset.disabled = isTransformNeutral();
    }

    function syncAdjustUI() {
        const normalized = normalizeAdjustments(bulkEdit.adjustments);

        ADJUSTMENT_KEYS.forEach((key) => {
            const slider = adjustSliders.get(key);
            if (slider && document.activeElement !== slider) {
                slider.value = String(normalized[key]);
            }
            const output = adjustOutputs.get(key);
            if (output) {
                output.textContent = String(normalized[key]);
                output.classList.toggle('is-active', normalized[key] !== DEFAULT_ADJUSTMENTS[key]);
            }
        });

        const activePreset = matchFilterPreset(normalized);
        presetChips.forEach((chip) => {
            chip.classList.toggle('active', chip.dataset.bulkPreset === activePreset);
        });

        const reset = dom('bulk-adjust-reset');
        if (reset) reset.disabled = isNeutralAdjustments(normalized);
    }

    /** Builds the preset chips and the eight sliders straight from the shared
     *  adjustment metadata, so the two tabs can never drift apart. */
    function buildAdjustControls() {
        const presetRow = dom('bulk-preset-row');
        if (presetRow && !presetRow.childElementCount) {
            const chips = [];
            FILTER_PRESET_ORDER.forEach((name) => {
                const chip = document.createElement('button');
                chip.type = 'button';
                chip.className = 'bulk-preset-chip';
                // `data-bulk-preset`, not `data-preset`: the Raster tab already
                // owns the unprefixed attribute and is selected on unscoped.
                chip.dataset.bulkPreset = name;
                chip.textContent = FILTER_PRESET_LABELS[name] || name;
                chip.addEventListener('click', () => {
                    bulkEdit.adjustments = getFilterPreset(name);
                    syncAdjustUI();
                    updatePreview();
                });
                presetRow.appendChild(chip);
                chips.push(chip);
            });
            presetChips = chips;
        }

        const grid = dom('bulk-adjust-grid');
        if (grid && !grid.childElementCount) {
            ADJUSTMENT_KEYS.forEach((key) => {
                const range = ADJUSTMENT_RANGES[key];

                const row = document.createElement('div');
                row.className = 'bulk-adjust-row';

                const label = document.createElement('label');
                label.className = 'bulk-adjust-label';
                label.htmlFor = `bulk-adjust-${key}`;
                label.textContent = range.label;
                label.title = range.hint;

                const slider = document.createElement('input');
                slider.type = 'range';
                slider.id = `bulk-adjust-${key}`;
                slider.className = 'bulk-adjust-slider';
                slider.dataset.bulkAdjust = key;
                slider.min = String(range.min);
                slider.max = String(range.max);
                slider.step = String(range.step);
                slider.value = String(bulkEdit.adjustments[key]);
                slider.title = range.hint;

                const output = document.createElement('output');
                output.className = 'bulk-adjust-value';
                output.dataset.bulkAdjustValue = key;
                output.textContent = String(bulkEdit.adjustments[key]);

                // Dragging only refreshes the downscaled preview; releasing the
                // slider re-runs the (much more expensive) size estimates.
                slider.addEventListener('input', () => {
                    bulkEdit.adjustments[key] = Number(slider.value);
                    syncAdjustUI();
                    schedulePreviewRender();
                });
                slider.addEventListener('change', () => {
                    bulkEdit.adjustments[key] = Number(slider.value);
                    syncAdjustUI();
                    updatePreview();
                });

                row.append(label, slider, output);
                grid.appendChild(row);
                adjustSliders.set(key, slider);
                adjustOutputs.set(key, output);
            });
        }

        syncAdjustUI();
        syncTransformUI();
    }

    function rotateBulkBy(degrees) {
        bulkEdit.rotation = (bulkEdit.rotation + degrees + 360) % 360;
        syncTransformUI();
        updatePreview();
        if (elements.statusText) {
            elements.statusText.textContent = bulkEdit.rotation === 0
                ? 'Batch rotation reset to the original orientation.'
                : `Every image in the batch is rotated to ${bulkEdit.rotation}°.`;
        }
    }

    function toggleBulkFlip(axis) {
        if (axis === 'h') bulkEdit.flipH = !bulkEdit.flipH;
        else bulkEdit.flipV = !bulkEdit.flipV;
        syncTransformUI();
        updatePreview();
        if (elements.statusText) {
            elements.statusText.textContent = axis === 'h'
                ? `Batch horizontal flip ${bulkEdit.flipH ? 'on' : 'off'}.`
                : `Batch vertical flip ${bulkEdit.flipV ? 'on' : 'off'}.`;
        }
    }

    function resetBulkTransform() {
        bulkEdit.rotation = 0;
        bulkEdit.flipH = false;
        bulkEdit.flipV = false;
        syncTransformUI();
        updatePreview();
        if (elements.statusText) elements.statusText.textContent = 'Batch transforms reverted.';
    }

    function resetBulkAdjustments() {
        bulkEdit.adjustments = { ...DEFAULT_ADJUSTMENTS };
        syncAdjustUI();
        updatePreview();
        if (elements.statusText) elements.statusText.textContent = 'Batch colour adjustments reset.';
    }

    // ── Main refresh ────────────────────────────────────────────────────────

    function updatePreview() {
        const preserveAlpha = resolveBulkPreserveAlpha(state.bulk.exportFormat, state.bulk.preserveAlpha);
        const exportNames = buildBulkExportFileNames(state.bulk.files);
        const previewItems = state.bulk.files.map((entry, index) => {
            const target = computeBulkTarget(entry);
            const estimateCacheKey = getBulkEstimateCacheKey(entry, target, state.bulk.exportFormat, preserveAlpha);
            const estimatedBytes = bulkEstimateCache.has(estimateCacheKey)
                ? bulkEstimateCache.get(estimateCacheKey)
                : null;
            return {
                ...entry,
                target,
                estimatedBytes,
                estimateCacheKey,
                exportName: exportNames[index]
            };
        });

        const originalBytes = state.bulk.files.reduce((sum, entry) => sum + entry.size, 0);

        state.bulk.previewItems = previewItems;
        syncSelectedPreviewIndex();
        bulkEstimateJobId += 1;

        if (elements.bulkPreviewCount) elements.bulkPreviewCount.textContent = String(state.bulk.files.length);
        if (elements.bulkPreviewFormat) elements.bulkPreviewFormat.textContent = bulkFormatLabel(state.bulk.exportFormat);
        if (elements.bulkPreviewScale) {
            elements.bulkPreviewScale.textContent = state.bulk.resizeMode === 'fixed'
                ? `${Math.max(1, Math.round(state.bulk.targetWidth))}×${Math.max(1, Math.round(state.bulk.targetHeight))}`
                : `${state.bulk.exportScale}%`;
        }
        elements.bulkFormatTabs.forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.format === state.bulk.exportFormat);
        });
        if (elements.bulkPreserveAlphaCheckbox) elements.bulkPreserveAlphaCheckbox.checked = state.bulk.preserveAlpha;
        if (elements.bulkFolderName) elements.bulkFolderName.textContent = state.bulk.folderName || '—';
        if (elements.bulkFileCount) elements.bulkFileCount.textContent = String(state.bulk.files.length);
        if (elements.bulkSkipCount) elements.bulkSkipCount.textContent = String(state.bulk.skippedCount);
        const skipWrap = document.getElementById('bulk-skip-count-wrap');
        if (skipWrap) skipWrap.classList.toggle('hidden', state.bulk.skippedCount === 0);
        if (elements.bulkOutputNameInput && !state.bulk.outputName) {
            elements.bulkOutputNameInput.placeholder = state.bulk.folderName
                ? `e.g. ${state.bulk.folderName} (saved as name_1.${bulkExtension(state.bulk.exportFormat)})`
                : 'e.g. export (saved as name_1.jpg)';
        }
        if (elements.bulkOriginalTotal) elements.bulkOriginalTotal.textContent = formatBytes(originalBytes);
        updateBulkTotalsDisplay(originalBytes);

        if (elements.bulkFolderSummary) {
            elements.bulkFolderSummary.textContent = state.bulk.folderName
                ? `${state.bulk.files.length} file(s)${state.bulk.skippedCount ? ` · ${state.bulk.skippedCount} skipped` : ''}`
                : '';
        }

        updateBulkAlphaVisibility();
        syncResizeModeUI();
        syncTransformUI();
        syncAdjustUI();
        renderBulkSourceList();
        renderBulkPreviewList();
        renderSelectedPreviewDetails();
        schedulePreviewRender();

        if (elements.bulkDownloadBtn) {
            elements.bulkDownloadBtn.disabled = state.bulk.files.length === 0;
        }

        if (state.bulk.previewItems.length) {
            void hydrateBulkEstimates(bulkEstimateJobId, state.bulk.exportFormat, preserveAlpha);
        }
    }

    async function handleFolderSelection(files) {
        syncWorkspaceView();

        showLoader(true, {
            title: 'Scanning Folder...',
            subtitle: 'Preparing folder scan...'
        });

        try {
            const sortedFiles = getSortedBulkFiles(files);
            const supportedFiles = sortedFiles.filter((file) => isBulkImportableFile(file));
            const skippedUnsupported = sortedFiles.length - supportedFiles.length;
            const supportedTotal = supportedFiles.length;

            showLoader(true, {
                title: 'Scanning Folder...',
                subtitle: supportedTotal
                    ? `0 / ${supportedTotal} supported image(s) analyzed`
                    : 'Checking selected folder contents',
                progress: supportedTotal ? 0 : 1
            });
            elements.statusText.textContent = supportedTotal
                ? `Scanning ${supportedTotal} compatible image(s)...`
                : `Checking selected folder for ${IMPORTABLE_IMAGE_PROMPT}...`;

            let processedCount = 0;
            const loadedEntries = await Promise.all(supportedFiles.map(async (file) => {
                try {
                    const metrics = await loadBulkImageMetrics(file);
                    return {
                        file,
                        name: file.name,
                        relativePath: getBulkRelativePath(file),
                        format: getImageFormat(file.name, null),
                        size: file.size,
                        width: metrics.width,
                        height: metrics.height
                    };
                } catch (error) {
                    console.warn('Skipping unreadable bulk file:', file.name, error);
                    return null;
                } finally {
                    processedCount += 1;
                    showLoader(true, {
                        title: 'Scanning Folder...',
                        subtitle: `${processedCount} / ${supportedTotal} supported image(s) analyzed`,
                        progress: supportedTotal ? processedCount / supportedTotal : 1
                    });
                }
            }));

            const validFiles = loadedEntries.filter(Boolean);
            const invalidCount = loadedEntries.length - validFiles.length;

            state.bulk.folderName = sortedFiles.length ? getBulkFolderName(sortedFiles) : '';
            state.bulk.files = validFiles;
            state.bulk.selectedPreviewIndex = validFiles.length ? 0 : -1;
            state.bulk.skippedCount = skippedUnsupported + invalidCount;

            releasePreviewSource();
            updatePreview();

            if (validFiles.length) {
                elements.statusText.textContent = `Loaded ${validFiles.length} image(s) from ${state.bulk.folderName}.${state.bulk.skippedCount ? ` Skipped ${state.bulk.skippedCount}.` : ''}`;
            } else {
                elements.statusText.textContent = `No compatible images found in selected folder. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`;
            }
        } catch (error) {
            console.error('Bulk folder scan failed:', error);
            state.bulk.folderName = '';
            state.bulk.files = [];
            state.bulk.selectedPreviewIndex = -1;
            state.bulk.skippedCount = 0;
            releasePreviewSource();
            updatePreview();
            elements.statusText.textContent = `Folder scan failed: ${error.message || 'Unexpected error while reading the selected folder.'}`;
        } finally {
            showLoader(false);
        }
    }

    async function saveBulkRaster() {
        if (!state.bulk.files.length) {
            elements.statusText.textContent = 'No folder loaded for bulk export.';
            return;
        }

        state.bulk.keepOriginalNames = elements.bulkKeepNamesCheckbox?.checked
            ?? state.bulk.keepOriginalNames;
        const format = state.bulk.exportFormat;
        const preserveAlpha = resolveBulkPreserveAlpha(format, state.bulk.preserveAlpha);
        const exportNames = buildBulkExportFileNames(state.bulk.files);
        const zipEntries = Object.create(null);
        let processedCount = 0;
        let failedCount = 0;

        try {
            // Fail loudly *before* writing any file rather than shipping a ZIP
            // full of PNG bytes wearing .webp names.
            if (format === 'webp' && !(await probeWebpSupport())) {
                throw new BulkFormatUnsupportedError(
                    'This browser cannot encode WEBP. Pick PNG, JPG, or TGA for this batch.'
                );
            }

            showLoader(true, {
                title: 'Converting Bulk Images...',
                subtitle: `0 / ${state.bulk.files.length} image(s) converted`,
                progress: 0
            });
            if (elements.bulkDownloadBtn) elements.bulkDownloadBtn.disabled = true;

            for (const [index, entry] of state.bulk.files.entries()) {
                elements.statusText.textContent = `Converting ${index + 1}/${state.bulk.files.length}: ${entry.name}`;
                showLoader(true, {
                    title: 'Converting Bulk Images...',
                    subtitle: `${index} / ${state.bulk.files.length} image(s) converted`,
                    progress: state.bulk.files.length ? index / state.bulk.files.length : 0
                });

                try {
                    const { source, cleanup } = await loadBulkImageSource(entry.file);
                    try {
                        const target = computeBulkTarget(entry);
                        const blob = await renderBulkBlob(source, target, format, preserveAlpha);
                        zipEntries[exportNames[index]] = blob;
                        processedCount++;
                    } finally {
                        cleanup();
                    }
                } catch (error) {
                    // A missing encoder is not a per-file problem — stop now.
                    if (error instanceof BulkFormatUnsupportedError) throw error;
                    failedCount++;
                    console.warn('Bulk export skipped file:', entry.name, error);
                }

                showLoader(true, {
                    title: 'Converting Bulk Images...',
                    subtitle: `${index + 1} / ${state.bulk.files.length} image(s) converted`,
                    progress: state.bulk.files.length ? (index + 1) / state.bulk.files.length : 1
                });
            }

            if (!processedCount) {
                throw new Error('No files were successfully converted.');
            }

            elements.statusText.textContent = 'Packaging ZIP archive...';
            showLoader(true, {
                title: 'Packaging ZIP Archive...',
                subtitle: `${processedCount} file(s) ready for download`,
                progress: 1
            });
            const zipBlob = await createZipFile(zipEntries);
            const preservedSingleFileName = state.bulk.keepOriginalNames && state.bulk.files.length === 1
                ? getBulkSourceFileName(state.bulk.files[0])
                : '';
            const rawArchiveName = state.bulk.outputName.trim()
                || preservedSingleFileName
                || state.bulk.folderName
                || 'bulk_export';
            const archiveName = `${sanitizeFileComponent(rawArchiveName, 'bulk_export')}.zip`;
            downloadBlob(zipBlob, archiveName);
            elements.statusText.textContent = `Exported ${processedCount} image(s) to ${archiveName}.${failedCount ? ` Skipped ${failedCount} unreadable file(s).` : ''}`;
        } catch (error) {
            console.error('Bulk export failed:', error);
            elements.statusText.textContent = error.message || 'Failed to export bulk images.';
        } finally {
            showLoader(false);
            if (elements.bulkDownloadBtn) {
                elements.bulkDownloadBtn.disabled = state.bulk.files.length === 0;
            }
        }
    }

    function bindEvents() {
        buildAdjustControls();

        if (elements.bulkFolderInput) {
            elements.bulkFolderInput.setAttribute('accept', BULK_INPUT_ACCEPT);
            elements.bulkFolderInput.addEventListener('change', async (event) => {
                const files = Array.from(event.target.files || []);
                if (files.length) {
                    await handleFolderSelection(files);
                }
                event.target.value = '';
            });
        }

        elements.bulkResizeChips.forEach((chip) => {
            chip.addEventListener('click', () => {
                const scale = parseInt(chip.dataset.scale, 10);
                if (!isNaN(scale)) setExportScale(scale);
            });
        });

        if (elements.applyBulkCustomResizeBtn) {
            elements.applyBulkCustomResizeBtn.addEventListener('click', () => {
                const val = parseInt(elements.bulkResizeCustomInput.value, 10);
                if (!isNaN(val)) setExportScale(val);
            });
        }

        if (elements.bulkResizeModeTabs) {
            elements.bulkResizeModeTabs.forEach((tab) => {
                tab.addEventListener('click', () => {
                    setResizeMode(tab.dataset.mode);
                });
            });
        }

        if (elements.applyBulkFixedSizeBtn) {
            elements.applyBulkFixedSizeBtn.addEventListener('click', () => {
                const w = parseInt(elements.bulkTargetWidthInput?.value, 10);
                const h = parseInt(elements.bulkTargetHeightInput?.value, 10);
                if (!isNaN(w) && w > 0) state.bulk.targetWidth = Math.min(16384, w);
                if (!isNaN(h) && h > 0) state.bulk.targetHeight = Math.min(16384, h);
                updatePreview();
            });
        }

        if (elements.bulkFitModeSelect) {
            elements.bulkFitModeSelect.addEventListener('change', () => {
                state.bulk.fitMode = elements.bulkFitModeSelect.value;
                updatePreview();
            });
        }

        if (elements.bulkKeepNamesCheckbox) {
            elements.bulkKeepNamesCheckbox.checked = state.bulk.keepOriginalNames;
            elements.bulkKeepNamesCheckbox.addEventListener('change', () => {
                state.bulk.keepOriginalNames = elements.bulkKeepNamesCheckbox.checked;
                updatePreview();
            });
        }

        elements.bulkFormatTabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                state.bulk.exportFormat = tab.dataset.format;
                updatePreview();
                if (tab.dataset.format === 'webp') {
                    void probeWebpSupport().then((supported) => {
                        if (!supported && elements.statusText && state.bulk.exportFormat === 'webp') {
                            elements.statusText.textContent = 'This browser cannot encode WEBP. Pick PNG, JPG, or TGA before downloading.';
                        }
                    });
                }
            });
        });

        dom('bulk-rotate-ccw')?.addEventListener('click', () => rotateBulkBy(-90));
        dom('bulk-rotate-cw')?.addEventListener('click', () => rotateBulkBy(90));
        dom('bulk-flip-h')?.addEventListener('click', () => toggleBulkFlip('h'));
        dom('bulk-flip-v')?.addEventListener('click', () => toggleBulkFlip('v'));
        dom('bulk-transform-reset')?.addEventListener('click', resetBulkTransform);
        dom('bulk-adjust-reset')?.addEventListener('click', resetBulkAdjustments);

        if (elements.bulkOutputNameInput) {
            elements.bulkOutputNameInput.addEventListener('input', () => {
                state.bulk.outputName = elements.bulkOutputNameInput.value;
                updatePreview();
            });
        }

        if (elements.bulkPreserveAlphaCheckbox) {
            elements.bulkPreserveAlphaCheckbox.checked = state.bulk.preserveAlpha;
            elements.bulkPreserveAlphaCheckbox.addEventListener('change', () => {
                state.bulk.preserveAlpha = elements.bulkPreserveAlphaCheckbox.checked;
                updatePreview();
            });
        }

        if (elements.bulkDownloadBtn) {
            elements.bulkDownloadBtn.addEventListener('click', saveBulkRaster);
        }
    }

    function onTabActivated() {
        buildAdjustControls();
        updatePreview();
    }

    return {
        bindEvents,
        onTabActivated,
        setExportScale,
        updatePreview,
        handleFolderSelection,
        saveBulkRaster
    };
}
