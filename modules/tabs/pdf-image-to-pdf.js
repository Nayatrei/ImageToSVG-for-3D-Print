let pdfLibPromise = null;

const AUTO_PAGE_POINTS_PER_PIXEL = 72 / 96;
const MAX_PDF_PAGE_POINTS = 14_400;
const PAGE_MARGIN_POINTS = 36;
const MAX_CANVAS_EDGE = 8192;
const MAX_CANVAS_PIXELS = 40_000_000;
const PAGE_SIZES = Object.freeze({
    a4: Object.freeze([595.28, 841.89]),
    letter: Object.freeze([612, 792])
});

async function getPdfLib() {
    if (!pdfLibPromise) {
        pdfLibPromise = import('../../vendor/pdf-lib/pdf-lib.esm.min.js?v=r-78ade4c03db6e3a2');
    }
    return pdfLibPromise;
}

export function createImageToPdfController({
    state,
    elements,
    showLoader,
    downloadBlob
}) {
    let nextId = 1;
    let isBound = false;
    let isDisposed = false;
    const eventCleanups = [];

    function getImageState() {
        state.pdf ||= {};
        state.pdf.imagesToPdf ||= {
            items: [],
            pageSize: 'auto',
            outputName: 'images.pdf',
            isExporting: false
        };

        const imageState = state.pdf.imagesToPdf;
        if (!Array.isArray(imageState.items)) imageState.items = [];
        if (!['auto', 'a4', 'letter'].includes(imageState.pageSize)) imageState.pageSize = 'auto';
        if (typeof imageState.outputName !== 'string') imageState.outputName = 'images.pdf';
        imageState.isExporting = Boolean(imageState.isExporting);
        return imageState;
    }

    function getPdfElements() {
        return elements?.pdf || {};
    }

    function bindEvents() {
        if (isBound || isDisposed) return;
        isBound = true;

        const pdfElements = getPdfElements();
        listen(pdfElements.imagePdfDropzone, 'click', () => {
            pdfElements.imagePdfInput?.click();
        });
        listen(pdfElements.imagePdfDropzone, 'keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            pdfElements.imagePdfInput?.click();
        });
        if (pdfElements.imagePdfEmpty !== pdfElements.imagePdfDropzone) {
            listen(pdfElements.imagePdfEmpty, 'click', () => {
                pdfElements.imagePdfInput?.click();
            });
            listen(pdfElements.imagePdfEmpty, 'keydown', (event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                pdfElements.imagePdfInput?.click();
            });
        }
        listen(pdfElements.imagePdfInput, 'change', async (event) => {
            await addFiles(event.target?.files);
            if (event.target) event.target.value = '';
        });
        listen(pdfElements.imagePdfDropzone, 'dragover', (event) => {
            event.preventDefault();
            pdfElements.imagePdfDropzone?.classList.add('drag-over');
        });
        listen(pdfElements.imagePdfDropzone, 'dragleave', () => {
            pdfElements.imagePdfDropzone?.classList.remove('drag-over');
        });
        listen(pdfElements.imagePdfDropzone, 'drop', async (event) => {
            event.preventDefault();
            pdfElements.imagePdfDropzone?.classList.remove('drag-over');
            await addFiles(event.dataTransfer?.files);
        });

        listen(pdfElements.imagePdfFileList, 'click', handleItemAction);
        if (pdfElements.imagePdfList !== pdfElements.imagePdfFileList) {
            listen(pdfElements.imagePdfList, 'click', handleItemAction);
        }

        Array.from(pdfElements.imagePdfPageSizeButtons || []).forEach((button) => {
            listen(button, 'click', () => {
                const pageSize = readPageSizeButton(button);
                if (!['auto', 'a4', 'letter'].includes(pageSize)) return;
                getImageState().pageSize = pageSize;
                render();
            });
        });

        listen(pdfElements.imagePdfName, 'input', () => {
            getImageState().outputName = pdfElements.imagePdfName.value;
        });
        listen(pdfElements.imagePdfExportBtn, 'click', exportPdf);

        render();
    }

    function listen(target, type, handler, options) {
        if (!target?.addEventListener) return;
        target.addEventListener(type, handler, options);
        eventCleanups.push(() => target.removeEventListener(type, handler, options));
    }

    async function addFiles(fileList) {
        if (isDisposed) return;
        const suppliedFiles = Array.from(fileList || []);
        const acceptedFiles = suppliedFiles
            .map((file) => ({ file, kind: getImageKind(file) }))
            .filter(({ kind }) => Boolean(kind));
        const rejectedCount = suppliedFiles.length - acceptedFiles.length;

        if (!acceptedFiles.length) {
            setStatus('Choose JPG, PNG, WebP, or HEIC image files.', 'error');
            return;
        }

        const imageState = getImageState();
        const createdItems = acceptedFiles.map(({ file, kind }) => {
            const item = {
                id: `pdf-image-${Date.now()}-${nextId++}`,
                file,
                name: file.name || `image-${nextId}`,
                size: Number(file.size) || 0,
                kind,
                width: 0,
                height: 0,
                rotation: 0,
                exifOrientation: 1,
                // A HEIC blob cannot back an <img>, so its preview URL is
                // withheld until loadItem has swapped in the decoded PNG.
                previewUrl: kind === 'heic' ? '' : URL.createObjectURL(file),
                status: 'loading',
                error: ''
            };
            imageState.items.push(item);
            return item;
        });

        render();
        await Promise.all(createdItems.map(loadItem));
        if (isDisposed) return;
        render();

        if (rejectedCount && createdItems.every((item) => item.status === 'ready')) {
            setStatus(
                `Added ${acceptedFiles.length} image${acceptedFiles.length === 1 ? '' : 's'}; ignored ${rejectedCount} unsupported file${rejectedCount === 1 ? '' : 's'}.`,
                'ready'
            );
        }
    }

    // Replaces a HEIC item's file with the decoded PNG, in place, so every later
    // step (preview, rotate, embedPng) runs the ordinary PNG path. The decoder
    // module — and the WebAssembly build behind it — loads only when this runs.
    async function decodeHeicItem(item) {
        const { decodeHeicToBlob } = await import('../shared/heic.js?v=r-78ade4c03db6e3a2');
        const pngBlob = await decodeHeicToBlob(item.file, 'image/png');
        if (isDisposed || !getImageState().items.includes(item)) return;
        const stem = String(item.name || 'image').replace(/\.[^/.]+$/, '') || 'image';
        item.file = new File([pngBlob], `${stem}.png`, { type: 'image/png' });
        item.kind = 'png';
        revokeItemPreview(item);
        item.previewUrl = URL.createObjectURL(item.file);
    }

    async function loadItem(item) {
        try {
            if (item.kind === 'heic') await decodeHeicItem(item);
            if (isDisposed || !getImageState().items.includes(item)) return;
            const [image, exifOrientation] = await Promise.all([
                loadImageElement(item.previewUrl),
                item.kind === 'jpg' ? readJpegExifOrientation(item.file) : Promise.resolve(1)
            ]);
            if (isDisposed || !getImageState().items.includes(item)) return;
            item.width = image.naturalWidth || image.width;
            item.height = image.naturalHeight || image.height;
            item.exifOrientation = exifOrientation;
            if (!item.width || !item.height) throw new Error('Image dimensions are unavailable.');
            item.status = 'ready';
            item.error = '';
        } catch (error) {
            if (isDisposed || !getImageState().items.includes(item)) return;
            item.status = 'error';
            item.error = error?.message || 'Could not read this image.';
            revokeItemPreview(item);
        }
    }

    function handleItemAction(event) {
        const button = event.target?.closest?.('[data-image-pdf-action]');
        const row = button?.closest?.('[data-image-pdf-id]');
        if (!button || !row) return;

        const imageState = getImageState();
        const index = imageState.items.findIndex((item) => item.id === row.dataset.imagePdfId);
        if (index < 0 || imageState.isExporting) return;

        const action = button.dataset.imagePdfAction;
        const item = imageState.items[index];
        if (action === 'move-earlier' && index > 0) {
            imageState.items.splice(index, 1);
            imageState.items.splice(index - 1, 0, item);
        } else if (action === 'move-later' && index < imageState.items.length - 1) {
            imageState.items.splice(index, 1);
            imageState.items.splice(index + 1, 0, item);
        } else if (action === 'rotate-left' && item.status === 'ready') {
            item.rotation = normalizeRotation(item.rotation - 90);
        } else if (action === 'rotate-right' && item.status === 'ready') {
            item.rotation = normalizeRotation(item.rotation + 90);
        } else if (action === 'remove') {
            imageState.items.splice(index, 1);
            revokeItemPreview(item);
        } else {
            return;
        }

        render();
    }

    function render() {
        if (isDisposed) return;
        const imageState = getImageState();
        const pdfElements = getPdfElements();
        const items = imageState.items;
        const readyItems = items.filter((item) => item.status === 'ready');
        const totalSize = items.reduce((total, item) => total + (Number(item.size) || 0), 0);
        const hasItems = items.length > 0;
        const hasErrors = items.some((item) => item.status === 'error');
        const isLoading = items.some((item) => item.status === 'loading');
        const canExport = hasItems
            && readyItems.length === items.length
            && !hasErrors
            && !isLoading
            && !imageState.isExporting;

        setText(pdfElements.imagePdfFileCount, String(items.length));
        setText(pdfElements.imagePdfCount, String(items.length));
        setText(
            pdfElements.imagePdfCount?.nextElementSibling,
            items.length === 1 ? 'image added' : 'images added'
        );
        setText(pdfElements.imagePdfTotalSize, formatBytes(totalSize));
        pdfElements.imagePdfEmpty?.classList.toggle('hidden', hasItems);
        pdfElements.imagePdfList?.classList.toggle('hidden', !hasItems);
        if (pdfElements.imagePdfExportBtn) pdfElements.imagePdfExportBtn.disabled = !canExport;
        if (pdfElements.imagePdfDropzone) {
            pdfElements.imagePdfDropzone.setAttribute('aria-busy', String(isLoading));
        }

        if (pdfElements.imagePdfName && document.activeElement !== pdfElements.imagePdfName) {
            pdfElements.imagePdfName.value = imageState.outputName;
        }
        Array.from(pdfElements.imagePdfPageSizeButtons || []).forEach((button) => {
            const active = readPageSizeButton(button) === imageState.pageSize;
            button.classList.toggle('active', active);
            button.setAttribute('aria-pressed', String(active));
        });

        renderFileList(pdfElements.imagePdfFileList, items, imageState.isExporting);
        renderPageList(pdfElements.imagePdfList, items, imageState.isExporting);
        renderStatus({ items, readyItems, hasErrors, isLoading, isExporting: imageState.isExporting });
    }

    function renderFileList(container, items, isExporting) {
        if (!container) return;
        const fragment = document.createDocumentFragment();
        items.forEach((item, index) => {
            const row = document.createElement('article');
            row.className = 'pdf-image-file-row';
            row.dataset.imagePdfId = item.id;
            row.dataset.status = item.status;

            const order = document.createElement('span');
            order.className = 'pdf-image-file-order';
            order.textContent = String(index + 1).padStart(2, '0');

            const info = document.createElement('div');
            info.className = 'pdf-image-file-info';
            const name = document.createElement('strong');
            name.className = 'pdf-image-file-name';
            name.textContent = item.name;
            name.title = item.name;
            const meta = document.createElement('span');
            meta.className = 'pdf-image-file-meta';
            meta.textContent = getItemMeta(item);
            info.append(name, meta);

            const actions = document.createElement('div');
            actions.className = 'pdf-image-file-actions';
            actions.append(
                createActionButton('Move earlier', 'move-earlier', index === 0 || isExporting),
                createActionButton('Move later', 'move-later', index === items.length - 1 || isExporting),
                createActionButton('Remove', 'remove', isExporting, 'is-danger')
            );

            row.append(order, info, actions);
            fragment.appendChild(row);
        });
        container.replaceChildren(fragment);
    }

    function renderPageList(container, items, isExporting) {
        if (!container) return;
        const fragment = document.createDocumentFragment();
        items.forEach((item, index) => {
            const card = document.createElement('article');
            card.className = 'pdf-image-page-card';
            card.dataset.imagePdfId = item.id;
            card.dataset.status = item.status;

            const preview = document.createElement('div');
            preview.className = 'pdf-image-page-preview';
            if (item.previewUrl) {
                const image = document.createElement('img');
                image.className = 'pdf-image-page-image';
                image.src = item.previewUrl;
                image.alt = `${item.name} preview`;
                image.draggable = false;
                image.style.transform = `rotate(${normalizeRotation(item.rotation)}deg)`;
                preview.appendChild(image);
            } else {
                const unavailable = document.createElement('span');
                unavailable.className = 'pdf-image-page-unavailable';
                unavailable.textContent = item.status === 'error' ? 'Preview unavailable' : 'Loading preview';
                preview.appendChild(unavailable);
            }

            const badge = document.createElement('span');
            badge.className = 'pdf-image-page-order';
            badge.textContent = `Page ${index + 1}`;
            preview.appendChild(badge);

            const info = document.createElement('div');
            info.className = 'pdf-image-page-info';
            const name = document.createElement('strong');
            name.textContent = item.name;
            name.title = item.name;
            const meta = document.createElement('span');
            meta.textContent = getItemMeta(item);
            info.append(name, meta);

            const actions = document.createElement('div');
            actions.className = 'pdf-image-page-actions';
            const ready = item.status === 'ready' && !isExporting;
            actions.append(
                createActionButton('Move earlier', 'move-earlier', index === 0 || isExporting),
                createActionButton('Move later', 'move-later', index === items.length - 1 || isExporting),
                createActionButton('Rotate left', 'rotate-left', !ready),
                createActionButton('Rotate right', 'rotate-right', !ready),
                createActionButton('Remove', 'remove', isExporting, 'is-danger')
            );

            card.append(preview, info, actions);
            fragment.appendChild(card);
        });
        container.replaceChildren(fragment);
    }

    function createActionButton(label, action, disabled, className = '') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `pdf-image-action ${className}`.trim();
        button.dataset.imagePdfAction = action;
        button.textContent = label;
        button.disabled = Boolean(disabled);
        return button;
    }

    function getItemMeta(item) {
        if (item.status === 'loading') return `Reading · ${formatBytes(item.size)}`;
        if (item.status === 'error') return item.error || 'Could not read image';
        const rotated = item.rotation === 90 || item.rotation === 270;
        const width = rotated ? item.height : item.width;
        const height = rotated ? item.width : item.height;
        const rotation = item.rotation ? ` · ${item.rotation}°` : '';
        return `${width} × ${height}px · ${formatBytes(item.size)}${rotation}`;
    }

    function renderStatus({ items, readyItems, hasErrors, isLoading, isExporting }) {
        if (!items.length) {
            setStatus('Add JPG, PNG, WebP, or HEIC images. Everything stays in this browser.', 'muted');
        } else if (isExporting) {
            setStatus('Building the PDF locally…', 'muted');
        } else if (isLoading) {
            setStatus(`Reading ${readyItems.length} of ${items.length} images…`, 'muted');
        } else if (hasErrors) {
            setStatus('Remove unreadable images before exporting.', 'error');
        } else {
            setStatus(`${readyItems.length} image${readyItems.length === 1 ? '' : 's'} ready for PDF export.`, 'ready');
        }
    }

    function setStatus(message, tone = 'muted') {
        const status = getPdfElements().imagePdfStatus;
        if (!status) return;
        status.textContent = message;
        status.dataset.tone = tone;
    }

    async function exportPdf() {
        const imageState = getImageState();
        if (imageState.isExporting) return;
        const items = imageState.items.filter((item) => item.status === 'ready');
        if (!items.length || items.length !== imageState.items.length) {
            setStatus('Wait for every image to finish loading or remove unreadable files.', 'error');
            return;
        }

        imageState.isExporting = true;
        render();
        showLoader?.(true, {
            title: 'Building PDF…',
            subtitle: 'Preparing images locally',
            progress: 0.04
        });

        let finalStatus = null;
        try {
            const { PDFDocument } = await getPdfLib();
            const pdfDocument = await PDFDocument.create();

            for (let index = 0; index < items.length; index += 1) {
                const item = items[index];
                showLoader?.(true, {
                    title: 'Building PDF…',
                    subtitle: `${item.name} · page ${index + 1} of ${items.length}`,
                    progress: 0.08 + (index / Math.max(items.length, 1)) * 0.78
                });

                const embedded = await embedImageItem(pdfDocument, item);
                const geometry = getPageGeometry({
                    pageSize: imageState.pageSize,
                    pixelWidth: getRotatedWidth(item),
                    pixelHeight: getRotatedHeight(item)
                });
                const page = pdfDocument.addPage([geometry.pageWidth, geometry.pageHeight]);
                page.drawImage(embedded, {
                    x: geometry.imageX,
                    y: geometry.imageY,
                    width: geometry.imageWidth,
                    height: geometry.imageHeight
                });
            }

            pdfDocument.setProducer('Genesis Image Tools');
            pdfDocument.setCreator('Genesis Image Tools Image to PDF');
            pdfDocument.setModificationDate(new Date());
            showLoader?.(true, {
                title: 'Building PDF…',
                subtitle: 'Saving the document',
                progress: 0.94
            });

            const bytes = await pdfDocument.save();
            const filename = sanitizePdfFilename(imageState.outputName);
            downloadBlob(
                new Blob([bytes], { type: 'application/pdf' }),
                filename
            );
            finalStatus = {
                message: `Downloaded ${filename} with ${items.length} page${items.length === 1 ? '' : 's'}.`,
                tone: 'ready'
            };
        } catch (error) {
            console.error('Image to PDF export error:', error);
            finalStatus = {
                message: error?.message || 'Could not build the PDF.',
                tone: 'error'
            };
        } finally {
            imageState.isExporting = false;
            showLoader?.(false);
            render();
            if (finalStatus) setStatus(finalStatus.message, finalStatus.tone);
        }
    }

    async function embedImageItem(pdfDocument, item) {
        if (item.rotation === 0 && item.kind === 'jpg' && item.exifOrientation === 1) {
            return pdfDocument.embedJpg(new Uint8Array(await item.file.arrayBuffer()));
        }
        if (item.rotation === 0 && item.kind === 'png') {
            return pdfDocument.embedPng(new Uint8Array(await item.file.arrayBuffer()));
        }

        const pngBytes = await rasterizeItemToPng(item);
        return pdfDocument.embedPng(pngBytes);
    }

    async function rasterizeItemToPng(item) {
        const temporaryUrl = URL.createObjectURL(item.file);
        try {
            const image = await loadImageElement(temporaryUrl);
            const sourceWidth = image.naturalWidth || image.width;
            const sourceHeight = image.naturalHeight || image.height;
            const rotated = item.rotation === 90 || item.rotation === 270;
            const outputWidth = rotated ? sourceHeight : sourceWidth;
            const outputHeight = rotated ? sourceWidth : sourceHeight;
            const scale = getSafeCanvasScale(outputWidth, outputHeight);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(outputWidth * scale));
            canvas.height = Math.max(1, Math.round(outputHeight * scale));
            const context = canvas.getContext('2d');
            if (!context) throw new Error('Canvas conversion is unavailable in this browser.');

            context.translate(canvas.width / 2, canvas.height / 2);
            context.rotate(normalizeRotation(item.rotation) * Math.PI / 180);
            context.drawImage(
                image,
                -(sourceWidth * scale) / 2,
                -(sourceHeight * scale) / 2,
                sourceWidth * scale,
                sourceHeight * scale
            );

            const blob = await canvasToBlob(canvas, 'image/png');
            canvas.width = 0;
            canvas.height = 0;
            return new Uint8Array(await blob.arrayBuffer());
        } finally {
            URL.revokeObjectURL(temporaryUrl);
        }
    }

    function getPageGeometry({ pageSize, pixelWidth, pixelHeight }) {
        const safePixelWidth = Math.max(1, Number(pixelWidth) || 1);
        const safePixelHeight = Math.max(1, Number(pixelHeight) || 1);

        if (pageSize === 'auto') {
            let pageWidth = safePixelWidth * AUTO_PAGE_POINTS_PER_PIXEL;
            let pageHeight = safePixelHeight * AUTO_PAGE_POINTS_PER_PIXEL;
            const scale = Math.min(
                1,
                MAX_PDF_PAGE_POINTS / Math.max(pageWidth, 1),
                MAX_PDF_PAGE_POINTS / Math.max(pageHeight, 1)
            );
            pageWidth = Math.max(1, pageWidth * scale);
            pageHeight = Math.max(1, pageHeight * scale);
            return {
                pageWidth,
                pageHeight,
                imageX: 0,
                imageY: 0,
                imageWidth: pageWidth,
                imageHeight: pageHeight
            };
        }

        const portraitSize = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
        const landscape = safePixelWidth > safePixelHeight;
        const pageWidth = landscape ? portraitSize[1] : portraitSize[0];
        const pageHeight = landscape ? portraitSize[0] : portraitSize[1];
        const availableWidth = pageWidth - PAGE_MARGIN_POINTS * 2;
        const availableHeight = pageHeight - PAGE_MARGIN_POINTS * 2;
        const imageScale = Math.min(
            availableWidth / safePixelWidth,
            availableHeight / safePixelHeight
        );
        const imageWidth = safePixelWidth * imageScale;
        const imageHeight = safePixelHeight * imageScale;
        return {
            pageWidth,
            pageHeight,
            imageX: (pageWidth - imageWidth) / 2,
            imageY: (pageHeight - imageHeight) / 2,
            imageWidth,
            imageHeight
        };
    }

    function dispose() {
        if (isDisposed) return;
        isDisposed = true;
        while (eventCleanups.length) eventCleanups.pop()();
        getImageState().items.forEach(revokeItemPreview);
        isBound = false;
    }

    return {
        bindEvents,
        render,
        dispose
    };
}

