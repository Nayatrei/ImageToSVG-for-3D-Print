import { SLIDER_TOOLTIPS, TRANSPARENT_ALPHA_CUTOFF } from '../config.js';
import { createObjPreview } from '../preview3d.js';
import { createObjExporter } from '../export3d.js';
import { hasTransparentPixels, markTransparentPixels, stripTransparentPalette, remapQuantizedPaletteToColors } from '../shared/image-utils.js';
import { debounce, layerHasPaths, buildTracedataSubset, createMergedTracedata, createSolidSilhouette, assess3DPrintQuality } from '../shared/trace-utils.js';
import { saveInitialSliderValues, updateAllSliderDisplays, resetSlidersToInitial } from '../shared/slider-manager.js';
import { createZoomPanController } from '../shared/zoom-pan.js';
import { svgToPng } from '../shared/svg-renderer.js';
import { createPaletteManager } from '../shared/palette-manager.js';
import { HTML_PRESETS, createHtmlEditor, extractDeclaredHtmlColors } from './logo/html-editor.js?v=4';

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

    // ── Logo-local element aliases ─────────────────────────────────────────────
    // `le` remaps logo-prefixed DOM elements to the same property names used by
    // shared utilities, so shared code receives a consistent element interface.
    const le = {
        ...elements,
        svgSourceMirror: elements.logoSvgSourceMirror,
        svgPreview: elements.logoSvgPreview,
        objPreviewCanvas: elements.logoObjPreviewCanvas,
        objPreviewPlaceholder: elements.logoObjPreviewPlaceholder,
        objBuildPlateToggle: elements.logoObjBuildPlateToggle,
        objPreviewBedSelect: elements.logoObjPreviewBedSelect,
        objBedSelect: elements.logoObjPreviewBedSelect,
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
        exportObjBtn: elements.logoExportObjBtn,
        export3mfBtn: elements.logoExport3mfBtn,
        exportStlBtn: elements.logoExportStlBtn,
        objScaleSlider: elements.logoObjScaleSlider,
        objScaleValue: elements.logoObjScaleValue,
        objThicknessSlider: elements.logoObjThicknessSlider,
        objThicknessValue: elements.logoObjThicknessValue,
        objMarginInput: elements.logoObjMarginInput,
        objSizeReadout: elements.logoObjSizeReadout,
        objStructureWarning: elements.logoObjStructureWarning,
        originalResolution: elements.logoOriginalResolution,
        htmlSourceImg: elements.logoHtmlSourceImg,
        htmlInput: elements.logoHtmlInput,
        htmlStatus: elements.logoHtmlStatus,
        htmlModeToggle: elements.logoHtmlModeToggle,
        htmlEditorBody: elements.logoHtmlEditorBody,
        htmlFontSelect: elements.logoHtmlFontSelect,
    };

    // Returns the active source image (HTML-rendered or imported)
    function getLogoSourceImage() {
        return ls.htmlModeActive && le.htmlSourceImg ? le.htmlSourceImg : le.sourceImage;
    }

    function hasLogoSourceLoaded() {
        const source = getLogoSourceImage();
        return Boolean(source?.src && source.naturalWidth && source.naturalHeight);
    }

    // ── Debounced re-trace ─────────────────────────────────────────────────────

    const debounceOptimizePaths = debounce(() => {
        if (ls.colorsAnalyzed) optimizePathsClick();
    });

    // ── Fidelity ───────────────────────────────────────────────────────────────

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
            updateAllSliderDisplays(le);
        }
    }

    // ── Tracing options ────────────────────────────────────────────────────────

    function getDeclaredHtmlColors(source = null) {
        if (!ls.htmlModeActive) {
            ls.htmlDeclaredColors = [];
            return [];
        }

        const declaredColors = Array.isArray(source)
            ? source
            : extractDeclaredHtmlColors(le.htmlInput?.value || '');
        ls.htmlDeclaredColors = declaredColors;
        return declaredColors;
    }

    function queueAutoBaseSelection() {
        ls.autoBaseLayerSelectionPending = true;
    }

    function buildOptimizedOptions({ htmlDeclaredColors = null } = {}) {
        const P = parseInt(le.pathSimplificationSlider.value, 10);
        const C = parseInt(le.cornerSharpnessSlider.value, 10);
        const S = parseInt(le.curveStraightnessSlider.value, 10);
        const CP = parseInt(le.colorPrecisionSlider.value, 10);
        const MC = le.maxColorsSlider ? parseInt(le.maxColorsSlider.value, 10) : 4;

        const map = (t, a, b) => (a + (b - a) * (t / 100));
        const mapInv = (t, a, b) => (a + (b - a) * (1 - (t / 100)));

        // HTML mode: flat-color content — derive color count from declared CSS colors,
        // but still respect the shared tracing sliders so logo tuning matches the SVG tab.
        if (ls.htmlModeActive) {
            const declaredColors = getDeclaredHtmlColors(htmlDeclaredColors);
            const declaredColorCount = Math.max(2, declaredColors.length || 3);
            const edgeAllowance = Math.max(0, Math.round(CP / (ls.highFidelity ? 24 : 32))) + (ls.highFidelity ? 1 : 0);
            const requestedColorCount = declaredColorCount + edgeAllowance;
            const colorCount = Number.isNaN(MC)
                ? requestedColorCount
                : Math.max(2, Math.min(Math.max(2, MC), requestedColorCount));
            return Object.assign({}, tracer.optionpresets.default, {
                viewbox: true,
                strokewidth: 0,
                numberofcolors: colorCount,
                colorsampling: 2,
                colorquantcycles: Math.max(ls.highFidelity ? 10 : 6, Math.round(map(CP, ls.highFidelity ? 12 : 8, ls.highFidelity ? 24 : 18))),
                pathomit: Math.round(map(P, 0, ls.highFidelity ? 1 : 2)),
                ltres: +map(S, ls.highFidelity ? 0.02 : 0.03, ls.highFidelity ? 0.45 : 0.7).toFixed(2),
                qtres: +mapInv(C, ls.highFidelity ? 0.45 : 0.6, 0.04).toFixed(2),
                blurradius: +map(P, 0, ls.highFidelity ? 0.08 : 0.14).toFixed(2),
                roundcoords: 1,
                rightangleenhance: true,
                mincolorratio: +mapInv(CP, 0.01, 0).toFixed(3),
            });
        }

        const options = Object.assign({}, tracer.optionpresets.default, {
            viewbox: true,
            strokewidth: 0
        });

        if (ls.highFidelity) {
            const _src = getLogoSourceImage();
            const rel = Math.max(0.5, Math.sqrt(_src.naturalWidth * _src.naturalHeight) / 512);
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

    function findLargestBackgroundLayerIndex(tracedata) {
        if (!tracedata?.layers?.length) return -1;

        let largestIndex = -1;
        let largestArea = -1;

        tracedata.layers.forEach((layer, index) => {
            if (!Array.isArray(layer) || !layer.length) return;
            const layerArea = layer.reduce((maxArea, path) => {
                if (path?.isholepath) return maxArea;
                const bb = path?.boundingbox;
                if (!bb) return maxArea;
                return Math.max(maxArea, (bb[2] - bb[0]) * (bb[3] - bb[1]));
            }, 0);

            if (layerArea > largestArea) {
                largestArea = layerArea;
                largestIndex = index;
            }
        });

        return largestIndex;
    }

    function cleanupHtmlBackgroundLayer(tracedata) {
        if (!ls.htmlModeActive || !tracedata?.layers?.length) return tracedata;

        const backgroundLayerIndex = findLargestBackgroundLayerIndex(tracedata);
        if (backgroundLayerIndex < 0) return tracedata;

        tracedata.layers = tracedata.layers.map((layer, index) => {
            if (index !== backgroundLayerIndex || !Array.isArray(layer)) return layer;
            return layer.filter((path) => !path.isholepath).map((path) => ({ ...path, holechildren: [] }));
        });

        const order = tracedata.layers.map((_, index) => index).sort((a, b) => {
            if (a === backgroundLayerIndex) return -1;
            if (b === backgroundLayerIndex) return 1;
            return a - b;
        });

        tracedata.layers = order.map((index) => tracedata.layers[index]);
        tracedata.palette = order.map((index) => tracedata.palette[index]);
        return tracedata;
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
        if (!le.colorCountNotice) return;
        if (!hasLogoSourceLoaded()) {
            le.colorCountNotice.style.display = 'none';
            return;
        }

        const maxColors = le.maxColorsSlider ? parseInt(le.maxColorsSlider.value, 10) : 4;
        const canvas = document.createElement('canvas');
        const srcImg = getLogoSourceImage();
        const w = srcImg.naturalWidth;
        const h = srcImg.naturalHeight;
        if (!w || !h) {
            le.colorCountNotice.style.display = 'none';
            return;
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(srcImg, 0, 0, w, h);
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

    async function analyzeColors() {
        showLoader(true);
        le.statusText.textContent = 'Analyzing colors...';
        disableDownloadButtons();

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const srcImg = getLogoSourceImage();
                    const width = srcImg.naturalWidth;
                    const height = srcImg.naturalHeight;
                    if (!width || !height) throw new Error('Invalid image dimensions');

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(srcImg, 0, 0, width, height);
                    const imageData = ctx.getImageData(0, 0, width, height);

                    const declaredHtmlColors = ls.htmlModeActive ? getDeclaredHtmlColors() : [];
                    const options = buildOptimizedOptions({ htmlDeclaredColors: declaredHtmlColors });
                    if (!ls.htmlModeActive) {
                        const MC = le.maxColorsSlider ? parseInt(le.maxColorsSlider.value, 10) : 4;
                        const dominantColorCount = estimateDominantColors(imageData);
                        if (dominantColorCount && dominantColorCount > MC) {
                            options.numberofcolors = Math.min(options.numberofcolors, dominantColorCount);
                        }
                        options.numberofcolors = Math.max(MC, options.numberofcolors);
                    }
                    ls.lastOptions = options;

                    ls.quantizedData = tracer.colorquantization(imageData, options);
                    if (!ls.quantizedData?.palette) throw new Error('Color analysis failed.');

                    if (hasTransparentPixels(imageData)) {
                        markTransparentPixels(ls.quantizedData, imageData);
                        stripTransparentPalette(ls.quantizedData);
                    } else {
                        ls.quantizedData.palette.forEach(c => { c.a = 255; });
                    }

                    if (ls.htmlModeActive && declaredHtmlColors.length > 0) {
                        remapQuantizedPaletteToColors(ls.quantizedData, declaredHtmlColors);
                    }

                    if (!ls.quantizedData.palette.length) throw new Error('No opaque pixels found.');
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

    async function analyzeColorsClick() {
        ls.layerThicknessById = {};
        await analyzeColors();
        ls.colorsAnalyzed = true;
        await optimizePathsClick();
    }

    async function optimizePathsClick() {
        if (!ls.quantizedData) return;
        queueAutoBaseSelection();
        await traceVectorPaths();
    }

    // ── HTML editor ────────────────────────────────────────────────────────────

    const htmlEditor = createHtmlEditor({
        ls,
        le,
        elements,
        syncWorkspaceView,
        analyzeColorsClick
    });

    // ── Layer helpers ──────────────────────────────────────────────────────────

    function getVisibleLayerIndices() {
        if (!ls.tracedata) return [];
        const indices = [];
        for (let i = 0; i < ls.tracedata.layers.length; i++) {
            if (layerHasPaths(ls.tracedata.layers[i])) indices.push(i);
        }
        return indices;
    }

    function getDataToExport() {
        if (!ls.tracedata) return null;
        const visibleIndices = getVisibleLayerIndices();
        if (!visibleIndices.length) return null;
        if (ls.mergeRules?.length > 0) {
            return createMergedTracedata(ls.tracedata, visibleIndices, ls.mergeRules);
        }
        return buildTracedataSubset(ls.tracedata, visibleIndices);
    }

    // ── Quality display ────────────────────────────────────────────────────────

    function updateQualityDisplay(quality) {
        if (le.qualityIndicator) {
            le.qualityIndicator.textContent = `${quality.pathCount} paths, ${quality.colorCount} colors`;
        }
    }

    // ── 3D preview / exporter ──────────────────────────────────────────────────

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

    // ── Tracing ────────────────────────────────────────────────────────────────

    async function traceVectorPaths() {
        if (!ls.quantizedData) return;
        showLoader(true);
        le.statusText.textContent = 'Tracing vector paths...';
        if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const options = buildOptimizedOptions({ htmlDeclaredColors: ls.htmlDeclaredColors });
                    ls.lastOptions = options;

                    const ii = ls.quantizedData;
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

                    if (ls.htmlModeActive) {
                        cleanupHtmlBackgroundLayer(tracedata);
                    }

                    ls.tracedata = tracedata;
                    ls.silhouetteTracedata = createSolidSilhouette(ls.tracedata, getVisibleLayerIndices);

                    palette.displayPalette();
                    palette.prepareMergeUIAfterGeneration();

                    le.outputSection.style.display = 'flex';
                    setTimeout(() => updateSegmentedControlIndicator(), 100);

                    await renderPreviews();
                    await updateFilteredPreview();

                    updateQualityDisplay(assess3DPrintQuality(ls.tracedata, getVisibleLayerIndices));
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

    // ── Zoom / pan ─────────────────────────────────────────────────────────────

    const { setupZoomControls } = createZoomPanController({
        st: ls,
        idPrefix: 'logo-'
    });

    // ── SVG preview rendering ──────────────────────────────────────────────────

    async function renderPreviews() {
        if (!ls.tracedata || !le.svgPreview) return;
        try {
            const visibleIndices = getVisibleLayerIndices();
            const previewData = buildTracedataSubset(ls.tracedata, visibleIndices);
            const svgString = tracer.getsvgstring(previewData, ls.lastOptions);
            const pngDataUrl = await svgToPng(svgString, null, null, true, le.previewResolution);
            le.svgPreview.src = pngDataUrl;
            le.svgPreview.style.display = 'block';
        } catch (error) {
            console.error('Preview rendering failed:', error);
            le.svgPreview.style.display = 'none';
        }
    }

    function updateFilteredPreview() {
        objPreview.render();
    }

    // ── Download buttons ───────────────────────────────────────────────────────

    function disableDownloadButtons() {
        [
            le.exportObjBtn,
            le.export3mfBtn,
            le.exportStlBtn
        ].forEach(btn => { if (btn) btn.disabled = true; });
    }

    function enableDownloadButtons() {
        [
            le.exportObjBtn,
            le.export3mfBtn,
            le.exportStlBtn
        ].forEach(btn => { if (btn) btn.disabled = false; });
    }

    // ── Palette manager ────────────────────────────────────────────────────────

    const palette = createPaletteManager({
        st: ls,
        el: le,
        getVisibleLayerIndices,
        updateFilteredPreview
    });

    // ── Original image saves ───────────────────────────────────────────────────

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    function onSourceImageLoaded() {
        // Importing an image auto-switches to image mode so the pipeline traces it
        if (ls.htmlModeActive) {
            htmlEditor.setHtmlMode(false);
        }
        ls.htmlDeclaredColors = [];

        if (elements.logoSvgSourceMirror && elements.sourceImage.src) {
            elements.logoSvgSourceMirror.src = elements.sourceImage.src;
        }

        syncWorkspaceView();
        le.analyzeColorsBtn.disabled = false;
        ls.sourceRenderScale = 1;

        const w = le.sourceImage.naturalWidth;
        const h = le.sourceImage.naturalHeight;
        le.originalResolution.textContent = `${w}×${h} px`;

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
        saveInitialSliderValues(ls, le);
        le.analyzeColorsBtn.click();

        if (state.activeTab === 'logo') {
            onTabActivated();
        } else {
            ls.colorsAnalyzed = false;
            if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
        }

        showLoader(false);
    }

    function onTabActivated() {
        if (ls.htmlModeActive) {
            if (!ls.colorsAnalyzed && le.htmlInput?.value.trim()) {
                htmlEditor.triggerHtmlRender();
            } else if (ls.colorsAnalyzed) {
                objPreview.render();
            }
            return;
        }

        if (!hasSingleImageLoaded()) return;
        if (!ls.colorsAnalyzed) {
            analyzeColorsClick();
        } else {
            objPreview.render();
        }
    }

    // ── Event binding ──────────────────────────────────────────────────────────

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
            le.resetBtn.addEventListener('click', () => {
                if (ls.htmlModeActive && le.htmlInput?.value.trim()) {
                    if (!ls.initialSliderValues) return;
                    le.pathSimplificationSlider.value = ls.initialSliderValues.pathSimplification;
                    le.cornerSharpnessSlider.value = ls.initialSliderValues.cornerSharpness;
                    le.curveStraightnessSlider.value = ls.initialSliderValues.curveStraightness;
                    le.colorPrecisionSlider.value = ls.initialSliderValues.colorPrecision;
                    if (le.maxColorsSlider) {
                        le.maxColorsSlider.value = ls.initialSliderValues.maxColors;
                    }
                    updateAllSliderDisplays(le);
                    ls.colorsAnalyzed = false;
                    if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
                    ls.isDirty = false;
                    le.resetBtn.style.display = 'none';
                    analyzeColorsClick();
                    return;
                }
                resetSlidersToInitial(ls, le);
            });
        }
        if (le.toggleFidelityBtn) {
            le.toggleFidelityBtn.addEventListener('click', () => {
                if (state.activeTab !== 'logo') return;
                setHighFidelity(!ls.highFidelity);
                if (ls.colorsAnalyzed && hasLogoSourceLoaded()) {
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

        if (le.objScaleSlider && le.objScaleValue) {
            le.objScaleValue.textContent = le.objScaleSlider.value;
            le.objScaleSlider.addEventListener('input', () => {
                le.objScaleValue.textContent = le.objScaleSlider.value;
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

        setupZoomControls(['all']);
        objPreview.bindControls();

        if (le.useBaseLayerCheckbox) {
            le.useBaseLayerCheckbox.addEventListener('change', (e) => {
                ls.autoBaseLayerSelectionPending = false;
                ls.useBaseLayer = e.target.checked;
                if (le.baseLayerSelect) le.baseLayerSelect.disabled = !e.target.checked;
                objPreview.render();
            });
            ls.useBaseLayer = le.useBaseLayerCheckbox.checked;
        }
        if (le.baseLayerSelect) {
            le.baseLayerSelect.addEventListener('change', (e) => {
                ls.autoBaseLayerSelectionPending = false;
                ls.baseSourceLayerId = Number.parseInt(e.target.value, 10);
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
                if (e.target.id === 'obj-thickness' || e.target.id === 'obj-scale') return;
                if (!ls.isDirty) {
                    ls.isDirty = true;
                    le.resetBtn.style.display = 'inline';
                }
                updateAllSliderDisplays(le);

                const tooltipEl = document.getElementById(`${e.target.id}-tooltip`);
                if (tooltipEl) {
                    tooltipEl.textContent = SLIDER_TOOLTIPS[e.target.id];
                    tooltipEl.style.opacity = '1';
                    clearTimeout(state.tooltipTimeout);
                    state.tooltipTimeout = setTimeout(() => { tooltipEl.style.opacity = '0'; }, 2000);
                }

                if (e.target.id === 'color-precision' || e.target.id === 'max-colors') {
                    if (ls.colorsAnalyzed && hasLogoSourceLoaded()) {
                        ls.colorsAnalyzed = false;
                        if (le.optimizePathsBtn) le.optimizePathsBtn.disabled = true;
                    }
                    if (e.target.id === 'max-colors') updateColorCountNotice();
                } else if (ls.colorsAnalyzed) {
                    debounceOptimizePaths();
                }
            });
        });

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
                palette.updateMergeRuleSwatches(row, defaultRule, visibleIndices);
                palette.updateFinalPalette();
                queueAutoBaseSelection();
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
                    palette.updateMergeRuleSwatches(e.target.parentElement, ls.mergeRules[ruleIndex], visibleIndices);
                    palette.updateFinalPalette();
                    queueAutoBaseSelection();
                    updateFilteredPreview();
                }
            });

            le.mergeRulesContainer.addEventListener('click', (e) => {
                if (e.target.tagName === 'BUTTON') {
                    const ruleIndex = parseInt(e.target.dataset.ruleIndex, 10);
                    ls.mergeRules.splice(ruleIndex, 1);
                    e.target.parentElement.remove();
                    document.querySelectorAll('#logo-merge-rules-container > div').forEach((row, i) => {
                        row.querySelectorAll('[data-rule-index]').forEach(el => { el.dataset.ruleIndex = i; });
                    });
                    palette.updateFinalPalette();
                    queueAutoBaseSelection();
                    updateFilteredPreview();
                }
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

        // ── HTML editor bindings ───────────────────────────────────────────────
        if (le.htmlModeToggle) {
            le.htmlModeToggle.addEventListener('click', () => {
                htmlEditor.setHtmlMode(!ls.htmlModeActive);
                if (ls.htmlModeActive && le.htmlInput?.value.trim()) {
                    htmlEditor.scheduleHtmlRender();
                }
            });
        }

        if (le.htmlInput) {
            le.htmlInput.addEventListener('input', () => {
                if (ls.htmlModeActive) htmlEditor.scheduleHtmlRender();
            });
        }

        document.querySelectorAll('#tab-logo .logo-html-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = HTML_PRESETS[btn.dataset.preset];
                if (!preset || !le.htmlInput) return;
                le.htmlInput.value = preset;
                if (ls.htmlModeActive) htmlEditor.scheduleHtmlRender();
            });
        });
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
