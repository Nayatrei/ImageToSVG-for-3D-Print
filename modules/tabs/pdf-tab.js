import {
    formatPdfBytes,
    getPdfImageExportDimensions,
    parsePdfPageRange,
    PDF_IMAGE_EXPORT_MAX_TOTAL_BYTES,
    sanitizePdfFilename,
    validatePdfImageExportPlan
} from './pdf-utils.js?v=r-afbde72383fa3b50';
import {
    canvasToBlobAsync,
    estimateSizeBytes,
    exportCanvasToRasterBlob,
    formatBytes,
    getRasterExtension,
    sanitizeFileComponent
} from '../raster-utils.js?v=r-afbde72383fa3b50';
import { createZipFile } from '../export3d.js?v=r-afbde72383fa3b50';
import { createImageToPdfController } from './pdf-image-to-pdf.js?v=r-afbde72383fa3b50';
import { createPdfOcrController } from './pdf-ocr.js?v=r-afbde72383fa3b50';

let pdfLibPromise = null;
let pdfJsPromise = null;

const MAX_THUMBS = 60;
const THUMB_WIDTH = 160;
const MAX_REVIEW_THUMBS = 12;
const STEP_COUNT = 3;
const IMAGE_EXPORT_FORMATS = ['png', 'jpg', 'webp', 'tga'];
// WEBP reuses the JPG quality level; raster-utils only knows png/jpg/tga.
const IMAGE_EXPORT_LOSSY_QUALITY = 0.92;
const WEBP_SIZE_RATIO_TO_JPG = 0.8;
const IMAGE_WIDTH_MIN = 16;
const IMAGE_WIDTH_MAX = 8192;
const PDF_TASKS = ['combine', 'pdf-images', 'images-pdf', 'ocr'];
const PDF_DOCUMENT_TASKS = new Set(['combine', 'pdf-images']);

function getImageExportExtension(format) {
    return format === 'webp' ? 'webp' : getRasterExtension(format);
}

function estimateImageExportBytes(width, height, format) {
    if (format === 'webp') {
        return Math.max(1, Math.round(estimateSizeBytes(width, height, 'jpg', false) * WEBP_SIZE_RATIO_TO_JPG));
    }
    return estimateSizeBytes(width, height, format, false);
}

async function exportCanvasToImageBlob(canvas, format) {
    if (format === 'webp') {
        const blob = await canvasToBlobAsync(canvas, 'image/webp', IMAGE_EXPORT_LOSSY_QUALITY);
        // Browsers without a WEBP encoder silently hand back PNG bytes.
        if (blob.type !== 'image/webp') {
            throw new Error('This browser cannot encode WEBP images. Choose JPG or PNG instead.');
        }
        return blob;
    }
    return exportCanvasToRasterBlob(canvas, format, false);
}

async function getPdfLib() {
    if (!pdfLibPromise) {
        pdfLibPromise = import('../../vendor/pdf-lib/pdf-lib.esm.min.js?v=r-afbde72383fa3b50');
    }
    return pdfLibPromise;
}

async function getPdfJs() {
    if (!pdfJsPromise) {
        pdfJsPromise = import('../../vendor/pdfjs/pdf.min.mjs?v=r-afbde72383fa3b50').then((pdfjs) => {
            pdfjs.GlobalWorkerOptions.workerSrc =
                new URL('../../vendor/pdfjs/pdf.worker.min.mjs?v=r-afbde72383fa3b50', import.meta.url).href;
            return pdfjs;
        });
    }
    return pdfJsPromise;
}