function getImageKind(file) {
    if (!file) return '';
    const mime = String(file.type || '').toLowerCase();
    const name = String(file.name || '').toLowerCase();
    if (mime === 'image/jpeg' || /\.jpe?g$/.test(name)) return 'jpg';
    if (mime === 'image/png' || /\.png$/.test(name)) return 'png';
    if (mime === 'image/webp' || /\.webp$/.test(name)) return 'webp';
    // iPhone photos. Nothing downstream can read HEIC bytes, so loadItem
    // decodes each one to PNG and rewrites the item's kind before any preview,
    // rotation, or embed step touches it.
    if (/\.(?:heic|heif|heics|heifs|hif)$/.test(name) || /^image\/hei[cf](?:-sequence)?$/.test(mime)) return 'heic';
    return '';
}

export async function readJpegExifOrientation(file) {
    if (!file?.arrayBuffer) return 1;
    try {
        const header = file.slice?.(0, 512 * 1024) || file;
        return parseJpegExifOrientation(new Uint8Array(await header.arrayBuffer()));
    } catch {
        return 1;
    }
}

export function parseJpegExifOrientation(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) return 1;

    let offset = 2;
    while (offset + 4 <= data.length) {
        if (data[offset] !== 0xff) {
            offset += 1;
            continue;
        }
        while (offset < data.length && data[offset] === 0xff) offset += 1;
        const marker = data[offset];
        offset += 1;
        if (marker === 0xd9 || marker === 0xda) break;
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
        if (offset + 2 > data.length) break;

        const segmentLength = (data[offset] << 8) | data[offset + 1];
        if (segmentLength < 2 || offset + segmentLength > data.length) break;
        const segmentStart = offset + 2;
        if (
            marker === 0xe1
            && segmentLength >= 8
            && data[segmentStart] === 0x45
            && data[segmentStart + 1] === 0x78
            && data[segmentStart + 2] === 0x69
            && data[segmentStart + 3] === 0x66
            && data[segmentStart + 4] === 0
            && data[segmentStart + 5] === 0
        ) {
            const orientation = readTiffOrientation(
                data,
                segmentStart + 6,
                offset + segmentLength
            );
            if (orientation >= 1 && orientation <= 8) return orientation;
        }
        offset += segmentLength;
    }
    return 1;
}

