/**
 * Returns the initial application state object.
 * Logo-tab state lives under state.logo and is passed as `ls` to the logo tab controller.
 * @returns {object}
 */
export function createState() {
    const obj3dPreview = () => ({
        renderer: null,
        scene: null,
        viewGroup: null,
        camera: null,
        group: null,
        isDragging: false,
        lastX: 0,
        lastY: 0,
        rotationX: -0.65,
        rotationY: 0.45,
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

    return {
        // ── SVG tab state ──────────────────────────────────────────────────────
        quantizedData: null,
        tracedata: null,
        originalImageUrl: null,
        originalImageFormat: null,
        originalImageSize: null,
        lastOptions: null,
        silhouetteTracedata: null,
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
        exportScale: 100,
        preserveAlpha: true,

        highFidelity: false,

        // ── Shared 3D Parameters ──────────────────────────────────────────────
        objParams: {
            scale: 100,
            thickness: 4,
            bedKey: 'x1',
            margin: 5,
            showBuildPlate: true,
            layerDisplayMode: 'ghost',
            targetLocked: true
        },

        // ── Bulk tab state ─────────────────────────────────────────────────────
        bulk: {
            folderName: '',
            files: [],
            skippedCount: 0,
            exportScale: 100,
            exportFormat: 'png',
            preserveAlpha: true,
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
            tracedata: null,
            quantizedData: null,
            lastOptions: null,
            silhouetteTracedata: null,
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
            highFidelity: false,
            htmlModeActive: true,
            htmlRenderTimer: null,
            htmlDeclaredColors: [],
            showAvailableLayers: true,
            showFinalPalette: true,
            objPreview: obj3dPreview(),
            zoom: {
                all: { scale: 1, x: 0, y: 0, isDragging: false }
            }
        }
    };
}
