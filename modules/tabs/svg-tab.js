import { SLIDER_TOOLTIPS, TRANSPARENT_ALPHA_CUTOFF } from '../config.js';
import { createObjPreview } from '../preview3d.js';
import { createObjExporter } from '../export3d.js';
import { hasTransparentPixels, markTransparentPixels, stripTransparentPalette } from '../shared/image-utils.js';
import { debounce, layerHasPaths, buildTracedataSubset, createMergedTracedata, createSolidSilhouette, assess3DPrintQuality } from '../shared/trace-utils.js';
import { saveInitialSliderValues, updateAllSliderDisplays, resetSlidersToInitial } from '../shared/slider-manager.js';
import { createZoomPanController } from '../shared/zoom-pan.js';
import { svgToPng } from '../shared/svg-renderer.js';
import { createPaletteManager } from '../shared/palette-manager.js';

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

    // ── Debounced re-trace ─────────────────────────────────────────────────────

    const debounceOptimizePaths = debounce(() => {
        if (state.colorsAnalyzed) optimizePathsClick();
    });

    // ── Fidelity ───────────────────────────────────────────────────────────────

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
            updateAllSliderDisplays(elements);
        }
    }

    // ── Tracing options ────────────────────────────────────────────────────────

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

    // ── Color analysis ─────────────────────────────────────────────────────────

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
        if (!elements.colorCountNotice || !elements.sourceImage.src) return;

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
                    if (!state.quantizedData?.palette) throw new Error('Color analysis failed.');

                    if (hasTransparentPixels(imageData)) {
                        markTransparentPixels(state.quantizedData, imageData);
                        stripTransparentPalette(state.quantizedData);
                    } else {
                        state.quantizedData.palette.forEach(c => { c.a = 255; });
                    }

                    if (!state.quantizedData.palette.length) throw new Error('No opaque pixels found.');
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

    // ── Layer helpers ──────────────────────────────────────────────────────────

    function getVisibleLayerIndices() {
        if (!state.tracedata) return [];
        const indices = [];
        for (let i = 0; i < state.tracedata.layers.length; i++) {
            if (layerHasPaths(state.tracedata.layers[i])) indices.push(i);
        }
        return indices;
    }

    function getDataToExport() {
        if (!state.tracedata) return null;
        const visibleIndices = getVisibleLayerIndices();
        if (!visibleIndices.length) return null;
        if (state.mergeRules?.length > 0) {
            return createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
        }
        return buildTracedataSubset(state.tracedata, visibleIndices);
    }

    // ── Quality display ────────────────────────────────────────────────────────

    function updateQualityDisplay(quality) {
        if (elements.qualityIndicator) {
            elements.qualityIndicator.textContent = `${quality.pathCount} paths, ${quality.colorCount} colors`;
        }
    }

    // ── 3D preview / exporter ──────────────────────────────────────────────────

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

    // ── Tracing ────────────────────────────────────────────────────────────────

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
                        tracedata.layers.push(tracer.batchtracepaths(
                            tracer.internodes(
                                tracer.pathscan(tracer.layeringstep(ii, colornum), options.pathomit),
                                options
                            ),
                            options.ltres, options.qtres
                        ));
                    }

                    state.tracedata = tracedata;
                    state.silhouetteTracedata = createSolidSilhouette(state.tracedata, getVisibleLayerIndices);

                    palette.displayPalette();
                    palette.prepareMergeUIAfterGeneration();

                    elements.outputSection.style.display = 'flex';
                    setTimeout(() => updateSegmentedControlIndicator(), 100);

                    await renderPreviews();
                    await updateFilteredPreview();

                    updateQualityDisplay(assess3DPrintQuality(state.tracedata, getVisibleLayerIndices));
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

    // ── Zoom / pan ─────────────────────────────────────────────────────────────

    const { setupZoomControls, zoomPreview, resetZoom } = createZoomPanController({
        st: state,
        idPrefix: ''
    });

    // ── SVG preview rendering ──────────────────────────────────────────────────

    async function renderPreviews() {
        if (!state.tracedata || !elements.svgPreview) return;
        try {
            const visibleIndices = getVisibleLayerIndices();
            const previewData = buildTracedataSubset(state.tracedata, visibleIndices);
            const svgString = tracer.getsvgstring(previewData, state.lastOptions);
            const pngDataUrl = await svgToPng(svgString, null, null, true, elements.previewResolution);
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
            const pngDataUrl = await svgToPng(svgString, null, null, false, elements.previewResolution);
            elements.svgPreviewFiltered.src = pngDataUrl;
            elements.svgPreviewFiltered.style.display = 'block';
        } catch (error) {
            console.error('Filtered preview rendering failed:', error);
            elements.svgPreviewFiltered.style.display = 'none';
        }
    }

    // ── Download buttons ───────────────────────────────────────────────────────

    function disableDownloadButtons() {
        [
            elements.exportLayersBtn,
            elements.combineAndDownloadBtn,
            elements.downloadCombinedLayersBtn,
            elements.exportObjBtn,
            elements.export3mfBtn
        ].forEach(btn => { if (btn) btn.disabled = true; });
    }

    function enableDownloadButtons() {
        [
            elements.exportLayersBtn,
            elements.exportObjBtn,
            elements.export3mfBtn
        ].forEach(btn => { if (btn) btn.disabled = false; });
        if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = state.mergeRules.length === 0;
        if (elements.downloadCombinedLayersBtn) elements.downloadCombinedLayersBtn.disabled = false;
    }

    // ── Palette manager ────────────────────────────────────────────────────────

    const palette = createPaletteManager({
        st: state,
        el: elements,
        getVisibleLayerIndices,
        updateFilteredPreview
    });

    // ── Original image saves ───────────────────────────────────────────────────

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    function onSourceImageLoaded() {
        syncWorkspaceView();
        elements.analyzeColorsBtn.disabled = false;

        const w = elements.sourceImage.naturalWidth;
        const h = elements.sourceImage.naturalHeight;
        elements.originalResolution.textContent = `${w}×${h} px`;

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
        saveInitialSliderValues(state, elements);
        elements.analyzeColorsBtn.click();

        if (state.activeTab === 'svg') {
            onTabActivated();
        }

        showLoader(false);
    }

    function onTabActivated() {
        if (!hasSingleImageLoaded()) return;
        objPreview.render();
    }

    // ── Event binding ──────────────────────────────────────────────────────────

    function bindEvents() {
        if (elements.analyzeColorsBtn) {
            elements.analyzeColorsBtn.addEventListener('click', analyzeColorsClick);
        }
        if (elements.optimizePathsBtn) {
            elements.optimizePathsBtn.addEventListener('click', optimizePathsClick);
        }
        if (elements.resetBtn) {
            elements.resetBtn.addEventListener('click', () => resetSlidersToInitial(state, elements));
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
        if (elements.objScaleSlider && elements.objScaleValue) {
            elements.objScaleValue.textContent = elements.objScaleSlider.value;
            elements.objScaleSlider.addEventListener('input', () => {
                elements.objScaleValue.textContent = elements.objScaleSlider.value;
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

        setupZoomControls(['all', 'selected']);
        objPreview.bindControls();

        if (elements.useBaseLayerCheckbox) {
            elements.useBaseLayerCheckbox.addEventListener('change', (e) => {
                state.useBaseLayer = e.target.checked;
                if (elements.baseLayerSelect) elements.baseLayerSelect.disabled = !e.target.checked;
                updateFilteredPreview();
            });
            state.useBaseLayer = elements.useBaseLayerCheckbox.checked;
            if (elements.baseLayerSelect) elements.baseLayerSelect.disabled = !elements.useBaseLayerCheckbox.checked;
        }
        if (elements.baseLayerSelect) {
            elements.baseLayerSelect.addEventListener('change', (e) => {
                state.baseLayerIndex = parseInt(e.target.value, 10);
                updateFilteredPreview();
            });
        }

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
                if (e.target.id === 'obj-thickness' || e.target.id === 'obj-scale') return;
                if (!state.isDirty) {
                    state.isDirty = true;
                    elements.resetBtn.style.display = 'inline';
                }
                updateAllSliderDisplays(elements);

                const tooltipEl = document.getElementById(`${e.target.id}-tooltip`);
                if (tooltipEl) {
                    tooltipEl.textContent = SLIDER_TOOLTIPS[e.target.id];
                    tooltipEl.style.opacity = '1';
                    clearTimeout(state.tooltipTimeout);
                    state.tooltipTimeout = setTimeout(() => { tooltipEl.style.opacity = '0'; }, 2000);
                }

                if (e.target.id === 'color-precision' || e.target.id === 'max-colors') {
                    if (state.colorsAnalyzed && elements.sourceImage.src) {
                        state.colorsAnalyzed = false;
                        if (elements.optimizePathsBtn) elements.optimizePathsBtn.disabled = true;
                    }
                    if (e.target.id === 'max-colors') updateColorCountNotice();
                } else if (state.colorsAnalyzed) {
                    debounceOptimizePaths();
                }
            });
        });

        if (elements.exportLayersBtn) {
            elements.exportLayersBtn.addEventListener('click', () => {
                if (!state.tracedata) return;
                const visibleIndices = getVisibleLayerIndices();
                if (!visibleIndices.length) return;
                const imageName = getImageBaseName();

                if (state.mergeRules?.length > 0) {
                    const mergedData = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
                    const layerIndices = [];
                    for (let i = 0; i < mergedData.layers.length; i++) {
                        if (layerHasPaths(mergedData.layers[i])) layerIndices.push(i);
                    }
                    layerIndices.forEach((idx) => {
                        downloadSVG(tracer.getsvgstring(buildTracedataSubset(mergedData, [idx]), state.lastOptions), `${imageName}_final_layer_${idx}`);
                    });
                } else {
                    visibleIndices.forEach((idx) => {
                        downloadSVG(tracer.getsvgstring(buildTracedataSubset(state.tracedata, [idx]), state.lastOptions), `${imageName}_layer_${idx}`);
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
                const dataToExport = state.mergeRules?.length > 0
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
                palette.updateMergeRuleSwatches(row, defaultRule, visibleIndices);
                if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = false;
                palette.updateFinalPalette();
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
                    palette.updateMergeRuleSwatches(e.target.parentElement, state.mergeRules[ruleIndex], visibleIndices);
                    palette.updateFinalPalette();
                    updateFilteredPreview();
                }
            });

            elements.mergeRulesContainer.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') {
                    const ruleIndex = parseInt(e.target.dataset.ruleIndex, 10);
                    state.mergeRules.splice(ruleIndex, 1);
                    e.target.parentElement.remove();
                    document.querySelectorAll('#merge-rules-container > div').forEach((row, i) => {
                        row.querySelectorAll('[data-rule-index]').forEach(el => { el.dataset.ruleIndex = i; });
                    });
                    if (state.mergeRules.length === 0 && elements.combineAndDownloadBtn) {
                        elements.combineAndDownloadBtn.disabled = true;
                    }
                    palette.updateFinalPalette();
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
                    if (layerHasPaths(mergedData.layers[i])) finalIndices.push(i);
                }
                finalIndices.forEach((idx, ord) => {
                    downloadSVG(tracer.getsvgstring(buildTracedataSubset(mergedData, [idx]), state.lastOptions), `${getImageBaseName()}_final_layer_${ord + 1}`);
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
        setHighFidelity,
        updateColorCountNotice,
        renderPreviews,
        updateFilteredPreview
    };
}
