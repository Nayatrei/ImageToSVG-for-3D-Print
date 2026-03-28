import { SLIDER_TOOLTIPS, TRANSPARENT_ALPHA_CUTOFF } from '../config.js';
import { createObjPreview } from '../preview3d.js';
import { createObjExporter } from '../export3d.js';
import { drawImageToCanvas } from '../raster-utils.js';

export function createSvgTabController({
    state,
    elements,
    showLoader,
    syncWorkspaceView,
    hasSingleImageLoaded,
    updateSegmentedControlIndicator,
    downloadBlob,
    downloadSVG,
    getImageBaseName,
    onRasterImageLoaded,
    onRasterExportStateChanged
}) {
    const tracer = window.ImageTracer;

    function saveInitialSliderValues() {
        state.initialSliderValues = {
            pathSimplification: elements.pathSimplificationSlider.value,
            cornerSharpness: elements.cornerSharpnessSlider.value,
            curveStraightness: elements.curveStraightnessSlider.value,
            colorPrecision: elements.colorPrecisionSlider.value,
            maxColors: elements.maxColorsSlider ? elements.maxColorsSlider.value : '4'
        };
        state.isDirty = false;
        elements.resetBtn.style.display = 'none';
    }

    function updateAllSliderDisplays() {
        elements.pathSimplificationValue.textContent = elements.pathSimplificationSlider.value;
        elements.cornerSharpnessValue.textContent = elements.cornerSharpnessSlider.value;
        elements.curveStraightnessValue.textContent = elements.curveStraightnessSlider.value;
        elements.colorPrecisionValue.textContent = elements.colorPrecisionSlider.value;
        if (elements.maxColorsValue && elements.maxColorsSlider) {
            elements.maxColorsValue.textContent = elements.maxColorsSlider.value;
        }
        if (elements.objThicknessValue && elements.objThicknessSlider) {
            elements.objThicknessValue.textContent = elements.objThicknessSlider.value;
        }
        if (elements.objDetailValue && elements.objDetailSlider) {
            elements.objDetailValue.textContent = elements.objDetailSlider.value;
        }
    }

    function setAvailableLayersVisible(show) {
        state.showAvailableLayers = show;
        if (elements.availableLayersContent) {
            elements.availableLayersContent.style.display = show ? 'block' : 'none';
        }
        if (elements.toggleAvailableLayersBtn) {
            elements.toggleAvailableLayersBtn.textContent = show ? 'Hide' : 'Show';
        }
    }

    function setFinalPaletteVisible(show) {
        state.showFinalPalette = show;
        if (elements.finalPaletteContent) {
            elements.finalPaletteContent.style.display = show ? 'block' : 'none';
        }
        if (elements.toggleFinalPaletteBtn) {
            elements.toggleFinalPaletteBtn.textContent = show ? 'Hide' : 'Show';
        }
    }

    function resetSlidersToInitial() {
        if (!state.initialSliderValues) return;

        elements.pathSimplificationSlider.value = state.initialSliderValues.pathSimplification;
        elements.cornerSharpnessSlider.value = state.initialSliderValues.cornerSharpness;
        elements.curveStraightnessSlider.value = state.initialSliderValues.curveStraightness;
        elements.colorPrecisionSlider.value = state.initialSliderValues.colorPrecision;
        if (elements.maxColorsSlider) {
            elements.maxColorsSlider.value = state.initialSliderValues.maxColors;
        }

        updateAllSliderDisplays();

        if (elements.sourceImage.src) {
            state.colorsAnalyzed = false;
            if (elements.optimizePathsBtn) elements.optimizePathsBtn.disabled = true;
            elements.analyzeColorsBtn.click();
        }

        state.isDirty = false;
        elements.resetBtn.style.display = 'none';
    }

    const debounce = (fn, ms = 250) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn(...args), ms);
        };
    };

    const debounceOptimizePaths = debounce(() => {
        if (state.colorsAnalyzed) {
            optimizePathsClick();
        }
    });

    function hasTransparentPixels(imageData) {
        const data = imageData.data;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] <= TRANSPARENT_ALPHA_CUTOFF) return true;
        }
        return false;
    }

    function markTransparentPixels(quantizedData, imageData) {
        const width = imageData.width;
        const height = imageData.height;
        const data = imageData.data;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const alpha = data[idx + 3];
                if (alpha <= TRANSPARENT_ALPHA_CUTOFF) {
                    quantizedData.array[y + 1][x + 1] = -1;
                }
            }
        }
    }

    function stripTransparentPalette(quantizedData) {
        if (!quantizedData || !Array.isArray(quantizedData.palette) || !Array.isArray(quantizedData.array)) {
            return false;
        }

        const mapping = new Array(quantizedData.palette.length).fill(-1);
        const newPalette = [];

        quantizedData.palette.forEach((color, index) => {
            const alpha = Number.isFinite(color.a) ? color.a : 255;
            if (alpha <= TRANSPARENT_ALPHA_CUTOFF) {
                mapping[index] = -1;
            } else {
                mapping[index] = newPalette.length;
                newPalette.push({ r: color.r, g: color.g, b: color.b, a: 255 });
            }
        });

        if (newPalette.length === quantizedData.palette.length) return false;

        for (let y = 0; y < quantizedData.array.length; y++) {
            const row = quantizedData.array[y];
            for (let x = 0; x < row.length; x++) {
                const idx = row[x];
                if (idx >= 0) {
                    row[x] = mapping[idx];
                }
            }
        }

        quantizedData.palette = newPalette;
        return true;
    }

    async function analyzeColorsClick() {
        state.layerThicknesses = null;
        await analyzeColors();
        state.colorsAnalyzed = true;
        await optimizePathsClick();
    }

    async function optimizePathsClick() {
        if (!state.quantizedData) return;
        await traceVectorPaths();
    }

    function setHighFidelity(enabled) {
        state.highFidelity = !!enabled;
        if (elements.toggleFidelityBtn) {
            elements.toggleFidelityBtn.textContent = state.highFidelity ? 'Mode: High Fidelity' : 'Mode: Logo';
            elements.toggleFidelityBtn.classList.toggle('btn-primary', state.highFidelity);
            elements.toggleFidelityBtn.classList.toggle('btn-secondary', !state.highFidelity);
        }
        if (elements.maxColorsSlider) {
            elements.maxColorsSlider.value = state.highFidelity ? '8' : '4';
            if (!state.isDirty) {
                state.isDirty = true;
                elements.resetBtn.style.display = 'inline';
            }
            updateAllSliderDisplays();
        }
    }

    function buildOptimizedOptions() {
        const P = parseInt(elements.pathSimplificationSlider.value, 10);
        const C = parseInt(elements.cornerSharpnessSlider.value, 10);
        const S = parseInt(elements.curveStraightnessSlider.value, 10);
        const CP = parseInt(elements.colorPrecisionSlider.value, 10);
        const MC = elements.maxColorsSlider ? parseInt(elements.maxColorsSlider.value, 10) : 4;

        const map = (t, a, b) => (a + (b - a) * (t / 100));
        const mapInv = (t, a, b) => (a + (b - a) * (1 - (t / 100)));

        const options = Object.assign({}, tracer.optionpresets.default, {
            viewbox: true,
            strokewidth: 0
        });

        if (state.highFidelity) {
            const rel = Math.max(0.5, Math.sqrt(elements.sourceImage.naturalWidth * elements.sourceImage.naturalHeight) / 512);
            const detailScale = Math.min(rel, 1.0);
            options.pathomit = Math.round(map(P, 0, 6) * detailScale);
            options.roundcoords = Math.round(map(P, 1, 2));
            options.blurradius = +map(P, 0, 0.8).toFixed(1);
            options.qtres = +mapInv(C, 2.5, 0.15).toFixed(2);
            options.ltres = +map(S, 0.15, 6.0).toFixed(2);
            options.colorsampling = 2;
            options.colorquantcycles = Math.max(1, Math.round(map(CP, 4, 12)));
        } else {
            options.pathomit = Math.round(map(P, 0, 5));
            options.roundcoords = Math.round(map(P, 1, 2));
            options.blurradius = +map(P, 0, 0.6).toFixed(1);
            options.qtres = +mapInv(C, 0.8, 0.05).toFixed(2);
            options.ltres = +map(S, 0.05, 1.0).toFixed(2);
            options.colorsampling = 1;
            options.colorquantcycles = Math.max(15, Math.round(map(CP, 10, 25)));
        }

        options.rightangleenhance = (C >= 50);
        options.mincolorratio = +mapInv(CP, 0.03, 0.0).toFixed(3);
        options.numberofcolors = Math.max(4, Math.min(20, 4 + Math.round(CP * 0.16)));
        if (!Number.isNaN(MC)) {
            options.numberofcolors = Math.max(2, Math.min(options.numberofcolors, MC));
        }

        return options;
    }

    async function analyzeColors() {
        showLoader(true);
        elements.statusText.textContent = 'Analyzing colors...';
        disableDownloadButtons();

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const width = elements.sourceImage.naturalWidth;
                    const height = elements.sourceImage.naturalHeight;
                    if (!width || !height) throw new Error('Invalid image dimensions');

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(elements.sourceImage, 0, 0, width, height);
                    const imageData = ctx.getImageData(0, 0, width, height);

                    const options = buildOptimizedOptions();
                    const MC = elements.maxColorsSlider ? parseInt(elements.maxColorsSlider.value, 10) : 4;
                    const dominantColorCount = estimateDominantColors(imageData);
                    if (dominantColorCount && dominantColorCount > MC) {
                        options.numberofcolors = Math.min(options.numberofcolors, dominantColorCount);
                    }
                    options.numberofcolors = Math.max(MC, options.numberofcolors);
                    state.lastOptions = options;

                    state.quantizedData = tracer.colorquantization(imageData, options);

                    if (!state.quantizedData || !state.quantizedData.palette) {
                        throw new Error('Color analysis failed.');
                    }

                    if (hasTransparentPixels(imageData)) {
                        markTransparentPixels(state.quantizedData, imageData);
                        stripTransparentPalette(state.quantizedData);
                    } else {
                        state.quantizedData.palette.forEach((color) => {
                            color.a = 255;
                        });
                    }

                    if (!state.quantizedData.palette.length) {
                        throw new Error('No opaque pixels found.');
                    }

                    resolve();
                } catch (error) {
                    console.error('Color analysis error:', error);
                    elements.statusText.textContent = `Error: ${error.message}`;
                    reject(error);
                } finally {
                    showLoader(false);
                }
            }, 50);
        });
    }

    function estimateDominantColors(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        if (!width || !height) return null;

        const data = imageData.data;
        const maxSamples = 4096;
        const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
        const counts = new Map();
        let samples = 0;

        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const idx = (y * width + x) * 4;
                const a = data[idx + 3];
                if (a <= TRANSPARENT_ALPHA_CUTOFF) continue;
                const r = data[idx] >> 3;
                const g = data[idx + 1] >> 3;
                const b = data[idx + 2] >> 3;
                const key = (r << 10) | (g << 5) | b;
                counts.set(key, (counts.get(key) || 0) + 1);
                samples++;
            }
        }

        if (!samples) return null;

        const bucketsAll = Array.from(counts.values()).sort((a, b) => b - a);
        const minBucketRatio = state.highFidelity ? 0.003 : 0.006;
        const minBucketCount = Math.max(2, Math.round(samples * minBucketRatio));
        const buckets = bucketsAll.filter(count => count >= minBucketCount);
        const selectedBuckets = buckets.length ? buckets : bucketsAll;
        const total = selectedBuckets.reduce((sum, count) => sum + count, 0);
        const targetCoverage = state.highFidelity ? 0.992 : 0.985;
        let cumulative = 0;
        let colorCount = 0;

        for (const count of selectedBuckets) {
            cumulative += count;
            colorCount++;
            if (cumulative / total >= targetCoverage) break;
        }

        return Math.max(1, Math.min(colorCount, selectedBuckets.length));
    }

    function updateColorCountNotice() {
        if (!elements.colorCountNotice || !elements.sourceImage.src) {
            return;
        }

        const maxColors = elements.maxColorsSlider ? parseInt(elements.maxColorsSlider.value, 10) : 4;
        const canvas = document.createElement('canvas');
        const w = elements.sourceImage.naturalWidth;
        const h = elements.sourceImage.naturalHeight;
        if (!w || !h) {
            elements.colorCountNotice.style.display = 'none';
            return;
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(elements.sourceImage, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);

        const estimatedColors = estimateDominantColors(imageData);
        state.estimatedColorCount = estimatedColors;

        if (estimatedColors && estimatedColors > maxColors) {
            elements.colorCountNotice.innerHTML =
                `Image has ~${estimatedColors} distinct colors. Consider increasing Max Colors to ${Math.min(estimatedColors, 8)} for better accuracy. ` +
                `<em style="opacity: 0.8">(3D printers may have filament limits)</em>`;
            elements.colorCountNotice.style.display = 'block';
        } else {
            elements.colorCountNotice.style.display = 'none';
        }
    }

    function getVisibleLayerIndices() {
        if (!state.tracedata) return [];

        const indices = [];
        for (let i = 0; i < state.tracedata.layers.length; i++) {
            if (layerHasPaths(state.tracedata.layers[i])) {
                indices.push(i);
            }
        }
        return indices;
    }

    function layerHasPaths(layer) {
        return Array.isArray(layer) && layer.length > 0;
    }

    function buildTracedataSubset(source, indices) {
        if (!source) return null;
        const layers = [];
        const palette = [];
        indices.forEach((idx) => {
            if (source.layers[idx] && source.palette[idx]) {
                layers.push(JSON.parse(JSON.stringify(source.layers[idx])));
                palette.push(source.palette[idx]);
            }
        });
        return { ...source, layers, palette };
    }

    function createMergedTracedata(sourceData, visibleIndices, rules) {
        if (!sourceData || !visibleIndices || !rules) return sourceData;

        const finalTargets = {};
        visibleIndices.forEach((_, ruleIndex) => {
            finalTargets[ruleIndex] = ruleIndex;
        });

        rules.forEach((rule) => {
            let ultimateTarget = rule.target;
            while (finalTargets[ultimateTarget] !== ultimateTarget) {
                ultimateTarget = finalTargets[ultimateTarget];
            }
            finalTargets[rule.source] = ultimateTarget;
        });

        Object.keys(finalTargets).forEach((key) => {
            let current = parseInt(key, 10);
            while (finalTargets[current] !== current) {
                current = finalTargets[current];
            }
            finalTargets[key] = current;
        });

        const groups = {};
        visibleIndices.forEach((originalIndex, ruleIndex) => {
            const finalTargetRuleIndex = finalTargets[ruleIndex];
            if (!groups[finalTargetRuleIndex]) {
                groups[finalTargetRuleIndex] = [];
            }
            groups[finalTargetRuleIndex].push(originalIndex);
        });

        const newPalette = [];
        const newLayers = [];
        Object.keys(groups).map(Number).sort((a, b) => a - b).forEach((targetRuleIndex) => {
            const originalIndicesInGroup = groups[targetRuleIndex];
            const representativeOriginalIndex = visibleIndices[targetRuleIndex];

            newPalette.push(sourceData.palette[representativeOriginalIndex]);

            let mergedPaths = [];
            originalIndicesInGroup.forEach((originalIndex) => {
                if (sourceData.layers[originalIndex]) {
                    mergedPaths = mergedPaths.concat(sourceData.layers[originalIndex]);
                }
            });
            newLayers.push(mergedPaths);
        });

        return { ...sourceData, palette: newPalette, layers: newLayers };
    }

    function getDataToExport() {
        if (!state.tracedata) return null;
        const visibleIndices = getVisibleLayerIndices();
        if (!visibleIndices.length) return null;
        if (state.mergeRules && state.mergeRules.length > 0) {
            return createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
        }
        return buildTracedataSubset(state.tracedata, visibleIndices);
    }

    function createSolidSilhouette(tracedata) {
        if (!tracedata) return null;
        const visibleIndices = getVisibleLayerIndices();
        if (!visibleIndices.length) return null;
        const subset = buildTracedataSubset(tracedata, visibleIndices);
        let mergedPaths = [];
        subset.layers.forEach((layer) => {
            if (Array.isArray(layer)) mergedPaths = mergedPaths.concat(layer);
        });
        return {
            width: subset.width,
            height: subset.height,
            layers: [mergedPaths],
            palette: [{ r: 0, g: 0, b: 0, a: 255 }]
        };
    }

    function assess3DPrintQuality(tracedata) {
        if (!tracedata) return { pathCount: 0, colorCount: 0 };
        const totalPaths = tracedata.layers.reduce((sum, layer) => sum + (Array.isArray(layer) ? layer.length : 0), 0);
        const visibleColors = getVisibleLayerIndices().length;
        return { pathCount: totalPaths, colorCount: visibleColors };
    }

    function updateQualityDisplay(quality) {
        if (elements.qualityIndicator) {
            elements.qualityIndicator.textContent = `${quality.pathCount} paths, ${quality.colorCount} colors`;
        }
    }

    const objPreview = createObjPreview({
        state,
        elements,
        getDataToExport,
        getVisibleLayerIndices,
        ImageTracer: tracer
    });

    const objExporter = createObjExporter({
        state,
        elements,
        getDataToExport,
        ImageTracer: tracer,
        showLoader,
        downloadBlob,
        getImageBaseName
    });

    async function traceVectorPaths() {
        if (!state.quantizedData) return;
        showLoader(true);
        elements.statusText.textContent = 'Tracing vector paths...';
        if (elements.optimizePathsBtn) elements.optimizePathsBtn.disabled = true;

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const options = buildOptimizedOptions();
                    state.lastOptions = options;

                    const ii = state.quantizedData;
                    const tracedata = {
                        layers: [],
                        palette: ii.palette,
                        width: ii.array[0].length - 2,
                        height: ii.array.length - 2
                    };

                    for (let colornum = 0; colornum < ii.palette.length; colornum++) {
                        const tracedlayer = tracer.batchtracepaths(
                            tracer.internodes(
                                tracer.pathscan(
                                    tracer.layeringstep(ii, colornum),
                                    options.pathomit
                                ),
                                options
                            ),
                            options.ltres,
                            options.qtres
                        );
                        tracedata.layers.push(tracedlayer);
                    }

                    state.tracedata = tracedata;
                    state.silhouetteTracedata = createSolidSilhouette(state.tracedata);

                    displayPalette();
                    prepareMergeUIAfterGeneration();

                    elements.outputSection.style.display = 'flex';
                    setTimeout(() => updateSegmentedControlIndicator(), 100);

                    await renderPreviews();
                    await updateFilteredPreview();

                    const quality = assess3DPrintQuality(state.tracedata);
                    updateQualityDisplay(quality);
                    elements.statusText.textContent = 'Preview generated!';
                    enableDownloadButtons();
                    onRasterExportStateChanged();
                    resolve();
                } catch (error) {
                    console.error('Tracing error:', error);
                    elements.statusText.textContent = `Error: ${error.message}`;
                    reject(error);
                } finally {
                    showLoader(false);
                    if (elements.optimizePathsBtn) elements.optimizePathsBtn.disabled = false;
                }
            }, 50);
        });
    }

    function setupZoomControls() {
        const zoomInAll = document.getElementById('zoom-in-all');
        const zoomOutAll = document.getElementById('zoom-out-all');
        const zoomResetAll = document.getElementById('zoom-reset-all');
        const zoomInSelected = document.getElementById('zoom-in-selected');
        const zoomOutSelected = document.getElementById('zoom-out-selected');
        const zoomResetSelected = document.getElementById('zoom-reset-selected');

        if (zoomInAll) zoomInAll.addEventListener('click', () => zoomPreview('all', 1.25));
        if (zoomOutAll) zoomOutAll.addEventListener('click', () => zoomPreview('all', 0.8));
        if (zoomResetAll) zoomResetAll.addEventListener('click', () => resetZoom('all'));

        if (zoomInSelected) zoomInSelected.addEventListener('click', () => zoomPreview('selected', 1.25));
        if (zoomOutSelected) zoomOutSelected.addEventListener('click', () => zoomPreview('selected', 0.8));
        if (zoomResetSelected) zoomResetSelected.addEventListener('click', () => resetZoom('selected'));

        setupPanControls('all');
        setupPanControls('selected');

        updateZoomDisplay('all');
        updateZoomDisplay('selected');
    }

    function zoomPreview(type, factor) {
        const zoomState = state.zoom[type];
        const newScale = Math.max(0.1, Math.min(5, zoomState.scale * factor));
        zoomState.scale = newScale;
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }

    function resetZoom(type) {
        const zoomState = state.zoom[type];
        zoomState.scale = 1;
        zoomState.x = 0;
        zoomState.y = 0;
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }

    function updatePreviewTransform(type) {
        const container = document.querySelector(`[data-preview="${type}"]`);
        if (!container) return;
        const content = container.querySelector('.preview-content');
        if (!content) return;
        const zoomState = state.zoom[type];

        content.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;

        if (zoomState.scale > 1) {
            container.classList.add('zoomed');
        } else {
            container.classList.remove('zoomed');
        }
    }

    function updateZoomDisplay(type) {
        const zoomLevel = Math.round(state.zoom[type].scale * 100);
        const resetButton = document.getElementById(`zoom-reset-${type}`);
        if (resetButton) {
            resetButton.textContent = `${zoomLevel}%`;
        }

        const zoomInBtn = document.getElementById(`zoom-in-${type}`);
        const zoomOutBtn = document.getElementById(`zoom-out-${type}`);

        if (zoomInBtn) zoomInBtn.disabled = state.zoom[type].scale >= 5;
        if (zoomOutBtn) zoomOutBtn.disabled = state.zoom[type].scale <= 0.1;
    }

    function setupPanControls(type) {
        const container = document.querySelector(`[data-preview="${type}"]`);
        if (!container) return;
        const content = container.querySelector('.preview-content');
        if (!content) return;
        let startX;
        let startY;
        let initialX;
        let initialY;

        content.addEventListener('mousedown', (e) => {
            if (state.zoom[type].scale <= 1) return;

            e.preventDefault();
            state.zoom[type].isDragging = true;
            container.classList.add('dragging');

            startX = e.clientX;
            startY = e.clientY;
            initialX = state.zoom[type].x;
            initialY = state.zoom[type].y;
        });

        document.addEventListener('mousemove', (e) => {
            if (!state.zoom[type].isDragging) return;

            e.preventDefault();
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            state.zoom[type].x = initialX + deltaX;
            state.zoom[type].y = initialY + deltaY;
            updatePreviewTransform(type);
        });

        document.addEventListener('mouseup', () => {
            if (state.zoom[type].isDragging) {
                state.zoom[type].isDragging = false;
                container.classList.remove('dragging');
            }
        });

        content.addEventListener('touchstart', (e) => {
            if (state.zoom[type].scale <= 1) return;

            e.preventDefault();
            state.zoom[type].isDragging = true;
            container.classList.add('dragging');

            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            initialX = state.zoom[type].x;
            initialY = state.zoom[type].y;
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (!state.zoom[type].isDragging) return;

            e.preventDefault();
            const touch = e.touches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            state.zoom[type].x = initialX + deltaX;
            state.zoom[type].y = initialY + deltaY;
            updatePreviewTransform(type);
        }, { passive: false });

        document.addEventListener('touchend', () => {
            if (state.zoom[type].isDragging) {
                state.zoom[type].isDragging = false;
                container.classList.remove('dragging');
            }
        });

        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            zoomPreview(type, factor);
        });
    }

    function svgToPng(svgString, maxSize = null, fixedSize = null, preserveAlpha = false) {
        return new Promise((resolve, reject) => {
            const selectedRes = maxSize || parseInt(elements.previewResolution?.value || '512', 10);
            const maxWidth = selectedRes;
            const maxHeight = selectedRes;

            const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(svgBlob);
            const img = new Image();

            img.onload = () => {
                try {
                    let width;
                    let height;
                    if (fixedSize && fixedSize.width && fixedSize.height) {
                        width = fixedSize.width;
                        height = fixedSize.height;
                    } else {
                        width = img.width || img.naturalWidth;
                        height = img.height || img.naturalHeight;
                        const aspectRatio = width / height;

                        if (width > height) {
                            if (width < maxWidth) {
                                width = maxWidth;
                                height = width / aspectRatio;
                            }
                            if (width > maxWidth) {
                                width = maxWidth;
                                height = width / aspectRatio;
                            }
                        } else {
                            if (height < maxHeight) {
                                height = maxHeight;
                                width = height * aspectRatio;
                            }
                            if (height > maxHeight) {
                                height = maxHeight;
                                width = height * aspectRatio;
                            }
                        }
                    }

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;

                    const ctx = canvas.getContext('2d', { alpha: true });
                    if (!preserveAlpha) {
                        ctx.fillStyle = 'white';
                        ctx.fillRect(0, 0, width, height);
                    } else {
                        ctx.clearRect(0, 0, width, height);
                    }
                    ctx.drawImage(img, 0, 0, width, height);

                    const pngDataUrl = canvas.toDataURL('image/png');
                    URL.revokeObjectURL(url);
                    resolve(pngDataUrl);
                } catch (error) {
                    URL.revokeObjectURL(url);
                    reject(error);
                }
            };

            img.onerror = () => {
                URL.revokeObjectURL(url);
                reject(new Error('Failed to load SVG'));
            };

            img.src = url;
        });
    }

    async function renderPreviews() {
        if (!state.tracedata || !elements.svgPreview) return;

        try {
            const visibleIndices = getVisibleLayerIndices();
            const previewData = buildTracedataSubset(state.tracedata, visibleIndices);
            const svgString = tracer.getsvgstring(previewData, state.lastOptions);
            const pngDataUrl = await svgToPng(svgString, null, null, true);
            elements.svgPreview.src = pngDataUrl;
            elements.svgPreview.style.display = 'block';
        } catch (error) {
            console.error('Preview rendering failed:', error);
            elements.svgPreview.style.display = 'none';
        }
    }

    async function updateFilteredPreview() {
        objPreview.render();
        if (!state.tracedata || !elements.svgPreviewFiltered) return;

        let dataToShow = state.tracedata;
        let indicesToRender = [];

        if (state.mergeRules.length > 0) {
            const visibleIndices = getVisibleLayerIndices();
            dataToShow = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);

            if (state.selectedFinalLayerIndices.size > 0) {
                indicesToRender = Array.from(state.selectedFinalLayerIndices);
                if (elements.selectedLayerText) {
                    elements.selectedLayerText.textContent = `Final Preview (${indicesToRender.length} layer(s))`;
                }
            } else {
                indicesToRender = Array.from(state.selectedLayerIndices);
                if (elements.selectedLayerText) {
                    elements.selectedLayerText.textContent = state.selectedLayerIndices.size > 0
                        ? `Previewing ${indicesToRender.length} original layer(s)`
                        : 'Select final layers to preview';
                }
            }
        } else {
            indicesToRender = Array.from(state.selectedLayerIndices);
            if (elements.selectedLayerText) {
                elements.selectedLayerText.textContent = state.selectedLayerIndices.size > 0
                    ? `Previewing ${indicesToRender.length} layer(s)`
                    : 'Select layers to preview';
            }
        }

        if (indicesToRender.length === 0) {
            elements.svgPreviewFiltered.style.display = 'none';
            return;
        }

        try {
            const filteredData = buildTracedataSubset(dataToShow, indicesToRender);
            const svgString = tracer.getsvgstring(filteredData, state.lastOptions);
            const pngDataUrl = await svgToPng(svgString);
            elements.svgPreviewFiltered.src = pngDataUrl;
            elements.svgPreviewFiltered.style.display = 'block';
        } catch (error) {
            console.error('Filtered preview rendering failed:', error);
            elements.svgPreviewFiltered.style.display = 'none';
        }
    }

    function disableDownloadButtons() {
        [
            elements.exportLayersBtn,
            elements.downloadSilhouetteBtn,
            elements.combineAndDownloadBtn,
            elements.downloadCombinedLayersBtn,
            elements.exportObjBtn,
            elements.export3mfBtn,
            elements.exportStlBtn
        ].forEach((btn) => {
            if (btn) btn.disabled = true;
        });
    }

    function enableDownloadButtons() {
        [
            elements.exportLayersBtn,
            elements.downloadSilhouetteBtn,
            elements.exportObjBtn,
            elements.export3mfBtn,
            elements.exportStlBtn
        ].forEach((btn) => {
            if (btn) btn.disabled = false;
        });
        if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = state.mergeRules.length === 0;
        if (elements.downloadCombinedLayersBtn) elements.downloadCombinedLayersBtn.disabled = false;
    }

    function displayPalette() {
        if (!state.tracedata) return;

        elements.paletteContainer.innerHTML = '';
        state.selectedLayerIndices.clear();
        const visibleIndices = getVisibleLayerIndices();

        if (visibleIndices.length === 0) {
            elements.paletteRow.style.display = 'none';
            return;
        }

        visibleIndices.forEach((index) => {
            const color = state.tracedata.palette[index];
            const container = document.createElement('div');
            container.className = 'flex flex-col items-center gap-1';

            const swatch = document.createElement('div');
            swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500 cursor-pointer transition-all';
            swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
            swatch.title = `Layer ${index}`;

            const label = document.createElement('div');
            label.className = 'text-xs text-gray-400 opacity-0 transition-opacity';
            label.textContent = `Layer ${index}`;

            swatch.dataset.index = index;
            swatch.addEventListener('click', () => {
                if (state.selectedLayerIndices.has(index)) {
                    state.selectedLayerIndices.delete(index);
                    swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.add('opacity-0');
                } else {
                    state.selectedLayerIndices.add(index);
                    swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.remove('opacity-0');
                }
                updateFilteredPreview();
            });

            container.appendChild(swatch);
            container.appendChild(label);
            elements.paletteContainer.appendChild(container);
        });
        elements.paletteRow.style.display = 'block';
    }

    function prepareMergeUIAfterGeneration() {
        state.mergeRules = [];
        state.selectedFinalLayerIndices.clear();
        if (elements.mergeRulesContainer) elements.mergeRulesContainer.innerHTML = '';
        const visibleIndices = getVisibleLayerIndices();
        if (visibleIndices.length >= 2) {
            if (elements.layerMergingSection) elements.layerMergingSection.style.display = 'block';
            if (elements.addMergeRuleBtn) elements.addMergeRuleBtn.disabled = false;
        } else {
            if (elements.layerMergingSection) elements.layerMergingSection.style.display = 'none';
        }
        if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = true;
        updateFinalPalette();
    }

    function updateMergeRuleSwatches(row, rule, allVisibleIndices) {
        const sourceIndex = allVisibleIndices[rule.source];
        const targetIndex = allVisibleIndices[rule.target];
        const sourceColor = state.tracedata.palette[sourceIndex];
        const targetColor = state.tracedata.palette[targetIndex];
        row.querySelector('[data-swatch="source"]').style.backgroundColor = `rgb(${sourceColor.r},${sourceColor.g},${sourceColor.b})`;
        row.querySelector('[data-swatch="target"]').style.backgroundColor = `rgb(${targetColor.r},${targetColor.g},${targetColor.b})`;
    }

    function updateFinalPalette() {
        elements.finalPaletteContainer.innerHTML = '';
        state.selectedFinalLayerIndices.clear();
        if (!state.tracedata) return;

        const visibleIndices = getVisibleLayerIndices();
        let palette;

        if (state.mergeRules.length > 0) {
            const data = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
            palette = data.palette;
        } else {
            palette = visibleIndices.map(i => state.tracedata.palette[i]);
        }

        if (palette.length > 0) {
            palette.forEach((color, i) => {
                const container = document.createElement('div');
                container.className = 'flex flex-col items-center gap-1';

                const swatch = document.createElement('div');
                swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500 cursor-pointer transition-all';
                swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;

                const label = document.createElement('div');
                label.className = 'text-xs text-gray-400 opacity-0 transition-opacity';

                if (state.mergeRules.length > 0) {
                    const visible = getVisibleLayerIndices();
                    const finalTargets = {};
                    visible.forEach((_, ruleIndex) => {
                        finalTargets[ruleIndex] = ruleIndex;
                    });

                    state.mergeRules.forEach((rule) => {
                        let ultimateTarget = rule.target;
                        while (finalTargets[ultimateTarget] !== ultimateTarget) {
                            ultimateTarget = finalTargets[ultimateTarget];
                        }
                        finalTargets[rule.source] = ultimateTarget;
                    });

                    Object.keys(finalTargets).forEach((key) => {
                        let current = parseInt(key, 10);
                        while (finalTargets[current] !== current) {
                            current = finalTargets[current];
                        }
                        finalTargets[key] = current;
                    });

                    const groups = {};
                    visible.forEach((originalIndex, ruleIndex) => {
                        const finalTargetRuleIndex = finalTargets[ruleIndex];
                        if (!groups[finalTargetRuleIndex]) {
                            groups[finalTargetRuleIndex] = [];
                        }
                        groups[finalTargetRuleIndex].push(originalIndex);
                    });

                    const sortedTargets = Object.keys(groups).map(Number).sort((a, b) => a - b);
                    if (i < sortedTargets.length) {
                        const targetRuleIndex = sortedTargets[i];
                        const originalIndices = groups[targetRuleIndex];
                        const representativeIndex = visible[targetRuleIndex];

                        if (originalIndices.length > 1) {
                            label.textContent = `Merged (${originalIndices.join('+')})`;
                        } else {
                            label.textContent = `Layer ${representativeIndex}`;
                        }

                        swatch.title = originalIndices.length > 1
                            ? `Merged layers: ${originalIndices.join(', ')}`
                            : `Layer ${representativeIndex}`;
                    }
                } else {
                    const originalIndex = visibleIndices[i];
                    label.textContent = `Layer ${originalIndex}`;
                    swatch.title = `Layer ${originalIndex}`;
                }

                swatch.dataset.index = i;
                swatch.addEventListener('click', () => {
                    if (state.selectedFinalLayerIndices.has(i)) {
                        state.selectedFinalLayerIndices.delete(i);
                        swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                        label.classList.add('opacity-0');
                    } else {
                        state.selectedFinalLayerIndices.add(i);
                        swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                        label.classList.remove('opacity-0');
                    }
                    updateFilteredPreview();
                });

                container.appendChild(swatch);
                container.appendChild(label);
                elements.finalPaletteContainer.appendChild(container);
            });
        }
    }

    function saveOriginalAsPNG() {
        if (!elements.sourceImage?.src) return;
        const canvas = drawImageToCanvas(elements.sourceImage);
        canvas.toBlob((blob) => {
            if (!blob) return;
            downloadBlob(blob, `${getImageBaseName()}.png`);
            elements.statusText.textContent = 'Saved original as PNG.';
        }, 'image/png');
    }

    function saveOriginalAsJPG() {
        if (!elements.sourceImage?.src) return;
        const canvas = drawImageToCanvas(elements.sourceImage);
        canvas.toBlob((blob) => {
            if (!blob) return;
            downloadBlob(blob, `${getImageBaseName()}.jpg`);
            elements.statusText.textContent = 'Saved original as JPG.';
        }, 'image/jpeg', 0.92);
    }

    function saveOriginalAsSVG() {
        if (!elements.sourceImage?.src) return;
        const w = elements.sourceImage.naturalWidth || 0;
        const h = elements.sourceImage.naturalHeight || 0;
        if (!w || !h) return;
        const href = elements.sourceImage.src;
        const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
            `<image x="0" y="0" width="${w}" height="${h}" href="${href}" xlink:href="${href}"/>` +
            `</svg>`;
        downloadSVG(svg, `${getImageBaseName()}`);
        elements.statusText.textContent = 'Saved original as SVG (raw).';
    }

    function onSourceImageLoaded() {
        syncWorkspaceView();
        elements.analyzeColorsBtn.disabled = false;

        const w = elements.sourceImage.naturalWidth;
        const h = elements.sourceImage.naturalHeight;
        elements.originalResolution.textContent = `${w}×${h} px`;

        if (elements.savePngBtn) elements.savePngBtn.disabled = false;
        if (elements.saveJpgBtn) elements.saveJpgBtn.disabled = false;
        if (elements.saveSvgBtn) elements.saveSvgBtn.disabled = false;

        onRasterImageLoaded();

        if (w < 512 || h < 512) {
            elements.resolutionNotice.textContent = 'Low resolution detected. For best results, use images larger than 512x512 pixels.';
            elements.resolutionNotice.style.display = 'block';
        } else {
            elements.resolutionNotice.style.display = 'none';
        }

        updateColorCountNotice();

        state.colorsAnalyzed = false;
        if (elements.optimizePathsBtn) elements.optimizePathsBtn.disabled = true;
        saveInitialSliderValues();
        elements.analyzeColorsBtn.click();

        if (state.activeTab === 'svg') {
            onTabActivated();
        } else if (state.activeTab === 'raster') {
            setAvailableLayersVisible(false);
            setFinalPaletteVisible(false);
        } else {
            setAvailableLayersVisible(false);
            setFinalPaletteVisible(false);
        }

        showLoader(false);
    }

    function onTabActivated() {
        if (!hasSingleImageLoaded()) return;
        setAvailableLayersVisible(true);
        setFinalPaletteVisible(true);
        objPreview.render();
    }

    function bindEvents() {
        if (elements.analyzeColorsBtn) {
            elements.analyzeColorsBtn.addEventListener('click', analyzeColorsClick);
        }
        if (elements.optimizePathsBtn) {
            elements.optimizePathsBtn.addEventListener('click', optimizePathsClick);
        }
        if (elements.resetBtn) {
            elements.resetBtn.addEventListener('click', resetSlidersToInitial);
        }
        if (elements.toggleFidelityBtn) {
            elements.toggleFidelityBtn.addEventListener('click', () => {
                setHighFidelity(!state.highFidelity);
                if (state.colorsAnalyzed && elements.sourceImage.src) {
                    state.colorsAnalyzed = false;
                    if (elements.optimizePathsBtn) elements.optimizePathsBtn.disabled = true;
                    elements.statusText.textContent = 'Fidelity changed. Re-analyze colors.';
                }
            });
        }

        if (elements.objThicknessSlider && elements.objThicknessValue) {
            elements.objThicknessValue.textContent = elements.objThicknessSlider.value;
            elements.objThicknessSlider.addEventListener('input', () => {
                elements.objThicknessValue.textContent = elements.objThicknessSlider.value;
                updateFilteredPreview();
            });
        }
        if (elements.objDetailSlider && elements.objDetailValue) {
            elements.objDetailValue.textContent = elements.objDetailSlider.value;
            elements.objDetailSlider.addEventListener('input', () => {
                elements.objDetailValue.textContent = elements.objDetailSlider.value;
                updateFilteredPreview();
            });
        }
        if (elements.objBedSelect) {
            elements.objBedSelect.addEventListener('change', () => updateFilteredPreview());
        }
        if (elements.objMarginInput) {
            elements.objMarginInput.addEventListener('input', () => updateFilteredPreview());
        }
        if (elements.exportObjBtn) {
            elements.exportObjBtn.addEventListener('click', () => objExporter.exportAsOBJ());
        }
        if (elements.export3mfBtn) {
            elements.export3mfBtn.addEventListener('click', () => objExporter.exportAs3MF());
        }
        if (elements.exportStlBtn) {
            elements.exportStlBtn.addEventListener('click', () => objExporter.exportAsSTL());
        }

        setupZoomControls();
        objPreview.bindControls();

        if (elements.previewResolution) {
            elements.previewResolution.addEventListener('change', () => {
                if (state.tracedata) {
                    renderPreviews();
                    updateFilteredPreview();
                }
            });
        }

        document.querySelectorAll('.control-panel input[type="range"]').forEach((slider) => {
            slider.addEventListener('input', (e) => {
                if (e.target.id === 'obj-thickness' || e.target.id === 'obj-detail') {
                    return;
                }
                if (!state.isDirty) {
                    state.isDirty = true;
                    elements.resetBtn.style.display = 'inline';
                }
                updateAllSliderDisplays();

                const tooltipId = `${e.target.id}-tooltip`;
                const tooltipEl = document.getElementById(tooltipId);
                if (tooltipEl) {
                    tooltipEl.textContent = SLIDER_TOOLTIPS[e.target.id];
                    tooltipEl.style.opacity = '1';
                    clearTimeout(state.tooltipTimeout);
                    state.tooltipTimeout = setTimeout(() => {
                        tooltipEl.style.opacity = '0';
                    }, 2000);
                }

                if (e.target.id === 'color-precision' || e.target.id === 'max-colors') {
                    if (state.colorsAnalyzed && elements.sourceImage.src) {
                        state.colorsAnalyzed = false;
                        if (elements.optimizePathsBtn) elements.optimizePathsBtn.disabled = true;
                    }
                    if (e.target.id === 'max-colors') {
                        updateColorCountNotice();
                    }
                } else if (state.colorsAnalyzed) {
                    debounceOptimizePaths();
                }
            });
        });

        if (elements.savePngBtn) elements.savePngBtn.addEventListener('click', saveOriginalAsPNG);
        if (elements.saveJpgBtn) elements.saveJpgBtn.addEventListener('click', saveOriginalAsJPG);
        if (elements.saveSvgBtn) elements.saveSvgBtn.addEventListener('click', saveOriginalAsSVG);

        if (elements.exportLayersBtn) {
            elements.exportLayersBtn.addEventListener('click', () => {
                if (!state.tracedata) return;
                const visibleIndices = getVisibleLayerIndices();
                if (!visibleIndices.length) return;

                const imageName = getImageBaseName();

                if (state.mergeRules && state.mergeRules.length > 0) {
                    const mergedData = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
                    const layerIndices = [];
                    for (let i = 0; i < mergedData.layers.length; i++) {
                        if (layerHasPaths(mergedData.layers[i])) {
                            layerIndices.push(i);
                        }
                    }

                    layerIndices.forEach((idx) => {
                        const singleLayer = buildTracedataSubset(mergedData, [idx]);
                        downloadSVG(tracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_final_layer_${idx}`);
                    });
                } else {
                    visibleIndices.forEach((idx) => {
                        const singleLayer = buildTracedataSubset(state.tracedata, [idx]);
                        downloadSVG(tracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_layer_${idx}`);
                    });
                }
            });
        }

        if (elements.downloadSilhouetteBtn) {
            elements.downloadSilhouetteBtn.addEventListener('click', () => {
                if (!state.silhouetteTracedata) return;
                downloadSVG(tracer.getsvgstring(state.silhouetteTracedata, state.lastOptions), `${getImageBaseName()}_silhouette`);
            });
        }

        if (elements.downloadCombinedLayersBtn) {
            elements.downloadCombinedLayersBtn.addEventListener('click', () => {
                if (!state.tracedata) return;
                const visibleIndices = getVisibleLayerIndices();
                if (!visibleIndices.length) return;

                const dataToExport = state.mergeRules && state.mergeRules.length > 0
                    ? createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules)
                    : buildTracedataSubset(state.tracedata, visibleIndices);

                if (!dataToExport) return;
                downloadSVG(tracer.getsvgstring(dataToExport, state.lastOptions), `${getImageBaseName()}_combined_layers`);
            });
        }

        if (elements.addMergeRuleBtn) {
            elements.addMergeRuleBtn.addEventListener('click', () => {
                const ruleIndex = state.mergeRules.length;
                const visibleIndices = getVisibleLayerIndices();
                if (visibleIndices.length < 2) return;

                const defaultRule = { source: 0, target: 1 };
                state.mergeRules.push(defaultRule);

                const row = document.createElement('div');
                row.className = 'flex items-center gap-2 text-sm';
                const optionsHTML = visibleIndices.map((idx, ord) => `<option value="${ord}">Layer ${idx}</option>`).join('');

                row.innerHTML = `
                    <span>Merge</span>
                    <span class="w-4 h-4 rounded border border-gray-500" data-swatch="source"></span>
                    <select data-rule-index="${ruleIndex}" data-type="source" class="border rounded-md p-1 bg-gray-700 border-gray-600 text-white">${optionsHTML}</select>
                    <span>into</span>
                    <span class="w-4 h-4 rounded border border-gray-500" data-swatch="target"></span>
                    <select data-rule-index="${ruleIndex}" data-type="target" class="border rounded-md p-1 bg-gray-700 border-gray-600 text-white">${optionsHTML}</select>
                    <button data-rule-index="${ruleIndex}" class="text-red-500 hover:text-red-400 font-bold text-lg">&times;</button>
                `;

                row.querySelector('select[data-type="target"]').value = '1';
                elements.mergeRulesContainer.appendChild(row);
                updateMergeRuleSwatches(row, defaultRule, visibleIndices);
                if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = false;
                updateFinalPalette();
                updateFilteredPreview();
            });
        }

        if (elements.mergeRulesContainer) {
            elements.mergeRulesContainer.addEventListener('change', (e) => {
                if (e.target.tagName === 'SELECT') {
                    const ruleIndex = parseInt(e.target.dataset.ruleIndex, 10);
                    const type = e.target.dataset.type;
                    state.mergeRules[ruleIndex][type] = parseInt(e.target.value, 10);
                    const visibleIndices = getVisibleLayerIndices();
                    updateMergeRuleSwatches(e.target.parentElement, state.mergeRules[ruleIndex], visibleIndices);
                    updateFinalPalette();
                    updateFilteredPreview();
                }
            });

            elements.mergeRulesContainer.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') {
                    const ruleIndex = parseInt(e.target.dataset.ruleIndex, 10);
                    state.mergeRules.splice(ruleIndex, 1);
                    e.target.parentElement.remove();

                    document.querySelectorAll('#merge-rules-container > div').forEach((row, i) => {
                        row.querySelectorAll('[data-rule-index]').forEach(el => {
                            el.dataset.ruleIndex = i;
                        });
                    });
                    if (state.mergeRules.length === 0 && elements.combineAndDownloadBtn) {
                        elements.combineAndDownloadBtn.disabled = true;
                    }
                    updateFinalPalette();
                    updateFilteredPreview();
                }
            });
        }

        if (elements.combineAndDownloadBtn) {
            elements.combineAndDownloadBtn.addEventListener('click', () => {
                const visibleIndices = getVisibleLayerIndices();
                const mergedData = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
                if (!mergedData) return;

                const finalIndices = [];
                for (let i = 0; i < mergedData.layers.length; i++) {
                    if (layerHasPaths(mergedData.layers[i])) {
                        finalIndices.push(i);
                    }
                }

                finalIndices.forEach((idx, ord) => {
                    const singleLayer = buildTracedataSubset(mergedData, [idx]);
                    downloadSVG(tracer.getsvgstring(singleLayer, state.lastOptions), `${getImageBaseName()}_final_layer_${ord + 1}`);
                });
            });
        }

        const layersToggle = document.getElementById('layers-toggle');
        const layersSection = document.getElementById('layers-section');
        if (layersToggle && layersSection) {
            layersToggle.addEventListener('click', () => {
                layersSection.classList.toggle('collapsed');
                layersToggle.classList.toggle('expanded');
                const isExpanded = !layersSection.classList.contains('collapsed');
                layersToggle.querySelector('span').textContent = isExpanded ? 'Click to collapse' : 'Click to expand';
            });
        }

        window.addEventListener('resize', () => {
            updateSegmentedControlIndicator();
            objPreview.resize();
            objPreview.render();
        });

        elements.sourceImage.onload = onSourceImageLoaded;
    }

    return {
        bindEvents,
        onTabActivated,
        onSourceImageLoaded,
        setAvailableLayersVisible,
        setFinalPaletteVisible,
        setHighFidelity,
        updateColorCountNotice,
        renderPreviews,
        updateFilteredPreview
    };
}
