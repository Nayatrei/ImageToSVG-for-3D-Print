export const IMPORTABLE_IMAGE_EXTENSIONS = new Set([
    'png', 'jpg', 'jpeg', 'jfif', 'jpe', 'pjpeg', 'pjp',
    'webp', 'gif', 'bmp', 'dib', 'avif', 'svg', 'svgz',
    'ico', 'cur', 'tif', 'tiff', 'apng'
]);

export const BULK_SUPPORTED_EXTENSIONS = IMPORTABLE_IMAGE_EXTENSIONS;

export const IMPORTABLE_IMAGE_PROMPT = 'PNG, JPG, JPEG, WEBP, GIF, BMP, AVIF, SVG, ICO, TIFF, and other browser-compatible image files';

const IMAGE_EXTENSION_MIME_TYPES = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    jfif: 'image/jpeg',
    jpe: 'image/jpeg',
    pjpeg: 'image/jpeg',
    pjp: 'image/jpeg',
    webp: 'image/webp',
    gif: 'image/gif',
    bmp: 'image/bmp',
    dib: 'image/bmp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    svgz: 'image/svg+xml',
    ico: 'image/x-icon',
    cur: 'image/x-icon',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    apng: 'image/png'
};

export const RASTER_FORMAT_LABELS = {
    png: 'PNG',
    jpg: 'JPG',
    tga: 'TGA'
};

export function getScaledDimensions(dims, scale) {
    return {
        width: Math.max(1, Math.round(dims.width * (scale / 100))),
        height: Math.max(1, Math.round(dims.height * (scale / 100)))
    };
}

export function getFormatLabel(format) {
    return RASTER_FORMAT_LABELS[format] || String(format || '').toUpperCase();
}

export function supportsAlphaForFormat(format) {
    return format === 'png' || format === 'tga';
}

export function getRasterExtension(format) {
    if (format === 'jpg') return 'jpg';
    if (format === 'tga') return 'tga';
    return 'png';
}

export function getRasterMimeType(format) {
    if (format === 'jpg') return 'image/jpeg';
    if (format === 'tga') return 'image/x-tga';
    return 'image/png';
}

export function getPreserveAlphaForFormat(format, preserveAlpha) {
    return supportsAlphaForFormat(format) ? !!preserveAlpha : false;
}

export function sanitizeFileComponent(value, fallback = 'image') {
    const cleaned = String(value || '')
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '');
    return cleaned || fallback;
}

export function getFileStem(name) {
    return String(name || 'image').replace(/\.[^/.]+$/, '') || 'image';
}

export function getFileExtension(name) {
    return String(name || '').match(/\.([^.]+)$/)?.[1]?.toLowerCase() || '';
}

export function getMimeTypeFromFilename(name) {
    return IMAGE_EXTENSION_MIME_TYPES[getFileExtension(name)] || '';
}

export function getImageFormat(filename, dataUrl) {
    if (filename) {
        const extension = getFileExtension(filename);
        if (extension === 'jpg' || extension === 'jpeg' || extension === 'jfif' || extension === 'jpe' || extension === 'pjpeg' || extension === 'pjp') return 'JPG';
        if (extension === 'svg' || extension === 'svgz') return 'SVG';
        if (extension === 'tif' || extension === 'tiff') return 'TIFF';
        if (extension === 'ico' || extension === 'cur') return 'ICO';
        if (extension) return extension.toUpperCase();
    }

    if (dataUrl && dataUrl.startsWith('data:')) {
        const match = dataUrl.match(/^data:image\/([^;]+)/);
        if (match) {
            if (match[1] === 'jpeg') return 'JPG';
            if (match[1] === 'svg+xml') return 'SVG';
            if (match[1] === 'tiff') return 'TIFF';
            return match[1].toUpperCase();
        }
    }

    return 'Unknown';
}

export function getDataUrlSize(dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return 0;

    const base64Data = dataUrl.split(',')[1];
    if (!base64Data) return 0;

    let size = base64Data.length * 0.75;
    const padding = (base64Data.match(/=/g) || []).length;
    size -= padding;

    return Math.round(size);
}

export function drawImageToCanvas(img) {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return canvas;
}

export function dataUrlToBlob(dataUrl) {
    const parts = dataUrl.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(parts[1]);
    const len = binary.length;
    const u8arr = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        u8arr[i] = binary.charCodeAt(i);
    }
    return new Blob([u8arr], { type: mime });
}

export function pngToJpgDataUrl(pngDataUrl, quality = 0.92) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = pngDataUrl;
    });
}