export function createPdfTabController({
    state,
    elements,
    showLoader,
    downloadBlob
}) {
    let nextId = 1;
    let taskNavigationMediaQuery = null;
    let taskNavigationChangeHandler = null;
    let taskNavigationListenerBound = false;
    const imageToPdfController = createImageToPdfController({
        state,
        elements,
        showLoader,
        downloadBlob
    });
    const ocrController = createPdfOcrController({
        state,
        elements,
        showLoader,
        downloadBlob
    });

    function getActiveTask() {
        return PDF_TASKS.includes(state.pdf.activeTask)
            ? state.pdf.activeTask
            : 'combine';
    }

    function moveTaskNavigationToResponsiveHost() {
        const navigation = elements.pdf.taskNavigation;
        const targetHost = taskNavigationMediaQuery?.matches
            ? elements.pdf.taskNavigationSidebarHost
            : elements.pdf.taskNavigationWorkspaceHost;

        if (navigation && targetHost && navigation.parentElement !== targetHost) {
            targetHost.append(navigation);
        }
    }

    function bindTaskNavigationLocation() {
        if (taskNavigationListenerBound) {
            moveTaskNavigationToResponsiveHost();
            return;
        }

        taskNavigationListenerBound = true;
        if (typeof window.matchMedia !== 'function') {
            moveTaskNavigationToResponsiveHost();
            return;
        }

        taskNavigationMediaQuery = window.matchMedia('(min-width: 1024px)');
        taskNavigationChangeHandler = moveTaskNavigationToResponsiveHost;

        if (typeof taskNavigationMediaQuery.addEventListener === 'function') {
            taskNavigationMediaQuery.addEventListener('change', taskNavigationChangeHandler);
        } else {
            taskNavigationMediaQuery.addListener?.(taskNavigationChangeHandler);
        }

        moveTaskNavigationToResponsiveHost();
    }

    function disposeTaskNavigationLocation() {
        if (taskNavigationMediaQuery && taskNavigationChangeHandler) {
            if (typeof taskNavigationMediaQuery.removeEventListener === 'function') {
                taskNavigationMediaQuery.removeEventListener('change', taskNavigationChangeHandler);
            } else {
                taskNavigationMediaQuery.removeListener?.(taskNavigationChangeHandler);
            }
        }

        taskNavigationMediaQuery = null;
        taskNavigationChangeHandler = null;
        taskNavigationListenerBound = false;

        const navigation = elements.pdf.taskNavigation;
        const workspaceHost = elements.pdf.taskNavigationWorkspaceHost;
        if (navigation && workspaceHost && navigation.parentElement !== workspaceHost) {
            workspaceHost.append(navigation);
        }
    }

    function setActiveTask(requestedTask) {
        const task = PDF_TASKS.includes(requestedTask) ? requestedTask : 'combine';
        state.pdf.activeTask = task;
        if (PDF_DOCUMENT_TASKS.has(task)) {
            state.pdf.activeStep = 1;
        }
        moveTaskNavigationToResponsiveHost();
        syncTaskUi();
        if (task === 'images-pdf') imageToPdfController.render();
        if (task === 'ocr') ocrController.render();

        if (task === 'combine') {
            setStatus('Choose pages, then save one combined PDF.', getOutputEntries().length ? 'ready' : 'muted');
        } else if (task === 'pdf-images') {
            setStatus('Choose the PDF pages you want to save as images.', getOutputEntries().length ? 'ready' : 'muted');
        }
    }

    function syncTaskUi() {
        const task = getActiveTask();
        const usesPdfDocuments = PDF_DOCUMENT_TASKS.has(task);
        state.pdf.activeTask = task;

        if (elements.pdf.guidedShell) {
            elements.pdf.guidedShell.dataset.activeTask = task;
        }

        elements.pdf.taskButtons?.forEach((button) => {
            const active = button.dataset.pdfTask === task;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });

        elements.pdf.taskPanels?.forEach((panel) => {
            const panelTask = panel.dataset.pdfTaskPanel;
            const active = panelTask === 'documents'
                ? usesPdfDocuments
                : panelTask === task;
            panel.classList.toggle('hidden', !active);
            panel.setAttribute('aria-hidden', String(!active));
        });

        elements.pdf.documentActionPanels?.forEach((panel) => {
            panel.classList.toggle('hidden', panel.dataset.pdfDocumentAction !== task);
        });

        const sidebarMode = usesPdfDocuments ? 'documents' : task;
        [
            elements.pdf.documentSidebarMode,
            elements.pdf.imageSidebarMode,
            elements.pdf.ocrSidebarMode
        ].forEach((mode) => {
            if (!mode) return;
            const active = mode.dataset.pdfSidebarMode === sidebarMode;
            mode.classList.toggle('hidden', !active);
            mode.setAttribute('aria-hidden', String(!active));
        });
        if (elements.pdf.sidebar) {
            elements.pdf.sidebar.dataset.activeTask = task;
        }

        const pdfTabIsActive = state.activeTab === 'pdf';
        elements.pdf.mergeFooter?.classList.toggle('hidden', !pdfTabIsActive || !usesPdfDocuments);

        syncStepUi();
    }

    function getReadyItems() {
        return state.pdf.files.filter((item) => item.status === 'ready');
    }

    function getValidMergeItems() {
        return state.pdf.files.filter((item) => (
            item.status === 'ready'
            && !item.error
            && Array.isArray(item.selectedIndices)
            && item.selectedIndices.length > 0
        ));
    }

    function getOutputEntries() {
        const entries = [];
        getValidMergeItems().forEach((item) => {
            item.selectedIndices.forEach((sourceIndex) => {
                entries.push({
                    fileId: item.id,
                    fileName: item.name,
                    item,
                    sourceIndex,
                    rotation: normalizeRotation(item.pageRotations?.[sourceIndex] || 0),
                    outputIndex: entries.length
                });
            });
        });
        return entries;
    }

    function getFocusedItem() {
        const focused = state.pdf.focusedPage;
        if (!focused) return null;
        return state.pdf.files.find((item) => item.id === focused.fileId) || null;
    }

    function getFocusedEntry(entries = getOutputEntries()) {
        const focused = state.pdf.focusedPage;
        if (!focused) return null;
        return entries.find((entry) => (
            entry.fileId === focused.fileId
            && entry.sourceIndex === focused.pageIndex
        )) || null;
    }

    function ensureFocusedPage() {
        const focused = state.pdf.focusedPage;
        const focusedItem = getFocusedItem();
        const focusIsUsable = focusedItem
            && focusedItem.status === 'ready'
            && Number.isInteger(focused.pageIndex)
            && focused.pageIndex >= 0
            && focused.pageIndex < focusedItem.pageCount;

        if (focusIsUsable) return;

        const firstReady = getReadyItems().find((item) => item.pageCount > 0);
        state.pdf.focusedPage = firstReady
            ? { fileId: firstReady.id, pageIndex: 0 }
            : null;
    }

    function setStatus(message, tone = 'muted') {
        if (elements.pdf.footerStatus) {
            elements.pdf.footerStatus.textContent = message;
            elements.pdf.footerStatus.dataset.tone = tone;
        }
    }

    function renderSummary() {
        const totalFiles = state.pdf.files.length;
        const readyFiles = getReadyItems().length;
        const outputEntries = getOutputEntries();
        const totalPages = outputEntries.length;
        const errorCount = state.pdf.files.filter((item) => item.status === 'error' || item.error).length;
        const hasErrors = errorCount > 0;
        const isReading = state.pdf.files.some((item) => item.status === 'loading');
        const isBusy = isReading || state.pdf.isMerging;
        const canExport = totalFiles > 0
            && readyFiles === totalFiles
            && !hasErrors
            && totalPages > 0
            && !isBusy;

        if (elements.pdf.fileCount) elements.pdf.fileCount.textContent = String(totalFiles);
        if (elements.pdf.pageCount) elements.pdf.pageCount.textContent = String(totalPages);
        if (elements.pdf.errorCount) elements.pdf.errorCount.textContent = String(errorCount);
        if (elements.pdf.mergeBtn) elements.pdf.mergeBtn.disabled = !canExport;
        if (elements.pdf.imageExportBtn) elements.pdf.imageExportBtn.disabled = !canExport;
        if (elements.pdf.nextBtn) elements.pdf.nextBtn.disabled = !canExport;
        if (elements.pdf.selectAllBtn) elements.pdf.selectAllBtn.disabled = readyFiles === 0 || isBusy;
        if (elements.pdf.clearBtn) elements.pdf.clearBtn.disabled = totalPages === 0 || isBusy;

        elements.pdf.stepButtons?.forEach((button) => {
            const step = Number.parseInt(button.dataset.pdfStep, 10);
            button.disabled = step > 1 && !canExport;
        });

        if (!totalFiles) {
            setStatus('Add one or more PDF files to begin.');
        } else if (isReading && !state.pdf.isMerging) {
            setStatus(`Reading ${readyFiles}/${totalFiles} PDF${totalFiles === 1 ? '' : 's'}...`);
        } else if (hasErrors) {
            setStatus('Fix or remove the highlighted PDF before continuing.', 'error');
        } else if (!totalPages) {
            setStatus('Select at least one output page.', 'error');
        } else if (getActiveTask() === 'pdf-images') {
            setStatus(`${totalPages} selected page${totalPages === 1 ? '' : 's'} ready to save as images.`, 'ready');
        } else {
            setStatus(`${totalPages} selected page${totalPages === 1 ? '' : 's'} ready to combine.`, 'ready');
        }

        syncFocusedActions();
        syncStepUi();
        renderCombineSummary();
        renderReview();
    }

    function renderCombineSummary() {
        const outputEntries = getOutputEntries();
        if (elements.pdf.combinePageCount) {
            elements.pdf.combinePageCount.textContent = String(outputEntries.length);
        }
        if (!elements.pdf.combineFileSummary) return;

        elements.pdf.combineFileSummary.textContent = '';
        const items = state.pdf.files.filter((item) => item.status !== 'error');
        if (!items.length) {
            const empty = document.createElement('span');
            empty.textContent = 'No PDF files added yet.';
            elements.pdf.combineFileSummary.appendChild(empty);
            return;
        }

        items.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'pdf-combine-summary-row';
            const name = document.createElement('span');
            name.textContent = `${index + 1}. ${item.name}`;
            name.title = item.name;
            const count = document.createElement('strong');
            count.textContent = item.status === 'loading'
                ? 'Reading…'
                : `${item.selectedIndices.length} page${item.selectedIndices.length === 1 ? '' : 's'}`;
            row.append(name, count);
            elements.pdf.combineFileSummary.appendChild(row);
        });
    }

    function renderFileList() {
        const list = elements.pdf.fileList;
        if (!list) return;

        list.textContent = '';

        state.pdf.files.forEach((item, index) => {
            list.appendChild(createFileRow(item, index));
        });

        ensureFocusedPage();
        renderSummary();
        renderPreview();
        renderFinishPreview();
    }

    function renderPreview() {
        const list = elements.pdf.previewList;
        if (!list) return;

        const hasFiles = state.pdf.files.length > 0;
        elements.pdf.previewEmpty?.classList.toggle('hidden', hasFiles);
        elements.pdf.pageToolbar?.classList.toggle('hidden', !hasFiles);
        list.classList.toggle('hidden', !hasFiles);
        list.textContent = '';
        if (!hasFiles) return;

        const outputEntries = getOutputEntries();
        const outputOrder = new Map(outputEntries.map((entry) => [
            pageKey(entry.fileId, entry.sourceIndex),
            entry.outputIndex + 1
        ]));

        state.pdf.files.forEach((item) => {
            const isReady = item.status === 'ready' && !item.error;
            const card = document.createElement('article');
            card.className = 'pdf-preview-card pdf-arrange-group';
            card.dataset.status = item.error ? 'error' : item.status;

            const top = document.createElement('div');
            top.className = 'pdf-preview-card-top';

            const info = document.createElement('div');
            info.className = 'pdf-preview-card-info';

            const name = document.createElement('strong');
            name.className = 'pdf-preview-card-name';
            name.textContent = item.name;
            name.title = item.name;

            const meta = document.createElement('span');
            meta.className = 'pdf-preview-card-meta';
            meta.textContent = item.status === 'loading'
                ? 'Reading pages...'
                : item.error
                    ? item.error
                    : `${item.selectedIndices.length} of ${item.pageCount} pages in output`;

            info.append(name, meta);
            top.appendChild(info);
            card.appendChild(top);

            if (isReady && item.pageCount > 0) {
                card.appendChild(buildThumbGrid(item, outputOrder));
            } else if (item.status === 'loading') {
                const skeleton = document.createElement('div');
                skeleton.className = 'pdf-file-loading-state';
                skeleton.innerHTML = '<span></span><span></span><span></span>';
                card.appendChild(skeleton);
            }

            list.appendChild(card);
        });
    }

    function buildThumbGrid(item, outputOrder) {
        const includedPages = new Set(item.selectedIndices);
        const thumbCount = Math.min(item.pageCount, MAX_THUMBS);
        const grid = document.createElement('div');
        grid.className = 'pdf-thumb-grid';

        for (let pageIndex = 0; pageIndex < thumbCount; pageIndex += 1) {
            const included = includedPages.has(pageIndex);
            const focused = state.pdf.focusedPage?.fileId === item.id
                && state.pdf.focusedPage?.pageIndex === pageIndex;
            const rotation = normalizeRotation(item.pageRotations?.[pageIndex] || 0);
            const outputNumber = outputOrder.get(pageKey(item.id, pageIndex));

            const cell = document.createElement('article');
            cell.className = 'pdf-thumb';
            cell.dataset.id = item.id;
            cell.dataset.page = String(pageIndex);
            cell.classList.toggle('is-included', included);
            cell.classList.toggle('is-focused', focused);

            const preview = document.createElement('button');
            preview.type = 'button';
            preview.className = 'pdf-thumb-preview';
            preview.dataset.pageAction = 'focus';
            preview.setAttribute('aria-label', `${item.name}, page ${pageIndex + 1}`);
            preview.setAttribute('aria-pressed', String(focused));

            const frame = document.createElement('span');
            frame.className = 'pdf-thumb-frame';
            const dataUrl = item.thumbs?.[pageIndex];
            if (dataUrl) {
                frame.appendChild(createThumbImage(dataUrl, rotation));
            } else {
                frame.classList.add('is-loading');
            }
            preview.appendChild(frame);

            if (outputNumber) {
                const outputBadge = document.createElement('span');
                outputBadge.className = 'pdf-thumb-output-order';
                outputBadge.textContent = String(outputNumber);
                preview.appendChild(outputBadge);
            }

            if (rotation) {
                const rotationBadge = document.createElement('span');
                rotationBadge.className = 'pdf-thumb-rotation';
                rotationBadge.textContent = `${rotation}°`;
                preview.appendChild(rotationBadge);
            }

            const meta = document.createElement('div');
            meta.className = 'pdf-thumb-meta';

            const number = document.createElement('span');
            number.className = 'pdf-thumb-num';
            number.textContent = `Page ${pageIndex + 1}`;

            const toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = 'pdf-thumb-toggle';
            toggle.dataset.pageAction = 'toggle';
            toggle.textContent = included ? 'Included' : 'Removed';
            toggle.setAttribute('aria-label', `${included ? 'Remove' : 'Include'} page ${pageIndex + 1}`);
            toggle.setAttribute('aria-pressed', String(included));

            meta.append(number, toggle);
            cell.append(preview, meta);
            grid.appendChild(cell);
        }

        if (item.pageCount > MAX_THUMBS) {
            const more = document.createElement('div');
            more.className = 'pdf-thumb-overflow';
            more.textContent = `The first ${MAX_THUMBS} pages are previewed. Use the range field on the left for the remaining ${item.pageCount - MAX_THUMBS}.`;
            grid.appendChild(more);
        }

        return grid;
    }

    async function renderThumbnails(item) {
        if (item.thumbStatus === 'rendering' || item.thumbStatus === 'done') return;
        item.thumbStatus = 'rendering';

        let doc = null;
        try {
            const pdfjs = await getPdfJs();
            doc = await pdfjs.getDocument({
                data: item.bytes.slice(),
                standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
                isEvalSupported: false,
                disableAutoFetch: true,
                disableStream: true
            }).promise;

            const count = Math.min(doc.numPages, MAX_THUMBS);
            if (!Array.isArray(item.thumbs)) {
                item.thumbs = new Array(item.pageCount).fill(null);
            }
            if (!Array.isArray(item.pageSizes)) {
                item.pageSizes = new Array(item.pageCount).fill(null);
            }

            for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
                if (!state.pdf.files.includes(item)) break;

                const page = await doc.getPage(pageNumber);
                const base = page.getViewport({ scale: 1 });
                item.pageSizes[pageNumber - 1] = { width: base.width, height: base.height };
                const scale = THUMB_WIDTH / Math.max(base.width, 1);
                const viewport = page.getViewport({ scale });
                const canvas = document.createElement('canvas');
                canvas.width = Math.max(1, Math.ceil(viewport.width));
                canvas.height = Math.max(1, Math.ceil(viewport.height));
                const context = canvas.getContext('2d', { alpha: false });
                if (!context) throw new Error('Canvas preview is unavailable.');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                // 'print' intent skips requestAnimationFrame scheduling, so
                // thumbnails keep rendering while this tab is in the background.
                await page.render({ canvasContext: context, viewport, intent: 'print' }).promise;
                item.thumbs[pageNumber - 1] = canvas.toDataURL('image/jpeg', 0.86);
                page.cleanup();
                patchThumbCell(item, pageNumber - 1);
            }

            item.thumbStatus = 'done';
        } catch (error) {
            console.error('PDF thumbnail render error:', error);
            item.thumbStatus = 'error';
        } finally {
            if (doc) {
                try { await doc.destroy(); } catch { /* no-op */ }
            }
        }
    }

    function patchThumbCell(item, pageIndex) {
        const dataUrl = item.thumbs?.[pageIndex];
        if (!dataUrl) return;
        const cell = elements.pdf.previewList?.querySelector(
            `.pdf-thumb[data-id="${cssEscape(item.id)}"][data-page="${pageIndex}"]`
        );
        const frame = cell?.querySelector('.pdf-thumb-frame');
        if (frame && !frame.querySelector('img')) {
            frame.classList.remove('is-loading');
            frame.appendChild(createThumbImage(
                dataUrl,
                normalizeRotation(item.pageRotations?.[pageIndex] || 0)
            ));
        }
        renderFinishPreview();
        renderReview();
    }

    function createThumbImage(dataUrl, rotation = 0) {
        const image = document.createElement('img');
        image.className = 'pdf-thumb-img';
        image.alt = '';
        image.loading = 'lazy';
        image.src = dataUrl;
        image.style.transform = `rotate(${rotation}deg)`;
        return image;
    }

    function focusPage(item, pageIndex) {
        if (item.status !== 'ready') return;
        state.pdf.focusedPage = { fileId: item.id, pageIndex };
        renderPreview();
        renderFinishPreview();
        syncFocusedActions();
    }

    function togglePageSelection(item, pageIndex) {
        if (item.status !== 'ready') return;
        const selectedIndex = item.selectedIndices.indexOf(pageIndex);
        if (selectedIndex >= 0) {
            item.selectedIndices.splice(selectedIndex, 1);
        } else {
            item.selectedIndices.push(pageIndex);
        }
        item.rangeText = indicesToRangeText(item.selectedIndices, item.pageCount);
        item.error = '';
        state.pdf.focusedPage = { fileId: item.id, pageIndex };
        renderFileList();
    }

    function rotateFocusedPage(delta) {
        const item = getFocusedItem();
        const pageIndex = state.pdf.focusedPage?.pageIndex;
        if (!item || !Number.isInteger(pageIndex)) return;
        item.pageRotations ||= {};
        item.pageRotations[pageIndex] = normalizeRotation((item.pageRotations[pageIndex] || 0) + delta);
        renderPreview();
        renderFinishPreview();
        renderReview();
        setStatus(`Page ${pageIndex + 1} rotated to ${item.pageRotations[pageIndex]}°.`, 'ready');
    }

    function moveFocusedPage(direction) {
        const item = getFocusedItem();
        const pageIndex = state.pdf.focusedPage?.pageIndex;
        if (!item || !Number.isInteger(pageIndex)) return;
        const currentIndex = item.selectedIndices.indexOf(pageIndex);
        const targetIndex = currentIndex + direction;
        if (currentIndex < 0 || targetIndex < 0 || targetIndex >= item.selectedIndices.length) return;

        [item.selectedIndices[currentIndex], item.selectedIndices[targetIndex]] =
            [item.selectedIndices[targetIndex], item.selectedIndices[currentIndex]];
        item.rangeText = indicesToRangeText(item.selectedIndices, item.pageCount);
        renderFileList();
    }

    function removeFocusedPage() {
        const item = getFocusedItem();
        const pageIndex = state.pdf.focusedPage?.pageIndex;
        if (!item || !Number.isInteger(pageIndex)) return;
        const selectedIndex = item.selectedIndices.indexOf(pageIndex);
        if (selectedIndex < 0) return;
        item.selectedIndices.splice(selectedIndex, 1);
        item.rangeText = indicesToRangeText(item.selectedIndices, item.pageCount);
        renderFileList();
    }

    function selectAllPages() {
        getReadyItems().forEach((item) => {
            item.selectedIndices = Array.from({ length: item.pageCount }, (_, index) => index);
            item.rangeText = 'all';
            item.error = '';
        });
        renderFileList();
    }

    function clearAllPages() {
        getReadyItems().forEach((item) => {
            item.selectedIndices = [];
            item.rangeText = '';
            item.error = '';
        });
        state.pdf.activeStep = 1;
        renderFileList();
    }

    function syncFocusedActions() {
        const item = getFocusedItem();
        const pageIndex = state.pdf.focusedPage?.pageIndex;
        const hasFocus = Boolean(item && Number.isInteger(pageIndex) && item.status === 'ready');
        const selectionIndex = hasFocus ? item.selectedIndices.indexOf(pageIndex) : -1;
        const included = selectionIndex >= 0;

        if (elements.pdf.rotateLeftBtn) elements.pdf.rotateLeftBtn.disabled = !hasFocus;
        if (elements.pdf.rotateRightBtn) elements.pdf.rotateRightBtn.disabled = !hasFocus;
        if (elements.pdf.pageRemoveBtn) elements.pdf.pageRemoveBtn.disabled = !included;
        if (elements.pdf.pageUpBtn) {
            elements.pdf.pageUpBtn.disabled = !included || selectionIndex === 0;
        }
        if (elements.pdf.pageDownBtn) {
            elements.pdf.pageDownBtn.disabled = !included || selectionIndex === item.selectedIndices.length - 1;
        }

        if (elements.pdf.focusedPageStatus) {
            elements.pdf.focusedPageStatus.textContent = hasFocus
                ? `${item.name} · page ${pageIndex + 1}${included ? '' : ' · removed'}`
                : 'No page focused';
        }
    }

    function createFileRow(item, index) {
        const row = document.createElement('article');
        row.className = 'pdf-file-row';
        row.dataset.id = item.id;
        row.dataset.status = item.status;

        const rangeDisabled = item.status !== 'ready';
        const pageLabel = item.status === 'ready'
            ? `${item.pageCount} page${item.pageCount === 1 ? '' : 's'}`
            : item.status === 'loading'
                ? 'Reading...'
                : 'Unreadable';
        const selectedLabel = item.status === 'ready' && !item.error
            ? `${item.selectedIndices.length} in output`
            : item.error || pageLabel;

        row.innerHTML = `
            <div class="pdf-row-index">${index + 1}</div>
            <div class="pdf-row-main">
                <div class="pdf-row-title">
                    <span class="pdf-row-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
                    <span class="pdf-row-pill">${escapeHtml(pageLabel)}</span>
                </div>
                <div class="pdf-row-meta">
                    <span>${escapeHtml(formatPdfBytes(item.size))}</span>
                    <span>${escapeHtml(selectedLabel)}</span>
                </div>
                <label class="pdf-range-field">
                    <span>Output pages</span>
                    <input type="text" class="pdf-range-input" value="${escapeHtml(item.rangeText)}" ${rangeDisabled ? 'disabled' : ''} aria-label="Output pages for ${escapeHtml(item.name)}">
                </label>
                <div class="pdf-row-error ${item.error ? '' : 'hidden'}">${escapeHtml(item.error)}</div>
            </div>
            <div class="pdf-row-actions" aria-label="PDF file actions">
                <button type="button" class="pdf-icon-btn" data-action="move-up" title="Move file earlier" ${index === 0 ? 'disabled' : ''}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>
                </button>
                <button type="button" class="pdf-icon-btn" data-action="move-down" title="Move file later" ${index === state.pdf.files.length - 1 ? 'disabled' : ''}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M19 12l-7 7-7-7"/></svg>
                </button>
                <button type="button" class="pdf-icon-btn pdf-icon-btn-danger" data-action="remove" title="Remove PDF">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>
                </button>
            </div>
        `;

        return row;
    }

    function updateItemRange(item) {
        if (item.status !== 'ready') return;
        const parsed = parsePdfPageRange(item.rangeText, item.pageCount);
        item.selectedIndices = parsed.indices;
        item.error = parsed.ok ? '' : parsed.error;
    }

    function updateRowRangeState(row, item) {
        const selectedLabel = item.error
            ? item.error
            : `${item.selectedIndices.length} in output`;
        const metaItems = row.querySelectorAll('.pdf-row-meta span');
        const error = row.querySelector('.pdf-row-error');

        if (metaItems[1]) metaItems[1].textContent = selectedLabel;
        if (error) {
            error.textContent = item.error;
            error.classList.toggle('hidden', !item.error);
        }
        row.dataset.status = item.error ? 'error' : item.status;
        renderSummary();
        renderPreview();
        renderFinishPreview();
    }

    async function addPdfFiles(fileList) {
        const files = Array.from(fileList || []).filter(isPdfFile);
        if (!files.length) {
            setStatus('Choose one or more PDF files.', 'error');
            return;
        }

        const createdItems = files.map((file) => {
            const item = {
                id: `pdf-${Date.now()}-${nextId++}`,
                file,
                name: file.name || 'document.pdf',
                size: file.size || 0,
                bytes: null,
                pageCount: 0,
                rangeText: 'all',
                selectedIndices: [],
                pageRotations: {},
                status: 'loading',
                error: '',
                thumbs: null,
                pageSizes: null,
                thumbStatus: 'idle'
            };
            state.pdf.files.push(item);
            return item;
        });

        state.pdf.activeStep = 1;
        renderFileList();
        await Promise.all(createdItems.map(loadPdfItem));
        renderFileList();
    }

    async function loadPdfItem(item) {
        try {
            const { PDFDocument } = await getPdfLib();
            const buffer = await item.file.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            const pdfDoc = await PDFDocument.load(bytes);
            const pageCount = pdfDoc.getPageCount();

            item.bytes = bytes;
            item.pageCount = pageCount;
            item.status = 'ready';
            item.error = '';
            item.pageRotations ||= {};
            updateItemRange(item);
            ensureFocusedPage();
            renderThumbnails(item);
        } catch (error) {
            console.error('PDF read error:', error);
            item.bytes = null;
            item.pageCount = 0;
            item.selectedIndices = [];
            item.status = 'error';
            item.error = 'Could not read this PDF. It may be encrypted or damaged.';
        }
    }

    function goToStep(requestedStep) {
        const step = Math.max(1, Math.min(STEP_COUNT, Number(requestedStep) || 1));
        const canContinue = getOutputEntries().length > 0
            && !state.pdf.files.some((item) => item.status === 'loading' || item.status === 'error' || item.error);
        if (step > 1 && !canContinue) {
            state.pdf.activeStep = 1;
            setStatus('Choose at least one valid output page before continuing.', 'error');
        } else {
            state.pdf.activeStep = step;
        }
        syncStepUi();
        if (state.pdf.activeStep === 1) {
            setStatus(`${getOutputEntries().length} output page${getOutputEntries().length === 1 ? '' : 's'} ready.`, 'ready');
        } else if (state.pdf.activeStep === 2) {
            renderFinishPreview();
            setStatus('Choose any optional finishing, then review the result.', 'ready');
        } else if (state.pdf.activeStep === 3) {
            renderReview();
            setStatus('Review complete. Download when the output looks right.', 'ready');
        }

        document.activeElement?.blur?.();
        globalThis.requestAnimationFrame(() => {
            document.documentElement.scrollTop = 0;
            document.body.scrollTop = 0;
        });
    }

    function syncStepUi() {
        const activeStep = Math.max(1, Math.min(STEP_COUNT, state.pdf.activeStep || 1));
        const activeTask = getActiveTask();
        const isCombineTask = activeTask === 'combine';
        state.pdf.activeStep = activeStep;

        elements.pdf.stepButtons?.forEach((button) => {
            const step = Number.parseInt(button.dataset.pdfStep, 10);
            const isActive = step === activeStep;
            const isComplete = step < activeStep;
            button.classList.toggle('active', isActive);
            button.classList.toggle('complete', isComplete);
            if (isActive) button.setAttribute('aria-current', 'step');
            else button.removeAttribute('aria-current');
        });

        elements.pdf.stepPanels?.forEach((panel) => {
            panel.classList.toggle(
                'hidden',
                Number.parseInt(panel.dataset.pdfStepPanel, 10) !== activeStep
            );
        });

        if (elements.pdf.backBtn) {
            elements.pdf.backBtn.classList.toggle('hidden', !isCombineTask || activeStep === 1);
        }
        if (elements.pdf.nextBtn) {
            elements.pdf.nextBtn.classList.toggle('hidden', !isCombineTask || activeStep === STEP_COUNT);
            elements.pdf.nextBtn.textContent = activeStep === 1
                ? 'Optional: add signature or page numbers'
                : 'Review combined PDF';
        }
        if (elements.pdf.mergeBtn) {
            elements.pdf.mergeBtn.classList.toggle('hidden', !isCombineTask);
            const label = elements.pdf.mergeBtn.querySelector('span');
            if (label) label.textContent = 'Save combined PDF';
        }

        elements.pdf.stepButtons?.forEach((button) => {
            button.classList.toggle('pdf-step-button--optional', !isCombineTask);
        });
    }

    function setActiveFinishTool(toolName) {
        if (!['signature', 'stamp', 'numbers'].includes(toolName)) return;
        state.pdf.activeFinishTool = toolName;
        elements.pdf.finishToolButtons?.forEach((button) => {
            const active = button.dataset.pdfFinishTool === toolName;
            button.classList.toggle('active', active);
            button.setAttribute('aria-selected', String(active));
        });
        elements.pdf.finishToolPanels?.forEach((panel) => {
            panel.classList.toggle('hidden', panel.dataset.pdfFinishPanel !== toolName);
        });
    }

    function syncFinishControlsFromState() {
        const { signature, stamp, pageNumbers } = state.pdf.finish;
        setControlChecked(elements.pdf.signatureEnabled, signature.enabled);
        setControlValue(elements.pdf.signatureText, signature.text);
        setControlValue(elements.pdf.signaturePosition, signature.position);
        setControlValue(elements.pdf.signatureApplyTo, signature.applyTo);
        setControlValue(elements.pdf.signatureSize, signature.size);

        setControlChecked(elements.pdf.stampEnabled, stamp.enabled);
        setControlValue(elements.pdf.stampText, stamp.text);
        setControlValue(elements.pdf.stampPosition, stamp.position);
        setControlValue(elements.pdf.stampApplyTo, stamp.applyTo);
        setControlValue(elements.pdf.stampOpacity, stamp.opacity);
        setControlValue(elements.pdf.stampSize, stamp.size);
        if (elements.pdf.stampOpacityValue) {
            elements.pdf.stampOpacityValue.textContent = `${stamp.opacity}%`;
        }

        setControlChecked(elements.pdf.pageNumbersEnabled, pageNumbers.enabled);
        setControlValue(elements.pdf.pageNumberFormat, pageNumbers.format);
        setControlValue(elements.pdf.pageNumberPosition, pageNumbers.position);
        setControlValue(elements.pdf.pageNumberStart, pageNumbers.startAt);
        setControlValue(elements.pdf.pageNumberSize, pageNumbers.size);
        setActiveFinishTool(state.pdf.activeFinishTool || 'signature');
    }

    function readFinishControls() {
        const finish = state.pdf.finish;
        finish.signature.enabled = Boolean(elements.pdf.signatureEnabled?.checked);
        finish.signature.text = elements.pdf.signatureText?.value.trim() || '';
        finish.signature.position = elements.pdf.signaturePosition?.value || 'bottom-left';
        finish.signature.applyTo = elements.pdf.signatureApplyTo?.value || 'current';
        finish.signature.size = readBoundedNumber(elements.pdf.signatureSize?.value, 14, 46, 22);

        finish.stamp.enabled = Boolean(elements.pdf.stampEnabled?.checked);
        finish.stamp.text = elements.pdf.stampText?.value || 'APPROVED';
        finish.stamp.position = elements.pdf.stampPosition?.value || 'top-right';
        finish.stamp.applyTo = elements.pdf.stampApplyTo?.value || 'all';
        finish.stamp.opacity = readBoundedNumber(elements.pdf.stampOpacity?.value, 20, 100, 72);
        finish.stamp.size = readBoundedNumber(elements.pdf.stampSize?.value, 18, 64, 28);

        finish.pageNumbers.enabled = Boolean(elements.pdf.pageNumbersEnabled?.checked);
        finish.pageNumbers.format = elements.pdf.pageNumberFormat?.value || 'page-total';
        finish.pageNumbers.position = elements.pdf.pageNumberPosition?.value || 'bottom-center';
        finish.pageNumbers.startAt = readBoundedNumber(elements.pdf.pageNumberStart?.value, 1, 9999, 1);
        finish.pageNumbers.size = readBoundedNumber(elements.pdf.pageNumberSize?.value, 7, 18, 9);

        if (elements.pdf.stampOpacityValue) {
            elements.pdf.stampOpacityValue.textContent = `${finish.stamp.opacity}%`;
        }
        renderFinishPreview();
        renderReview();
    }

    function renderFinishPreview() {
        const entries = getOutputEntries();
        const focusedEntry = getFocusedEntry(entries) || entries[0] || null;
        if (!focusedEntry) {
            elements.pdf.finishPreviewImage?.classList.add('hidden');
            elements.pdf.finishPreviewEmpty?.classList.remove('hidden');
            if (elements.pdf.finishPageLabel) {
                elements.pdf.finishPageLabel.textContent = 'Select a page in step 1';
            }
            hideFinishOverlays();
            syncFinishPager(-1, entries.length);
            return;
        }

        if (!getFocusedEntry(entries)) {
            state.pdf.focusedPage = {
                fileId: focusedEntry.fileId,
                pageIndex: focusedEntry.sourceIndex
            };
        }

        const dataUrl = focusedEntry.item.thumbs?.[focusedEntry.sourceIndex];
        if (dataUrl && elements.pdf.finishPreviewImage) {
            elements.pdf.finishPreviewImage.src = dataUrl;
            elements.pdf.finishPreviewImage.style.transform = `rotate(${focusedEntry.rotation}deg)`;
            elements.pdf.finishPreviewImage.classList.remove('hidden');
            elements.pdf.finishPreviewEmpty?.classList.add('hidden');
        } else {
            elements.pdf.finishPreviewImage?.classList.add('hidden');
            elements.pdf.finishPreviewEmpty?.classList.remove('hidden');
        }

        if (elements.pdf.finishPageLabel) {
            elements.pdf.finishPageLabel.textContent =
                `Output ${focusedEntry.outputIndex + 1} of ${entries.length} · ${focusedEntry.fileName} · page ${focusedEntry.sourceIndex + 1}`;
        }
        syncFinishPager(focusedEntry.outputIndex, entries.length);
        renderFinishOverlays(focusedEntry, entries);
        syncFocusedActions();
    }

    function syncFinishPager(currentIndex, total) {
        if (elements.pdf.finishPrevBtn) {
            elements.pdf.finishPrevBtn.disabled = currentIndex <= 0;
        }
        if (elements.pdf.finishNextBtn) {
            elements.pdf.finishNextBtn.disabled = currentIndex < 0 || currentIndex >= total - 1;
        }
    }

    function moveFinishPreview(offset) {
        const entries = getOutputEntries();
        const current = getFocusedEntry(entries) || entries[0];
        if (!current) return;
        const target = entries[current.outputIndex + offset];
        if (!target) return;
        state.pdf.focusedPage = { fileId: target.fileId, pageIndex: target.sourceIndex };
        renderFinishPreview();
        renderPreview();
    }

    function renderFinishOverlays(entry, entries) {
        const finish = state.pdf.finish;
        const signatureVisible = finish.signature.enabled
            && Boolean(finish.signature.text)
            && scopeIncludesEntry(finish.signature.applyTo, entry, entries);
        updateLiveOverlay(elements.pdf.finishSignaturePreview, {
            visible: signatureVisible,
            text: finish.signature.text,
            position: finish.signature.position,
            fontSize: Math.max(16, Math.round(finish.signature.size * 0.82)),
            opacity: 1
        });

        const stampVisible = finish.stamp.enabled
            && scopeIncludesEntry(finish.stamp.applyTo, entry, entries);
        updateLiveOverlay(elements.pdf.finishStampPreview, {
            visible: stampVisible,
            text: finish.stamp.text,
            position: finish.stamp.position,
            fontSize: Math.max(13, Math.round(finish.stamp.size * 0.58)),
            opacity: finish.stamp.opacity / 100
        });

        const numberVisible = finish.pageNumbers.enabled;
        updateLiveOverlay(elements.pdf.finishNumberPreview, {
            visible: numberVisible,
            text: formatPageNumber(
                finish.pageNumbers.format,
                finish.pageNumbers.startAt + entry.outputIndex,
                finish.pageNumbers.startAt + entries.length - 1
            ),
            position: finish.pageNumbers.position,
            fontSize: Math.max(8, finish.pageNumbers.size),
            opacity: 1
        });
    }

    function updateLiveOverlay(element, {
        visible,
        text,
        position,
        fontSize,
        opacity
    }) {
        if (!element) return;
        element.classList.toggle('hidden', !visible);
        element.textContent = visible ? text : '';
        element.dataset.position = position;
        element.style.fontSize = `${fontSize}px`;
        element.style.opacity = String(opacity);
    }

    function hideFinishOverlays() {
        [
            elements.pdf.finishSignaturePreview,
            elements.pdf.finishStampPreview,
            elements.pdf.finishNumberPreview
        ].forEach((element) => element?.classList.add('hidden'));
    }

    function renderReview() {
        const entries = getOutputEntries();
        const finishingCount = countFinishingTools();

        if (elements.pdf.reviewFileCount) {
            elements.pdf.reviewFileCount.textContent = String(getValidMergeItems().length);
        }
        if (elements.pdf.reviewPageCount) {
            elements.pdf.reviewPageCount.textContent = String(entries.length);
        }
        if (elements.pdf.reviewEditCount) {
            elements.pdf.reviewEditCount.textContent = String(finishingCount);
        }

        if (elements.pdf.reviewList) {
            elements.pdf.reviewOverflowNote?.classList.toggle('hidden', entries.length <= MAX_REVIEW_THUMBS);
            const multipleFiles = new Set(entries.map((entry) => entry.fileId)).size > 1;
            elements.pdf.reviewList.textContent = '';
            entries.slice(0, MAX_REVIEW_THUMBS).forEach((entry) => {
                const card = document.createElement('article');
                card.className = 'pdf-review-page-card';

                const frame = document.createElement('div');
                frame.className = 'pdf-review-page-frame';
                const dataUrl = entry.item.thumbs?.[entry.sourceIndex];
                if (dataUrl) {
                    frame.appendChild(createThumbImage(dataUrl, entry.rotation));
                } else {
                    frame.classList.add('is-loading');
                }

                const meta = document.createElement('div');
                meta.className = 'pdf-review-page-meta';
                const order = document.createElement('strong');
                order.textContent = String(entry.outputIndex + 1).padStart(2, '0');
                const source = document.createElement('span');
                source.textContent = multipleFiles
                    ? `${entry.fileName} · ${entry.sourceIndex + 1}`
                    : `page ${entry.sourceIndex + 1}`;
                meta.append(order, source);

                card.append(frame, meta);
                elements.pdf.reviewList.appendChild(card);
            });

            if (entries.length > MAX_REVIEW_THUMBS) {
                const more = document.createElement('div');
                more.className = 'pdf-review-more';
                more.textContent = `+${entries.length - MAX_REVIEW_THUMBS} more output pages`;
                elements.pdf.reviewList.appendChild(more);
            }
        }

        if (elements.pdf.reviewSummary) {
            elements.pdf.reviewSummary.textContent = '';
            const summaryRows = buildReviewSummary(entries);
            summaryRows.forEach(({ label, value, active }) => {
                const row = document.createElement('div');
                row.className = 'pdf-review-summary-row';
                row.classList.toggle('active', active);
                const labelElement = document.createElement('span');
                labelElement.textContent = label;
                const valueElement = document.createElement('strong');
                valueElement.textContent = value;
                row.append(labelElement, valueElement);
                elements.pdf.reviewSummary.appendChild(row);
            });
        }

        renderImageExportUi(entries);
    }

    function getEntryPixelDims(entry, targetWidth) {
        const size = entry.item.pageSizes?.[entry.sourceIndex];
        if (!size?.width || !size?.height) return null;
        const swap = entry.rotation === 90 || entry.rotation === 270;
        const baseWidth = swap ? size.height : size.width;
        const baseHeight = swap ? size.width : size.height;
        return getPdfImageExportDimensions({ targetWidth, baseWidth, baseHeight });
    }

    function setImageExportWidth(value) {
        const width = Math.round(readBoundedNumber(
            value,
            IMAGE_WIDTH_MIN,
            IMAGE_WIDTH_MAX,
            state.pdf.imageExport.targetWidth
        ));
        state.pdf.imageExport.targetWidth = width;
        if (elements.pdf.imageWidthInput) {
            elements.pdf.imageWidthInput.value = String(width);
        }
        renderImageExportUi();
    }

    function setImageExportFormat(format) {
        if (!IMAGE_EXPORT_FORMATS.includes(format)) return;
        state.pdf.imageExport.format = format;
        renderImageExportUi();
    }

    function renderImageExportUi(entries = getOutputEntries()) {
        const settings = state.pdf.imageExport;

        elements.pdf.imageWidthChips?.forEach((chip) => {
            const chipWidth = Number.parseInt(chip.dataset.pdfImageWidth, 10);
            chip.classList.toggle('active', chipWidth === settings.targetWidth);
        });
        if (elements.pdf.imageWidthInput && document.activeElement !== elements.pdf.imageWidthInput) {
            elements.pdf.imageWidthInput.value = String(settings.targetWidth);
        }
        elements.pdf.imageFormatCards?.forEach((card) => {
            const active = card.dataset.pdfImageFormat === settings.format;
            card.classList.toggle('active', active);
            card.setAttribute('aria-pressed', String(active));
        });

        const firstEntry = entries[0] || null;
        const dims = firstEntry ? getEntryPixelDims(firstEntry, settings.targetWidth) : null;
        if (elements.pdf.imageExportDims) {
            elements.pdf.imageExportDims.textContent = dims
                ? `${dims.width} × ${dims.height} px${entries.length > 1 ? ' · first page' : ''}`
                : '—';
        }

        const estimateTargets = {
            jpg: elements.pdf.imageEstJpg,
            webp: elements.pdf.imageEstWebp,
            png: elements.pdf.imageEstPng,
            tga: elements.pdf.imageEstTga
        };
        Object.entries(estimateTargets).forEach(([format, element]) => {
            if (!element) return;
            element.textContent = dims && entries.length
                ? `≈ ${formatBytes(estimateImageExportBytes(dims.width, dims.height, format) * entries.length)}`
                : '—';
        });
    }

    function buildReviewSummary(entries) {
        const finish = state.pdf.finish;
        const rotatedCount = entries.filter((entry) => entry.rotation !== 0).length;
        const rows = [{
            label: 'Page arrangement',
            value: rotatedCount
                ? `${rotatedCount} page${rotatedCount === 1 ? '' : 's'} rotated`
                : 'Original orientation',
            active: entries.length > 0
        }];

        if (finish.signature.enabled && finish.signature.text) {
            rows.push({
                label: 'Signature',
                value: `${finish.signature.text} · ${scopeLabel(finish.signature.applyTo)}`,
                active: true
            });
        }
        if (finish.stamp.enabled) {
            rows.push({
                label: 'Stamp / watermark',
                value: `${finish.stamp.text} · ${scopeLabel(finish.stamp.applyTo)}`,
                active: true
            });
        }
        if (finish.pageNumbers.enabled) {
            rows.push({
                label: 'Page numbers',
                value: `${formatLabel(finish.pageNumbers.format)} · ${positionLabel(finish.pageNumbers.position)}`,
                active: true
            });
        }
        if (rows.length === 1) {
            rows.push({ label: 'Finishing', value: 'None applied', active: false });
        }
        return rows;
    }

    function countFinishingTools() {
        const finish = state.pdf.finish;
        return [
            finish.signature.enabled && Boolean(finish.signature.text),
            finish.stamp.enabled,
            finish.pageNumbers.enabled
        ].filter(Boolean).length;
    }

    async function buildFinishedPdf({ items, outputEntries, onProgress }) {
        const {
            PDFDocument,
            StandardFonts,
            degrees,
            rgb
        } = await getPdfLib();
        const finishedDoc = await PDFDocument.create();
        const totalGroups = items.length;

        for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
            const item = items[itemIndex];
            onProgress?.({ stage: 'pages', item, itemIndex, totalGroups });

            const sourceDoc = await PDFDocument.load(item.bytes);
            const copiedPages = await finishedDoc.copyPages(sourceDoc, item.selectedIndices);
            copiedPages.forEach((page, copiedIndex) => {
                const sourceIndex = item.selectedIndices[copiedIndex];
                const editRotation = normalizeRotation(item.pageRotations?.[sourceIndex] || 0);
                if (editRotation) {
                    const sourceRotation = normalizeRotation(page.getRotation().angle || 0);
                    page.setRotation(degrees(normalizeRotation(sourceRotation + editRotation)));
                }
                finishedDoc.addPage(page);
            });
        }

        onProgress?.({ stage: 'finishing' });

        const fonts = {
            regular: await finishedDoc.embedFont(StandardFonts.Helvetica),
            bold: await finishedDoc.embedFont(StandardFonts.HelveticaBold)
        };
        const signatureAsset = state.pdf.finish.signature.enabled
            && state.pdf.finish.signature.text
            ? await createSignatureAsset(
                finishedDoc,
                state.pdf.finish.signature.text,
                state.pdf.finish.signature.size
            )
            : null;
        applyFinishingToDocument({
            document: finishedDoc,
            entries: outputEntries,
            finish: state.pdf.finish,
            focusedPage: state.pdf.focusedPage,
            fonts,
            signatureAsset,
            degrees,
            rgb
        });

        finishedDoc.setProducer('Genesis Image Tools');
        finishedDoc.setCreator('Genesis Image Tools PDF Guided Finish');
        finishedDoc.setModificationDate(new Date());

        onProgress?.({ stage: 'saving' });
        return {
            bytes: await finishedDoc.save(),
            pageCount: finishedDoc.getPageCount()
        };
    }

    async function exportFinishedPdf() {
        const items = getValidMergeItems();
        const outputEntries = getOutputEntries();
        if (!items.length || !outputEntries.length || elements.pdf.mergeBtn?.disabled) return;

        state.pdf.isMerging = true;
        renderSummary();
        showLoader(true, {
            title: 'Finishing PDF...',
            subtitle: 'Preparing output pages',
            progress: 0.04
        });

        let finalStatus = null;
        try {
            const finished = await buildFinishedPdf({
                items,
                outputEntries,
                onProgress: ({ stage, item, itemIndex, totalGroups }) => {
                    if (stage === 'pages') {
                        showLoader(true, {
                            title: 'Finishing PDF...',
                            subtitle: `${item.name} · ${item.selectedIndices.length} pages`,
                            progress: 0.08 + (itemIndex / Math.max(totalGroups, 1)) * 0.55
                        });
                    } else if (stage === 'finishing') {
                        showLoader(true, {
                            title: 'Finishing PDF...',
                            subtitle: 'Applying signature, stamps, and page numbers',
                            progress: 0.7
                        });
                    } else if (stage === 'saving') {
                        showLoader(true, {
                            title: 'Finishing PDF...',
                            subtitle: 'Saving the finished document',
                            progress: 0.94
                        });
                    }
                }
            });

            const filename = sanitizePdfFilename(state.pdf.outputName);
            downloadBlob(new Blob([finished.bytes], { type: 'application/pdf' }), filename);

            state.pdf.lastMergedPageCount = finished.pageCount;
            finalStatus = {
                message: `Downloaded ${filename} with ${state.pdf.lastMergedPageCount} page${state.pdf.lastMergedPageCount === 1 ? '' : 's'}.`,
                tone: 'ready'
            };
        } catch (error) {
            console.error('PDF finish error:', error);
            finalStatus = {
                message: error?.message || 'Could not finish this PDF.',
                tone: 'error'
            };
        } finally {
            state.pdf.isMerging = false;
            showLoader(false);
            renderSummary();
            if (finalStatus) setStatus(finalStatus.message, finalStatus.tone);
        }
    }

    async function exportPagesAsImages() {
        const items = getValidMergeItems();
        const outputEntries = getOutputEntries();
        if (!items.length || !outputEntries.length || elements.pdf.imageExportBtn?.disabled) return;

        const { format, targetWidth } = state.pdf.imageExport;
        const extension = getImageExportExtension(format);
        const formatLabel = extension.toUpperCase();
        const loaderTitle = `Exporting ${formatLabel} Pages...`;

        state.pdf.isMerging = true;
        renderSummary();
        showLoader(true, {
            title: loaderTitle,
            subtitle: 'Preparing output pages',
            progress: 0.04
        });

        let doc = null;
        let finalStatus = null;
        try {
            const finished = await buildFinishedPdf({
                items,
                outputEntries,
                onProgress: ({ stage, item, itemIndex, totalGroups }) => {
                    if (stage === 'pages') {
                        showLoader(true, {
                            title: loaderTitle,
                            subtitle: `${item.name} · ${item.selectedIndices.length} pages`,
                            progress: 0.06 + (itemIndex / Math.max(totalGroups, 1)) * 0.2
                        });
                    } else if (stage === 'finishing') {
                        showLoader(true, {
                            title: loaderTitle,
                            subtitle: 'Applying signature, stamps, and page numbers',
                            progress: 0.28
                        });
                    }
                }
            });

            const pdfjs = await getPdfJs();
            doc = await pdfjs.getDocument({
                data: finished.bytes,
                standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
                isEvalSupported: false,
                disableAutoFetch: true,
                disableStream: true
            }).promise;

            const stem = sanitizeFileComponent(
                String(state.pdf.outputName || '').replace(/\.pdf$/i, ''),
                'pages'
            );
            const pageTotal = doc.numPages;
            const digits = Math.max(2, String(pageTotal).length);
            const files = {};
            const pagePlans = [];

            for (let pageNumber = 1; pageNumber <= pageTotal; pageNumber += 1) {
                showLoader(true, {
                    title: loaderTitle,
                    subtitle: `Checking page ${pageNumber} of ${pageTotal}`,
                    progress: 0.32 + ((pageNumber - 1) / Math.max(pageTotal, 1)) * 0.08
                });
                const page = await doc.getPage(pageNumber);
                try {
                    const base = page.getViewport({ scale: 1 });
                    pagePlans.push({
                        pageNumber,
                        ...getPdfImageExportDimensions({
                            targetWidth,
                            baseWidth: base.width,
                            baseHeight: base.height
                        })
                    });
                } finally {
                    page.cleanup();
                }
            }
            validatePdfImageExportPlan({ pages: pagePlans, format });

            let actualOutputBytes = 0;

            for (let pageNumber = 1; pageNumber <= pageTotal; pageNumber += 1) {
                showLoader(true, {
                    title: loaderTitle,
                    subtitle: `Rendering page ${pageNumber} of ${pageTotal}`,
                    progress: 0.4 + ((pageNumber - 1) / Math.max(pageTotal, 1)) * 0.5
                });

                const page = await doc.getPage(pageNumber);
                const plan = pagePlans[pageNumber - 1];
                const viewport = page.getViewport({ scale: plan.scale });
                const canvas = document.createElement('canvas');
                canvas.width = plan.width;
                canvas.height = plan.height;
                const context = canvas.getContext('2d', { alpha: false });
                if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
                context.fillStyle = '#ffffff';
                context.fillRect(0, 0, canvas.width, canvas.height);
                // 'print' intent renders without requestAnimationFrame scheduling,
                // so the export keeps running while this tab is hidden.
                await page.render({ canvasContext: context, viewport, intent: 'print' }).promise;
                page.cleanup();

                const blob = await exportCanvasToImageBlob(canvas, format);
                canvas.width = 0;
                canvas.height = 0;
                actualOutputBytes += blob.size;
                if (actualOutputBytes > PDF_IMAGE_EXPORT_MAX_TOTAL_BYTES) {
                    throw new Error(
                        `The rendered ${formatLabel} files exceed the browser-safe ${formatPdfBytes(PDF_IMAGE_EXPORT_MAX_TOTAL_BYTES)} limit. Reduce the image width or export fewer pages.`
                    );
                }
                files[`${stem}_page_${String(pageNumber).padStart(digits, '0')}.${extension}`] = blob;
            }

            const fileNames = Object.keys(files);
            if (!fileNames.length) {
                throw new Error('No pages were rendered for image export.');
            }

            if (fileNames.length === 1) {
                downloadBlob(files[fileNames[0]], fileNames[0]);
                finalStatus = {
                    message: `Downloaded ${fileNames[0]}.`,
                    tone: 'ready'
                };
            } else {
                showLoader(true, {
                    title: loaderTitle,
                    subtitle: 'Packaging ZIP archive',
                    progress: 0.94
                });
                const zipBlob = await createZipFile(files);
                const archiveName = `${stem}_${extension}_pages.zip`;
                downloadBlob(zipBlob, archiveName);
                finalStatus = {
                    message: `Downloaded ${fileNames.length} ${formatLabel} page images in ${archiveName}.`,
                    tone: 'ready'
                };
            }
        } catch (error) {
            console.error('PDF image export error:', error);
            finalStatus = {
                message: error?.message || 'Could not export pages as images.',
                tone: 'error'
            };
        } finally {
            if (doc) {
                try { await doc.destroy(); } catch { /* no-op */ }
            }
            state.pdf.isMerging = false;
            showLoader(false);
            renderSummary();
            if (finalStatus) setStatus(finalStatus.message, finalStatus.tone);
        }
    }

    function bindEvents() {
        bindTaskNavigationLocation();

        elements.pdf.taskButtons?.forEach((button) => {
            button.addEventListener('click', () => setActiveTask(button.dataset.pdfTask));
        });

        elements.pdf.dropzone?.addEventListener('click', () => elements.pdf.fileInput?.click());
        elements.pdf.previewAddBtn?.addEventListener('click', () => elements.pdf.fileInput?.click());
        elements.pdf.dropzone?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                elements.pdf.fileInput?.click();
            }
        });

        elements.pdf.fileInput?.addEventListener('change', async (event) => {
            await addPdfFiles(event.target.files);
            event.target.value = '';
        });

        elements.pdf.dropzone?.addEventListener('dragover', (event) => {
            event.preventDefault();
            elements.pdf.dropzone.classList.add('drag-over');
        });
        elements.pdf.dropzone?.addEventListener('dragleave', () => {
            elements.pdf.dropzone.classList.remove('drag-over');
        });
        elements.pdf.dropzone?.addEventListener('drop', async (event) => {
            event.preventDefault();
            elements.pdf.dropzone.classList.remove('drag-over');
            await addPdfFiles(event.dataTransfer?.files);
        });

        elements.pdf.fileList?.addEventListener('input', (event) => {
            const input = event.target.closest('.pdf-range-input');
            if (!input) return;
            const row = input.closest('.pdf-file-row');
            const item = state.pdf.files.find((candidate) => candidate.id === row?.dataset.id);
            if (!item) return;

            item.rangeText = input.value;
            updateItemRange(item);
            updateRowRangeState(row, item);
        });

        elements.pdf.fileList?.addEventListener('click', (event) => {
            const button = event.target.closest('[data-action]');
            const row = button?.closest('.pdf-file-row');
            const index = state.pdf.files.findIndex((item) => item.id === row?.dataset.id);
            if (!button || index < 0) return;

            const action = button.dataset.action;
            if (action === 'remove') {
                state.pdf.files.splice(index, 1);
            } else if (action === 'move-up' && index > 0) {
                const [item] = state.pdf.files.splice(index, 1);
                state.pdf.files.splice(index - 1, 0, item);
            } else if (action === 'move-down' && index < state.pdf.files.length - 1) {
                const [item] = state.pdf.files.splice(index, 1);
                state.pdf.files.splice(index + 1, 0, item);
            }
            ensureFocusedPage();
            renderFileList();
        });

        elements.pdf.previewList?.addEventListener('click', (event) => {
            const cell = event.target.closest('.pdf-thumb');
            if (!cell) return;
            const item = state.pdf.files.find((candidate) => candidate.id === cell.dataset.id);
            const pageIndex = Number.parseInt(cell.dataset.page, 10);
            if (!item || Number.isNaN(pageIndex)) return;

            const action = event.target.closest('[data-page-action]')?.dataset.pageAction;
            if (action === 'toggle') togglePageSelection(item, pageIndex);
            else focusPage(item, pageIndex);
        });

        elements.pdf.selectAllBtn?.addEventListener('click', selectAllPages);
        elements.pdf.clearBtn?.addEventListener('click', clearAllPages);
        elements.pdf.rotateLeftBtn?.addEventListener('click', () => rotateFocusedPage(-90));
        elements.pdf.rotateRightBtn?.addEventListener('click', () => rotateFocusedPage(90));
        elements.pdf.pageUpBtn?.addEventListener('click', () => moveFocusedPage(-1));
        elements.pdf.pageDownBtn?.addEventListener('click', () => moveFocusedPage(1));
        elements.pdf.pageRemoveBtn?.addEventListener('click', removeFocusedPage);

        elements.pdf.stepButtons?.forEach((button) => {
            button.addEventListener('click', () => goToStep(button.dataset.pdfStep));
        });
        elements.pdf.backBtn?.addEventListener('click', () => goToStep(state.pdf.activeStep - 1));
        elements.pdf.nextBtn?.addEventListener('click', () => goToStep(state.pdf.activeStep + 1));

        elements.pdf.finishToolButtons?.forEach((button) => {
            button.addEventListener('click', () => setActiveFinishTool(button.dataset.pdfFinishTool));
        });

        [
            elements.pdf.signatureEnabled,
            elements.pdf.signatureText,
            elements.pdf.signaturePosition,
            elements.pdf.signatureApplyTo,
            elements.pdf.signatureSize,
            elements.pdf.stampEnabled,
            elements.pdf.stampText,
            elements.pdf.stampPosition,
            elements.pdf.stampApplyTo,
            elements.pdf.stampOpacity,
            elements.pdf.stampSize,
            elements.pdf.pageNumbersEnabled,
            elements.pdf.pageNumberFormat,
            elements.pdf.pageNumberPosition,
            elements.pdf.pageNumberStart,
            elements.pdf.pageNumberSize
        ].forEach((control) => {
            control?.addEventListener('input', readFinishControls);
            control?.addEventListener('change', readFinishControls);
        });

        elements.pdf.finishPrevBtn?.addEventListener('click', () => moveFinishPreview(-1));
        elements.pdf.finishNextBtn?.addEventListener('click', () => moveFinishPreview(1));

        elements.pdf.outputName?.addEventListener('input', () => {
            state.pdf.outputName = elements.pdf.outputName.value;
        });
        elements.pdf.mergeBtn?.addEventListener('click', exportFinishedPdf);

        elements.pdf.imageWidthChips?.forEach((chip) => {
            chip.addEventListener('click', () => setImageExportWidth(chip.dataset.pdfImageWidth));
        });
        elements.pdf.imageWidthApply?.addEventListener('click', () => {
            setImageExportWidth(elements.pdf.imageWidthInput?.value);
        });
        elements.pdf.imageWidthInput?.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                setImageExportWidth(event.target.value);
            }
        });
        elements.pdf.imageFormatCards?.forEach((card) => {
            card.addEventListener('click', () => setImageExportFormat(card.dataset.pdfImageFormat));
        });
        elements.pdf.imageExportBtn?.addEventListener('click', exportPagesAsImages);

        imageToPdfController.bindEvents();
        ocrController.bindEvents();

        syncFinishControlsFromState();
        syncTaskUi();
        renderImageExportUi();
    }

    function onTabActivated() {
        renderFileList();
        syncFinishControlsFromState();
        moveTaskNavigationToResponsiveHost();
        syncTaskUi();
        imageToPdfController.render();
        ocrController.render();
    }

    return {
        bindEvents,
        onTabActivated,
        addPdfFiles,
        dispose() {
            disposeTaskNavigationLocation();
            imageToPdfController.dispose();
            ocrController.dispose();
        }
    };
}

