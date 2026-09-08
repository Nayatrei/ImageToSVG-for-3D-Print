import { SLIDER_TOOLTIPS } from '../config.js?v=r-afbde72383fa3b50';
import { createObjPreview } from '../preview3d.js?v=r-afbde72383fa3b50';
import { createObjExporter } from '../export3d.js?v=r-afbde72383fa3b50';
import { hasTransparentPixels, markTransparentPixels, stripTransparentPalette } from '../shared/image-utils.js?v=r-afbde72383fa3b50';
import {
    debounce,
    layerHasPaths,
    detectBackgroundLayerIndex,
    buildTracedataSubset,
    createMergedTracedata,
    assess3DPrintQuality
} from '../shared/trace-utils.js?v=r-afbde72383fa3b50';
import { buildWeldedSilhouetteSvgString } from '../shared/silhouette-builder.js?v=r-afbde72383fa3b50';
import { saveInitialSliderValues, updateAllSliderDisplays, resetSlidersToInitial } from '../shared/slider-manager.js?v=r-afbde72383fa3b50';
import { createZoomPanController } from '../shared/zoom-pan.js?v=r-afbde72383fa3b50';
import { svgToPng } from '../shared/svg-renderer.js?v=r-afbde72383fa3b50';
import { createPaletteManager } from '../shared/palette-manager.js?v=r-afbde72383fa3b50';
import { formatObjScalePercent } from '../obj-scale.js?v=r-afbde72383fa3b50';
import { createAutoWorkingImageFromSource } from '../raster-utils.js?v=r-afbde72383fa3b50';
import { canAttemptBambuLaunch } from '../bambu-bridge.js?v=r-afbde72383fa3b50';
import {
    buildTraceOptions,
    cycleTracePreset,
    estimateMeaningfulColorCount,
    getColorCountNoticeMessage,
    readTraceControls
} from '../shared/trace-controls.js?v=r-afbde72383fa3b50';
import { setMakerWorkflow, updateMakerPreflight } from '../shared/maker-workflow.js?v=r-afbde72383fa3b50';
import {
    applyAmsPrintStylePreset,
    renderAmsPrintStyleChange,
    syncAmsPrintStyleControls,
    toggleFaceDownPrintStyle
} from '../shared/ams-print-style.js?v=r-afbde72383fa3b50';
import { yieldToBrowser } from '../shared/bambu-send-progress.js?v=r-afbde72383fa3b50';
import { syncShared3dControls } from '../shared/ui-syncer.js?v=r-afbde72383fa3b50';

