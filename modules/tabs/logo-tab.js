import { SLIDER_TOOLTIPS, TRANSPARENT_ALPHA_CUTOFF } from '../config.js';
import { createObjPreview } from '../preview3d.js';
import { createObjExporter } from '../export3d.js';
import { drawImageToCanvas } from '../raster-utils.js';

export function createLogoTabController({
    state,
    ls,
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

    const le = {
        ...elements,
        svgSourceMirror: elements.logoSvgSourceMirror,
        svgPreview: elements.logoSvgPreview,
        svgPreviewFiltered: null,
        selectedLayerText: null,
        objPreviewCanvas: elements.logoObjPreviewCanvas,
        objPreviewPlaceholder: elements.logoObjPreviewPlaceholder,
        objFitView: elements.logoObjFitView,
        objRecenter: elements.logoObjRecenter,
        objTargetLock: elements.logoObjTargetLock,
        objModeGhost: elements.logoObjModeGhost,
        objModeSolo: elements.logoObjModeSolo,
        layerStackList: elements.logoLayerStackList,
        layerStackMeta: elements.logoLayerStackMeta,
        previewResolution: elements.logoPreviewResolution,
        qualityIndicator: elements.logoQualityIndicator,
        paletteContainer: elements.logoPaletteContainer,
        paletteRow: elements.logoPaletteRow,
        finalPaletteContainer: elements.logoFinalPaletteContainer,
        layerMergingSection: elements.logoLayerMergingSection,
        mergeRulesContainer: elements.logoMergeRulesContainer,
        addMergeRuleBtn: elements.logoAddMergeRuleBtn,
        useBaseLayerCheckbox: elements.logoUseBaseLayerCheckbox,
        baseLayerSelect: elements.logoBaseLayerSelect,
        exportLayersBtn: elements.logoExportLayersBtn,
        downloadSilhouetteBtn: elements.logoDownloadSilhouetteBtn,
        combineAndDownloadBtn: null,
        downloadCombinedLayersBtn: elements.logoDownloadCombinedLayersBtn,
        exportObjBtn: elements.logoExportObjBtn,
        export3mfBtn: elements.logoExport3mfBtn,
        exportStlBtn: elements.logoExportStlBtn,
        originalResolution: elements.logoOriginalResolution,
    };

    function saveInitialSliderValues() {
        ls.initialSliderValues = {
            pathSimplification: le.pathSimplificationSlider.value,
            cornerSharpness: le.cornerSharpnessSlider.value,
            curveStraightness: le.curveStraightnessSlider.value,
            colorPrecision: le.colorPrecisionSlider.value,
            maxColors: le.maxColorsSlider ? le.maxColorsSlider.value : '4'
        };
        ls.isDirty = false;
        le.resetBtn.style.display = 'none';
    }

    function updateAllSliderDisplays() {
        le.pathSimplificationValue.textContent = le.pathSimplificationSlider.value;
        le.cornerSharpnessValue.textContent = le.cornerSharpnessSlider.value;
        le.curveStraightnessValue.textContent = le.curveStraightnessSlider.value;
        le.colorPrecisionValue.textContent = le.colorPrecisionSlider.value;
        if (le.maxColorsValue && le.maxColorsSlider) {
            le.maxColorsValue.textContent = le.maxColorsSlider.value;
        }
        if (le.objThicknessValue && le.objThicknessSlider) {
            le.objThicknessValue.textContent = le.objThicknessSlider.value;
        }
        if (le.objDetailValue && le.objDetailSlider) {
            le.objDetailValue.textContent = le.objDetailSlider.value;
        }
    }

    function setAvailableLayersVisible(show) {
        ls.showAvailableLayers = show;
        if (le.availableLayersContent) {
            le.availableLayersContent.style.display = show ? 'block' : 'none';
        }
        if (le.toggleAvailableLayersBtn) {
            le.toggleAvailableLayersBtn.textContent = show ? 'Hide' : 'Show';
        }
    }

    function setFinalPaletteVisible(show) {
        ls.showFinalPalette = show;
        if (le.finalPaletteContent) {
            le.finalPaletteContent.style.display = show ? 'block' : 'none';
        }
        if (le.toggleFinalPaletteBtn) {
            le.toggleFinalPaletteBtn.textContent = show ? 'Hide' : 'Show';
        }
    }

    function resetSlidersToInitial() {
        if (!ls.initialSliderValues) return;

        le.pathSimplificationSlider.value = ls.initialSliderValues.pathSimplification;
        le.cornerSharpnessSlider.value = ls.initialSliderValues.cornerSharpness;
        le.curveStraightnessSlider.value = ls.initialSliderValues.curveStraightness;
        le.colorPrecisionSlider.value = ls.initialSliderValues.colorPrecision;
        if (le.maxColorsSlider) {
            le.maxColorsSlider.value = ls.initialSliderValues.maxColors;
        }

        updateAllSliderDisplays();

        if (le.sourceImage.src) {
            ls.colorsAnalyzed = false;
            if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
            le.analyzeColorsBtn.click();
        }

        ls.isDirty = false;
        le.resetBtn.style.display = 'none';
    }

    const debounce = (fn, ms = 250) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn(...args), ms);
        };
    };

    const debounceOptimizePaths = debounce(() => {
        if (ls.colorsAnalyzed) {
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
        ls.layerThicknesses = null;
        await analyzeColors();
        ls.colorsAnalyzed = true;
        await optimizePathsClick();
    }

    async function optimizePathsClick() {
        if (!ls.quantizedData) return;
        await traceVectorPaths();
    }

    function setHighFidelity(enabled) {
        ls.highFidelity = !!enabled;
        if (le.toggleFidelityBtn) {
            le.toggleFidelityBtn.textContent = ls.highFidelity ? 'Mode: High Fidelity' : 'Mode: Logo';
            le.toggleFidelityBtn.classList.toggle('btn-primary', ls.highFidelity);
            le.toggleFidelityBtn.classList.toggle('btn-secondary', !ls.highFidelity);
        }
        if (le.maxColorsSlider) {
            le.maxColorsSlider.value = ls.highFidelity ? '8' : '4';
            if (!ls.isDirty) {
                ls.isDirty = true;
                le.resetBtn.style.display = 'inline';
            }
            updateAllSliderDisplays();
        }
    }

    function buildOptimizedOptions() {
        const P = parseInt(le.pathSimplificationSlider.value, 10);
        const C = parseInt(le.cornerSharpnessSlider.value, 10);
        const S = parseInt(le.curveStraightnessSlider.value, 10);
        const CP = parseInt(le.colorPrecisionSlider.value, 10);
        const MC = le.maxColorsSlider ? parseInt(le.maxColorsSlider.value, 10) : 4;

        const map = (t, a, b) => (a + (b - a) * (t / 100));
        const mapInv = (t, a, b) => (a + (b - a) * (1 - (t / 100)));

        const options = Object.assign({}, tracer.optionpresets.default, {
            viewbox: true,
            strokewidth: 0
        });

        if (ls.highFidelity) {
            const rel = Math.max(0.5, Math.sqrt(le.sourceImage.naturalWidth * le.sourceImage.naturalHeight) / 512);
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
        le.statusText.textContent = 'Analyzing colors...';
        disableDownloadButtons();

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const width = le.sourceImage.naturalWidth;
                    const height = le.sourceImage.naturalHeight;
                    if (!width || !height) throw new Error('Invalid image dimensions');

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(le.sourceImage, 0, 0, width, height);
                    const imageData = ctx.getImageData(0, 0, width, height);

                    const options = buildOptimizedOptions();
                    const MC = le.maxColorsSlider ? parseInt(le.maxColorsSlider.value, 10) : 4;
                    const dominantColorCount = estimateDominantColors(imageData);
                    if (dominantColorCount && dominantColorCount > MC) {
                        options.numberofcolors = Math.min(options.numberofcolors, dominantColorCount);
                    }
                    options.numberofcolors = Math.max(MC, options.numberofcolors);
                    ls.lastOptions = options;

                    ls.quantizedData = tracer.colorquantization(imageData, options);

                    if (!ls.quantizedData || !ls.quantizedData.palette) {
                        throw new Error('Color analysis failed.');
                    }

                    if (hasTransparentPixels(imageData)) {
                        markTransparentPixels(ls.quantizedData, imageData);
                        stripTransparentPalette(ls.quantizedData);
                    } else {
                        ls.quantizedData.palette.forEach((color) => {
                            color.a = 255;
                        });
                    }

                    if (!ls.quantizedData.palette.length) {
                        throw new Error('No opaque pixels found.');
                    }

                    resolve();
                } catch (error) {
                    console.error('Color analysis error:', error);
                    le.statusText.textContent = `Error: ${error.message}`;
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
        const minBucketRatio = ls.highFidelity ? 0.003 : 0.006;
        const minBucketCount = Math.max(2, Math.round(samples * minBucketRatio));
        const buckets = bucketsAll.filter(count => count >= minBucketCount);
        const selectedBuckets = buckets.length ? buckets : bucketsAll;
        const total = selectedBuckets.reduce((sum, count) => sum + count, 0);
        const targetCoverage = ls.highFidelity ? 0.992 : 0.985;
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
        if (!le.colorCountNotice || !le.sourceImage.src) {
            return;
        }

        const maxColors = le.maxColorsSlider ? parseInt(le.maxColorsSlider.value, 10) : 4;
        const canvas = document.createElement('canvas');
        const w = le.sourceImage.naturalWidth;
        const h = le.sourceImage.naturalHeight;
        if (!w || !h) {
            le.colorCountNotice.style.display = 'none';
            return;
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(le.sourceImage, 0, 0, w, h);
        const imageData = ctx.getImageData(0, 0, w, h);

        const estimatedColors = estimateDominantColors(imageData);
        ls.estimatedColorCount = estimatedColors;

        if (estimatedColors && estimatedColors > maxColors) {
            le.colorCountNotice.innerHTML =
                `Image has ~${estimatedColors} distinct colors. Consider increasing Max Colors to ${Math.min(estimatedColors, 8)} for better accuracy. ` +
                `<em style="opacity: 0.8">(3D printers may have filament limits)</em>`;
            le.colorCountNotice.style.display = 'block';
        } else {
            le.colorCountNotice.style.display = 'none';
        }
    }

    function getVisibleLayerIndices() {
        if (!ls.tracedata) return [];

        const indices = [];
        for (let i = 0; i < ls.tracedata.layers.length; i++) {
            if (layerHasPaths(ls.tracedata.layers[i])) {
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
        if (!ls.tracedata) return null;
        const visibleIndices = getVisibleLayerIndices();
        if (!visibleIndices.length) return null;
        if (ls.mergeRules && ls.mergeRules.length > 0) {
            return createMergedTracedata(ls.tracedata, visibleIndices, ls.mergeRules);
        }
        return buildTracedataSubset(ls.tracedata, visibleIndices);
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
        if (le.qualityIndicator) {
            le.qualityIndicator.textContent = `${quality.pathCount} paths, ${quality.colorCount} colors`;
        }
    }

    const objPreview = createObjPreview({
        state: ls,
        elements: le,
        getDataToExport,
        getVisibleLayerIndices,
        ImageTracer: tracer
    });

    const objExporter = createObjExporter({
        state: ls,
        elements: le,
        getDataToExport,
        ImageTracer: tracer,
        showLoader,
        downloadBlob,
        getImageBaseName
    });

    async function traceVectorPaths() {
        if (!ls.quantizedData) return;
        showLoader(true);
        le.statusText.textContent = 'Tracing vector paths...';
        if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const options = buildOptimizedOptions();
                    ls.lastOptions = options;

                    const ii = ls.quantizedData;
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

                    ls.tracedata = tracedata;
                    ls.silhouetteTracedata = createSolidSilhouette(ls.tracedata);

                    displayPalette();
                    prepareMergeUIAfterGeneration();

                    le.outputSection.style.display = 'flex';
                    setTimeout(() => updateSegmentedControlIndicator(), 100);

                    await renderPreviews();
                    await updateFilteredPreview();

                    const quality = assess3DPrintQuality(ls.tracedata);
                    updateQualityDisplay(quality);
                    le.statusText.textContent = 'Preview generated!';
                    enableDownloadButtons();
                    onRasterExportStateChanged();
                    resolve();
                } catch (error) {
                    console.error('Tracing error:', error);
                    le.statusText.textContent = `Error: ${error.message}`;
                    reject(error);
                } finally {
                    showLoader(false);
                    if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = false;
                }
            }, 50);
        });
    }

    function setupZoomControls() {
        const zoomInAll = document.getElementById('logo-zoom-in-all');
        const zoomOutAll = document.getElementById('logo-zoom-out-all');
        const zoomResetAll = document.getElementById('logo-zoom-reset-all');
        const zoomInSelected = null;
        const zoomOutSelected = null;
        const zoomResetSelected = null;

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
        const zoomState = ls.zoom[type];
        const newScale = Math.max(0.1, Math.min(5, zoomState.scale * factor));
        zoomState.scale = newScale;
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }

    function resetZoom(type) {
        const zoomState = ls.zoom[type];
        zoomState.scale = 1;
        zoomState.x = 0;
        zoomState.y = 0;
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }

    function updatePreviewTransform(type) {
        const container = document.querySelector(`[data-preview="logo-${type}"]`);
        if (!container) return;
        const content = container.querySelector('.preview-content');
        if (!content) return;
        const zoomState = ls.zoom[type];

        content.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;

        if (zoomState.scale > 1) {
            container.classList.add('zoomed');
        } else {
            container.classList.remove('zoomed');
        }
    }

    function updateZoomDisplay(type) {
        const zoomLevel = Math.round(ls.zoom[type].scale * 100);
        const resetButton = document.getElementById(`logo-zoom-reset-${type}`);
        if (resetButton) {
            resetButton.textContent = `${zoomLevel}%`;
        }

        const zoomInBtn = document.getElementById(`logo-zoom-in-${type}`);
        const zoomOutBtn = document.getElementById(`logo-zoom-out-${type}`);

        if (zoomInBtn) zoomInBtn.disabled = ls.zoom[type].scale >= 5;
        if (zoomOutBtn) zoomOutBtn.disabled = ls.zoom[type].scale <= 0.1;
    }

    function setupPanControls(type) {
        const container = document.querySelector(`[data-preview="logo-${type}"]`);
        if (!container) return;
        const content = container.querySelector('.preview-content');
        if (!content) return;
        let startX;
        let startY;
        let initialX;
        let initialY;

        content.addEventListener('mousedown', (e) => {
            if (ls.zoom[type].scale <= 1) return;

            e.preventDefault();
            ls.zoom[type].isDragging = true;
            container.classList.add('dragging');

            startX = e.clientX;
            startY = e.clientY;
            initialX = ls.zoom[type].x;
            initialY = ls.zoom[type].y;
        });

        document.addEventListener('mousemove', (e) => {
            if (!ls.zoom[type].isDragging) return;

            e.preventDefault();
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            ls.zoom[type].x = initialX + deltaX;
            ls.zoom[type].y = initialY + deltaY;
            updatePreviewTransform(type);
        });

        document.addEventListener('mouseup', () => {
            if (ls.zoom[type].isDragging) {
                ls.zoom[type].isDragging = false;
                container.classList.remove('dragging');
            }
        });

        content.addEventListener('touchstart', (e) => {
            if (ls.zoom[type].scale <= 1) return;

            e.preventDefault();
            ls.zoom[type].isDragging = true;
            container.classList.add('dragging');

            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            initialX = ls.zoom[type].x;
            initialY = ls.zoom[type].y;
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (!ls.zoom[type].isDragging) return;

            e.preventDefault();
            const touch = e.touches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            ls.zoom[type].x = initialX + deltaX;
            ls.zoom[type].y = initialY + deltaY;
            updatePreviewTransform(type);
        }, { passive: false });

        document.addEventListener('touchend', () => {
            if (ls.zoom[type].isDragging) {
                ls.zoom[type].isDragging = false;
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
            const selectedRes = maxSize || parseInt(le.previewResolution?.value || '512', 10);
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
        if (!ls.tracedata || !le.svgPreview) return;

        try {
            const visibleIndices = getVisibleLayerIndices();
            const previewData = buildTracedataSubset(ls.tracedata, visibleIndices);
            const svgString = tracer.getsvgstring(previewData, ls.lastOptions);
            const pngDataUrl = await svgToPng(svgString, null, null, true);
            le.svgPreview.src = pngDataUrl;
            le.svgPreview.style.display = 'block';
        } catch (error) {
            console.error('Preview rendering failed:', error);
            le.svgPreview.style.display = 'none';
        }
    }

    async function updateFilteredPreview() {
        objPreview.render();
        if (!ls.tracedata || !le.svgPreviewFiltered) return;

        let dataToShow = ls.tracedata;
        let indicesToRender = [];

        if (ls.mergeRules.length > 0) {
            const visibleIndices = getVisibleLayerIndices();
            dataToShow = createMergedTracedata(ls.tracedata, visibleIndices, ls.mergeRules);

            if (ls.selectedFinalLayerIndices.size > 0) {
                indicesToRender = Array.from(ls.selectedFinalLayerIndices);
                if (le.selectedLayerText) {
                    le.selectedLayerText.textContent = `Final Preview (${indicesToRender.length} layer(s))`;
                }
            } else {
                indicesToRender = Array.from(ls.selectedLayerIndices);
                if (le.selectedLayerText) {
                    le.selectedLayerText.textContent = ls.selectedLayerIndices.size > 0
                        ? `Previewing ${indicesToRender.length} original layer(s)`
                        : 'Select final layers to preview';
                }
            }
        } else {
            indicesToRender = Array.from(ls.selectedLayerIndices);
            if (le.selectedLayerText) {
                le.selectedLayerText.textContent = ls.selectedLayerIndices.size > 0
                    ? `Previewing ${indicesToRender.length} layer(s)`
                    : 'Select layers to preview';
            }
        }

        if (indicesToRender.length === 0) {
            le.svgPreviewFiltered.style.display = 'none';
            return;
        }

        try {
            const filteredData = buildTracedataSubset(dataToShow, indicesToRender);
            const svgString = tracer.getsvgstring(filteredData, ls.lastOptions);
            const pngDataUrl = await svgToPng(svgString);
            le.svgPreviewFiltered.src = pngDataUrl;
            le.svgPreviewFiltered.style.display = 'block';
        } catch (error) {
            console.error('Filtered preview rendering failed:', error);
            le.svgPreviewFiltered.style.display = 'none';
        }
    }

    function disableDownloadButtons() {
        [
            le.exportLayersBtn,
            le.downloadSilhouetteBtn,
            le.combineAndDownloadBtn,
            le.downloadCombinedLayersBtn,
            le.exportObjBtn,
            le.export3mfBtn,
            le.exportStlBtn
        ].forEach((btn) => {
            if (btn) btn.disabled = true;
        });
    }

    function enableDownloadButtons() {
        [
            le.exportLayersBtn,
            le.downloadSilhouetteBtn,
            le.exportObjBtn,
            le.export3mfBtn,
            le.exportStlBtn
        ].forEach((btn) => {
            if (btn) btn.disabled = false;
        });
        if (le.combineAndDownloadBtn) le.combineAndDownloadBtn.disabled = ls.mergeRules.length === 0;
        if (le.downloadCombinedLayersBtn) le.downloadCombinedLayersBtn.disabled = false;
    }

    function displayPalette() {
        if (!ls.tracedata) return;

        le.paletteContainer.innerHTML = '';
        ls.selectedLayerIndices.clear();
        const visibleIndices = getVisibleLayerIndices();

        if (visibleIndices.length === 0) {
            le.paletteRow.style.display = 'none';
            return;
        }

        visibleIndices.forEach((index) => {
            const color = ls.tracedata.palette[index];
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
                if (ls.selectedLayerIndices.has(index)) {
                    ls.selectedLayerIndices.delete(index);
                    swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.add('opacity-0');
                } else {
                    ls.selectedLayerIndices.add(index);
                    swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.remove('opacity-0');
                }
                updateFilteredPreview();
            });

            container.appendChild(swatch);
            container.appendChild(label);
            le.paletteContainer.appendChild(container);
        });
        le.paletteRow.style.display = 'block';
    }

    function prepareMergeUIAfterGeneration() {
        ls.mergeRules = [];
        ls.selectedFinalLayerIndices.clear();
        if (le.mergeRulesContainer) le.mergeRulesContainer.innerHTML = '';
        const visibleIndices = getVisibleLayerIndices();
        if (visibleIndices.length >= 2) {
            if (le.layerMergingSection) le.layerMergingSection.style.display = 'block';
            if (le.addMergeRuleBtn) le.addMergeRuleBtn.disabled = false;
        } else {
            if (le.layerMergingSection) le.layerMergingSection.style.display = 'none';
        }
        if (le.combineAndDownloadBtn) le.combineAndDownloadBtn.disabled = true;
        updateFinalPalette();
    }

    function updateMergeRuleSwatches(row, rule, allVisibleIndices) {
        const sourceIndex = allVisibleIndices[rule.source];
        const targetIndex = allVisibleIndices[rule.target];
        const sourceColor = ls.tracedata.palette[sourceIndex];
        const targetColor = ls.tracedata.palette[targetIndex];
        row.querySelector('[data-swatch="source"]').style.backgroundColor = `rgb(${sourceColor.r},${sourceColor.g},${sourceColor.b})`;
        row.querySelector('[data-swatch="target"]').style.backgroundColor = `rgb(${targetColor.r},${targetColor.g},${targetColor.b})`;
    }

    function updateFinalPalette() {
        le.finalPaletteContainer.innerHTML = '';
        ls.selectedFinalLayerIndices.clear();
        if (!ls.tracedata) return;

        const visibleIndices = getVisibleLayerIndices();
        let palette;

        if (ls.mergeRules.length > 0) {
            const data = createMergedTracedata(ls.tracedata, visibleIndices, ls.mergeRules);
            palette = data.palette;
        } else {
            palette = visibleIndices.map(i => ls.tracedata.palette[i]);
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

                if (ls.mergeRules.length > 0) {
                    const visible = getVisibleLayerIndices();
                    const finalTargets = {};
                    visible.forEach((_, ruleIndex) => {
                        finalTargets[ruleIndex] = ruleIndex;
                    });

                    ls.mergeRules.forEach((rule) => {
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
                    if (ls.selectedFinalLayerIndices.has(i)) {
                        ls.selectedFinalLayerIndices.delete(i);
                        swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                        label.classList.add('opacity-0');
                    } else {
                        ls.selectedFinalLayerIndices.add(i);
                        swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                        label.classList.remove('opacity-0');
                    }
                    updateFilteredPreview();
                });

                container.appendChild(swatch);
                container.appendChild(label);
                le.finalPaletteContainer.appendChild(container);
            });
        }
    }

    function saveOriginalAsPNG() {
        if (!le.sourceImage?.src) return;
        const canvas = drawImageToCanvas(le.sourceImage);
        canvas.toBlob((blob) => {
            if (!blob) return;
            downloadBlob(blob, `${getImageBaseName()}.png`);
            le.statusText.textContent = 'Saved original as PNG.';
        }, 'image/png');
    }

    function saveOriginalAsJPG() {
        if (!le.sourceImage?.src) return;
        const canvas = drawImageToCanvas(le.sourceImage);
        canvas.toBlob((blob) => {
            if (!blob) return;
            downloadBlob(blob, `${getImageBaseName()}.jpg`);
            le.statusText.textContent = 'Saved original as JPG.';
        }, 'image/jpeg', 0.92);
    }

    function saveOriginalAsSVG() {
        if (!le.sourceImage?.src) return;
        const w = le.sourceImage.naturalWidth || 0;
        const h = le.sourceImage.naturalHeight || 0;
        if (!w || !h) return;
        const href = le.sourceImage.src;
        const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
            `<image x="0" y="0" width="${w}" height="${h}" href="${href}" xlink:href="${href}"/>` +
            `</svg>`;
        downloadSVG(svg, `${getImageBaseName()}`);
        le.statusText.textContent = 'Saved original as SVG (raw).';
    }

    function onSourceImageLoaded() {
        // Sync the logo source mirror with the loaded image
        if (elements.logoSvgSourceMirror && elements.sourceImage.src) {
            elements.logoSvgSourceMirror.src = elements.sourceImage.src;
        }

        syncWorkspaceView();
        le.analyzeColorsBtn.disabled = false;

        const w = le.sourceImage.naturalWidth;
        const h = le.sourceImage.naturalHeight;
        le.originalResolution.textContent = `${w}×${h} px`;

        if (le.savePngBtn) le.savePngBtn.disabled = false;
        if (le.saveJpgBtn) le.saveJpgBtn.disabled = false;
        if (le.saveSvgBtn) le.saveSvgBtn.disabled = false;

        onRasterImageLoaded();

        if (w < 512 || h < 512) {
            le.resolutionNotice.textContent = 'Low resolution detected. For best results, use images larger than 512x512 pixels.';
            le.resolutionNotice.style.display = 'block';
        } else {
            le.resolutionNotice.style.display = 'none';
        }

        updateColorCountNotice();

        ls.colorsAnalyzed = false;
        if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
        saveInitialSliderValues();
        le.analyzeColorsBtn.click();

        if (state.activeTab === 'logo') {
            onTabActivated();
        } else {
            // Logo tab not active, don't auto-analyze
            ls.colorsAnalyzed = false;
            if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
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
        if (le.analyzeColorsBtn) {
            le.analyzeColorsBtn.addEventListener('click', () => {
                if (state.activeTab !== 'logo') return;
                analyzeColorsClick();
            });
        }
        if (le.optimizePathsBtn) {
            le.optimizePathsBtn.addEventListener('click', () => {
                if (state.activeTab !== 'logo') return;
                optimizePathsClick();
            });
        }
        if (le.resetBtn) {
            le.resetBtn.addEventListener('click', resetSlidersToInitial);
        }
        if (le.toggleFidelityBtn) {
            le.toggleFidelityBtn.addEventListener('click', () => {
                if (state.activeTab !== 'logo') return;
                setHighFidelity(!ls.highFidelity);
                if (ls.colorsAnalyzed && le.sourceImage.src) {
                    ls.colorsAnalyzed = false;
                    if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
                    le.statusText.textContent = 'Fidelity changed. Re-analyze colors.';
                }
            });
        }

        if (le.objThicknessSlider && le.objThicknessValue) {
            le.objThicknessValue.textContent = le.objThicknessSlider.value;
            le.objThicknessSlider.addEventListener('input', () => {
                le.objThicknessValue.textContent = le.objThicknessSlider.value;
                updateFilteredPreview();
            });
        }
        if (le.objDetailSlider && le.objDetailValue) {
            le.objDetailValue.textContent = le.objDetailSlider.value;
            le.objDetailSlider.addEventListener('input', () => {
                le.objDetailValue.textContent = le.objDetailSlider.value;
                updateFilteredPreview();
            });
        }
        if (le.objBedSelect) {
            le.objBedSelect.addEventListener('change', () => updateFilteredPreview());
        }
        if (le.objMarginInput) {
            le.objMarginInput.addEventListener('input', () => updateFilteredPreview());
        }
        if (le.exportObjBtn) {
            le.exportObjBtn.addEventListener('click', () => objExporter.exportAsOBJ());
        }
        if (le.export3mfBtn) {
            le.export3mfBtn.addEventListener('click', () => objExporter.exportAs3MF());
        }
        if (le.exportStlBtn) {
            le.exportStlBtn.addEventListener('click', () => objExporter.exportAsSTL());
        }

        setupZoomControls();
        objPreview.bindControls();

        if (le.useBaseLayerCheckbox) {
            le.useBaseLayerCheckbox.addEventListener('change', (e) => {
                ls.useBaseLayer = e.target.checked;
                if (le.baseLayerSelect) le.baseLayerSelect.disabled = !e.target.checked;
                objPreview.render();
            });
            ls.useBaseLayer = le.useBaseLayerCheckbox.checked;
        }
        if (le.baseLayerSelect) {
            le.baseLayerSelect.addEventListener('change', (e) => {
                ls.baseLayerIndex = parseInt(e.target.value, 10);
                objPreview.render();
            });
        }

        if (le.previewResolution) {
            le.previewResolution.addEventListener('change', () => {
                if (state.activeTab !== 'logo') return;
                if (ls.tracedata) {
                    renderPreviews();
                    updateFilteredPreview();
                }
            });
        }

        document.querySelectorAll('.control-panel input[type="range"]').forEach((slider) => {
            slider.addEventListener('input', (e) => {
                if (state.activeTab !== 'logo') return;
                if (e.target.id === 'obj-thickness' || e.target.id === 'obj-detail') {
                    return;
                }
                if (!ls.isDirty) {
                    ls.isDirty = true;
                    le.resetBtn.style.display = 'inline';
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
                    if (ls.colorsAnalyzed && le.sourceImage.src) {
                        ls.colorsAnalyzed = false;
                        if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
                    }
                    if (e.target.id === 'max-colors') {
                        updateColorCountNotice();
                    }
                } else if (ls.colorsAnalyzed) {
                    debounceOptimizePaths();
                }
            });
        });

        if (le.savePngBtn) le.savePngBtn.addEventListener('click', saveOriginalAsPNG);
        if (le.saveJpgBtn) le.saveJpgBtn.addEventListener('click', saveOriginalAsJPG);
        if (le.saveSvgBtn) le.saveSvgBtn.addEventListener('click', saveOriginalAsSVG);

        if (le.exportLayersBtn) {
            le.exportLayersBtn.addEventListener('click', () => {
                if (!ls.tracedata) return;
                const visibleIndices = getVisibleLayerIndices();
                if (!visibleIndices.length) return;

                const imageName = getImageBaseName();

                if (ls.mergeRules && ls.mergeRules.length > 0) {
                    const mergedData = createMergedTracedata(ls.tracedata, visibleIndices, ls.mergeRules);
                    const layerIndices = [];
                    for (let i = 0; i < mergedData.layers.length; i++) {
                        if (layerHasPaths(mergedData.layers[i])) {
                            layerIndices.push(i);
                        }
                    }

                    layerIndices.forEach((idx) => {
                        const singleLayer = buildTracedataSubset(mergedData, [idx]);
                        downloadSVG(tracer.getsvgstring(singleLayer, ls.lastOptions), `${imageName}_final_layer_${idx}`);
                    });
                } else {
                    visibleIndices.forEach((idx) => {
                        const singleLayer = buildTracedataSubset(ls.tracedata, [idx]);
                        downloadSVG(tracer.getsvgstring(singleLayer, ls.lastOptions), `${imageName}_layer_${idx}`);
                    });
                }
            });
        }

        if (le.downloadSilhouetteBtn) {
            le.downloadSilhouetteBtn.addEventListener('click', () => {
                if (!ls.silhouetteTracedata) return;
                downloadSVG(tracer.getsvgstring(ls.silhouetteTracedata, ls.lastOptions), `${getImageBaseName()}_silhouette`);
            });
        }

        if (le.downloadCombinedLayersBtn) {
            le.downloadCombinedLayersBtn.addEventListener('click', () => {
                if (!ls.tracedata) return;
                const visibleIndices = getVisibleLayerIndices();
                if (!visibleIndices.length) return;

                const dataToExport = ls.mergeRules && ls.mergeRules.length > 0
                    ? createMergedTracedata(ls.tracedata, visibleIndices, ls.mergeRules)
                    : buildTracedataSubset(ls.tracedata, visibleIndices);

                if (!dataToExport) return;
                downloadSVG(tracer.getsvgstring(dataToExport, ls.lastOptions), `${getImageBaseName()}_combined_layers`);
            });
        }

        if (le.addMergeRuleBtn) {
            le.addMergeRuleBtn.addEventListener('click', () => {
                const ruleIndex = ls.mergeRules.length;
                const visibleIndices = getVisibleLayerIndices();
                if (visibleIndices.length < 2) return;

                const defaultRule = { source: 0, target: 1 };
                ls.mergeRules.push(defaultRule);

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
                le.mergeRulesContainer.appendChild(row);
                updateMergeRuleSwatches(row, defaultRule, visibleIndices);
                if (le.combineAndDownloadBtn) le.combineAndDownloadBtn.disabled = false;
                updateFinalPalette();
                updateFilteredPreview();
            });
        }

        if (le.mergeRulesContainer) {
            le.mergeRulesContainer.addEventListener('change', (e) => {
                if (e.target.tagName === 'SELECT') {
                    const ruleIndex = parseInt(e.target.dataset.ruleIndex, 10);
                    const type = e.target.dataset.type;
                    ls.mergeRules[ruleIndex][type] = parseInt(e.target.value, 10);
                    const visibleIndices = getVisibleLayerIndices();
                    updateMergeRuleSwatches(e.target.parentElement, ls.mergeRules[ruleIndex], visibleIndices);
                    updateFinalPalette();
                    updateFilteredPreview();
                }
            });

            le.mergeRulesContainer.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') {
                    const ruleIndex = parseInt(e.target.dataset.ruleIndex, 10);
                    ls.mergeRules.splice(ruleIndex, 1);
                    e.target.parentElement.remove();

                    document.querySelectorAll('#logo-merge-rules-container > div').forEach((row, i) => {
                        row.querySelectorAll('[data-rule-index]').forEach(el => {
                            el.dataset.ruleIndex = i;
                        });
                    });
                    if (ls.mergeRules.length === 0 && le.combineAndDownloadBtn) {
                        le.combineAndDownloadBtn.disabled = true;
                    }
                    updateFinalPalette();
                    updateFilteredPreview();
                }
            });
        }

        if (le.combineAndDownloadBtn) {
            le.combineAndDownloadBtn.addEventListener('click', () => {
                const visibleIndices = getVisibleLayerIndices();
                const mergedData = createMergedTracedata(ls.tracedata, visibleIndices, ls.mergeRules);
                if (!mergedData) return;

                const finalIndices = [];
                for (let i = 0; i < mergedData.layers.length; i++) {
                    if (layerHasPaths(mergedData.layers[i])) {
                        finalIndices.push(i);
                    }
                }

                finalIndices.forEach((idx, ord) => {
                    const singleLayer = buildTracedataSubset(mergedData, [idx]);
                    downloadSVG(tracer.getsvgstring(singleLayer, ls.lastOptions), `${getImageBaseName()}_final_layer_${ord + 1}`);
                });
            });
        }

        const layersToggle = document.getElementById('logo-layers-toggle');
        const layersSection = document.getElementById('logo-layers-section');
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

        elements.sourceImage.addEventListener('load', onSourceImageLoaded);
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