function applyFinishingToDocument({
    document,
    entries,
    finish,
    focusedPage,
    fonts,
    signatureAsset,
    degrees,
    rgb
}) {
    const pages = document.getPages();
    const currentOutputIndex = entries.findIndex((entry) => (
        entry.fileId === focusedPage?.fileId
        && entry.sourceIndex === focusedPage?.pageIndex
    ));

    if (finish.signature.enabled && finish.signature.text && signatureAsset) {
        const targetIndices = getScopeIndices(
            finish.signature.applyTo,
            pages.length,
            currentOutputIndex
        );
        targetIndices.forEach((outputIndex) => {
            const page = pages[outputIndex];
            const maxWidth = Math.max(40, page.getWidth() - 72);
            const preferredHeight = finish.signature.size * 1.45;
            const preferredWidth = preferredHeight * signatureAsset.aspectRatio;
            const scale = Math.min(1, maxWidth / Math.max(preferredWidth, 1));
            const width = preferredWidth * scale;
            const height = preferredHeight * scale;
            const point = resolveImagePosition({
                position: finish.signature.position,
                page,
                imageWidth: width,
                imageHeight: height,
                margin: 38
            });
            page.drawImage(signatureAsset.image, {
                x: point.x,
                y: point.y,
                width,
                height
            });
        });
    }

    if (finish.stamp.enabled && finish.stamp.text) {
        const targetIndices = getScopeIndices(
            finish.stamp.applyTo,
            pages.length,
            currentOutputIndex
        );
        targetIndices.forEach((outputIndex) => {
            const page = pages[outputIndex];
            const isCenter = finish.stamp.position === 'center';
            const maxWidth = isCenter
                ? page.getWidth() * 0.72
                : Math.max(60, page.getWidth() * 0.38);
            const size = fitTextSize(
                fonts.bold,
                finish.stamp.text,
                finish.stamp.size,
                maxWidth
            );
            const width = fonts.bold.widthOfTextAtSize(finish.stamp.text, size);
            const point = resolveTextPosition({
                position: finish.stamp.position,
                page,
                textWidth: width,
                fontSize: size,
                margin: 36
            });
            page.drawText(finish.stamp.text, {
                x: point.x,
                y: point.y,
                size,
                font: fonts.bold,
                color: rgb(0.76, 0.22, 0.18),
                opacity: finish.stamp.opacity / 100,
                rotate: degrees(isCenter ? 34 : -7)
            });
        });
    }

    if (finish.pageNumbers.enabled) {
        const finalNumber = finish.pageNumbers.startAt + pages.length - 1;
        pages.forEach((page, outputIndex) => {
            const pageNumber = finish.pageNumbers.startAt + outputIndex;
            const text = formatPageNumber(
                finish.pageNumbers.format,
                pageNumber,
                finalNumber
            );
            const size = finish.pageNumbers.size;
            const width = fonts.regular.widthOfTextAtSize(text, size);
            const point = resolveTextPosition({
                position: finish.pageNumbers.position,
                page,
                textWidth: width,
                fontSize: size,
                margin: 28
            });
            page.drawText(text, {
                x: point.x,
                y: point.y,
                size,
                font: fonts.regular,
                color: rgb(0.32, 0.34, 0.39),
                opacity: 0.9
            });
        });
    }
}

