const ACCEPTED_FILE_TYPES = new Set([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp'
]);

const ACCEPTED_FILE_EXTENSIONS = new Set([
    'pdf',
    'jpg',
    'jpeg',
    'png',
    'webp'
]);

const FILE_INPUT_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,.pdf,.jpg,.jpeg,.png,.webp';
const OCR_LANGUAGES = new Set(['eng', 'eng+kor']);
const PDF_RENDER_WIDTH = 1800;
const PDF_RENDER_MAX_EDGE = 2600;
const SUBSTANTIAL_RASTER_PAGE_RATIO = 0.18;
const NATIVE_TEXT_PAGE_SPAN_RATIO = 0.4;
const NATIVE_TEXT_MIN_PAGE_BANDS = 4;
const NATIVE_TEXT_MIN_INTERIOR_BANDS = 2;
const OCR_CORE_PATH = new URL('../../vendor/tesseract/core/', import.meta.url).href;
const OCR_LANG_PATH = new URL('../../vendor/tesseract/lang/', import.meta.url).href;

let pdfJsPromise = null;
let tesseractPromise = null;

async function getPdfJs() {
    if (!pdfJsPromise) {
        pdfJsPromise = import('../../vendor/pdfjs/pdf.min.mjs?v=r-0482439758aef41c')
            .then((pdfjs) => {
                pdfjs.GlobalWorkerOptions.workerSrc = new URL(
                    '../../vendor/pdfjs/pdf.worker.min.mjs?v=r-0482439758aef41c',
                    import.meta.url
                ).href;
                return pdfjs;
            })
            .catch((error) => {
                pdfJsPromise = null;
                throw error;
            });
    }
    return pdfJsPromise;
}

async function getTesseract() {
    if (!tesseractPromise) {
        tesseractPromise = import('../../vendor/tesseract/tesseract.esm.min.js?v=r-0482439758aef41c')
            .catch((error) => {
                tesseractPromise = null;
                throw error;
            });
    }
    return tesseractPromise;
}

