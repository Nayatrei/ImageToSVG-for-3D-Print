/**
 * Queries and returns all DOM elements used by the application.
 * Must be called inside DOMContentLoaded (or equivalent).
 * @returns {object} elements map
 */
export function createElements() {
    return {
        // App shell
        welcomeScreen: document.getElementById('welcome-screen'),
        mainContent: document.getElementById('main-content'),
        loaderOverlay: document.getElementById('loader-overlay'),
        loaderTitle: document.getElementById('loader-title'),
        loaderSubtitle: document.getElementById('loader-subtitle'),
        loaderProgressShell: document.getElementById('loader-progress-shell'),
        loaderProgressBar: document.getElementById('loader-progress-bar'),
        loaderProgressMeta: document.getElementById('loader-progress-meta'),
        workspace: document.querySelector('.workspace'),

        // Sidebar / import panel
        sidebarImportSection: document.getElementById('sidebar-import-section'),
        importPanelTitle: document.getElementById('import-panel-title'),
        importBtnLabel: document.getElementById('import-btn-label'),
        importModeCopy: document.getElementById('import-mode-copy'),
        importUrlShell: document.getElementById('import-url-shell'),
        sidebar: {
            adjustSection: document.getElementById('sidebar-adjust-section'),
            footer: document.getElementById('sidebar-primary-footer'),
            svgControls: document.getElementById('svg-sidebar-controls'),
            logoControls: document.getElementById('logo-sidebar-controls'),
            svgActions: document.getElementById('svg-sidebar-actions'),
            logoActions: document.getElementById('logo-sidebar-actions'),
            svgResetBtn: document.getElementById('reset-btn'),
            logoResetBtn: document.getElementById('logo-reset-btn')
        },

        // Shared source / status
        sourceImage: document.getElementById('source-image'),
        originalImagePanel: document.getElementById('original-image-panel'),
        singleOriginalView: document.getElementById('single-original-view'),
        bulkOriginalView: document.getElementById('bulk-original-view'),
        statusText: document.getElementById('status-text'),
        importBtn: document.getElementById('import-btn'),
        fileInput: document.getElementById('file-input'),
        urlInput: document.getElementById('url-input'),
        loadUrlBtn: document.getElementById('load-url-btn'),
        resolutionNotice: document.getElementById('resolution-notice'),
        outputSection: document.getElementById('output-section'),

        // Shared 3D controls (Unificed)
        shared3d: {
            objThicknessSlider: document.getElementById('obj-thickness'),
            objThicknessValue: document.getElementById('obj-thickness-value'),
            objDecimateSlider: document.getElementById('obj-decimate'),
            objDecimateValue: document.getElementById('obj-decimate-value'),
            objScaleSlider: document.getElementById('obj-scale'),
            objScaleValue: document.getElementById('obj-scale-value'),
            objSizeReadout: document.getElementById('obj-size-readout'),
            objStructureWarning: document.getElementById('obj-structure-warning'),
            objBedSelect: document.getElementById('obj-bed'),
            objMarginInput: document.getElementById('obj-margin')
        },

        // Bulk tab
        bulkFolderInput: document.getElementById('bulk-folder-input'),
        bulkFolderSummary: document.getElementById('bulk-folder-summary'),
        bulkSourceList: document.getElementById('bulk-source-list'),
        bulkPreviewList: document.getElementById('bulk-preview-list'),
        bulkPreviewCount: document.getElementById('bulk-preview-count'),
        bulkPreviewFormat: document.getElementById('bulk-preview-format'),
        bulkPreviewScale: document.getElementById('bulk-preview-scale'),
        bulkFolderName: document.getElementById('bulk-folder-name'),
        bulkFileCount: document.getElementById('bulk-file-count'),
        bulkSkipCount: document.getElementById('bulk-skip-count'),
        bulkOriginalTotal: document.getElementById('bulk-original-total'),
        bulkFormatTabs: document.querySelectorAll('#tab-bulk .bulk-format-tab'),
        bulkResizeChips: document.querySelectorAll('#tab-bulk .bulk-resize-chip'),
        bulkResizeCustomInput: document.getElementById('bulk-resize-custom'),
        applyBulkCustomResizeBtn: document.getElementById('apply-bulk-custom-resize'),
        bulkOutputNameInput: document.getElementById('bulk-output-name'),
        bulkAlphaToggle: document.getElementById('bulk-alpha-toggle'),
        bulkPreserveAlphaCheckbox: document.getElementById('bulk-preserve-alpha'),
        bulkTotalSaved: document.getElementById('bulk-total-saved'),
        bulkTotalSavedPercent: document.getElementById('bulk-total-saved-percent'),
        bulkEstOriginal: document.getElementById('bulk-est-original'),
        bulkEstOutput: document.getElementById('bulk-est-output'),
        bulkDownloadBtn: document.getElementById('bulk-download-btn'),
        bulkSelectedChip: document.getElementById('bulk-selected-chip'),
        bulkSelectedName: document.getElementById('bulk-selected-name'),
        bulkSelectedPath: document.getElementById('bulk-selected-path'),
        bulkSelectedExportName: document.getElementById('bulk-selected-export-name'),
        bulkSelectedOriginalDims: document.getElementById('bulk-selected-original-dims'),
        bulkSelectedOriginalSize: document.getElementById('bulk-selected-original-size'),
        bulkSelectedOutputDims: document.getElementById('bulk-selected-output-dims'),
        bulkSelectedEstSize: document.getElementById('bulk-selected-est-size'),
        bulkSelectedFormat: document.getElementById('bulk-selected-format'),
        bulkSelectedOutputFormat: document.getElementById('bulk-selected-output-format'),

        // Raster tab
        originalResolution: document.getElementById('original-resolution'),
        colorCountNotice: document.getElementById('color-count-notice'),
        resizeChips: document.querySelectorAll('#tab-raster .resize-chip'),
        resizeCustomInput: document.getElementById('resize-custom'),
        applyCustomResizeBtn: document.getElementById('apply-custom-resize'),
        saveResizedPngBtn: document.getElementById('save-resized-png-btn'),
        saveResizedJpgBtn: document.getElementById('save-resized-jpg-btn'),
        saveResizedTgaBtn: document.getElementById('save-resized-tga-btn'),
        exportSizeCurrent: document.getElementById('export-size-current'),
        exportSizeTarget: document.getElementById('export-size-target'),
        sizeEstPng: document.getElementById('size-est-png'),
        sizeEstJpg: document.getElementById('size-est-jpg'),
        sizeEstTga: document.getElementById('size-est-tga'),

        // SVG tab
        svg: {
            sidebar: {
                analyzeColorsBtn: document.getElementById('analyze-colors-btn'),
                optimizePathsBtn: document.getElementById('optimize-paths-btn'),
                resetBtn: document.getElementById('reset-btn'),
                colorControls: document.getElementById('color-controls'),
                pathControls: document.getElementById('path-controls'),
                pathSimplificationSlider: document.getElementById('path-simplification'),
                pathSimplificationValue: document.getElementById('path-simplification-value'),
                pathSimplificationTooltip: document.getElementById('path-simplification-tooltip'),
                cornerSharpnessSlider: document.getElementById('corner-sharpness'),
                cornerSharpnessValue: document.getElementById('corner-sharpness-value'),
                cornerSharpnessTooltip: document.getElementById('corner-sharpness-tooltip'),
                curveStraightnessSlider: document.getElementById('curve-straightness'),
                curveStraightnessValue: document.getElementById('curve-straightness-value'),
                curveStraightnessTooltip: document.getElementById('curve-straightness-tooltip'),
                colorPrecisionSlider: document.getElementById('color-precision'),
                colorPrecisionValue: document.getElementById('color-precision-value'),
                colorPrecisionTooltip: document.getElementById('color-precision-tooltip'),
                maxColorsSlider: document.getElementById('max-colors'),
                maxColorsValue: document.getElementById('max-colors-value'),
                maxColorsTooltip: document.getElementById('max-colors-tooltip'),
                toggleFidelityBtn: document.getElementById('toggle-fidelity-btn')
            },
            preview: {
                svgPreview: document.getElementById('svg-preview'),
                svgPreviewImportOverlay: document.getElementById('svg-preview-import-overlay'),
                svgPreviewFiltered: document.getElementById('svg-preview-filtered'),
                previewResolution: document.getElementById('preview-resolution'),
                qualityIndicator: document.getElementById('quality-indicator'),
                selectedLayerText: document.getElementById('selected-layer-text'),
                originalResolution: document.getElementById('original-resolution')
            },
            palette: {
                paletteContainer: document.getElementById('palette-container'),
                paletteRow: document.getElementById('palette-row'),
                finalPaletteContainer: document.getElementById('final-palette-container'),
                layerMergingSection: document.getElementById('layer-merging-section'),
                mergeRulesContainer: document.getElementById('merge-rules-container'),
                addMergeRuleBtn: document.getElementById('add-merge-rule-btn'),
                combineAndDownloadBtn: document.getElementById('combine-and-download-btn'),
                downloadCombinedLayersBtn: document.getElementById('download-combined-layers-btn'),
                downloadSilhouetteBtn: document.getElementById('download-silhouette-btn'),
                exportLayersBtn: document.getElementById('export-layers-btn')
            },
            preview3d: {
                objPreviewCanvas: document.getElementById('obj-preview-canvas'),
                objPreviewPlaceholder: document.getElementById('obj-preview-placeholder'),
                objBuildPlateToggle: document.getElementById('obj-build-plate-toggle'),
                objPreviewBedSelect: document.getElementById('obj-preview-bed'),
                objFitView: document.getElementById('obj-fit-view'),
                objRecenter: document.getElementById('obj-recenter'),
                objTargetLock: document.getElementById('obj-target-lock'),
                objModeGhost: document.getElementById('obj-mode-ghost'),
                objModeSolo: document.getElementById('obj-mode-solo'),
                layerStackList: document.getElementById('layer-stack-list'),
                layerStackMeta: document.getElementById('layer-stack-meta'),
                useBaseLayerCheckbox: document.getElementById('use-base-layer'),
                baseLayerSelect: document.getElementById('base-layer-select')
            },
            export: {
                exportObjBtn: document.getElementById('export-obj-btn'),
                export3mfBtn: document.getElementById('export-3mf-btn'),
                exportStlBtn: document.getElementById('export-stl-btn'),
                exportFooter: document.getElementById('svg-export-footer')
            }
        },

        // Logo tab
        logo: {
            sidebar: {
                analyzeColorsBtn: document.getElementById('logo-analyze-colors-btn'),
                optimizePathsBtn: document.getElementById('logo-optimize-paths-btn'),
                resetBtn: document.getElementById('logo-reset-btn'),
                colorControls: document.getElementById('logo-color-controls'),
                pathControls: document.getElementById('logo-path-controls'),
                pathSimplificationSlider: document.getElementById('logo-path-simplification'),
                pathSimplificationValue: document.getElementById('logo-path-simplification-value'),
                pathSimplificationTooltip: document.getElementById('logo-path-simplification-tooltip'),
                cornerSharpnessSlider: document.getElementById('logo-corner-sharpness'),
                cornerSharpnessValue: document.getElementById('logo-corner-sharpness-value'),
                cornerSharpnessTooltip: document.getElementById('logo-corner-sharpness-tooltip'),
                curveStraightnessSlider: document.getElementById('logo-curve-straightness'),
                curveStraightnessValue: document.getElementById('logo-curve-straightness-value'),
                curveStraightnessTooltip: document.getElementById('logo-curve-straightness-tooltip'),
                colorPrecisionSlider: document.getElementById('logo-color-precision'),
                colorPrecisionValue: document.getElementById('logo-color-precision-value'),
                colorPrecisionTooltip: document.getElementById('logo-color-precision-tooltip'),
                maxColorsSlider: document.getElementById('logo-max-colors'),
                maxColorsValue: document.getElementById('logo-max-colors-value'),
                maxColorsTooltip: document.getElementById('logo-max-colors-tooltip'),
                toggleFidelityBtn: document.getElementById('logo-toggle-fidelity-btn')
            },
            preview: {
                svgSourceMirror: document.getElementById('logo-svg-source-mirror'),
                originalResolution: document.getElementById('logo-original-resolution'),
                svgPreview: document.getElementById('logo-svg-preview'),
                previewResolution: document.getElementById('logo-preview-resolution'),
                qualityIndicator: document.getElementById('logo-quality-indicator')
            },
            palette: {
                paletteContainer: document.getElementById('logo-palette-container'),
                paletteRow: document.getElementById('logo-palette-row'),
                finalPaletteContainer: document.getElementById('logo-final-palette-container'),
                layerMergingSection: document.getElementById('logo-layer-merging-section'),
                mergeRulesContainer: document.getElementById('logo-merge-rules-container'),
                addMergeRuleBtn: document.getElementById('logo-add-merge-rule-btn')
            },
            preview3d: {
                objPreviewCanvas: document.getElementById('logo-obj-preview-canvas'),
                objPreviewPlaceholder: document.getElementById('logo-obj-preview-placeholder'),
                objBuildPlateToggle: document.getElementById('logo-obj-build-plate-toggle'),
                objFitView: document.getElementById('logo-obj-fit-view'),
                objRecenter: document.getElementById('logo-obj-recenter'),
                objTargetLock: document.getElementById('logo-obj-target-lock'),
                objModeGhost: document.getElementById('logo-obj-mode-ghost'),
                objModeSolo: document.getElementById('logo-obj-mode-solo'),
                layerStackList: document.getElementById('logo-layer-stack-list'),
                layerStackMeta: document.getElementById('logo-layer-stack-meta'),
                triangleEstimate: document.getElementById('logo-triangle-estimate'),
                triangleControlsHint: document.getElementById('logo-triangle-controls-hint'),
                useBaseLayerCheckbox: document.getElementById('logo-use-base-layer'),
                baseLayerSelect: document.getElementById('logo-base-layer-select')
            },
            export: {
                exportObjBtn: document.getElementById('logo-export-obj-btn'),
                export3mfBtn: document.getElementById('logo-export-3mf-btn'),
                exportStlBtn: document.getElementById('logo-export-stl-btn'),
                exportFooter: document.getElementById('logo-export-footer')
            },
            html: {
                htmlSourceImg: document.getElementById('logo-html-source-img'),
                bambuOpenBtn: document.getElementById('logo-bambu-open-btn'),
                htmlInput: document.getElementById('logo-html-input'),
                htmlStatus: document.getElementById('logo-html-status'),
                htmlRenderBtn: document.getElementById('logo-html-render-btn'),
                htmlWidthRow: document.getElementById('logo-html-width-row'),
                htmlWidthSlider: document.getElementById('logo-html-width-slider'),
                htmlWidthLabel: document.getElementById('logo-html-width-label'),
                htmlWidthReset: document.getElementById('logo-html-width-reset'),
                htmlCountdown: document.getElementById('logo-html-countdown'),
                htmlCountdownArc: document.getElementById('logo-html-countdown-arc'),
                htmlModeToggle: document.getElementById('logo-html-mode-toggle'),
                htmlEditorBody: document.getElementById('logo-html-editor-body'),
                htmlFontSelect: document.getElementById('logo-html-font-select'),
                htmlFontSearch: document.getElementById('logo-html-font-search'),
                htmlFontPills: document.getElementById('logo-html-font-pills'),
                htmlFontAccessBtn: document.getElementById('logo-html-font-access-btn')
            }
        },

        // Tab nav
        exportTabs: document.querySelectorAll('.segmented-control-tab'),
        exportPanels: document.querySelectorAll('.export-panel'),
        svgExportFooter: document.getElementById('svg-export-footer'),
        rasterDownloadFooter: document.getElementById('download-footer'),
        bulkDownloadFooter: document.getElementById('bulk-download-footer')
    };
}
