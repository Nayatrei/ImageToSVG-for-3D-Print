// HEIC/HEIF decoding for iPhone photos.
//
// No browser decodes HEIC natively outside Safari, so this wraps the vendored
// libheif WebAssembly build (vendor/heic/libheif-bundle.mjs). That bundle is
// ~1.4 MB, so it is *only* pulled in by the first decodeHeicToCanvas call —
// importing this module costs nothing until a HEIC file actually shows up.

const HEIC_MIME_TYPES = new Set([
    'image/heic',
    'image/heif',
    'image/heic-sequence',
    'image/heif-sequence',
    'image/heix',
    'image/heim',
    'image/heis',
    'image/hevc',
    'image/hevx'
]);

const HEIC_EXTENSIONS = new Set([
    'heic',
    'heif',
    'heics',
    'heifs',
    'hif'
]);

let libheifPromise = null;

function getExtension(name) {
    return String(name || '').match(/\.([^.\\/]+)$/)?.[1]?.toLowerCase() || '';
}

/**
 * True when the file looks like HEIC/HEIF.
 *
 * Browsers frequently hand back an empty `type` for HEIC (Chrome and Firefox on
 * every platform, and Safari for files copied off a device), so the extension
 * check is the primary signal rather than a fallback.
 */
export function isHeicFile(file) {
    if (!file) return false;
    const mimeType = String(file.type || '').toLowerCase().split(';')[0].trim();
    if (mimeType && HEIC_MIME_TYPES.has(mimeType)) return true;
    return HEIC_EXTENSIONS.has(getExtension(file.name));
}

/**
 * Lazily loads (and then caches) the vendored libheif module.
 * A failed load clears the cache so the next drop can retry.
 */
async function getLibheif() {
    if (!libheifPromise) {
        libheifPromise = import('../../vendor/heic/libheif-bundle.mjs?v=r-78ade4c03db6e3a2')
            .then((module) => (module.default || module)())
            .catch((error) => {
                libheifPromise = null;
                throw new Error(`Could not load the HEIC decoder. ${error?.message || error}`);
            });
    }
    return libheifPromise;
}

function releaseImages(images) {
    if (!Array.isArray(images)) return;
    images.forEach((image) => {
        try {
            image?.free?.();
        } catch {
            // Freeing is best effort; a failure here must not mask a decode result.
        }
    });
}

/**
 * Decodes the primary image of a HEIC/HEIF file onto a canvas.
 *
 * @param {File|Blob} file
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function decodeHeicToCanvas(file) {
    if (!file) throw new Error('Could not decode HEIC file: no file was provided.');
    const label = file.name || 'image';

    let buffer;
    try {
        buffer = new Uint8Array(await file.arrayBuffer());
    } catch (error) {
        throw new Error(`Could not decode HEIC file "${label}": the file could not be read. ${error?.message || error}`);
    }
    if (!buffer.length) {
        throw new Error(`Could not decode HEIC file "${label}": the file is empty.`);
    }

    const libheif = await getLibheif();

    let images = null;
    try {
        images = new libheif.HeifDecoder().decode(buffer);
    } catch (error) {
        throw new Error(`Could not decode HEIC file "${label}". ${error?.message || error}`);
    }

    if (!images?.length) {
        throw new Error(`Could not decode HEIC file "${label}": no image was found inside it.`);
    }

    try {
        // A HEIC container can hold a burst or a live-photo sequence; the first
        // entry is the primary image, which is what every caller here wants.
        const primary = images[0];
        const width = primary.get_width();
        const height = primary.get_height();
        if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
            throw new Error('the image reported no usable dimensions.');
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext('2d');
        if (!context) {
            throw new Error('this browser did not provide a 2D canvas context.');
        }

        const imageData = context.createImageData(width, height);
        await new Promise((resolve, reject) => {
            primary.display(imageData, (displayed) => {
                if (displayed) resolve(displayed);
                else reject(new Error('libheif returned no pixel data.'));
            });
        });

        context.putImageData(imageData, 0, 0);
        return canvas;
    } catch (error) {
        const detail = error?.message || String(error);
        throw new Error(
            detail.startsWith('Could not decode HEIC file')
                ? detail
                : `Could not decode HEIC file "${label}": ${detail}`
        );
    } finally {
        releaseImages(images);
    }
}

/**
 * Convenience wrapper: decodes a HEIC/HEIF file straight to an encodable blob.
 *
 * @param {File|Blob} file
 * @param {string} [type] Any mime type this browser's canvas can encode.
 * @returns {Promise<Blob>}
 */
export async function decodeHeicToBlob(file, type = 'image/png', quality) {
    const canvas = await decodeHeicToCanvas(file);
    const label = file?.name || 'image';
    try {
        return await new Promise((resolve, reject) => {
            canvas.toBlob(
                (blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error(`Could not decode HEIC file "${label}": this browser could not encode ${type}.`));
                },
                type,
                quality
            );
        });
    } finally {
        canvas.width = 0;
        canvas.height = 0;
    }
}
