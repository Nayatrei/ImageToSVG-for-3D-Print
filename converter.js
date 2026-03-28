import { createBulkTabController } from './modules/tabs/bulk-tab.js';
import { createRasterTabController } from './modules/tabs/raster-tab.js';
import { createSvgTabController } from './modules/tabs/svg-tab.js';
import { getDataUrlSize, getImageFormat } from './modules/raster-utils.js';

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        welcomeScreen: document.getElementById('welcome-screen'),
        mainContent: document.getElementById('main-content'),
        loaderOverlay: document.getElementById('loader-overlay'),
        workspace: document.querySelector('.workspace'),
        sourceImage: document.getElementById('source-image'),
        singleOriginalView: document.getElementById('single-original-view'),
        bulkOriginalView: document.getElementById('bulk-original-view'),
        statusText: document.getElementById('status-text'),
        importBtn: document.getElementById('import-btn'),
        fileInput: document.getElementById('file-input'),
        urlInput: document.getElementById('url-input'),
        loadUrlBtn: document.getElementById('load-url-btn'),
        bulkFolderBtn: document.getElementById('bulk-folder-btn'),
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
        bulkResizeChips: document.querySelectorAll('#tab-bulk .bulk-resize-chip'),
        bulkResizeCustomInput: document.getElementById('bulk-resize-custom'),
        applyBulkCustomResizeBtn: document.getElementById('apply-bulk-custom-resize'),
        bulkFormatSelect: document.getElementById('bulk-format-select'),
        bulkAlphaToggle: document.getElementById('bulk-alpha-toggle'),
        bulkPreserveAlphaCheckbox: document.getElementById('bulk-preserve-alpha'),
        bulkTotalSaved: document.getElementById('bulk-total-saved'),
        bulkTotalSavedPercent: document.getElementById('bulk-total-saved-percent'),
        bulkEstOriginal: document.getElementById('bulk-est-original'),
        bulkEstOutput: document.getElementById('bulk-est-output'),
        bulkDownloadBtn: document.getElementById('bulk-download-btn'),
        savePngBtn: document.getElementById('save-png-btn'),
        saveJpgBtn: document.getElementById('save-jpg-btn'),
        saveSvgBtn: document.getElementById('save-svg-btn'),
        originalResolution: document.getElementById('original-resolution'),
        resolutionNotice: document.getElementById('resolution-notice'),
        colorCountNotice: document.getElementById('color-count-notice'),
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
        toggleFidelityBtn: document.getElementById('toggle-fidelity-btn'),
        svgPreview: document.getElementById('svg-preview'),
        svgPreviewFiltered: document.getElementById('svg-preview-filtered'),
        objPreviewCanvas: document.getElementById('obj-preview-canvas'),
        objPreviewPlaceholder: document.getElementById('obj-preview-placeholder'),
        objFitView: document.getElementById('obj-fit-view'),
        objRecenter: document.getElementById('obj-recenter'),
        objTargetLock: document.getElementById('obj-target-lock'),
        objModeGhost: document.getElementById('obj-mode-ghost'),
        objModeSolo: document.getElementById('obj-mode-solo'),
        layerStackList: document.getElementById('layer-stack-list'),
        layerStackMeta: document.getElementById('layer-stack-meta'),
        previewResolution: document.getElementById('preview-resolution'),
        qualityIndicator: document.getElementById('quality-indicator'),
        selectedLayerText: document.getElementById('selected-layer-text'),
        paletteContainer: document.getElementById('palette-container'),
        paletteRow: document.getElementById('palette-row'),
        outputSection: document.getElementById('output-section'),
        finalPaletteContainer: document.getElementById('final-palette-container'),
        downloadSilhouetteBtn: document.getElementById('download-silhouette-btn'),
        layerMergingSection: document.getElementById('layer-merging-section'),
        mergeRulesContainer: document.getElementById('merge-rules-container'),
        addMergeRuleBtn: document.getElementById('add-merge-rule-btn'),
        combineAndDownloadBtn: document.getElementById('combine-and-download-btn'),
        downloadCombinedLayersBtn: document.getElementById('download-combined-layers-btn'),
        exportTabs: document.querySelectorAll('.segmented-control-tab'),
        exportPanels: document.querySelectorAll('.export-panel'),
        svgExportFooter: document.getElementById('svg-export-footer'),
        rasterDownloadFooter: document.getElementById('download-footer'),
        bulkDownloadFooter: document.getElementById('bulk-download-footer'),
        resizeChips: document.querySelectorAll('#tab-raster .resize-chip'),
        resizeCustomInput: document.getElementById('resize-custom'),
        applyCustomResizeBtn: document.getElementById('apply-custom-resize'),
        saveResizedPngBtn: document.getElementById('save-resized-png-btn'),
        saveResizedJpgBtn: document.getElementById('save-resized-jpg-btn'),
        saveResizedTgaBtn: document.getElementById('save-resized-tga-btn'),
        preserveAlphaCheckbox: document.getElementById('preserve-alpha'),
        exportSizeCurrent: document.getElementById('export-size-current'),
        exportSizeTarget: document.getElementById('export-size-target'),
        sizeEstPng: document.getElementById('size-est-png'),
        sizeEstJpg: document.getElementById('size-est-jpg'),
        sizeEstTga: document.getElementById('size-est-tga'),
        objThicknessSlider: document.getElementById('obj-thickness'),
        objThicknessValue: document.getElementById('obj-thickness-value'),
        objDetailSlider: document.getElementById('obj-detail'),
        objDetailValue: document.getElementById('obj-detail-value'),
        exportObjBtn: document.getElementById('export-obj-btn'),
        export3mfBtn: document.getElementById('export-3mf-btn'),
        exportStlBtn: document.getElementById('export-stl-btn'),
        objBedSelect: document.getElementById('obj-bed'),
        objMarginInput: document.getElementById('obj-margin'),
        availableLayersContent: document.getElementById('available-layers-content'),
        finalPaletteContent: document.getElementById('final-palette-content'),
        toggleAvailableLayersBtn: document.getElementById('toggle-available-layers'),
        toggleFinalPaletteBtn: document.getElementById('toggle-final-palette'),
        exportLayersBtn: document.getElementById('export-layers-btn'),
        useBaseLayerCheckbox: document.getElementById('use-base-layer'),
        baseLayerSelect: document.getElementById('base-layer-select')
    };

    const state = {
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
        layerThicknesses: null,
        useBaseLayer: true,
        baseLayerIndex: 0,
        exportScale: 100,
        preserveAlpha: true,
        showAvailableLayers: true,
        showFinalPalette: true,
        highFidelity: false,
        bulk: {
            folderName: '',
            files: [],
            skippedCount: 0,
            exportScale: 100,
            exportFormat: 'png',
            preserveAlpha: true,
            previewItems: [],
            totals: {
                originalBytes: 0,
                estimatedBytes: 0,
                savedBytes: 0,
                savedPercent: 0
            }
        },
        objPreview: {
            renderer: null,
            scene: null,
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
            basePosition: null,
            targetLocked: true,
            layerDisplayMode: 'ghost'
        },
        zoom: {
            all: { scale: 1, x: 0, y: 0, isDragging: false },
            selected: { scale: 1, x: 0, y: 0, isDragging: false }
        },
        activeTab: 'svg'
    };

    function showLoader(show) {
        elements.loaderOverlay.style.display = show ? 'flex' : 'none';
    }

    function hasSingleImageLoaded() {
        return Boolean(elements.sourceImage?.getAttribute('src'));
    }

    function setOriginalPanelMode(mode) {
        const showBulk = mode === 'bulk';
        if (elements.singleOriginalView) {
            elements.singleOriginalView.classList.toggle('hidden', showBulk);
        }
        if (elements.bulkOriginalView) {
            elements.bulkOriginalView.classList.toggle('hidden', !showBulk);
        }
    }

    function syncWorkspaceView() {
        const imageLoaded = hasSingleImageLoaded();
        const showMainContent = state.activeTab === 'bulk' || imageLoaded;

        if (elements.welcomeScreen) {
            elements.welcomeScreen.style.display = showMainContent ? 'none' : 'flex';
        }
        if (elements.mainContent) {
            elements.mainContent.classList.toggle('hidden', !showMainContent);
        }
        if (elements.outputSection) {
            if (state.activeTab === 'bulk') {
                elements.outputSection.style.display = 'flex';
            } else if (!imageLoaded) {
                elements.outputSection.style.display = 'none';
            }
        }
    }

    function updateSegmentedControlIndicator() {
        const activeTab = document.querySelector('.segmented-control-tab.active');
        const indicator = document.querySelector('.segmented-control-indicator');
        if (!activeTab || !indicator) return;

        const tabRect = activeTab.getBoundingClientRect();
        const containerRect = activeTab.parentElement.getBoundingClientRect();
        const offsetLeft = tabRect.left - containerRect.left - 6;

        indicator.style.width = `${tabRect.width}px`;
        indicator.style.transform = `translateX(${offsetLeft}px)`;
    }

    function getImageBaseName() {
        const name = (state.originalImageUrl || 'image').split(/[\\/]/).pop() || 'image';
        return name.replace(/\.[^/.]+$/, '') || 'image';
    }

    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function downloadSVG(svgContent, baseName) {
        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName || 'converted'}.svg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    const rasterTab = createRasterTabController({
        state,
        elements,
        downloadBlob,
        getImageBaseName,
        hasSingleImageLoaded
    });

    const bulkTab = createBulkTabController({
        state,
        elements,
        showLoader,
        syncWorkspaceView,
        downloadBlob
    });

    const svgTab = createSvgTabController({
        state,
        elements,
        showLoader,
        syncWorkspaceView,
        hasSingleImageLoaded,
        updateSegmentedControlIndicator,
        downloadBlob,
        downloadSVG,
        getImageBaseName,
        onRasterImageLoaded: rasterTab.onSourceImageLoaded,
        onRasterExportStateChanged: rasterTab.updateExportScaleDisplay
    });

    function switchExportTab(target) {
        state.activeTab = target;

        elements.exportTabs.forEach((btn) => {
            const isActive = btn.dataset.tab === target;
            btn.classList.toggle('active', isActive);
        });

        elements.exportPanels.forEach((panel) => {
            const isVisible = panel.id === `tab-${target}`;
            panel.classList.toggle('hidden', !isVisible);
        });

        if (elements.svgExportFooter) {
            elements.svgExportFooter.classList.toggle('hidden', target !== 'svg');
        }
        if (elements.rasterDownloadFooter) {
            elements.rasterDownloadFooter.classList.toggle('hidden', target !== 'raster');
        }
        if (elements.bulkDownloadFooter) {
            elements.bulkDownloadFooter.classList.toggle('hidden', target !== 'bulk');
        }

        setOriginalPanelMode(target === 'bulk' ? 'bulk' : 'single');
        syncWorkspaceView();

        updateSegmentedControlIndicator();

        if (target === 'svg' && hasSingleImageLoaded()) {
            svgTab.onTabActivated();
        } else if (target === 'raster' && hasSingleImageLoaded()) {
            svgTab.setAvailableLayersVisible(false);
            svgTab.setFinalPaletteVisible(false);
            rasterTab.onTabActivated();
        } else {
            svgTab.setAvailableLayersVisible(false);
            svgTab.setFinalPaletteVisible(false);
            bulkTab.onTabActivated();
        }
    }

    function loadImage(src, name) {
        state.originalImageUrl = name;

        if (!state.originalImageFormat) {
            state.originalImageFormat = getImageFormat(name, src);
        }
        if (!state.originalImageSize) {
            state.originalImageSize = getDataUrlSize(src);
        }

        elements.sourceImage.src = src;
    }

    function resetImageInfo() {
        state.originalImageFormat = null;
        state.originalImageSize = null;
    }

    function handleImportedFile(file) {
        resetImageInfo();
        state.originalImageFormat = getImageFormat(file.name, null);
        state.originalImageSize = file.size;

        const reader = new FileReader();
        reader.onload = (event) => loadImage(event.target.result, file.name);
        reader.readAsDataURL(file);
    }

    async function loadImageFromUrl(url) {
        resetImageInfo();

        showLoader(true);
        elements.statusText.textContent = 'Fetching image...';
        try {
            let dataUrl;
            if (url.startsWith('data:')) {
                dataUrl = url;
            } else if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
                dataUrl = await new Promise((resolve, reject) => {
                    const port = chrome.runtime.connect({ name: 'fetchImagePort' });
                    port.postMessage({ type: 'fetchImage', url });
                    port.onMessage.addListener((response) => {
                        if (response.dataUrl) resolve(response.dataUrl);
                        else reject(new Error(response.error || 'Failed to fetch'));
                    });
                });
            } else {
                const response = await fetch(url);
                const blob = await response.blob();
                dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            }
            loadImage(dataUrl, url.split('/').pop());
        } catch (error) {
            console.error('URL load error:', error);
            elements.statusText.textContent = 'Failed to load image from URL.';
            showLoader(false);
        }
    }

    function setupWorkspaceDragAndDrop() {
        if (!elements.workspace) return;

        const clearDragState = () => elements.workspace.classList.remove('drag-over');

        elements.workspace.addEventListener('dragover', (event) => {
            event.preventDefault();
            elements.workspace.classList.add('drag-over');
        });

        elements.workspace.addEventListener('dragleave', clearDragState);

        elements.workspace.addEventListener('drop', (event) => {
            event.preventDefault();
            clearDragState();

            const dt = event.dataTransfer;
            if (dt?.files?.length) {
                const file = Array.from(dt.files).find(f => f.type.startsWith('image/'));
                if (file) {
                    handleImportedFile(file);
                    return;
                }
            }

            const url = dt?.getData('text/uri-list') || dt?.getData('text/plain');
            if (url) {
                loadImageFromUrl(url.trim());
            }
        });
    }

    function bindAppEvents() {
        if (elements.importBtn) {
            elements.importBtn.addEventListener('click', () => elements.fileInput.click());
        }

        if (elements.fileInput) {
            elements.fileInput.addEventListener('change', (event) => {
                const file = event.target.files[0];
                if (file) {
                    handleImportedFile(file);
                }
                event.target.value = '';
            });
        }

        if (elements.welcomeScreen && elements.fileInput) {
            const openImportPicker = () => elements.fileInput.click();
            const isInteractiveTarget = (target) => target instanceof Element && Boolean(target.closest('button, a, input, select, textarea, label'));

            elements.welcomeScreen.addEventListener('click', (event) => {
                if (isInteractiveTarget(event.target)) return;
                openImportPicker();
            });
            elements.welcomeScreen.setAttribute('tabindex', '0');
            elements.welcomeScreen.setAttribute('role', 'button');
            elements.welcomeScreen.setAttribute('aria-label', 'Open image import dialog');
            elements.welcomeScreen.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openImportPicker();
                }
            });
        }

        if (elements.loadUrlBtn) {
            elements.loadUrlBtn.addEventListener('click', () => {
                const url = elements.urlInput.value.trim();
                if (url) loadImageFromUrl(url);
            });
        }

        elements.exportTabs.forEach((btn) => {
            btn.addEventListener('click', () => {
                switchExportTab(btn.dataset.tab);
            });
        });
    }

    function initialize() {
        bindAppEvents();
        setupWorkspaceDragAndDrop();

        rasterTab.bindEvents();
        bulkTab.bindEvents();
        svgTab.bindEvents();

        switchExportTab('svg');
        rasterTab.setExportScale(state.exportScale);
        bulkTab.setExportScale(state.bulk.exportScale);
        svgTab.setHighFidelity(state.highFidelity);
        rasterTab.updateExportScaleDisplay();
        syncWorkspaceView();

        if (typeof chrome !== 'undefined' && chrome.storage) {
            chrome.storage.local.get(['imageUrlToConvert'], (result) => {
                if (result.imageUrlToConvert) {
                    elements.urlInput.value = result.imageUrlToConvert;
                    loadImageFromUrl(result.imageUrlToConvert);
                    chrome.storage.local.remove('imageUrlToConvert');
                }
            });
        }
    }

    initialize();
});