export function createPdfOcrController({
    state,
    elements,
    downloadBlob
}) {
    const pdfElements = elements?.pdf || {};
    const listeners = [];
    const terminatedWorkers = new WeakSet();
    let activeWorker = null;
    let activePdfDocument = null;
    let activePdfLoadingTask = null;
    let activeRenderTask = null;
    let textBeforeJob = '';
    let statusMessage = '';
    let bound = false;
    let disposed = false;
    let jobId = 0;

    ensureOcrState(state);

    function listen(target, type, handler, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, options);
        listeners.push({ target, type, handler, options });
    }

    function render() {
        const ocr = state.pdf.ocr;
        const isWorking = ocr.status === 'working';
        const hasFile = Boolean(ocr.file);

        if (pdfElements.ocrFileInput) {
            pdfElements.ocrFileInput.accept = FILE_INPUT_ACCEPT;
            pdfElements.ocrFileInput.multiple = false;
            pdfElements.ocrFileInput.disabled = isWorking;
        }

        if (pdfElements.ocrDropzone) {
            pdfElements.ocrDropzone.classList.toggle('has-file', hasFile);
            pdfElements.ocrDropzone.classList.toggle('is-busy', isWorking);
            pdfElements.ocrDropzone.dataset.fileName = ocr.fileName || '';
            pdfElements.ocrDropzone.dataset.status = ocr.status;
            pdfElements.ocrDropzone.setAttribute('aria-busy', String(isWorking));
            if (ocr.fileName) pdfElements.ocrDropzone.title = ocr.fileName;
            else pdfElements.ocrDropzone.removeAttribute('title');
        }

        if (pdfElements.ocrLanguage) {
            const language = normalizeLanguage(ocr.language);
            if (pdfElements.ocrLanguage.value !== language) {
                pdfElements.ocrLanguage.value = language;
            }
            pdfElements.ocrLanguage.disabled = isWorking;
        }

        if (pdfElements.ocrStartBtn) {
            pdfElements.ocrStartBtn.disabled = !hasFile || isWorking;
            pdfElements.ocrStartBtn.hidden = isWorking;
            pdfElements.ocrStartBtn.setAttribute('aria-busy', String(isWorking));
        }
        if (pdfElements.ocrCancelBtn) {
            pdfElements.ocrCancelBtn.disabled = !isWorking;
            pdfElements.ocrCancelBtn.hidden = !isWorking;
        }

        syncOutputValue(pdfElements.ocrOutput, ocr.text || '');
        renderOutputFeedback();
    }

    function renderOutputFeedback() {
        const ocr = state.pdf.ocr;
        const isWorking = ocr.status === 'working';
        const hasOutput = Boolean(String(ocr.text || '').trim());
        const progress = clampProgress(ocr.progress);

        if (pdfElements.ocrStatus) {
            pdfElements.ocrStatus.textContent = getVisibleStatus();
            pdfElements.ocrStatus.dataset.status = ocr.status;
            pdfElements.ocrStatus.dataset.progress = String(progress);
            pdfElements.ocrStatus.setAttribute('role', 'status');
            pdfElements.ocrStatus.setAttribute('aria-live', 'polite');
            if (isWorking) {
                pdfElements.ocrStatus.setAttribute('aria-label', `${getVisibleStatus()} ${progress}%`);
            } else {
                pdfElements.ocrStatus.removeAttribute('aria-label');
            }
        }

        if (pdfElements.ocrOutput && 'disabled' in pdfElements.ocrOutput) {
            pdfElements.ocrOutput.disabled = isWorking;
        }
        if (pdfElements.ocrCopyBtn) {
            pdfElements.ocrCopyBtn.disabled = !hasOutput || isWorking;
        }
        if (pdfElements.ocrDownloadBtn) {
            pdfElements.ocrDownloadBtn.disabled = !hasOutput || isWorking;
        }
    }

    function getVisibleStatus() {
        if (statusMessage) return statusMessage;

        const ocr = state.pdf.ocr;
        if (ocr.status === 'working') {
            return `Reading text... ${clampProgress(ocr.progress)}%`;
        }
        if (ocr.status === 'done') {
            return 'Text is ready. Review it, copy it, or download it as a TXT file.';
        }
        if (ocr.status === 'error') {
            return 'Text could not be read from this file.';
        }
        if (ocr.status === 'cancelled') {
            return 'Reading stopped. Your file is still ready if you want to try again.';
        }
        if (ocr.file) {
            return `${ocr.fileName} is ready. The file stays on this device.`;
        }
        return 'Choose one PDF, JPG, PNG, or WEBP file. Your file is not uploaded.';
    }

    function setFileList(fileList) {
        if (state.pdf.ocr.status === 'working') return;

        const files = Array.from(fileList || []);
        if (files.length !== 1) {
            clearSelectedFile();
            state.pdf.ocr.status = 'error';
            statusMessage = files.length > 1
                ? 'Choose one file at a time.'
                : 'Choose one PDF, JPG, PNG, or WEBP file.';
            render();
            return;
        }

        const [file] = files;
        if (!isAcceptedFile(file)) {
            clearSelectedFile();
            state.pdf.ocr.status = 'error';
            statusMessage = 'This file type is not supported. Choose a PDF, JPG, PNG, or WEBP file.';
            render();
            return;
        }

        state.pdf.ocr.file = file;
        state.pdf.ocr.fileName = file.name || defaultFileName(file);
        state.pdf.ocr.text = '';
        state.pdf.ocr.status = 'ready';
        state.pdf.ocr.progress = 0;
        statusMessage = `${state.pdf.ocr.fileName} is ready. The file stays on this device.`;
        render();
    }

    function clearSelectedFile() {
        state.pdf.ocr.file = null;
        state.pdf.ocr.fileName = '';
        state.pdf.ocr.text = '';
        state.pdf.ocr.progress = 0;
    }

    function updateProgress(progress, message) {
        if (disposed || state.pdf.ocr.status !== 'working') return;
        state.pdf.ocr.progress = clampProgress(progress);
        statusMessage = message;
        render();
    }

    function assertActiveJob(currentJobId) {
        if (disposed || currentJobId !== jobId) {
            throw new Error('The OCR job was stopped.');
        }
    }

    function makeWorkerLogger(context) {
        return (event = {}) => {
            if (disposed || state.pdf.ocr.status !== 'working') return;

            const workerProgress = clampUnitProgress(event.progress);
            const total = Math.max(1, context.totalPages || 1);
            const pageIndex = Math.max(0, Math.min(total - 1, context.pageIndex || 0));
            const overall = 5 + ((pageIndex + workerProgress) / total) * 90;
            const action = humanizeWorkerStatus(event.status);
            const pageLabel = total > 1 ? `Page ${pageIndex + 1} of ${total}` : 'Image';
            updateProgress(
                overall,
                `${pageLabel}: ${action} ${Math.round(workerProgress * 100)}%`,
                `${pageLabel} · ${action}`
            );
        };
    }

    async function createWorker(language, logger) {
        const workerOptions = {
            logger,
            workerPath: new URL('../../vendor/tesseract/worker.min.js?v=r-0482439758aef41c', import.meta.url).href,
            corePath: OCR_CORE_PATH,
            langPath: OCR_LANG_PATH
        };

        const override = globalThis.__GENESIS_OCR_WORKER_FACTORY__;
        if (typeof override === 'function') {
            // Test override contract: ({ language, logger, workerOptions }) => Promise<worker>.
            const testWorker = await override({ language, logger, workerOptions });
            assertOcrWorker(testWorker);
            return testWorker;
        }

        const module = await getTesseract();
        const api = module.default || module;
        const factory = api.createWorker || module.createWorker;
        if (typeof factory !== 'function') {
            throw new Error('The OCR engine is unavailable.');
        }

        const worker = await factory(language, api.OEM?.LSTM_ONLY, workerOptions);
        assertOcrWorker(worker);
        return worker;
    }

    async function terminateWorker(worker) {
        const isObject = typeof worker === 'object' || typeof worker === 'function';
        if (!worker || !isObject || terminatedWorkers.has(worker)) return;
        terminatedWorkers.add(worker);
        if (typeof worker.terminate === 'function') {
            try {
                await worker.terminate();
            } catch {
                // The worker may already have stopped after an OCR or navigation failure.
            }
        }
    }

    async function runOcr() {
        const ocr = state.pdf.ocr;
        if (!ocr.file || ocr.status === 'working' || disposed) return;

        const currentJobId = ++jobId;
        const file = ocr.file;
        const language = normalizeLanguage(ocr.language);
        textBeforeJob = String(ocr.text || '');
        ocr.language = language;
        ocr.text = '';
        ocr.status = 'working';
        ocr.progress = 0;
        ocr.isRunning = true;
        statusMessage = 'Preparing the file. OCR runs on this device with the engine and language files included in this app.';
        render();

        let worker = null;
        try {
            let output;
            if (isPdfFile(file)) {
                output = await readPdf(file, language, currentJobId, (createdWorker) => {
                    worker = createdWorker;
                    activeWorker = createdWorker;
                });
            } else {
                output = await readImage(file, language, currentJobId, (createdWorker) => {
                    worker = createdWorker;
                    activeWorker = createdWorker;
                });
            }

            if (disposed || currentJobId !== jobId) return;

            ocr.text = output;
            ocr.status = 'done';
            ocr.progress = 100;
            ocr.isRunning = false;
            textBeforeJob = output;
            statusMessage = hasRecognizedText(output)
                ? 'Text is ready. Review it, copy it, or download it as a TXT file.'
                : 'No readable text was found. Try a clearer scan or choose Korean + English.';
            render();
        } catch (error) {
            if (disposed || currentJobId !== jobId) return;
            console.error('PDF OCR error:', error);
            ocr.status = 'error';
            ocr.progress = 0;
            ocr.isRunning = false;
            ocr.text = textBeforeJob;
            statusMessage = getUserFacingError(error);
            render();
        } finally {
            await terminateWorker(worker);
            if (activeWorker === worker) activeWorker = null;

        }
    }

    function cancelOcr() {
        const ocr = state.pdf.ocr;
        if (ocr.status !== 'working') return;

        jobId += 1;
        ocr.status = 'cancelled';
        ocr.progress = 0;
        ocr.isRunning = false;
        ocr.text = textBeforeJob;
        statusMessage = 'Reading stopped. Your file is still ready if you want to try again.';
        render();
        stopActiveResources();
    }

    function stopActiveResources() {
        const renderTask = activeRenderTask;
        activeRenderTask = null;
        try {
            renderTask?.cancel?.();
        } catch {
            // A render that completed between the click and cleanup needs no action.
        }

        const worker = activeWorker;
        activeWorker = null;
        void terminateWorker(worker);

        const pdfDocument = activePdfDocument;
        activePdfDocument = null;
        if (pdfDocument?.destroy) {
            void pdfDocument.destroy().catch(() => {});
        }

        const loadingTask = activePdfLoadingTask;
        activePdfLoadingTask = null;
        if (loadingTask?.destroy) {
            void loadingTask.destroy().catch(() => {});
        }
    }

    async function readImage(file, language, currentJobId, onWorkerCreated) {
        const context = { pageIndex: 0, totalPages: 1 };
        updateProgress(3, 'Preparing the OCR engine...', 'The first run may take a moment');
        const worker = await createWorker(language, makeWorkerLogger(context));
        onWorkerCreated(worker);
        assertActiveJob(currentJobId);

        updateProgress(8, 'Reading the image...', 'The image stays on this device');
        const result = await worker.recognize(file);
        assertActiveJob(currentJobId);

        return formatPageOutput(1, getRecognizedText(result));
    }

    async function readPdf(file, language, currentJobId, onWorkerCreated) {
        updateProgress(2, 'Opening the PDF...', 'Reading the PDF on this device');
        const pdfjs = await getPdfJs();
        assertActiveJob(currentJobId);

        const bytes = new Uint8Array(await file.arrayBuffer());
        assertActiveJob(currentJobId);

        const loadingTask = pdfjs.getDocument({
            data: bytes,
            standardFontDataUrl: new URL('../../vendor/pdfjs/standard_fonts/', import.meta.url).href,
            isEvalSupported: false,
            disableAutoFetch: true,
            disableStream: true
        });
        activePdfLoadingTask = loadingTask;

        let documentHandle = null;
        let worker = null;
        try {
            documentHandle = await loadingTask.promise;
            assertActiveJob(currentJobId);
            activePdfDocument = documentHandle;
            const pageTotal = documentHandle.numPages;
            const outputs = [];
            const workerContext = { pageIndex: 0, totalPages: pageTotal };

            for (let pageNumber = 1; pageNumber <= pageTotal; pageNumber += 1) {
                assertActiveJob(currentJobId);
                workerContext.pageIndex = pageNumber - 1;
                updateProgress(
                    5 + ((pageNumber - 1) / Math.max(pageTotal, 1)) * 90,
                    `Checking page ${pageNumber} of ${pageTotal} for selectable text...`,
                    `Checking page ${pageNumber} of ${pageTotal}`
                );

                const page = await documentHandle.getPage(pageNumber);
                assertActiveJob(currentJobId);
                let canvas = null;
                try {
                    const textContent = await page.getTextContent();
                    assertActiveJob(currentJobId);
                    const nativeText = extractNativeText(textContent);
                    const useNativeText = await shouldUseNativeText({
                        page,
                        pdfjs,
                        textContent,
                        nativeText
                    });
                    assertActiveJob(currentJobId);
                    if (useNativeText) {
                        outputs.push(formatPageOutput(pageNumber, nativeText));
                    } else {
                        if (!worker) {
                            updateProgress(
                                5 + ((pageNumber - 1) / Math.max(pageTotal, 1)) * 90,
                                'Preparing the OCR engine. The first run may take a moment...',
                                'Downloading OCR engine and language data'
                            );
                            worker = await createWorker(language, makeWorkerLogger(workerContext));
                            onWorkerCreated(worker);
                            assertActiveJob(currentJobId);
                        }

                        updateProgress(
                            5 + ((pageNumber - 1) / Math.max(pageTotal, 1)) * 90,
                            `Rendering scanned page ${pageNumber} of ${pageTotal}...`,
                            `Rendering page ${pageNumber} of ${pageTotal}`
                        );
                        canvas = await renderPdfPage(page, (renderTask) => {
                            activeRenderTask = renderTask;
                        });
                        assertActiveJob(currentJobId);

                        const result = await worker.recognize(canvas);
                        assertActiveJob(currentJobId);
                        const recognizedText = getRecognizedText(result);
                        outputs.push(formatPageOutput(
                            pageNumber,
                            mergeRecognizedAndNativeText(recognizedText, nativeText)
                        ));
                    }
                } finally {
                    page.cleanup();
                    if (canvas) {
                        canvas.width = 0;
                        canvas.height = 0;
                    }
                }

                updateProgress(
                    5 + (pageNumber / Math.max(pageTotal, 1)) * 90,
                    `Finished page ${pageNumber} of ${pageTotal}.`,
                    `Finished page ${pageNumber} of ${pageTotal}`
                );
            }

            if (!outputs.length) {
                throw new Error('This PDF has no pages to read.');
            }
            return outputs.join('\n\n');
        } finally {
            if (documentHandle) {
                try {
                    await documentHandle.destroy();
                } catch {
                    // Ignore PDF.js cleanup errors after the job is already finished.
                }
            } else {
                try {
                    await loadingTask.destroy();
                } catch {
                    // Ignore a loading task that failed before it produced a document.
                }
            }
            if (activePdfDocument === documentHandle) activePdfDocument = null;
            if (activePdfLoadingTask === loadingTask) activePdfLoadingTask = null;
            activeRenderTask = null;
        }
    }

    async function copyOutput() {
        const text = String(state.pdf.ocr.text || '');
        if (!text.trim() || state.pdf.ocr.status === 'working') return;

        try {
            if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
            await navigator.clipboard.writeText(text);
        } catch {
            try {
                copyTextWithFallback(text);
            } catch (error) {
                console.error('OCR copy error:', error);
                statusMessage = 'Could not copy automatically. Select the text and use Copy.';
                render();
                return;
            }
        }

        statusMessage = 'Text copied to the clipboard.';
        render();
    }

    function downloadOutput() {
        const text = String(state.pdf.ocr.text || '');
        if (!text.trim() || state.pdf.ocr.status === 'working') return;

        const filename = getTextFilename(state.pdf.ocr.fileName);
        const blob = new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' });
        if (typeof downloadBlob === 'function') {
            downloadBlob(blob, filename);
        } else {
            downloadBlobFallback(blob, filename);
        }
        statusMessage = `Downloaded ${filename}.`;
        render();
    }

    function bindEvents() {
        if (bound || disposed) return;
        bound = true;

        listen(pdfElements.ocrFileInput, 'change', (event) => {
            setFileList(event.target.files);
            event.target.value = '';
        });

        listen(pdfElements.ocrDropzone, 'click', (event) => {
            if (state.pdf.ocr.status === 'working') return;
            if (event.target === pdfElements.ocrFileInput || event.target.closest?.('button, input, select, a')) {
                return;
            }
            pdfElements.ocrFileInput?.click();
        });

        listen(pdfElements.ocrDropzone, 'keydown', (event) => {
            if (state.pdf.ocr.status === 'working') return;
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                pdfElements.ocrFileInput?.click();
            }
        });

        listen(pdfElements.ocrDropzone, 'dragenter', (event) => {
            event.preventDefault();
            if (state.pdf.ocr.status !== 'working') {
                pdfElements.ocrDropzone.classList.add('drag-over');
            }
        });

        listen(pdfElements.ocrDropzone, 'dragover', (event) => {
            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
            if (state.pdf.ocr.status !== 'working') {
                pdfElements.ocrDropzone.classList.add('drag-over');
            }
        });

        listen(pdfElements.ocrDropzone, 'dragleave', (event) => {
            if (!pdfElements.ocrDropzone.contains(event.relatedTarget)) {
                pdfElements.ocrDropzone.classList.remove('drag-over');
            }
        });

        listen(pdfElements.ocrDropzone, 'drop', (event) => {
            event.preventDefault();
            pdfElements.ocrDropzone.classList.remove('drag-over');
            setFileList(event.dataTransfer?.files);
        });

        listen(pdfElements.ocrLanguage, 'change', (event) => {
            state.pdf.ocr.language = normalizeLanguage(event.target.value);
            statusMessage = state.pdf.ocr.file
                ? `${state.pdf.ocr.fileName} is ready. The file stays on this device.`
                : '';
            render();
        });

        listen(pdfElements.ocrOutput, 'input', (event) => {
            state.pdf.ocr.text = event.target.value;
            statusMessage = state.pdf.ocr.text.trim()
                ? 'Text updated. Copy it or download the corrected TXT file.'
                : 'The text box is empty. Add text before copying or downloading.';
            // Do not call render(): writing the textarea value during input would
            // move the caret while the user is correcting OCR mistakes.
            renderOutputFeedback();
        });

        listen(pdfElements.ocrStartBtn, 'click', () => {
            void runOcr();
        });
        listen(pdfElements.ocrCancelBtn, 'click', cancelOcr);
        listen(pdfElements.ocrCopyBtn, 'click', () => {
            void copyOutput();
        });
        listen(pdfElements.ocrDownloadBtn, 'click', downloadOutput);

        render();
    }

    function dispose() {
        if (disposed) return;
        disposed = true;
        jobId += 1;
        state.pdf.ocr.isRunning = false;

        listeners.splice(0).forEach(({ target, type, handler, options }) => {
            target.removeEventListener(type, handler, options);
        });
        pdfElements.ocrDropzone?.classList.remove('drag-over');

        stopActiveResources();

    }

    return {
        bindEvents,
        render,
        dispose
    };
}