async function createSignatureAsset(pdfDocument, text, size) {
    const scale = 3;
    const canvas = globalThis.document.createElement('canvas');
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Signature rendering is unavailable in this browser.');

    const fontSize = Math.max(18, size) * scale;
    const font = `${fontSize}px "Snell Roundhand", "Apple Chancery", "Segoe Script", cursive`;
    context.font = font;
    const measuredWidth = Math.ceil(context.measureText(text).width);
    canvas.width = Math.max(64, measuredWidth + 28 * scale);
    canvas.height = Math.ceil(fontSize * 1.7);

    context.clearRect(0, 0, canvas.width, canvas.height);
    context.font = font;
    context.fillStyle = '#1f4779';
    context.textBaseline = 'middle';
    context.fillText(text, 14 * scale, canvas.height * 0.52);

    const bytes = dataUrlToBytes(canvas.toDataURL('image/png'));
    return {
        image: await pdfDocument.embedPng(bytes),
        aspectRatio: canvas.width / Math.max(canvas.height, 1)
    };
}

function getScopeIndices(scope, pageCount, currentIndex) {
    if (!pageCount) return [];
    if (scope === 'all') return Array.from({ length: pageCount }, (_, index) => index);
    if (scope === 'last') return [pageCount - 1];
    return [currentIndex >= 0 ? currentIndex : pageCount - 1];
}