function readTiffOrientation(data, tiffStart, segmentEnd) {
    if (tiffStart + 8 > segmentEnd) return 1;
    const littleEndian = data[tiffStart] === 0x49 && data[tiffStart + 1] === 0x49;
    const bigEndian = data[tiffStart] === 0x4d && data[tiffStart + 1] === 0x4d;
    if (!littleEndian && !bigEndian) return 1;

    const read16 = (position) => {
        if (position < tiffStart || position + 2 > segmentEnd) return null;
        return littleEndian
            ? data[position] | (data[position + 1] << 8)
            : (data[position] << 8) | data[position + 1];
    };
    const read32 = (position) => {
        if (position < tiffStart || position + 4 > segmentEnd) return null;
        if (littleEndian) {
            return (
                data[position]
                + data[position + 1] * 0x100
                + data[position + 2] * 0x10000
                + data[position + 3] * 0x1000000
            );
        }
        return (
            data[position] * 0x1000000
            + data[position + 1] * 0x10000
            + data[position + 2] * 0x100
            + data[position + 3]
        );
    };

    if (read16(tiffStart + 2) !== 42) return 1;
    const firstIfdOffset = read32(tiffStart + 4);
    if (!Number.isFinite(firstIfdOffset)) return 1;
    const ifdStart = tiffStart + firstIfdOffset;
    const entryCount = read16(ifdStart);
    if (!Number.isInteger(entryCount)) return 1;

    for (let index = 0; index < entryCount; index += 1) {
        const entry = ifdStart + 2 + index * 12;
        if (entry + 12 > segmentEnd) break;
        if (read16(entry) !== 0x0112 || read16(entry + 2) !== 3 || read32(entry + 4) < 1) {
            continue;
        }
        const orientation = read16(entry + 8);
        return orientation >= 1 && orientation <= 8 ? orientation : 1;
    }
    return 1;
}