export function createSvgTabController({
    state,
    sharedElements,
    sidebarControls,
    previewElements,
    paletteElements,
    modelControls,
    viewControls,
    exportElements,
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
    const elements = {
        ...sharedElements,
        ...sidebarControls,
        ...previewElements,
        ...paletteElements,
        ...modelControls,
        ...viewControls,
        ...exportElements
    };
    syncAmsPrintStyleControls({ rootState: state, tabState: state, controls: elements });
    setMakerWorkflow(elements.workflow, elements.sourceImage?.src ? 'layers' : 'source');
    let previewGenerationPromise = null;
    let previewGenerationQueued = false;

    // ── Debounced re-trace ─────────────────────────────────────────────────────

    const runDebouncedGeneratePreview = debounce(() => {
        if (!state.colorsAnalyzed || !elements.sourceImage.src) return;
        void generatePreviewClick().catch(() => {});
    });

    function debounceGeneratePreview() {
        if (!state.colorsAnalyzed || !elements.sourceImage.src) return;
        if (elements.generatePreviewBtn) elements.generatePreviewBtn.disabled = true;
        setMakerWorkflow(elements.workflow, 'layers', { tone: 'processing' });
        runDebouncedGeneratePreview();
    }

    function queueAutoBaseSelection() {
        state.autoBaseLayerSelectionPending = true;
    }

    function syncTraceControlUi() {
        updateAllSliderDisplays(state, elements);
        updateColorCountNotice();
    }

    // The 3D sidebar nodes are shared with the Logo tab, so repaint them from
    // this tab's objParams whenever this tab takes over. The model/export path
    // still reads several of these straight off the DOM.
    function syncShared3dControlsForTab() {
        syncShared3dControls({ tabState: state, controls: elements });
        updateBezelHelperText();
    }

    function updateBezelHelperText() {
        if (!elements.objBezelHelper) return;
        const preset = elements.objBezelSelect?.value || 'off';
        const helperText = preset === 'high'
            ? 'Adds a 1.0mm inner rim with 0.8mm extra height on the support base.'
            : preset === 'low'
                ? 'Adds a 0.6mm inner rim with 0.4mm extra height on the support base.'
                : 'No raised rim is added to the support base.';
        elements.objBezelHelper.textContent = helperText;
    }

    // ── Tracing options ────────────────────────────────────────────────────────

    function buildOptimizedOptions() {
        const controls = readTraceControls(elements);
        state.traceControls = controls;
        return Object.assign({}, tracer.optionpresets.default, buildTraceOptions(controls));
    }

    // ── Color analysis ─────────────────────────────────────────────────────────

    function resetWorkingImageCache() {
        state.workingImageWidth = 0;
        state.workingImageHeight = 0;
        state.workingImageScale = 1;
        state.workingImageWasReduced = false;
        state.workingImageCanvas = null;
        state.workingImageData = null;
        state.sourceRenderScale = 1;
    }

    function buildWorkingImageCache() {
        resetWorkingImageCache();

        const workingImage = createAutoWorkingImageFromSource(elements.sourceImage);
        if (!workingImage?.imageData) return null;

        state.workingImageWidth = workingImage.workingWidth;
        state.workingImageHeight = workingImage.workingHeight;
        state.workingImageScale = workingImage.workingScale;
        state.workingImageWasReduced = workingImage.wasReduced;
        state.workingImageCanvas = workingImage.canvas;
        state.workingImageData = workingImage.imageData;
        state.sourceRenderScale = workingImage.workingScale;

        return workingImage;
    }

    function getWorkingImageData() {
        if (state.workingImageData) {
            state.sourceRenderScale = state.workingImageScale || 1;
            return state.workingImageData;
        }
        return buildWorkingImageCache()?.imageData || null;
    }

    function updateResolutionNotice(originalWidth, originalHeight) {
        if (!elements.resolutionNotice) return;

        if (state.workingImageWasReduced && state.workingImageWidth && state.workingImageHeight) {
            elements.resolutionNotice.textContent = `Large source detected. Using ${state.workingImageWidth}×${state.workingImageHeight} internally for faster SVG/3D processing.`;
            elements.resolutionNotice.style.display = 'block';
            return;
        }

        if (originalWidth < 512 || originalHeight < 512) {
            elements.resolutionNotice.textContent = 'Low resolution detected. For best results, use images larger than 512x512 pixels.';
            elements.resolutionNotice.style.display = 'block';
            return;
        }

        elements.resolutionNotice.style.display = 'none';
    }

    function updateColorCountNotice() {
        if (!elements.colorCountNotice || !elements.sourceImage.src) return;

        const imageData = getWorkingImageData();
        if (!imageData) {
            elements.colorCountNotice.classList.add('hidden');
            return;
        }

        const estimatedColors = estimateMeaningfulColorCount(imageData);
        state.estimatedColorCount = estimatedColors;
        const currentOutputColors = parseInt(elements.outputColorsSlider?.value || '4', 10);
        const notice = getColorCountNoticeMessage(estimatedColors, currentOutputColors);

        elements.colorCountNotice.textContent = notice;
        elements.colorCountNotice.classList.toggle('hidden', !notice);
    }

    async function quantizeColors(options) {
        showLoader(true, {
            title: 'Analyzing image colors…',
            subtitle: 'Preparing printable color regions.',
            progress: 0.08
        });
        elements.statusText.textContent = 'Analyzing colors...';
        disableDownloadButtons();

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const imageData = getWorkingImageData();
                    if (!imageData) throw new Error('Invalid image dimensions');

                    state.lastOptions = options;

                    state.quantizedData = tracer.colorquantization(imageData, options);
                    if (!state.quantizedData?.palette) throw new Error('Color analysis failed.');
                    showLoader(true, {
                        title: 'Analyzing image colors…',
                        subtitle: `Found ${state.quantizedData.palette.length} candidate colors.`,
                        progress: 0.18
                    });

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
                    showLoader(false);
                    reject(error);
                }
            }, 50);
        });
    }

    function needsRequantization(newOptions) {
        if (!state.quantizedData || !state.lastOptions) return true;
        return newOptions.numberofcolors !== state.lastOptions.numberofcolors
            || newOptions.mincolorratio !== state.lastOptions.mincolorratio;
    }

    async function runPreviewGeneration() {
        if (!elements.sourceImage.src) return;
        resetBambuSendProgress();
        state.layerThicknessById = {};
        queueAutoBaseSelection();
        setMakerWorkflow(elements.workflow, 'layers', { tone: 'processing' });

        try {
            const options = buildOptimizedOptions();
            if (needsRequantization(options)) {
                await quantizeColors(options);
            } else {
                state.lastOptions = options;
            }
            state.colorsAnalyzed = true;
            await traceVectorPaths();
            state.tracedSourceGeneration = state.sourceGeneration;
        } catch (error) {
            state.colorsAnalyzed = false;
            setMakerWorkflow(elements.workflow, 'layers', { tone: 'error' });
            throw error;
        }
    }

    function generatePreviewClick() {
        if (previewGenerationPromise) {
            previewGenerationQueued = true;
            return previewGenerationPromise;
        }

        if (elements.generatePreviewBtn) {
            elements.generatePreviewBtn.disabled = true;
            elements.generatePreviewBtn.setAttribute('aria-busy', 'true');
        }
        previewGenerationPromise = (async () => {
            do {
                previewGenerationQueued = false;
                await runPreviewGeneration();
            } while (previewGenerationQueued);
        })().finally(() => {
            previewGenerationPromise = null;
            if (elements.generatePreviewBtn) {
                elements.generatePreviewBtn.disabled = false;
                elements.generatePreviewBtn.setAttribute('aria-busy', 'false');
            }
        });
        return previewGenerationPromise;
    }

    // ── Layer helpers ──────────────────────────────────────────────────────────

    function getVisibleLayerIndices() {
        if (!state.tracedata) return [];
        const hidden = state.hiddenSourceLayerIds || new Set();
        const indices = [];
        for (let i = 0; i < state.tracedata.layers.length; i++) {
            if (layerHasPaths(state.tracedata.layers[i]) && !hidden.has(i)) indices.push(i);
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
        const plan = state.objPreview?.lastPlan;
        const finalColorCount = plan?.outputLayers?.length || quality.colorCount;
        const styleWarnings = (plan?.warnings || []).filter((warning) => (
            String(warning?.type || '').startsWith('ams-')
        ));
        const finalQuality = {
            ...quality,
            colorCount: finalColorCount,
            ...(quality.status === 'ready' && styleWarnings.length
                ? {
                    status: 'review',
                    label: 'Style adjusted',
                    note: styleWarnings.map((warning) => warning.message).join(' ')
                }
                : {})
        };
        if (elements.qualityIndicator) {
            elements.qualityIndicator.textContent = `${finalQuality.pathCount.toLocaleString()} paths · ${finalQuality.colorCount} colors`;
        }
        updateMakerPreflight(viewControls, finalQuality);
        objPreview?.refreshPreflight();
    }

    // ── 3D preview / exporter ──────────────────────────────────────────────────

    let resetBambuSendProgress = () => true;
    const objPreview = createObjPreview({
        state,
        modelControls,
        viewControls,
        getDataToExport,
        getVisibleLayerIndices,
        onLayerVisibilityChange: async () => {
            state.mergeRules = [];
            state.selectedLayerIndices.clear();
            state.selectedFinalLayerIndices.clear();
            state.autoBaseLayerSelectionPending = true;
            state.baseSourceLayerId = null;
            state.silhouetteSvgString = buildWeldedSilhouetteSvgString({
                tracedata: state.tracedata,
                layerIndices: getVisibleLayerIndices(),
                tracer,
                options: state.lastOptions,
                SVGLoader: window.SVGLoader,
                THREERef: window.THREE
            });
            palette.displayPalette();
            palette.prepareMergeUIAfterGeneration();
            await renderPreviews();
            await updateFilteredPreview();
        },
        onExportGeometryInvalidated: () => resetBambuSendProgress(),
        isTabActive: () => state.activeTab === 'svg',
        ImageTracer: tracer
    });

    function renderObjModelOnly({ styleOnly = false } = {}) {
        const renderSucceeded = objPreview.render({ styleOnly });
        if (state.tracedata) {
            updateQualityDisplay(assess3DPrintQuality(state.tracedata, getVisibleLayerIndices));
        }
        return renderSucceeded;
    }

    // Coalesce rapid 3D-only control changes and leave the 2D filtered preview
    // alone; neither its pixels nor its layer selection changed.
    const runScheduledObjModelRender = debounce(() => {
        const renderSucceeded = renderObjModelOnly();
        if (viewControls.objPreviewCanvas) {
            viewControls.objPreviewCanvas.dataset.renderState = renderSucceeded ? 'ready' : 'error';
        }
    }, 80);

    function scheduleObjModelRender() {
        resetBambuSendProgress();
        if (viewControls.objPreviewCanvas) {
            viewControls.objPreviewCanvas.dataset.renderState = 'building';
        }
        runScheduledObjModelRender();
    }

    const objExporter = createObjExporter({
        state,
        modelControls,
        exportControls: {
            ...exportElements,
            objPreviewCanvas: viewControls.objPreviewCanvas
        },
        statusText: elements.statusText,
        getDataToExport,
        ImageTracer: tracer,
        showLoader,
        downloadBlob,
        getImageBaseName
    });
    resetBambuSendProgress = objExporter.resetBambuSendProgress;

    // ── Tracing ────────────────────────────────────────────────────────────────

    async function traceVectorPaths() {
        if (!state.quantizedData) return;
        showLoader(true, {
            title: 'Building the 3D model…',
            subtitle: 'Tracing printable color paths.',
            progress: 0.22
        });
        elements.statusText.textContent = 'Tracing vector paths...';
        if (elements.generatePreviewBtn) elements.generatePreviewBtn.disabled = true;
        setMakerWorkflow(elements.workflow, 'model', { tone: 'processing' });

        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const options = state.lastOptions || buildOptimizedOptions();
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
                        showLoader(true, {
                            title: 'Building the 3D model…',
                            subtitle: `Tracing color ${colornum + 1} of ${ii.palette.length}.`,
                            progress: 0.22 + (((colornum + 1) / Math.max(1, ii.palette.length)) * 0.34)
                        });
                        await yieldToBrowser();
                    }

                    state.tracedata = tracedata;
                    state.hiddenSourceLayerIds.clear();
                    state.backgroundCandidateSourceLayerId = detectBackgroundLayerIndex(tracedata);
                    showLoader(true, {
                        title: 'Building the 3D model…',
                        subtitle: 'Joining the printable silhouette.',
                        progress: 0.62
                    });
                    await yieldToBrowser();
                    state.silhouetteSvgString = buildWeldedSilhouetteSvgString({
                        tracedata: state.tracedata,
                        layerIndices: getVisibleLayerIndices(),
                        tracer,
                        options: state.lastOptions,
                        SVGLoader: window.SVGLoader,
                        THREERef: window.THREE
                    });

                    palette.displayPalette();
                    palette.prepareMergeUIAfterGeneration();

                    elements.outputSection.style.display = 'flex';
                    setTimeout(() => updateSegmentedControlIndicator(), 100);

                    showLoader(true, {
                        title: 'Building the 3D model…',
                        subtitle: 'Rendering color previews.',
                        progress: 0.72
                    });
                    await yieldToBrowser();
                    await renderPreviews();
                    showLoader(true, {
                        title: 'Building the 3D model…',
                        subtitle: 'Generating print geometry.',
                        progress: 0.82
                    });
                    await yieldToBrowser();
                    const modelReady = await updateFilteredPreview();
                    if (!modelReady) throw new Error('The 3D preview could not be generated. Adjust the image settings and try again.');

                    updateQualityDisplay(assess3DPrintQuality(state.tracedata, getVisibleLayerIndices));
                    setMakerWorkflow(elements.workflow, 'export');
                    elements.statusText.textContent = 'Preview generated!';
                    showLoader(true, {
                        title: '3D model ready',
                        subtitle: 'Print checks and export controls are ready.',
                        progress: 1
                    });
                    enableDownloadButtons();
                    onRasterExportStateChanged();
                    resolve();
                } catch (error) {
                    console.error('Tracing error:', error);
                    elements.statusText.textContent = `Error: ${error.message}`;
                    setMakerWorkflow(elements.workflow, 'model', { tone: 'error' });
                    reject(error);
                } finally {
                    showLoader(false);
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
            if (elements.svgPreviewImportOverlay) elements.svgPreviewImportOverlay.classList.add('hidden');
        } catch (error) {
            console.error('Preview rendering failed:', error);
            elements.svgPreview.style.display = 'none';
            if (elements.svgPreviewImportOverlay) elements.svgPreviewImportOverlay.classList.remove('hidden');
        }
    }

    async function updateFilteredPreview() {
        const modelReady = objPreview.render();
        if (state.tracedata) {
            updateQualityDisplay(assess3DPrintQuality(state.tracedata, getVisibleLayerIndices));
        }
        if (!state.tracedata || !elements.svgPreviewFiltered) return modelReady;

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
            return modelReady;
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
        return modelReady;
    }

    // ── Download buttons ───────────────────────────────────────────────────────

    function disableDownloadButtons() {
        [
            elements.exportLayersBtn,
            elements.combineAndDownloadBtn,
            elements.downloadCombinedLayersBtn,
            elements.exportObjBtn,
            elements.export3mfBtn,
            elements.bambuOpenBtn,
            elements.exportStlBtn
        ].forEach(btn => { if (btn) btn.disabled = true; });
    }

    function refreshBambuOpenButtonState() {
        if (!elements.bambuOpenBtn) return;
        const canLaunch = canAttemptBambuLaunch();
        elements.bambuOpenBtn.disabled = !state.tracedata || !canLaunch;
        elements.bambuOpenBtn.title = canLaunch
            ? 'Prepares the 3MF transfer, then opens Bambu Studio from a second click.'
            : 'Bambu Studio launch is only available on desktop browsers.';
        const meta = document.getElementById('svg-bambu-open-meta');
        if (meta) {
            meta.textContent = canLaunch
                ? 'Build a 10-minute transfer, then open Bambu Studio'
                : 'Desktop browsers only';
            meta.dataset.bambuIdleText = meta.textContent;
        }
    }

    function enableDownloadButtons() {
        [
            elements.exportLayersBtn,
            elements.exportObjBtn,
            elements.export3mfBtn,
            elements.exportStlBtn
        ].forEach(btn => { if (btn) btn.disabled = false; });
        if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = state.mergeRules.length === 0;
        if (elements.downloadCombinedLayersBtn) elements.downloadCombinedLayersBtn.disabled = false;
        refreshBambuOpenButtonState();
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

    // Every tab listens to the one shared <img id="source-image">, so this must
    // bail out before any side effect when another tab owns the import. The
    // stale results left behind are dropped by onTabActivated's generation check.
    function onSourceImageLoaded() {
        if (state.activeTab !== 'svg') {
            return;
        }

        resetBambuSendProgress();
        const w = elements.sourceImage.naturalWidth;
        const h = elements.sourceImage.naturalHeight;
        if (elements.originalResolution) elements.originalResolution.textContent = `${w}×${h} px`;
        state.colorsAnalyzed = false;
        setMakerWorkflow(elements.workflow, 'layers');

        onRasterImageLoaded();
        syncWorkspaceView();
        if (elements.generatePreviewBtn) elements.generatePreviewBtn.disabled = false;
        buildWorkingImageCache();
        // Reports the working-image size, so it can only run once the cache for
        // this image exists.
        updateResolutionNotice(w, h);
        saveInitialSliderValues(state, elements);
        syncTraceControlUi();
        void generatePreviewClick().catch(() => {});
    }

    // Drops everything traced from a previous source image. Only ever called on
    // activation, so an inactive tab never races the tab that owns the import.
    function resetForNewSource() {
        state.tracedata = null;
        state.quantizedData = null;
        state.lastOptions = null;
        state.silhouetteSvgString = '';
        state.mergeRules = [];
        state.layerThicknessById = {};
        state.colorsAnalyzed = false;
        state.estimatedColorCount = null;
        state.selectedLayerIndices.clear();
        state.selectedFinalLayerIndices.clear();
        state.hiddenSourceLayerIds.clear();
        state.backgroundCandidateSourceLayerId = null;
        state.useBaseLayer = false;
        state.baseSourceLayerId = null;
        state.autoBaseLayerSelectionPending = true;
        state.tracedSourceGeneration = state.sourceGeneration;

        resetBambuSendProgress();
        disableDownloadButtons();
        if (elements.qualityIndicator) elements.qualityIndicator.textContent = '';
        elements.paletteContainer?.replaceChildren();
        if (elements.paletteRow) elements.paletteRow.style.display = 'none';
        elements.mergeRulesContainer?.replaceChildren();
        if (elements.svgPreview) elements.svgPreview.style.display = 'none';
        if (elements.svgPreviewFiltered) elements.svgPreviewFiltered.style.display = 'none';
        objPreview.render();
    }

    function onTabActivated() {
        if (state.tracedSourceGeneration !== state.sourceGeneration) {
            resetForNewSource();
        }
        syncShared3dControlsForTab();
        if (!hasSingleImageLoaded()) {
            setMakerWorkflow(elements.workflow, 'source');
            return;
        }
        if (!state.colorsAnalyzed) {
            setMakerWorkflow(elements.workflow, 'layers');
            if (elements.generatePreviewBtn) elements.generatePreviewBtn.disabled = false;
            buildWorkingImageCache();
            // The notice is shared with the Logo tab, so re-state it for the
            // source this tab is about to trace.
            updateResolutionNotice(
                elements.sourceImage.naturalWidth,
                elements.sourceImage.naturalHeight
            );
            saveInitialSliderValues(state, elements);
            syncTraceControlUi();
            void generatePreviewClick().catch(() => {});
            return;
        }
        setMakerWorkflow(elements.workflow, 'export');
        objPreview.render();
    }

    // ── Event binding ──────────────────────────────────────────────────────────

    function bindEvents() {
        if (elements.generatePreviewBtn) {
            elements.generatePreviewBtn.addEventListener('click', () => {
                void generatePreviewClick().catch(() => {});
            });
        }
        if (elements.resetBtn) {
            elements.resetBtn.addEventListener('click', () => {
                resetSlidersToInitial(state, elements);
                syncTraceControlUi();
                if (elements.sourceImage.src) {
                    void generatePreviewClick().catch(() => {});
                }
            });
        }
        if (elements.presetBtn) {
            elements.presetBtn.addEventListener('click', () => {
                cycleTracePreset(elements);
                if (!state.isDirty) {
                    state.isDirty = true;
                    elements.resetBtn.style.display = 'inline';
                }
                syncTraceControlUi();
                showTraceControlTooltip('trace-preset');
                if (state.colorsAnalyzed) {
                    debounceGeneratePreview();
                }
            });
        }

        if (elements.objAmsPrintStyle) {
            elements.objAmsPrintStyle.addEventListener('change', () => {
                if (state.activeTab !== 'svg') return;
                void renderAmsPrintStyleChange({
                    rootState: state,
                    tabState: state,
                    controls: elements,
                    apply: () => applyAmsPrintStylePreset({
                        rootState: state,
                        tabState: state,
                        controls: elements,
                        styleId: elements.objAmsPrintStyle.value
                    }),
                    render: () => renderObjModelOnly({ styleOnly: true })
                });
            });
        }
        if (elements.objFaceDownToggle) {
            elements.objFaceDownToggle.addEventListener('click', () => {
                if (state.activeTab !== 'svg') return;
                void renderAmsPrintStyleChange({
                    rootState: state,
                    tabState: state,
                    controls: elements,
                    apply: () => toggleFaceDownPrintStyle({
                        rootState: state,
                        tabState: state,
                        controls: elements
                    }),
                    render: () => renderObjModelOnly({ styleOnly: true })
                });
            });
        }
        if (elements.objBaseThicknessSlider && elements.objBaseThicknessValue) {
            elements.objBaseThicknessValue.textContent = elements.objBaseThicknessSlider.value;
            elements.objBaseThicknessSlider.addEventListener('input', () => {
                if (state.activeTab !== 'svg') return;
                state.objParams.baseThickness = Number.parseFloat(elements.objBaseThicknessSlider.value);
                elements.objBaseThicknessValue.textContent = state.objParams.baseThickness;
            });
            elements.objBaseThicknessSlider.addEventListener('change', () => {
                if (state.activeTab !== 'svg') return;
                objPreview.updateLayerHeights();
                updateQualityDisplay(assess3DPrintQuality(state.tracedata, getVisibleLayerIndices));
            });
        }
        if (elements.objThicknessSlider && elements.objThicknessValue) {
            elements.objThicknessValue.textContent = elements.objThicknessSlider.value;
            elements.objThicknessSlider.addEventListener('input', () => {
                if (state.activeTab !== 'svg') return;
                state.objParams.thickness = Number.parseFloat(elements.objThicknessSlider.value);
                elements.objThicknessValue.textContent = state.objParams.thickness;
            });
            elements.objThicknessSlider.addEventListener('change', () => {
                if (state.activeTab !== 'svg') return;
                objPreview.updateLayerHeights();
                updateQualityDisplay(assess3DPrintQuality(state.tracedata, getVisibleLayerIndices));
            });
        }
        if (elements.objDecimateSlider && elements.objDecimateValue) {
            elements.objDecimateValue.textContent = elements.objDecimateSlider.value;
            elements.objDecimateSlider.addEventListener('input', () => {
                if (state.activeTab !== 'svg') return;
                state.objParams.decimate = Number.parseFloat(elements.objDecimateSlider.value);
                elements.objDecimateValue.textContent = state.objParams.decimate;
                scheduleObjModelRender();

                const tooltipEl = document.getElementById('obj-decimate-tooltip');
                if (tooltipEl) {
                    tooltipEl.textContent = SLIDER_TOOLTIPS['obj-decimate'];
                    tooltipEl.style.opacity = '1';
                    clearTimeout(state.tooltipTimeout);
                    state.tooltipTimeout = setTimeout(() => { tooltipEl.style.opacity = '0'; }, 2000);
                }
            });
        }
        if (elements.objScaleSlider && elements.objScaleValue) {
            elements.objScaleValue.textContent = formatObjScalePercent(elements.objScaleSlider.value);
            elements.objScaleSlider.addEventListener('input', () => {
                if (state.activeTab !== 'svg') return;
                state.objParams.scale = Number.parseFloat(elements.objScaleSlider.value);
                elements.objScaleValue.textContent = formatObjScalePercent(state.objParams.scale);
                scheduleObjModelRender();
            });
        }
        if (elements.objBedSelect) {
            elements.objBedSelect.addEventListener('change', (e) => {
                if (state.activeTab !== 'svg') return;
                state.objParams.bedKey = e.target.value;
                scheduleObjModelRender();
            });
        }
        if (elements.objMarginInput) {
            elements.objMarginInput.addEventListener('input', (e) => {
                if (state.activeTab !== 'svg') return;
                state.objParams.margin = Number.parseFloat(e.target.value);
                scheduleObjModelRender();
            });
        }
        if (elements.objBezelSelect) {
            elements.objBezelSelect.addEventListener('change', () => {
                if (state.activeTab !== 'svg') return;
                state.objParams.bezelPreset = elements.objBezelSelect.value || 'off';
                updateBezelHelperText();
                scheduleObjModelRender();

                const tooltipEl = document.getElementById('obj-bezel-tooltip');
                if (tooltipEl) {
                    tooltipEl.textContent = SLIDER_TOOLTIPS['obj-bezel'];
                    tooltipEl.style.opacity = '1';
                    clearTimeout(state.tooltipTimeout);
                    state.tooltipTimeout = setTimeout(() => { tooltipEl.style.opacity = '0'; }, 2000);
                }
            });
            if (!state.objParams.bezelPreset) state.objParams.bezelPreset = elements.objBezelSelect.value || 'off';
            elements.objBezelSelect.value = state.objParams.bezelPreset || 'off';
            updateBezelHelperText();
        }
        if (elements.exportObjBtn) {
            elements.exportObjBtn.addEventListener('click', () => objExporter.exportAsOBJ());
        }
        if (elements.export3mfBtn) {
            elements.export3mfBtn.addEventListener('click', () => objExporter.exportAs3MF());
        }
        if (elements.bambuOpenBtn) {
            refreshBambuOpenButtonState();
            elements.bambuOpenBtn.addEventListener('click', () => {
                void objExporter.exportAndOpenInBambu();
            });
        }
        if (elements.exportStlBtn) {
            elements.exportStlBtn.addEventListener('click', () => objExporter.exportAsSTL());
        }

        setupZoomControls(['all', 'selected']);
        objPreview.bindControls();

        if (elements.useBaseLayerCheckbox) {
            elements.useBaseLayerCheckbox.addEventListener('change', (e) => {
                state.autoBaseLayerSelectionPending = false;
                state.useBaseLayer = e.target.checked;
                if (elements.baseLayerSelect) elements.baseLayerSelect.disabled = !e.target.checked;
                updateFilteredPreview();
            });
            state.useBaseLayer = elements.useBaseLayerCheckbox.checked;
            if (elements.baseLayerSelect) elements.baseLayerSelect.disabled = !elements.useBaseLayerCheckbox.checked;
        }
        if (elements.baseLayerSelect) {
            elements.baseLayerSelect.addEventListener('change', (e) => {
                state.autoBaseLayerSelectionPending = false;
                state.baseSourceLayerId = Number.parseInt(e.target.value, 10);
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

        [
            elements.outputColorsSlider,
            elements.colorCleanupSlider,
            elements.pathCleanupSlider,
            elements.cornerSharpnessSlider,
            elements.curveStraightnessSlider,
            elements.preserveRightAnglesCheckbox
        ].filter(Boolean).forEach((control) => {
            control.addEventListener(control.type === 'checkbox' ? 'change' : 'input', (e) => {
                if (!state.isDirty) {
                    state.isDirty = true;
                    elements.resetBtn.style.display = 'inline';
                }
                syncTraceControlUi();
                showTraceControlTooltip(e.target.id);

                if (state.colorsAnalyzed) {
                    debounceGeneratePreview();
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
                if (!state.silhouetteSvgString) return;
                downloadSVG(state.silhouetteSvgString, `${getImageBaseName()}_silhouette`);
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
                queueAutoBaseSelection();
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
                    queueAutoBaseSelection();
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
                    queueAutoBaseSelection();
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
        });

        elements.sourceImage.onload = onSourceImageLoaded;
    }

    function showTraceControlTooltip(controlId, tooltipId = controlId) {
        const tooltipEl = document.getElementById(`${tooltipId}-tooltip`);
        if (!tooltipEl) return;
        tooltipEl.textContent = SLIDER_TOOLTIPS[controlId] || '';
        tooltipEl.style.opacity = '1';
        clearTimeout(state.tooltipTimeout);
        state.tooltipTimeout = setTimeout(() => { tooltipEl.style.opacity = '0'; }, 2000);
    }

    return {
        bindEvents,
        onTabActivated,
        onSourceImageLoaded,
        syncTraceControlUi,
        updateColorCountNotice,
        renderPreviews,
        updateFilteredPreview
    };
}