export function pngDataUrlToTgaBlob(pngDataUrl, includeAlpha) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext('2d');
            if (!includeAlpha) {
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            ctx.drawImage(img, 0, 0);
            const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const hasAlpha = includeAlpha;

            const header = new Uint8Array(18);
            header[2] = 2;
            header[12] = width & 0xff;
            header[13] = (width >> 8) & 0xff;
            header[14] = height & 0xff;
            header[15] = (height >> 8) & 0xff;
            header[16] = hasAlpha ? 32 : 24;
            header[17] = hasAlpha ? (8 | 0x20) : 0x20;

            const pixelSize = hasAlpha ? 4 : 3;
            const imageSize = width * height * pixelSize;
            const pixels = new Uint8Array(imageSize);
            for (let i = 0, p = 0; i < data.length; i += 4, p += pixelSize) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                const a = data[i + 3];
                pixels[p] = b;
                pixels[p + 1] = g;
                pixels[p + 2] = r;
                if (hasAlpha) pixels[p + 3] = a;
            }

            const tgaData = new Uint8Array(header.length + pixels.length);
            tgaData.set(header, 0);
            tgaData.set(pixels, header.length);
            resolve(new Blob([tgaData], { type: 'image/x-tga' }));
        };
        img.onerror = reject;
        img.src = pngDataUrl;
    });
}

export function createRasterCanvasFromSource(source, target, preserveAlpha) {
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d');

    if (!preserveAlpha) {
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, target.width, target.height);
    } else {
        ctx.clearRect(0, 0, target.width, target.height);
    }

    ctx.drawImage(source, 0, 0, target.width, target.height);
    return canvas;
}

export function canvasToBlobAsync(canvas, mimeType, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error(`Failed to render ${mimeType} blob.`));
            }
        }, mimeType, quality);
    });
}

export async function exportCanvasToRasterBlob(canvas, format, preserveAlpha) {
    if (format === 'png') {
        return canvasToBlobAsync(canvas, getRasterMimeType(format));
    }

    if (format === 'jpg') {
        return canvasToBlobAsync(canvas, getRasterMimeType(format), 0.92);
    }

    const pngDataUrl = canvas.toDataURL('image/png');
    return pngDataUrlToTgaBlob(pngDataUrl, preserveAlpha);
}

export async function renderRasterBlobFromSource(source, target, format, preserveAlpha) {
    const canvas = createRasterCanvasFromSource(source, target, preserveAlpha);
    return exportCanvasToRasterBlob(canvas, format, preserveAlpha);
}

export async function estimateRasterBlobSizeFromSource(source, target, format, preserveAlpha) {
    const blob = await renderRasterBlobFromSource(source, target, format, preserveAlpha);
    return blob.size;
}

export function estimateSizeBytes(width, height, format, alpha) {
    if (!width || !height) return 0;
    const channels = alpha ? 4 : 3;
    const rawBytes = width * height * channels;
    let factor = 1;
    if (format === 'png') factor = 0.45;
    if (format === 'jpg') factor = 0.16;
    if (format === 'tga') factor = 1.0;
    return Math.max(1, Math.round(rawBytes * factor));
}

export function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const kb = bytes / 1024;
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    const mb = kb / 1024;
    return `${mb.toFixed(1)} MB`;
}

export function getBulkRelativePath(file) {
    return file.webkitRelativePath || file.name;
}

export function getBulkFolderName(files) {
    const firstPath = files.find(file => file.webkitRelativePath)?.webkitRelativePath;
    if (!firstPath) return 'Selected Folder';
    return firstPath.split('/')[0] || 'Selected Folder';
}

export function getSortedBulkFiles(files) {
    return [...files].sort((a, b) => getBulkRelativePath(a).localeCompare(getBulkRelativePath(b)));
}

function resolveSupportedExtensions(candidate, fallback) {
    return candidate instanceof Set ? candidate : fallback;
}

export function isImportableImageFile(file, supportedExtensions = IMPORTABLE_IMAGE_EXTENSIONS) {
    const extensionSet = resolveSupportedExtensions(supportedExtensions, IMPORTABLE_IMAGE_EXTENSIONS);
    const mimeType = String(file?.type || '').toLowerCase();
    if (mimeType.startsWith('image/')) return true;
    return extensionSet.has(getFileExtension(file?.name));
}

export function isSupportedBulkFile(file) {
    return isImportableImageFile(file, BULK_SUPPORTED_EXTENSIONS);
}

export function normalizeImageBlob(blob, filename = '') {
    const existingType = String(blob?.type || '').toLowerCase();
    if (existingType.startsWith('image/')) {
        return blob;
    }

    const fallbackType = getMimeTypeFromFilename(filename);
    if (!fallbackType) {
        return blob;
    }

    return new Blob([blob], { type: fallbackType });
}

export function loadImageMetricsFromFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(normalizeImageBlob(file, file.name));
        const img = new Image();
        img.onload = () => {
            const width = img.naturalWidth || img.width;
            const height = img.naturalHeight || img.height;
            URL.revokeObjectURL(url);
            resolve({ width, height });
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(`Failed to load ${file.name}`));
        };
        img.src = url;
    });
}

export function loadImageElementFromFile(file) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(normalizeImageBlob(file, file.name));
        const img = new Image();
        img.onload = () => resolve({
            img,
            cleanup: () => URL.revokeObjectURL(url)
        });
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error(`Failed to load ${file.name}`));
        };
        img.src = url;
    });
}
