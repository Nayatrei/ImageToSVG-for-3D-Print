import { createDefaultTraceControls } from './shared/trace-controls.js?v=r-afbde72383fa3b50';
import {
    DEFAULT_AMS_PRINT_STYLE,
    OBJ_DEFAULT_ROTATION,
    getAmsPrintStylePreset
} from './config.js?v=r-afbde72383fa3b50';
import { createDefaultMagnetPocketConfig } from './shared/magnet-pockets.js?v=r-afbde72383fa3b50';

/**
 * Returns the initial application state object.
 * Logo-tab state lives under state.logo and is passed as `ls` to the logo tab controller.
 * @returns {object}
 */
export function createState() {
    // Each tab owns its own objParams tree. Nothing here may be shared by
    // reference between the SVG and Logo trees: an aliased sub-object turns a
    // per-tab edit into a silent cross-tab write.
    const createObjParams = () => ({
        scale: 100,
        thickness: getAmsPrintStylePreset(DEFAULT_AMS_PRINT_STYLE).colorThickness,
        baseThickness: getAmsPrintStylePreset(DEFAULT_AMS_PRINT_STYLE).baseThickness,
        amsPrintStyle: DEFAULT_AMS_PRINT_STYLE,
        faceDownReturnStyle: DEFAULT_AMS_PRINT_STYLE,
        decimate: 0,
        bedKey: 'x1',
        margin: 5,
        bezelPreset: 'off',
        showBuildPlate: true,
        layerDisplayMode: 'ghost',
        targetLocked: true,
        magnetPocket: createDefaultMagnetPocketConfig()
    });

    const obj3dPreview = () => ({
        renderer: null,
        scene: null,
        viewGroup: null,
        camera: null,
        group: null,
        isDragging: false,
        lastX: 0,
        lastY: 0,
        rotationX: OBJ_DEFAULT_ROTATION.x,
        rotationY: OBJ_DEFAULT_ROTATION.y,
        interactionsBound: false,
        retryScheduled: false,
        zoom: 1,
        target: null,
        fitTarget: null,
        panX: 0,
        panY: 0,
        panScale: 1,
        targetLocked: true,
        showBuildPlate: true,
        layerDisplayMode: 'ghost',
        needsFit: true
    });

    const workingImageState = () => ({
        workingImageWidth: 0,
        workingImageHeight: 0,
        workingImageScale: 1,
        workingImageWasReduced: false,
        workingImageCanvas: null,
        workingImageData: null
    });

    return {
        // ── Shared source image ────────────────────────────────────────────────
        // Every tab shares one <img id="source-image">, so each import bumps this
        // counter. A tab records the generation it traced (tracedSourceGeneration)
        // and drops its stale results the next time it is activated.
        sourceGeneration: 0,

        // ── SVG tab state ──────────────────────────────────────────────────────
        tracedSourceGeneration: 0,
        quantizedData: null,
        tracedata: null,
        originalImageUrl: null,
        originalImageFormat: null,
        originalImageSize: null,
        lastOptions: null,
        silhouetteSvgString: '',
        mergeRules: [],
        initialSliderValues: {},
        isDirty: false,
        selectedLayerIndices: new Set(),
        selectedFinalLayerIndices: new Set(),
        hiddenSourceLayerIds: new Set(),
        backgroundCandidateSourceLayerId: null,
        tooltipTimeout: null,
        colorsAnalyzed: false,
        estimatedColorCount: null,
        layerThicknessById: {},
        useBaseLayer: false,
        baseSourceLayerId: null,
        autoBaseLayerSelectionPending: true,
        sourceRenderScale: 1,
        ...workingImageState(),
        exportScale: 100,
        preserveAlpha: true,
        traceControls: createDefaultTraceControls('logo'),

        // ── Shared 3D Parameters ──────────────────────────────────────────────
        objParams: createObjParams(),

        // ── Bulk tab state ─────────────────────────────────────────────────────
        bulk: {
            folderName: '',
            files: [],
            skippedCount: 0,
            exportScale: 100,
            exportFormat: 'png',
            preserveAlpha: true,
            resizeMode: 'scale',
            targetWidth: 1024,
            targetHeight: 1024,
            fitMode: 'contain',
            keepOriginalNames: true,
            outputName: '',
            selectedPreviewIndex: -1,
            previewItems: [],
            totals: {
                originalBytes: 0,
                estimatedBytes: 0,
                savedBytes: 0,
                savedPercent: 0
            }
        },

        // ── PDF tab state ──────────────────────────────────────────────────────
        pdf: {
            files: [],
            outputName: 'combined.pdf',
            isMerging: false,
            lastMergedPageCount: 0,
            activeTask: 'combine',
            activeStep: 1,
            activeFinishTool: 'signature',
            focusedPage: null,
            imagesToPdf: {
                items: [],
                pageSize: 'auto',
                outputName: 'images.pdf',
                isExporting: false
            },
            ocr: {
                file: null,
                fileName: '',
                language: 'eng',
                text: '',
                status: 'idle',
                progress: 0,
                isRunning: false
            },
            imageExport: {
                format: 'png',
                targetWidth: 1600
            },
            finish: {
                signature: {
                    enabled: false,
                    text: '',
                    position: 'bottom-left',
                    applyTo: 'current',
                    size: 22
                },
                stamp: {
                    enabled: false,
                    text: 'APPROVED',
                    position: 'top-right',
                    applyTo: 'all',
                    opacity: 72,
                    size: 28
                },
                pageNumbers: {
                    enabled: false,
                    format: 'page-total',
                    position: 'bottom-center',
                    startAt: 1,
                    size: 9
                }
            }
        },

        // ── 3D preview state (SVG tab) ─────────────────────────────────────────
        objPreview: obj3dPreview(),

        // ── Zoom state (SVG tab) ───────────────────────────────────────────────
        zoom: {
            all: { scale: 1, x: 0, y: 0, isDragging: false },
            selected: { scale: 1, x: 0, y: 0, isDragging: false }
        },

        // ── Tab navigation ─────────────────────────────────────────────────────
        activeTab: 'svg',

        // ── Logo tab state (passed as `ls`) ────────────────────────────────────
        logo: {
            tracedSourceGeneration: 0,
            tracedata: null,
            quantizedData: null,
            lastOptions: null,
            silhouetteSvgString: '',
            mergeRules: [],
            initialSliderValues: {},
            isDirty: false,
            selectedLayerIndices: new Set(),
            selectedFinalLayerIndices: new Set(),
            tooltipTimeout: null,
            colorsAnalyzed: false,
            estimatedColorCount: null,
            layerThicknessById: {},
            useBaseLayer: false,
            baseSourceLayerId: null,
            autoBaseLayerSelectionPending: true,
            sourceRenderScale: 1,
            ...workingImageState(),
            traceControls: createDefaultTraceControls('logo'),
            htmlModeActive: true,
            activeLogoPresetId: 'capsule-wordmark',
            htmlRenderTimer: null,
            htmlDeclaredColors: [],
            showAvailableLayers: true,
            showFinalPalette: true,
            objParams: createObjParams(),
            objPreview: obj3dPreview(),
            zoom: {
                all: { scale: 1, x: 0, y: 0, isDragging: false }
            }
        }
    };
}
