import {
    estimateRasterBlobSizeFromSource,
    estimateSizeBytes,
    formatBytes,
    getFormatLabel,
    getPreserveAlphaForFormat,
    getRasterExtension,
    getScaledDimensions,
    renderRasterBlobFromSource
} from '../raster-utils.js';

export function createRasterTabController({
    state,
    elements,
    downloadBlob,
    getImageBaseName,
    hasSingleImageLoaded
}) {
    const channelDataCache = {
        red: null,
        green: null,
        blue: null,
        alpha: null,
        width: 0,
        height: 0
    };
    const sizeEstimateCache = new Map();
    let sizeEstimateRequestId = 0;

    function getEstimateCacheKey(targetDims, format, preserveAlpha) {
        const sourceKey = [
            state.originalImageUrl || 'image',
            state.originalImageSize || 0,
            elements.sourceImage?.naturalWidth || 0,
            elements.sourceImage?.naturalHeight || 0,
            targetDims?.width || 0,
            targetDims?.height || 0,
            format,
            preserveAlpha ? 1 : 0
        ];
        return sourceKey.join('|');
    }

    async function getAccurateEstimate(targetDims, format, preserveAlpha) {
        const cacheKey = getEstimateCacheKey(targetDims, format, preserveAlpha);
        if (sizeEstimateCache.has(cacheKey)) {
            return sizeEstimateCache.get(cacheKey);
        }

        const bytes = await estimateRasterBlobSizeFromSource(elements.sourceImage, targetDims, format, preserveAlpha);
        sizeEstimateCache.set(cacheKey, bytes);
        return bytes;
    }

    function getBaseDimensions() {
        if (state.tracedata?.width && state.tracedata?.height) {
            return { width: state.tracedata.width, height: state.tracedata.height };
        }
        if (elements.sourceImage?.naturalWidth && elements.sourceImage?.naturalHeight) {
            return { width: elements.sourceImage.naturalWidth, height: elements.sourceImage.naturalHeight };
        }
        return null;
    }

    function updateSizeEstimates(targetDims) {
        if (!elements.sizeEstPng || !elements.sizeEstJpg || !elements.sizeEstTga) return;
        if (!targetDims) {
            elements.sizeEstPng.textContent = '—';
            elements.sizeEstJpg.textContent = '—';
            elements.sizeEstTga.textContent = '—';
            return;
        }

        if (!elements.sourceImage?.complete || !elements.sourceImage?.naturalWidth) {
            elements.sizeEstPng.textContent = '—';
            elements.sizeEstJpg.textContent = '—';
            elements.sizeEstTga.textContent = '—';
            return;
        }

        const alpha = !!state.preserveAlpha;
        const estimateConfigs = [
            { element: elements.sizeEstPng, format: 'png', preserveAlpha: alpha },
            { element: elements.sizeEstJpg, format: 'jpg', preserveAlpha: false },
            { element: elements.sizeEstTga, format: 'tga', preserveAlpha: alpha }
        ];

        const requestId = ++sizeEstimateRequestId;

        estimateConfigs.forEach((config) => {
            const cacheKey = getEstimateCacheKey(targetDims, config.format, config.preserveAlpha);
            if (sizeEstimateCache.has(cacheKey)) {
                config.element.textContent = formatBytes(sizeEstimateCache.get(cacheKey));
            } else {
                config.element.textContent = 'Estimating...';
            }
        });

        void Promise.all(estimateConfigs.map(async (config) => {
            try {
                const bytes = await getAccurateEstimate(targetDims, config.format, config.preserveAlpha);
                return { ...config, bytes };
            } catch (error) {
                console.warn(`Falling back to approximate ${getFormatLabel(config.format)} estimate.`, error);
                return {
                    ...config,
                    bytes: estimateSizeBytes(targetDims.width, targetDims.height, config.format, config.preserveAlpha)
                };
            }
        })).then((results) => {
            if (requestId !== sizeEstimateRequestId) return;
            results.forEach(({ element, bytes }) => {
                element.textContent = formatBytes(bytes);
            });
        });
    }

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

        const exportScaleDisplay = document.getElementById('export-scale-display');
        if (exportScaleDisplay) {
            exportScaleDisplay.textContent = `(${state.exportScale}%)`;
        }

        const originalDims = document.getElementById('original-dims');
        if (originalDims) {
            originalDims.textContent = `${dims.width}×${dims.height}`;
        }

        const originalAspect = document.getElementById('original-aspect');
        if (originalAspect) {
            const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
            const divisor = gcd(dims.width, dims.height);
            originalAspect.textContent = `${dims.width / divisor}:${dims.height / divisor}`;
        }

        const originalFormat = document.getElementById('original-format');
        if (originalFormat) {
            originalFormat.textContent = state.originalImageFormat || '—';
        }

        const originalFileSize = document.getElementById('original-file-size');
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

    function renderRGBAChannels() {
        const sourceImage = elements.sourceImage;
        if (!sourceImage || !sourceImage.complete || !sourceImage.naturalWidth) return;

        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = sourceImage.naturalWidth;
        tempCanvas.height = sourceImage.naturalHeight;
        tempCtx.drawImage(sourceImage, 0, 0);

        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;

        channelDataCache.width = tempCanvas.width;
        channelDataCache.height = tempCanvas.height;

        ['red', 'green', 'blue', 'alpha'].forEach((channel) => {
            const channelData = tempCtx.createImageData(tempCanvas.width, tempCanvas.height);

            for (let i = 0; i < data.length; i += 4) {
                let value = data[i];
                if (channel === 'green') value = data[i + 1];
                if (channel === 'blue') value = data[i + 2];
                if (channel === 'alpha') value = data[i + 3];

                channelData.data[i] = value;
                channelData.data[i + 1] = value;
                channelData.data[i + 2] = value;
                channelData.data[i + 3] = 255;
            }

            channelDataCache[channel] = channelData;
        });

        displayChannel('red');
    }

    function displayChannel(channel) {
        const canvas = document.getElementById('rgba-preview-canvas');
        if (!canvas || !channelDataCache[channel]) return;

        canvas.width = channelDataCache.width;
        canvas.height = channelDataCache.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(channelDataCache[channel], 0, 0);
    }

    async function saveRaster(type = 'png') {
        if (!elements.sourceImage || !hasSingleImageLoaded()) {
            elements.statusText.textContent = 'No image loaded.';
            return;
        }

        const dims = getBaseDimensions();
        if (!dims) return;

        const target = getScaledDimensions(dims, state.exportScale);
        const preserveAlpha = getPreserveAlphaForFormat(type, state.preserveAlpha);

        try {
            const blob = await renderRasterBlobFromSource(elements.sourceImage, target, type, preserveAlpha);
            downloadBlob(blob, `${getImageBaseName()}_${target.width}x${target.height}.${getRasterExtension(type)}`);
            elements.statusText.textContent = `Saved ${getFormatLabel(type)} at ${target.width}×${target.height}.${type === 'tga' && preserveAlpha ? ' Includes alpha.' : ''}`;
        } catch (error) {
            console.error('Raster export failed:', error);
            elements.statusText.textContent = 'Failed to export image.';
        }
    }

    function syncRasterEmptyState() {
        const emptyState = document.getElementById('raster-empty-state');
        const content = document.getElementById('raster-content');
        const hasImage = hasSingleImageLoaded();
        if (emptyState) emptyState.classList.toggle('hidden', hasImage);
        if (content) content.classList.toggle('hidden', !hasImage);
    }

    function onSourceImageLoaded() {
        if (elements.saveResizedPngBtn) elements.saveResizedPngBtn.disabled = false;
        if (elements.saveResizedJpgBtn) elements.saveResizedJpgBtn.disabled = false;
        if (elements.saveResizedTgaBtn) elements.saveResizedTgaBtn.disabled = false;
        syncRasterEmptyState();
        renderRGBAChannels();
        updateExportScaleDisplay();
    }

    function onTabActivated() {
        syncRasterEmptyState();
        if (hasSingleImageLoaded()) renderRGBAChannels();
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

        const channelTabs = document.querySelectorAll('.rgba-channel-tab');
        channelTabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                const channel = tab.dataset.channel;
                channelTabs.forEach(t => t.classList.remove('active'));
                tab.classList.add('active');
                displayChannel(channel);
            });
        });

        const preserveAlphaPng = document.getElementById('preserve-alpha-png');
        const preserveAlphaTga = document.getElementById('preserve-alpha-tga');

        if (preserveAlphaPng) {
            preserveAlphaPng.checked = state.preserveAlpha;
            preserveAlphaPng.addEventListener('change', () => {
                state.preserveAlpha = preserveAlphaPng.checked || preserveAlphaTga?.checked;
                updateExportScaleDisplay();
            });
        }

        if (preserveAlphaTga) {
            preserveAlphaTga.checked = state.preserveAlpha;
            preserveAlphaTga.addEventListener('change', () => {
                state.preserveAlpha = preserveAlphaTga.checked || preserveAlphaPng?.checked;
                updateExportScaleDisplay();
            });
        }

    }

    return {
        bindEvents,
        onSourceImageLoaded,
        onTabActivated,
        setExportScale,
        updateExportScaleDisplay
    };
}