function resolveImagePosition({
    position,
    page,
    imageWidth,
    imageHeight,
    margin
}) {
    const width = page.getWidth();
    const centerX = Math.max(margin, (width - imageWidth) / 2);
    const rightX = Math.max(margin, width - margin - imageWidth);
    const bottomY = Math.max(18, margin - imageHeight * 0.18);

    if (position === 'bottom-center') return { x: centerX, y: bottomY };
    if (position === 'bottom-right') return { x: rightX, y: bottomY };
    return { x: margin, y: bottomY };
}

function resolveTextPosition({
    position,
    page,
    textWidth,
    fontSize,
    margin
}) {
    const width = page.getWidth();
    const height = page.getHeight();
    const centerX = Math.max(margin, (width - textWidth) / 2);
    const rightX = Math.max(margin, width - margin - textWidth);
    const bottomY = Math.max(18, margin - fontSize * 0.15);
    const topY = Math.max(bottomY, height - margin - fontSize);

    if (position === 'bottom-center') return { x: centerX, y: bottomY };
    if (position === 'bottom-right') return { x: rightX, y: bottomY };
    if (position === 'top-right') return { x: rightX, y: topY };
    if (position === 'center') {
        return {
            x: Math.max(margin, (width - textWidth) / 2),
            y: Math.max(margin, (height - fontSize) / 2)
        };
    }
    return { x: margin, y: bottomY };
}

