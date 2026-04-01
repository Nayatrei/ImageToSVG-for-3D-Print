/**
 * Converts an SVG string to a PNG data URL.
 *
 * @param {string} svgString
 * @param {number|null} maxSize - overrides the preview resolution selector
 * @param {{ width: number, height: number }|null} fixedSize - forces exact canvas dimensions
 * @param {boolean} preserveAlpha - if false, fills canvas with white before drawing
 * @param {HTMLSelectElement|null} previewResolutionEl - the resolution <select> element
 * @returns {Promise<string>} PNG data URL
 */
export function svgToPng(svgString, maxSize = null, fixedSize = null, preserveAlpha = false, previewResolutionEl = null) {
    return new Promise((resolve, reject) => {
        const selectedRes = maxSize || parseInt(previewResolutionEl?.value || '512', 10);
        const maxWidth = selectedRes;
        const maxHeight = selectedRes;

        const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();

        img.onload = () => {
            try {
                let width, height;
                if (fixedSize && fixedSize.width && fixedSize.height) {
                    width = fixedSize.width;
                    height = fixedSize.height;
                } else {
                    width = img.width || img.naturalWidth;
                    height = img.height || img.naturalHeight;
                    const aspectRatio = width / height;

                    if (width > height) {
                        if (width < maxWidth) { width = maxWidth; height = width / aspectRatio; }
                        if (width > maxWidth) { width = maxWidth; height = width / aspectRatio; }
                    } else {
                        if (height < maxHeight) { height = maxHeight; width = height * aspectRatio; }
                        if (height > maxHeight) { height = maxHeight; width = height * aspectRatio; }
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;

                const ctx = canvas.getContext('2d', { alpha: true });
                if (!preserveAlpha) {
                    ctx.fillStyle = 'white';
                    ctx.fillRect(0, 0, width, height);
                } else {
                    ctx.clearRect(0, 0, width, height);
                }
                ctx.drawImage(img, 0, 0, width, height);

                URL.revokeObjectURL(url);
                resolve(canvas.toDataURL('image/png'));
            } catch (error) {
                URL.revokeObjectURL(url);
                reject(error);
            }
        };

        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error('Failed to load SVG'));
        };

        img.src = url;
    });
}
