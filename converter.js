import { createBulkTabController } from './modules/tabs/bulk-tab.js';
import { createRasterTabController } from './modules/tabs/raster-tab.js';
import { createSvgTabController } from './modules/tabs/svg-tab.js';
import {
    getDataUrlSize,
    getImageFormat,
    IMPORTABLE_IMAGE_PROMPT,
    isImportableImageFile,
    normalizeImageBlob
} from './modules/raster-utils.js';

document.addEventListener('DOMContentLoaded', () => {
    const elements = {
        welcomeScreen: document.getElementById('welcome-screen'),
        mainContent: document.getElementById('main-content'),
        loaderOverlay: document.getElementById('loader-overlay'),
        loaderTitle: document.getElementById('loader-title'),
        loaderSubtitle: document.getElementById('loader-subtitle'),
        loaderProgressShell: document.getElementById('loader-progress-shell'),
        loaderProgressBar: document.getElementById('loader-progress-bar'),
        loaderProgressMeta: document.getElementById('loader-progress-meta'),
        workspace: document.querySelector('.workspace'),
        sidebarImportSection: document.getElementById('sidebar-import-section'),
        importPanelTitle: document.getElementById('import-panel-title'),
        importBtnLabel: document.getElementById('import-btn-label'),
        importModeCopy: document.getElementById('import-mode-copy'),
        importUrlShell: document.getElementById('import-url-shell'),
        sidebarAdjustSection: document.getElementById('sidebar-adjust-section'),
        sidebarPrimaryFooter: document.getElementById('sidebar-primary-footer'),
        sourceImage: document.getElementById('source-image'),
        singleOriginalView: document.getElementById('single-original-view'),
        bulkOriginalView: document.getElementById('bulk-original-view'),
        statusText: document.getElementById('status-text'),
        importBtn: document.getElementById('import-btn'),
        fileInput: document.getElementById('file-input'),
        urlInput: document.getElementById('url-input'),
        loadUrlBtn: document.getElementById('load-url-btn'),
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

    function showLoader(show, options = {}) {
        if (show) {
            const {
                title = 'Processing Image...',
                subtitle = '',
                progress = null
            } = options;

            if (elements.loaderTitle) {
                elements.loaderTitle.textContent = title;
            }

            if (elements.loaderSubtitle) {
                elements.loaderSubtitle.textContent = subtitle;
                elements.loaderSubtitle.classList.toggle('hidden', !subtitle);
            }

            if (elements.loaderProgressShell && elements.loaderProgressBar && elements.loaderProgressMeta) {
                const hasProgress = typeof progress === 'number' && !Number.isNaN(progress);
                const normalizedProgress = hasProgress
                    ? Math.max(0, Math.min(1, progress))
                    : 0;

                elements.loaderProgressShell.classList.toggle('hidden', !hasProgress);
                elements.loaderProgressBar.style.width = `${normalizedProgress * 100}%`;
                elements.loaderProgressMeta.textContent = `${Math.round(normalizedProgress * 100)}%`;
            }
        } else {
            if (elements.loaderTitle) {
                elements.loaderTitle.textContent = 'Processing Image...';
            }
            if (elements.loaderSubtitle) {
                elements.loaderSubtitle.textContent = '';
                elements.loaderSubtitle.classList.add('hidden');
            }
            if (elements.loaderProgressShell) {
                elements.loaderProgressShell.classList.add('hidden');
            }
            if (elements.loaderProgressBar) {
                elements.loaderProgressBar.style.width = '0%';
            }
            if (elements.loaderProgressMeta) {
                elements.loaderProgressMeta.textContent = '0%';
            }
        }

        elements.loaderOverlay.style.display = show ? 'flex' : 'none';
    }

    function readBlobAsDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (event) => resolve(event.target?.result);
            reader.onerror = () => reject(new Error('Failed to read image data.'));
            reader.readAsDataURL(blob);
        });
    }

    function validateImageSource(src) {
        return new Promise((resolve, reject) => {
            const probe = new Image();
            probe.onload = () => resolve();
            probe.onerror = () => reject(new Error(`This image format could not be opened here. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`));
            probe.src = src;
        });
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

    function syncImportPanel() {
        const isBulk = state.activeTab === 'bulk';

        if (elements.importPanelTitle) {
            elements.importPanelTitle.textContent = isBulk ? '1. Load Folder' : '1. Load Image';
        }
        if (elements.importBtnLabel) {
            elements.importBtnLabel.textContent = isBulk ? 'Choose Folder' : 'Import From Device';
        }
        if (elements.importModeCopy) {
            elements.importModeCopy.textContent = isBulk
                ? `Scan a folder of ${IMPORTABLE_IMAGE_PROMPT} for batch resize and ZIP export.`
                : `Choose a single image from your device or paste a direct image URL. Supported imports: ${IMPORTABLE_IMAGE_PROMPT}.`;
        }
        if (elements.importUrlShell) {
            elements.importUrlShell.classList.toggle('hidden', isBulk);
        }
        if (elements.sidebarAdjustSection) {
            elements.sidebarAdjustSection.classList.toggle('hidden', isBulk);
        }
        if (elements.sidebarPrimaryFooter) {
            elements.sidebarPrimaryFooter.classList.toggle('hidden', isBulk);
        }
        if (elements.resolutionNotice && isBulk) {
            elements.resolutionNotice.classList.add('hidden');
        }
        if (elements.importBtn) {
            elements.importBtn.setAttribute('aria-label', isBulk ? 'Choose a folder for bulk conversion' : 'Import an image from your device');
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
            elements.bulkDownloadFooter.classList.add('hidden');
        }

        setOriginalPanelMode(target === 'bulk' ? 'bulk' : 'single');
        syncImportPanel();
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

    async function handleImportedFile(file) {
        if (!isImportableImageFile(file)) {
            elements.statusText.textContent = `Unsupported file. Import supports ${IMPORTABLE_IMAGE_PROMPT}.`;
            return;
        }

        resetImageInfo();
        state.originalImageFormat = getImageFormat(file.name, null);
        state.originalImageSize = file.size;

        try {
            showLoader(true, {
                title: 'Loading Image...',
                subtitle: `Opening ${file.name}`
            });

            const normalizedFile = normalizeImageBlob(file, file.name);
            const dataUrl = await readBlobAsDataUrl(normalizedFile);
            await validateImageSource(dataUrl);
            loadImage(dataUrl, file.name);
            elements.statusText.textContent = `${file.name} loaded.`;
        } catch (error) {
            console.error('Local image load error:', error);
            elements.statusText.textContent = error.message || `Failed to load image. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`;
            showLoader(false);
        }
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
                const blob = normalizeImageBlob(await response.blob(), url.split('/').pop());
                dataUrl = await readBlobAsDataUrl(blob);
            }
            await validateImageSource(dataUrl);
            loadImage(dataUrl, url.split('/').pop());
        } catch (error) {
            console.error('URL load error:', error);
            elements.statusText.textContent = error.message || `Failed to load image from URL. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`;
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
                const file = Array.from(dt.files).find(isImportableImageFile);
                if (file) {
                    handleImportedFile(file);
                    return;
                }

                elements.statusText.textContent = `Dragged file is not a compatible image. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`;
                return;
            }

            const url = dt?.getData('text/uri-list') || dt?.getData('text/plain');
            if (url) {
                loadImageFromUrl(url.trim());
            }
        });
    }

    function bindAppEvents() {
        if (elements.importBtn) {
            elements.importBtn.addEventListener('click', () => {
                if (state.activeTab === 'bulk') {
                    elements.bulkFolderInput?.click();
                    return;
                }
                elements.fileInput?.click();
            });
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
        syncImportPanel();
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