function dataUrlToBytes(dataUrl) {
    const base64 = String(dataUrl).split(',')[1] || '';
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}

function fitTextSize(font, text, preferredSize, maxWidth) {
    let size = preferredSize;
    while (size > 7 && font.widthOfTextAtSize(text, size) > maxWidth) {
        size -= 1;
    }
    return size;
}

function scopeIncludesEntry(scope, entry, entries) {
    if (scope === 'all') return true;
    if (scope === 'last') return entry.outputIndex === entries.length - 1;
    const focused = entries.find((candidate) => (
        candidate.fileId === entry.fileId
        && candidate.sourceIndex === entry.sourceIndex
    ));
    return Boolean(focused && focused.outputIndex === entry.outputIndex);
}

function formatPageNumber(format, current, finalNumber) {
    if (format === 'number') return String(current);
    if (format === 'number-total') return `${current} / ${finalNumber}`;
    return `Page ${current} of ${finalNumber}`;
}

function formatLabel(format) {
    if (format === 'number') return '1';
    if (format === 'number-total') return '1 / total';
    return 'Page 1 of total';
}

function scopeLabel(scope) {
    if (scope === 'all') return 'every page';
    if (scope === 'last') return 'last page';
    return 'current page';
}

function positionLabel(position) {
    return String(position || '')
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
}