function loadImageElement(url) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.decoding = 'async';
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Could not decode this image.'));
        image.src = url;
    });
}

function canvasToBlob(canvas, mimeType) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) resolve(blob);
            else reject(new Error('Could not convert this image.'));
        }, mimeType);
    });
}

function getSafeCanvasScale(width, height) {
    return Math.min(
        1,
        MAX_CANVAS_EDGE / Math.max(width, 1),
        MAX_CANVAS_EDGE / Math.max(height, 1),
        Math.sqrt(MAX_CANVAS_PIXELS / Math.max(width * height, 1))
    );
}

function getRotatedWidth(item) {
    return item.rotation === 90 || item.rotation === 270 ? item.height : item.width;
}

function getRotatedHeight(item) {
    return item.rotation === 90 || item.rotation === 270 ? item.width : item.height;
}

function normalizeRotation(value) {
    return ((Number(value) % 360) + 360) % 360;
}

function readPageSizeButton(button) {
    return String(
        button?.dataset?.imagePdfPageSize
        || button?.dataset?.pdfPageSize
        || button?.dataset?.pageSize
        || button?.value
        || ''
    ).toLowerCase();
}

function revokeItemPreview(item) {
    if (!item?.previewUrl) return;
    URL.revokeObjectURL(item.previewUrl);
    item.previewUrl = '';
}

function sanitizePdfFilename(rawName) {
    const cleaned = String(rawName || '')
        .trim()
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
        .replace(/\s+/g, ' ');
    if (!cleaned) return 'images.pdf';
    return /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
}

function formatBytes(bytes) {
    const value = Number(bytes);
    if (!Number.isFinite(value) || value < 0) return '—';
    if (value < 1024) return `${value} B`;
    const units = ['KB', 'MB', 'GB'];
    let scaled = value / 1024;
    let unitIndex = 0;
    while (scaled >= 1024 && unitIndex < units.length - 1) {
        scaled /= 1024;
        unitIndex += 1;
    }
    return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

function setText(element, value) {
    if (element) element.textContent = value;
}