function ensureOcrState(state) {
    if (!state || typeof state !== 'object') {
        throw new TypeError('PDF OCR requires an application state object.');
    }
    if (!state.pdf || typeof state.pdf !== 'object') state.pdf = {};

    const current = state.pdf.ocr && typeof state.pdf.ocr === 'object'
        ? state.pdf.ocr
        : {};
    state.pdf.ocr = {
        file: current.file || null,
        fileName: String(current.fileName || ''),
        language: normalizeLanguage(current.language),
        text: String(current.text || ''),
        status: String(current.status || 'idle'),
        progress: clampProgress(current.progress),
        isRunning: Boolean(current.isRunning)
    };
}

function normalizeLanguage(value) {
    return OCR_LANGUAGES.has(value) ? value : 'eng';
}

function isAcceptedFile(file) {
    if (!file) return false;
    const mime = String(file.type || '').toLowerCase();
    const extension = getFileExtension(file.name);
    return ACCEPTED_FILE_TYPES.has(mime) || ACCEPTED_FILE_EXTENSIONS.has(extension);
}

function isPdfFile(file) {
    return String(file?.type || '').toLowerCase() === 'application/pdf'
        || getFileExtension(file?.name) === 'pdf';
}

function getFileExtension(name) {
    const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return match ? match[1] : '';
}