function setControlValue(control, value) {
    if (control) control.value = String(value);
}

function setControlChecked(control, checked) {
    if (control) control.checked = Boolean(checked);
}

function readBoundedNumber(value, min, max, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function isPdfFile(file) {
    if (!file) return false;
    return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

function indicesToRangeText(indices, pageCount) {
    if (!indices.length) return '';
    const isNaturalAll = indices.length === pageCount
        && indices.every((value, index) => value === index);
    if (isNaturalAll) return 'all';

    const parts = [];
    let start = indices[0];
    let previous = indices[0];

    for (let index = 1; index < indices.length; index += 1) {
        const current = indices[index];
        if (current === previous + 1) {
            previous = current;
            continue;
        }
        parts.push(start === previous ? `${start + 1}` : `${start + 1}-${previous + 1}`);
        start = current;
        previous = current;
    }
    parts.push(start === previous ? `${start + 1}` : `${start + 1}-${previous + 1}`);
    return parts.join(',');
}

function normalizeRotation(value) {
    return ((Number(value) % 360) + 360) % 360;
}

function pageKey(fileId, pageIndex) {
    return `${fileId}:${pageIndex}`;
}

function cssEscape(value) {
    if (globalThis.CSS?.escape) return globalThis.CSS.escape(String(value));
    return String(value).replace(/["\\]/g, '\\$&');
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
