import { createAnnotateTabController } from './modules/tabs/annotate-tab.js?v=r-0482439758aef41c';
import { createBulkTabController } from './modules/tabs/bulk-tab.js?v=r-0482439758aef41c';
import { createRasterTabController } from './modules/tabs/raster-tab.js?v=r-0482439758aef41c';
import { createSvgTabController } from './modules/tabs/svg-tab.js?v=r-0482439758aef41c';
import { createLogoTabController } from './modules/tabs/logo-tab.js?v=r-0482439758aef41c';
import { createPdfTabController } from './modules/tabs/pdf-tab.js?v=r-0482439758aef41c';
import {
    getDataUrlSize,
    getFileStem,
    getImageFormat,
    IMPORTABLE_IMAGE_PROMPT,
    isImportableImageFile,
    normalizeImageBlob
} from './modules/raster-utils.js?v=r-0482439758aef41c';
// Only the classifier is imported eagerly — it is a few string checks. The
// ~1.4 MB libheif WebAssembly build behind decodeHeicToBlob stays unloaded
// until the HEIC branch below actually asks for it.
import { isHeicFile } from './modules/shared/heic.js?v=r-0482439758aef41c';
import { createElements } from './modules/app-elements.js?v=r-0482439758aef41c';
import { createState } from './modules/app-state.js?v=r-0482439758aef41c';
import { applyTabCase, TAB_CASES } from './modules/tab-cases.js?v=r-0482439758aef41c';
import { bindMagnetPocketControls } from './modules/shared/magnet-pocket-controls.js?v=r-0482439758aef41c';

