import { TRANSPARENT_ALPHA_CUTOFF } from '../config.js';

/**
 * Returns true if any pixel in imageData has alpha <= TRANSPARENT_ALPHA_CUTOFF.
 */
export function hasTransparentPixels(imageData) {
    const data = imageData.data;
    for (let i = 3; i < data.length; i += 4) {
        if (data[i] <= TRANSPARENT_ALPHA_CUTOFF) return true;
    }
    return false;
}

/**
 * Marks pixels in quantizedData that are transparent in the original imageData.
 */
export function markTransparentPixels(quantizedData, imageData) {
    const width = imageData.width;
    const height = imageData.height;
    const data = imageData.data;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const idx = (y * width + x) * 4;
            const alpha = data[idx + 3];
            if (alpha <= TRANSPARENT_ALPHA_CUTOFF) {
                quantizedData.array[y + 1][x + 1] = -1;
            }
        }
    }
}

/**
 * Removes transparent colors from the quantized palette and remaps indices.
 * Returns true if any colors were removed.
 */
export function stripTransparentPalette(quantizedData) {
    if (!quantizedData || !Array.isArray(quantizedData.palette) || !Array.isArray(quantizedData.array)) {
        return false;
    }

    const mapping = new Array(quantizedData.palette.length).fill(-1);
    const newPalette = [];

    quantizedData.palette.forEach((color, index) => {
        const alpha = Number.isFinite(color.a) ? color.a : 255;
        if (alpha <= TRANSPARENT_ALPHA_CUTOFF) {
            mapping[index] = -1;
        } else {
            mapping[index] = newPalette.length;
            newPalette.push({ r: color.r, g: color.g, b: color.b, a: 255 });
        }
    });

    if (newPalette.length === quantizedData.palette.length) return false;

    for (let y = 0; y < quantizedData.array.length; y++) {
        const row = quantizedData.array[y];
        for (let x = 0; x < row.length; x++) {
            const idx = row[x];
            if (idx >= 0) {
                row[x] = mapping[idx];
            }
        }
    }

    quantizedData.palette = newPalette;
    return true;
}
