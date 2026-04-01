import { createBulkTabController } from './modules/tabs/bulk-tab.js';
import { createRasterTabController } from './modules/tabs/raster-tab.js';
import { createSvgTabController } from './modules/tabs/svg-tab.js';
import { createLogoTabController } from './modules/tabs/logo-tab.js?v=7';
import {
    getDataUrlSize,
    getImageFormat,
    IMPORTABLE_IMAGE_PROMPT,
    isImportableImageFile,
    normalizeImageBlob
} from './modules/raster-utils.js';
import { createElements } from './modules/app-elements.js';
import { createState } from './modules/app-state.js';

async function loadTabPartials() {
    const tabs = ['svg', 'logo', 'raster', 'bulk'];
    await Promise.all(tabs.map(async (name) => {
        const res = await fetch(`modules/tabs/html/tab-${name}.html`);
        const html = await res.text();
        const tmp = document.createElement('div');
        tmp.innerHTML = html;
        const panel = tmp.querySelector(`#tab-${name}`);
        const footer = tmp.querySelector('footer');
        const panelSlot = document.getElementById(`tab-${name}-slot`);
        const footerSlot = document.getElementById(`footer-${name}-slot`);
        if (panel && panelSlot) panelSlot.outerHTML = panel.outerHTML;
        if (footer && footerSlot) footerSlot.outerHTML = footer.outerHTML;
    }));
}

document.addEventListener('DOMContentLoaded', async () => {
    await loadTabPartials();

    const elements = createElements();
    const state = createState();

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
        const showPanel = mode === 'single'; // hide for both 'bulk' and 'svg'
        if (elements.originalImagePanel) {
            elements.originalImagePanel.classList.toggle('hidden', !showPanel);
        }
        if (elements.singleOriginalView) {
            elements.singleOriginalView.classList.toggle('hidden', showBulk);
        }
        if (elements.bulkOriginalView) {
            elements.bulkOriginalView.classList.toggle('hidden', !showBulk);
        }
    }

    function syncWorkspaceView() {
        const isSvgLike = state.activeTab === 'svg' || state.activeTab === 'logo';

        if (elements.welcomeScreen) {
            elements.welcomeScreen.style.display = 'none';
        }
        if (elements.mainContent) {
            elements.mainContent.classList.remove('hidden');
        }
        if (elements.outputSection) {
            elements.outputSection.style.display = 'flex';
        }

        setOriginalPanelMode(state.activeTab === 'bulk' ? 'bulk' : isSvgLike ? 'svg' : 'single');
    }

    function syncImportPanel() {
        const isBulk = state.activeTab === 'bulk';
        const isLogo = state.activeTab === 'logo';

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
        // Logo tab: hide conversion sliders and manual action buttons — all settings are automated
        if (elements.sidebarAdjustSection) {
            elements.sidebarAdjustSection.classList.toggle('hidden', isBulk || isLogo);
        }
        if (elements.sidebarPrimaryFooter) {
            elements.sidebarPrimaryFooter.classList.toggle('hidden', isBulk || isLogo);
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

    const logoTab = createLogoTabController({
        state,
        ls: state.logo,
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

        document.querySelectorAll('[data-tab-footer]').forEach(f => {
            f.classList.toggle('hidden', f.dataset.tabFooter !== target);
        });

        const isSvgLike = target === 'svg' || target === 'logo';
        setOriginalPanelMode(target === 'bulk' ? 'bulk' : isSvgLike ? 'svg' : 'single');
        syncImportPanel();
        syncWorkspaceView();

        updateSegmentedControlIndicator();

        if (target === 'svg' && hasSingleImageLoaded()) {
            svgTab.onTabActivated();
        } else if (target === 'logo' && hasSingleImageLoaded()) {
            logoTab.onTabActivated();
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
        if (elements.svgSourceMirror) elements.svgSourceMirror.src = src;
        if (elements.logoSvgSourceMirror) elements.logoSvgSourceMirror.src = src;
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
        logoTab.bindEvents();

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