async function loadTabPartials() {
    const appVersion = window.__GENESIS_APP_VERSION__
        || new URL(import.meta.url).searchParams.get('v')
        || 'dev';
    const withVersion = (path) => `${path}?v=${encodeURIComponent(appVersion)}`;
    const tabs = ['svg', 'logo', 'raster', 'bulk', 'pdf', 'annotate'];
    await Promise.all(tabs.map(async (name) => {
        const res = await fetch(withVersion(`modules/tabs/html/tab-${name}.html`));
        if (!res.ok) throw new Error(`Failed to load the ${name} tab (HTTP ${res.status}).`);
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

    const brandRes = await fetch(withVersion('modules/partials/footer-brand.html'));
    if (!brandRes.ok) throw new Error(`Failed to load the footer (HTTP ${brandRes.status}).`);
    const brandHtml = await brandRes.text();
    const brandSlot = document.getElementById('footer-brand-slot');
    if (brandSlot) brandSlot.outerHTML = brandHtml;
}

async function initializeApplication() {
    await loadTabPartials();

    const elements = createElements();
    const state = createState();
    // Read-only inspection hook. Each tab owns its own 3D state while sharing
    // one set of DOM controls, and that ownership is only observable from the
    // state tree, so browser tests need a handle on it.
    window.__GENESIS_APP_STATE__ = state;
    const TAB_SLUGS = Object.freeze({
        svg: '3d-obj',
        logo: 'logo',
        raster: 'raster',
        bulk: 'bulk',
        pdf: 'pdf',
        annotate: 'annotate'
    });

    function getTabFromPathname(pathname = window.location.pathname) {
        const pageName = pathname.split('/').filter(Boolean).pop()?.replace(/\.html$/i, '').toLowerCase() || '';
        const slugMatch = Object.entries(TAB_SLUGS).find(([, slug]) => slug === pageName)?.[0];
        if (slugMatch) return slugMatch;
        return Object.hasOwn(TAB_SLUGS, pageName) ? pageName : 'svg';
    }

    function syncTabSlug(target, historyMode) {
        if (!historyMode || !Object.hasOwn(TAB_SLUGS, target)) return;
        const pathname = `/${TAB_SLUGS[target]}`;
        try {
            window.localStorage.setItem('genesis:lastTool', pathname);
        } catch {
            // Tool navigation must remain functional when storage is unavailable.
        }
        if (window.location.pathname === pathname) return;
        window.history[`${historyMode}State`]({ tab: target }, '', pathname);
    }

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

                elements.loaderProgressShell.classList.remove('hidden');
                elements.loaderProgressShell.classList.toggle('is-indeterminate', !hasProgress);
                elements.loaderProgressBar.style.width = hasProgress
                    ? `${normalizedProgress * 100}%`
                    : '';
                elements.loaderProgressMeta.textContent = hasProgress
                    ? `${Math.round(normalizedProgress * 100)}%`
                    : 'Working…';
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
                elements.loaderProgressShell.classList.remove('is-indeterminate');
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

    function readBlobAsDataUrl(blob, { onProgress } = {}) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onprogress = (event) => {
                if (event.lengthComputable) {
                    onProgress?.(event.loaded / event.total);
                }
            };
            reader.onload = (event) => {
                onProgress?.(1);
                resolve(event.target?.result);
            };
            reader.onerror = () => reject(new Error('Failed to read image data.'));
            reader.readAsDataURL(blob);
        });
    }

    async function fetchImageBlobWithProgress(url, onProgress) {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch image (${response.status}).`);
        }

        const contentType = response.headers.get('content-type') || undefined;
        const contentLength = Number.parseInt(response.headers.get('content-length') || '', 10);

        if (!response.body || !Number.isFinite(contentLength) || contentLength <= 0) {
            const blob = await response.blob();
            onProgress?.(1);
            return blob;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;

            chunks.push(value);
            loaded += value.byteLength;
            onProgress?.(loaded / contentLength);
        }

        onProgress?.(1);
        return new Blob(chunks, { type: contentType });
    }

    function getImportDisplayName(source) {
        if (!source) return 'image';
        if (source.startsWith('data:')) return 'pasted image';

        try {
            const parsed = new URL(source);
            const pathname = parsed.pathname.split('/').filter(Boolean).pop();
            return pathname || parsed.hostname || 'remote image';
        } catch {
            const fallback = source.split('?')[0].split('#')[0];
            return fallback.split('/').filter(Boolean).pop() || 'remote image';
        }
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

    // The active tab's case (modules/tab-cases.js) owns which original-image
    // panel mode shows in column 2 — applied via applyCurrentTabCase below.
    // This only reveals the workspace shell (welcome -> main/output).
    function syncWorkspaceView() {
        if (elements.welcomeScreen) {
            elements.welcomeScreen.style.display = 'none';
        }
        if (elements.mainContent) {
            elements.mainContent.classList.remove('hidden');
        }
        if (elements.outputSection) {
            elements.outputSection.style.display = 'flex';
        }
    }

    // Drive column 1 (sidebar) and column 2 (workspace) for the active tab from
    // a single declarative source. Replaces the old per-element toggle pile.
    function applyCurrentTabCase() {
        return applyTabCase(state.activeTab, {
            importablePrompt: IMPORTABLE_IMAGE_PROMPT,
            svgIsDirty: state.isDirty,
            logoIsDirty: state.logo?.isDirty
        });
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

    const annotateTab = createAnnotateTabController({
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

    let svgTab = null;
    let logoTab = null;
    bindMagnetPocketControls({
        state,
        controls: elements.shared3d,
        onChange: () => {
            if (state.activeTab === 'logo') {
                logoTab?.updateFilteredPreview();
            } else if (state.activeTab === 'svg') {
                svgTab?.updateFilteredPreview();
            }
        }
    });

    svgTab = createSvgTabController({
        state,
        sharedElements: {
            sourceImage: elements.sourceImage,
            outputSection: elements.outputSection,
            statusText: elements.statusText,
            resolutionNotice: elements.resolutionNotice
        },
        sidebarControls: elements.svg.sidebar,
        previewElements: elements.svg.preview,
        paletteElements: elements.svg.palette,
        modelControls: elements.shared3d,
        viewControls: elements.svg.preview3d,
        exportElements: elements.svg.export,
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

    logoTab = createLogoTabController({
        state,
        ls: state.logo,
        sharedElements: {
            sourceImage: elements.sourceImage,
            outputSection: elements.outputSection,
            statusText: elements.statusText,
            resolutionNotice: elements.resolutionNotice
        },
        sidebarControls: elements.logo.sidebar,
        previewElements: elements.logo.preview,
        paletteElements: elements.logo.palette,
        modelControls: elements.shared3d,
        viewControls: elements.logo.preview3d,
        exportElements: elements.logo.export,
        htmlElements: elements.logo.html,
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

    const pdfTab = createPdfTabController({
        state,
        elements,
        showLoader,
        downloadBlob
    });

    function switchExportTab(target, { historyMode = null } = {}) {
        state.activeTab = target;
        syncTabSlug(target, historyMode);

        // One declarative call drives BOTH columns for this tab: sidebar
        // sections (column 1) plus the tab button, export panel, footer, and
        // original-image panel (column 2), the accent color, and the case strip.
        applyCurrentTabCase();
        syncWorkspaceView();
        updateSegmentedControlIndicator();

        // Explicit per-tab dispatch. The old else-chain fell through to the bulk
        // tab whenever svg/raster were opened without an image, so switching to
        // the 3D tab on an empty workspace ran the Bulk tab's activation and
        // skipped the 3D tab's own (which includes resyncing the shared 3D
        // controls to this tab's objParams).
        switch (target) {
            case 'svg':
                svgTab.onTabActivated();
                break;
            case 'logo':
                logoTab.onTabActivated();
                break;
            case 'raster':
                rasterTab.onTabActivated();
                break;
            case 'pdf':
                pdfTab.onTabActivated();
                break;
            case 'bulk':
                bulkTab.onTabActivated();
                break;
            case 'annotate':
                annotateTab.onTabActivated();
                break;
            default:
                break;
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

        // Every tab reads the same <img>, so stamp a new generation. Tabs compare
        // it against their own tracedSourceGeneration on activation and discard
        // results traced from a previous source.
        state.sourceGeneration = (state.sourceGeneration || 0) + 1;

        elements.sourceImage.src = src;
        // Only the active Logo tab mirrors the import. Copying it while another
        // tab is active leaked that tab's image into the Logo workspace.
        if (state.activeTab === 'logo' && elements.logo?.preview?.svgSourceMirror) {
            elements.logo.preview.svgSourceMirror.src = src;
        }
    }

    function resetImageInfo() {
        state.originalImageFormat = null;
        state.originalImageSize = null;
    }

    // Decodes a HEIC/HEIF blob to a PNG File so the rest of the import pipeline
    // (data URL -> <img> -> every tab) never has to know HEIC exists. The
    // decoder module is pulled in here, on first use, so the WebAssembly build
    // is never downloaded by visitors who only import PNG/JPG.
    async function convertHeicForImport(file, updateImportProgress, progress = 0.08) {
        updateImportProgress(progress, `Converting ${file.name || 'image'} from HEIC`);
        const { decodeHeicToBlob } = await import('./modules/shared/heic.js?v=r-0482439758aef41c');
        const pngBlob = await decodeHeicToBlob(file, 'image/png');
        const pngName = `${getFileStem(file.name || 'image')}.png`;
        return new File([pngBlob], pngName, { type: 'image/png' });
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
            const updateImportProgress = (progress, subtitle) => {
                showLoader(true, {
                    title: 'Loading Image...',
                    subtitle,
                    progress
                });
            };

            updateImportProgress(0.05, `Preparing ${file.name}`);
            // iPhone photos arrive as HEIC, which no browser but Safari can put
            // in an <img>. Decode them to PNG first; every tab downstream reads
            // the same source <img>, so one conversion here covers all of them.
            const importSource = isHeicFile(file)
                ? await convertHeicForImport(file, updateImportProgress)
                : file;
            const normalizedFile = normalizeImageBlob(importSource, importSource.name);
            updateImportProgress(0.15, `Reading ${file.name}`);
            const dataUrl = await readBlobAsDataUrl(normalizedFile, {
                onProgress: (progress) => {
                    updateImportProgress(0.15 + (progress * 0.6), `Reading ${file.name}`);
                }
            });
            updateImportProgress(0.82, `Validating ${file.name}`);
            await validateImageSource(dataUrl);
            updateImportProgress(0.96, `Rendering ${file.name}`);
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

        const displayName = getImportDisplayName(url);
        const updateImportProgress = (progress, subtitle) => {
            showLoader(true, {
                title: 'Loading Image...',
                subtitle,
                progress
            });
        };

        updateImportProgress(0.05, url.startsWith('data:') ? 'Preparing pasted image' : `Fetching ${displayName}`);
        elements.statusText.textContent = 'Fetching image...';
        try {
            let dataUrl;
            if (url.startsWith('data:')) {
                dataUrl = url;
                updateImportProgress(0.75, 'Reading pasted image');
            } else {
                let blob = normalizeImageBlob(
                    await fetchImageBlobWithProgress(url, (progress) => {
                        updateImportProgress(0.1 + (progress * 0.6), `Fetching ${displayName}`);
                    }),
                    displayName
                );
                if (isHeicFile({ name: displayName, type: blob.type })) {
                    blob = await convertHeicForImport(
                        new File([blob], displayName, { type: blob.type || 'image/heic' }),
                        updateImportProgress,
                        0.72
                    );
                }
                updateImportProgress(0.78, `Reading ${displayName}`);
                dataUrl = await readBlobAsDataUrl(blob, {
                    onProgress: (progress) => {
                        updateImportProgress(0.78 + (progress * 0.14), `Reading ${displayName}`);
                    }
                });
            }
            updateImportProgress(0.94, `Validating ${displayName}`);
            await validateImageSource(dataUrl);
            updateImportProgress(0.98, `Rendering ${displayName}`);
            loadImage(dataUrl, displayName);
            elements.statusText.textContent = `${displayName} loaded.`;
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
                switchExportTab(btn.dataset.tab, { historyMode: 'push' });
            });
        });

        window.addEventListener('popstate', () => {
            switchExportTab(getTabFromPathname());
        });
    }

    function initialize() {
        bindAppEvents();
        setupWorkspaceDragAndDrop();

        rasterTab.bindEvents();
        annotateTab.bindEvents();
        bulkTab.bindEvents();
        svgTab.bindEvents();
        logoTab.bindEvents();
        pdfTab.bindEvents();

        // SVG and Logo own their active 3D pipelines. Other tabs still need one
        // source-load completion path so the import overlay cannot remain open.
        elements.sourceImage?.addEventListener('load', () => {
            if (state.activeTab === 'svg' || state.activeTab === 'logo') return;
            rasterTab.onSourceImageLoaded();
            annotateTab.onSourceImageLoaded();
            showLoader(false);
        });

        // Named HTML entrypoints canonicalize to each tab's clean slug.
        switchExportTab(getTabFromPathname(), { historyMode: 'replace' });
        rasterTab.setExportScale(state.exportScale);
        bulkTab.setExportScale(state.bulk.exportScale);
        svgTab.syncTraceControlUi();
        logoTab.syncTraceControlUi();
        rasterTab.updateExportScaleDisplay();
        applyCurrentTabCase();
        syncWorkspaceView();
    }

    initialize();
    window.__GENESIS_APP_EVENTS_BOUND__ = true;
    const pendingImportFile = window.__GENESIS_PENDING_IMPORT_FILE__;
    window.__GENESIS_PENDING_IMPORT_FILE__ = null;
    if (pendingImportFile) {
        if (elements.fileInput) elements.fileInput.value = '';
        await handleImportedFile(pendingImportFile);
    }
}

let applicationStartPromise = null;

export function startApplication() {
    if (!applicationStartPromise) applicationStartPromise = initializeApplication();
    return applicationStartPromise;
}

function startWhenDomIsReady() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void startApplication(), { once: true });
    } else {
        void startApplication();
    }
}

if (!window.__GENESIS_BOOTSTRAP_MANAGED__) startWhenDomIsReady();