function defaultFileName(file) {
    return isPdfFile(file) ? 'document.pdf' : 'image';
}

function clampProgress(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Math.round(number)));
}

function clampUnitProgress(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(1, number));
}

function humanizeWorkerStatus(status) {
    const value = String(status || 'reading text')
        .replace(/[_-]+/g, ' ')
        .trim();
    if (!value) return 'Reading text';
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function assertOcrWorker(worker) {
    if (!worker || typeof worker.recognize !== 'function') {
        throw new Error('The OCR engine did not start correctly.');
    }
}

function extractNativeText(textContent) {
    const lines = [];
    let currentLine = '';

    for (const item of textContent?.items || []) {
        const text = typeof item?.str === 'string' ? item.str.trim() : '';
        if (text) currentLine += `${currentLine ? ' ' : ''}${text}`;
        if (item?.hasEOL) {
            if (currentLine) lines.push(currentLine);
            currentLine = '';
        }
    }
    if (currentLine) lines.push(currentLine);

    return lines
        .join('\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function isMeaningfulNativeText(text) {
    const letterOrNumberCount = (String(text).match(/[\p{L}\p{N}]/gu) || []).length;
    const wordCount = (String(text).match(/[\p{L}\p{N}]{2,}/gu) || []).length;
    return letterOrNumberCount >= 8 && (wordCount >= 2 || letterOrNumberCount >= 16);
}

async function shouldUseNativeText({ page, pdfjs, textContent, nativeText }) {
    if (!isMeaningfulNativeText(nativeText)) return false;

    // A searchable PDF often contains harmless raster logos or icons. Only treat
    // the page as a mixed scan when raster content occupies a meaningful share of
    // the page; otherwise the selectable text is already the better result.
    const operatorList = await page.getOperatorList();
    const viewport = page.getViewport({ scale: 1 });
    const pageArea = Math.max(1, Math.abs(viewport.width * viewport.height));
    const hasSubstantialRaster = operatorListContainsSubstantialRasterImage(
        operatorList,
        pdfjs?.OPS,
        pageArea
    );
    return !hasSubstantialRaster || hasPageSpanningNativeText(textContent, page);
}

function hasPageSpanningNativeText(textContent, page) {
    const candidates = (textContent?.items || [])
        .filter((item) => /[\p{L}\p{N}]/u.test(String(item?.str || '')))
        .filter((item) => isTransform(item?.transform));
    const characterCount = candidates.reduce(
        (total, item) => total + (String(item.str).match(/[\p{L}\p{N}]/gu) || []).length,
        0
    );
    if (characterCount < 40 || candidates.length < NATIVE_TEXT_MIN_PAGE_BANDS) {
        return false;
    }

    const horizontalWeight = candidates.reduce((total, item) => {
        const [a, b] = item.transform;
        const weight = (String(item.str).match(/[\p{L}\p{N}]/gu) || []).length;
        return total + (Math.abs(a) >= Math.abs(b) ? weight : -weight);
    }, 0);
    const useVerticalPosition = horizontalWeight >= 0;
    const pageView = page?.view;
    const viewport = page.getViewport({ scale: 1 });
    const rawPageWidth = isPageView(pageView)
        ? Math.abs(pageView[2] - pageView[0])
        : Math.abs(viewport.width);
    const rawPageHeight = isPageView(pageView)
        ? Math.abs(pageView[3] - pageView[1])
        : Math.abs(viewport.height);
    const pageExtent = Math.max(1, useVerticalPosition ? rawPageHeight : rawPageWidth);
    const pageOrigin = isPageView(pageView)
        ? pageView[useVerticalPosition ? 1 : 0]
        : 0;
    const positions = candidates
        .filter((item) => {
            const [a, b] = item.transform;
            return useVerticalPosition ? Math.abs(a) >= Math.abs(b) : Math.abs(b) > Math.abs(a);
        })
        .map((item) => item.transform[useVerticalPosition ? 5 : 4])
        .filter(Number.isFinite)
        .sort((first, second) => first - second);
    if (positions.length < NATIVE_TEXT_MIN_PAGE_BANDS) return false;

    const spanRatio = Math.abs(positions.at(-1) - positions[0]) / pageExtent;
    if (spanRatio < NATIVE_TEXT_PAGE_SPAN_RATIO) return false;

    const bandGap = pageExtent * 0.02;
    const pageBands = [positions[0]];
    let previousBandPosition = positions[0];
    for (const position of positions.slice(1)) {
        if (position - previousBandPosition >= bandGap) {
            pageBands.push(position);
            previousBandPosition = position;
        }
    }
    if (pageBands.length < NATIVE_TEXT_MIN_PAGE_BANDS) return false;

    const interiorStart = pageOrigin + pageExtent * 0.25;
    const interiorEnd = pageOrigin + pageExtent * 0.75;
    const interiorBandCount = pageBands.filter(
        (position) => position >= interiorStart && position <= interiorEnd
    ).length;
    return interiorBandCount >= NATIVE_TEXT_MIN_INTERIOR_BANDS;
}

function isPageView(value) {
    return (Array.isArray(value) || ArrayBuffer.isView(value))
        && value.length >= 4
        && Array.from(value).slice(0, 4).every(Number.isFinite);
}

function operatorListContainsSubstantialRasterImage(operatorList, operations = {}, pageArea) {
    const directImageOperations = new Set([
        operations.paintImageMaskXObject,
        operations.paintImageXObject,
        operations.paintInlineImageXObject
    ].filter(Number.isInteger));
    const fnArray = operatorList?.fnArray || [];
    const argsArray = operatorList?.argsArray || [];
    const transformStack = [];
    let currentTransform = [1, 0, 0, 1, 0, 0];
    let rasterArea = 0;

    const addRasterArea = (area) => {
        if (!Number.isFinite(area) || area < 0) return true;
        rasterArea += Math.min(area, pageArea);
        return rasterArea / pageArea >= SUBSTANTIAL_RASTER_PAGE_RATIO;
    };

    for (let index = 0; index < fnArray.length; index += 1) {
        const operation = fnArray[index];
        const args = argsArray[index] || [];

        if (operation === operations.save) {
            transformStack.push(currentTransform.slice());
            continue;
        }
        if (operation === operations.restore) {
            currentTransform = transformStack.pop() || [1, 0, 0, 1, 0, 0];
            continue;
        }
        if (operation === operations.transform) {
            currentTransform = multiplyTransforms(currentTransform, args);
            continue;
        }
        if (operation === operations.paintFormXObjectBegin) {
            transformStack.push(currentTransform.slice());
            if (Array.isArray(args[0])) {
                currentTransform = multiplyTransforms(currentTransform, args[0]);
            }
            continue;
        }
        if (operation === operations.paintFormXObjectEnd) {
            currentTransform = transformStack.pop() || [1, 0, 0, 1, 0, 0];
            continue;
        }

        const currentAreaScale = getTransformArea(currentTransform);
        if (directImageOperations.has(operation)) {
            if (addRasterArea(currentAreaScale)) return true;
            continue;
        }
        if (operation === operations.paintImageXObjectRepeat) {
            const positions = args[3];
            const count = Math.max(1, Math.floor((positions?.length || 0) / 2));
            const repeatedArea = currentAreaScale * Math.abs(Number(args[1]) * Number(args[2])) * count;
            if (addRasterArea(repeatedArea)) return true;
            continue;
        }
        if (operation === operations.paintImageMaskXObjectRepeat) {
            const positions = args[5];
            const count = Math.max(1, Math.floor((positions?.length || 0) / 2));
            const repeatedTransform = [args[1], args[2], args[3], args[4], 0, 0];
            if (addRasterArea(currentAreaScale * getTransformArea(repeatedTransform) * count)) {
                return true;
            }
            continue;
        }
        if (operation === operations.paintImageMaskXObjectGroup) {
            const images = args[0];
            if (!Array.isArray(images)) return true;
            for (const image of images) {
                if (addRasterArea(currentAreaScale * getTransformArea(image?.transform))) {
                    return true;
                }
            }
            continue;
        }
        if (operation === operations.paintInlineImageXObjectGroup) {
            const imageMap = args[1];
            if (!Array.isArray(imageMap)) return true;
            for (const entry of imageMap) {
                if (addRasterArea(currentAreaScale * getTransformArea(entry?.transform))) {
                    return true;
                }
            }
        }
    }

    return false;
}

function multiplyTransforms(first, second) {
    if (!isTransform(first) || !isTransform(second)) {
        return [Number.NaN, 0, 0, 1, 0, 0];
    }
    return [
        first[0] * second[0] + first[2] * second[1],
        first[1] * second[0] + first[3] * second[1],
        first[0] * second[2] + first[2] * second[3],
        first[1] * second[2] + first[3] * second[3],
        first[0] * second[4] + first[2] * second[5] + first[4],
        first[1] * second[4] + first[3] * second[5] + first[5]
    ];
}

function getTransformArea(transform) {
    if (!isTransform(transform)) return Number.POSITIVE_INFINITY;
    return Math.abs(transform[0] * transform[3] - transform[1] * transform[2]);
}

function isTransform(value) {
    return (Array.isArray(value) || ArrayBuffer.isView(value))
        && value.length >= 6
        && Array.from(value).slice(0, 6).every(Number.isFinite);
}

async function renderPdfPage(page, onRenderTask) {
    const baseViewport = page.getViewport({ scale: 1 });
    const targetScale = PDF_RENDER_WIDTH / Math.max(baseViewport.width, 1);
    const maxEdgeAtTarget = Math.max(baseViewport.width, baseViewport.height) * targetScale;
    const scale = maxEdgeAtTarget > PDF_RENDER_MAX_EDGE
        ? targetScale * (PDF_RENDER_MAX_EDGE / maxEdgeAtTarget)
        : targetScale;
    const viewport = page.getViewport({ scale: Math.max(scale, 0.01) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));

    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);

    const renderTask = page.render({
        canvasContext: context,
        viewport,
        intent: 'print',
        background: 'rgb(255,255,255)'
    });
    onRenderTask?.(renderTask);
    try {
        await renderTask.promise;
    } finally {
        onRenderTask?.(null);
    }
    return canvas;
}

function getRecognizedText(result) {
    const text = result?.data?.text ?? result?.text ?? '';
    return String(text)
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function mergeRecognizedAndNativeText(recognizedText, nativeText) {
    const recognized = String(recognizedText || '').trim();
    const native = String(nativeText || '').trim();
    if (!recognized) return native;
    if (!native) return recognized;

    const normalizedRecognized = normalizeTextForComparison(recognized);
    const normalizedNative = normalizeTextForComparison(native);
    if (normalizedNative && normalizedRecognized.includes(normalizedNative)) {
        return recognized;
    }
    return `${recognized}\n\n${native}`;
}

function normalizeTextForComparison(text) {
    return String(text || '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, '');
}

function formatPageOutput(pageNumber, text) {
    const body = String(text || '').trim() || '[No readable text found on this page.]';
    return `--- Page ${pageNumber} ---\n${body}`;
}

function hasRecognizedText(output) {
    return String(output || '')
        .replace(/--- Page \d+ ---/g, '')
        .replace(/\[No readable text found on this page\.\]/g, '')
        .trim().length > 0;
}

function syncOutputValue(output, value) {
    if (!output) return;
    if ('value' in output) {
        if (output.value !== value) output.value = value;
    } else if (output.textContent !== value) {
        output.textContent = value;
    }
}

function getTextFilename(sourceName) {
    const stem = String(sourceName || '')
        .replace(/\.[^.]+$/, '')
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/[. ]+$/g, '');
    return `${stem || 'ocr-text'}.txt`;
}

function copyTextWithFallback(text) {
    const textarea = document.createElement('textarea');
    const activeElement = document.activeElement;
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.top = '0';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);

    const copied = typeof document.execCommand === 'function' && document.execCommand('copy');
    textarea.remove();
    activeElement?.focus?.();
    if (!copied) throw new Error('The browser blocked clipboard access.');
}

function downloadBlobFallback(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.hidden = true;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

function getUserFacingError(error) {
    const name = String(error?.name || '');
    const message = String(error?.message || error || '');
    const combined = `${name} ${message}`.toLowerCase();

    if (combined.includes('password')) {
        return 'This PDF is password protected. Remove the password and try again.';
    }
    if (combined.includes('invalidpdf') || combined.includes('invalid pdf')) {
        return 'This PDF could not be read. It may be damaged or unsupported.';
    }
    if (
        combined.includes('failed to fetch')
        || combined.includes('networkerror')
        || combined.includes('network request')
        || combined.includes('language data')
    ) {
        return 'The OCR engine or language data could not be downloaded. Check your internet connection and try again. Your file was not uploaded.';
    }
    if (combined.includes('memory') || combined.includes('allocation')) {
        return 'This file is too large for the browser to read safely. Try a smaller file.';
    }
    if (combined.includes('no pages')) {
        return 'This PDF has no pages to read.';
    }
    return 'Could not read text from this file. Try a clearer image or a smaller file.';
}
