/**
 * HTML Logo Editor feature for the Logo tab.
 *
 * Provides:
 *   - HTML_PRESETS: preset snippet strings
 *   - sanitizeHtml: strips unsafe markup
 *   - renderHtmlToDataUrl: renders HTML snippet to a PNG data URL via SVG foreignObject
 *   - createHtmlEditor: factory that returns the stateful editor controller
 */

export const HTML_PRESETS = {
    pill: `<div style="
  display:inline-flex; align-items:center; justify-content:center;
  padding:18px 48px; border-radius:999px;
  background:linear-gradient(135deg,#6366f1,#8b5cf6);
  font-family:system-ui,sans-serif; font-size:28px; font-weight:700;
  color:#fff; letter-spacing:0.01em; white-space:nowrap;">
  My Brand
</div>`,
    badge: `<div style="
  display:inline-flex; flex-direction:column; align-items:center; justify-content:center;
  width:200px; height:200px; border-radius:24px;
  background:#1e293b; border:3px solid #6366f1;
  font-family:system-ui,sans-serif; gap:8px;">
  <span style="font-size:64px;">🚀</span>
  <span style="font-size:20px; font-weight:700; color:#e2e8f0;">LAUNCH</span>
</div>`,
    cta: `<div style="
  display:inline-flex; align-items:center; justify-content:center;
  padding:20px 52px; border-radius:12px;
  background:#f59e0b; box-shadow:0 4px 24px rgba(245,158,11,0.5);
  font-family:system-ui,sans-serif; font-size:26px; font-weight:800;
  color:#1c1917; letter-spacing:0.02em; white-space:nowrap;">
  GET STARTED →
</div>`
};

/**
 * Strips script elements and dangerous attributes from raw HTML.
 * @param {string} raw
 * @returns {string} sanitized innerHTML
 */
export function sanitizeHtml(raw) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, 'text/html');
    doc.querySelectorAll('script').forEach(el => el.remove());
    const FORBIDDEN_ATTRS = /^on|^srcdoc$/i;
    const JS_PROTO = /^\s*javascript\s*:/i;
    doc.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(attr => {
            if (FORBIDDEN_ATTRS.test(attr.name)) {
                el.removeAttribute(attr.name);
            } else if (
                (attr.name === 'href' || attr.name === 'src' || attr.name === 'action') &&
                JS_PROTO.test(attr.value)
            ) {
                el.removeAttribute(attr.name);
            }
        });
    });
    return doc.body.innerHTML;
}

/**
 * Scans imageData for the bounding box of non-transparent pixels.
 * @param {ImageData} imageData
 * @returns {{ minX, minY, maxX, maxY } | null}
 */
function findContentBounds(imageData) {
    const { data, width, height } = imageData;
    let minX = width, minY = height, maxX = -1, maxY = -1;

    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            if (data[(y * width + x) * 4 + 3] > 10) {
                if (x < minX) minX = x;
                if (x > maxX) maxX = x;
                if (y < minY) minY = y;
                if (y > maxY) maxY = y;
            }
        }
    }

    return maxX >= minX ? { minX, minY, maxX, maxY } : null;
}

/**
 * Populates a <select> with system fonts via the Font Access API,
 * falling back silently to a curated cross-platform list.
 * @param {HTMLSelectElement} selectEl
 */
async function loadSystemFonts(selectEl) {
    if (!selectEl) return;

    // Broad fallback covering common fonts across macOS, Windows, Linux, and
    // popular Adobe / Google / Microsoft / Apple font collections.
    // The Font Access API (queryLocalFonts) supersedes this list when available
    // and returns the full set of every font actually installed on the machine.
    const FALLBACK = [
        // ── Core web / system ────────────────────────────────────────────────
        'Arial', 'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold',
        'Calibri', 'Cambria', 'Cambria Math', 'Candara', 'Carlito',
        'Comic Sans MS', 'Constantia', 'Corbel', 'Courier New',
        'Franklin Gothic Medium', 'Georgia', 'Impact',
        'Lucida Console', 'Lucida Grande', 'Lucida Sans',
        'Lucida Sans Typewriter', 'Lucida Sans Unicode',
        'Microsoft Sans Serif', 'Palatino', 'Palatino Linotype',
        'Segoe Print', 'Segoe Script', 'Segoe UI', 'Segoe UI Black',
        'Segoe UI Emoji', 'Segoe UI Historic', 'Segoe UI Symbol',
        'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana',
        // ── macOS / Apple ────────────────────────────────────────────────────
        '-apple-system', 'American Typewriter', 'Andale Mono', 'Apple Chancery',
        'Apple Color Emoji', 'Apple SD Gothic Neo', 'Apple Symbols',
        'Avenir', 'Avenir Next', 'Avenir Next Condensed',
        'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bodoni 72 Oldstyle',
        'Bodoni 72 Smallcaps', 'Bradley Hand', 'Brush Script MT',
        'Chalkboard', 'Chalkboard SE', 'Chalkduster', 'Charter',
        'Cochin', 'Comic Sans MS', 'Copperplate', 'Courier',
        'DIN Alternate', 'DIN Condensed', 'Damascus', 'Didot',
        'Diwan Mishafi', 'Euphemia UCAS', 'Farah', 'Futura',
        'Geneva', 'Gill Sans', 'Gill Sans MT', 'Gujarati Sangam MN',
        'Gurmukhi MN', 'Helvetica', 'Helvetica Neue', 'Herculanum',
        'Hiragino Kaku Gothic Pro', 'Hiragino Kaku Gothic ProN',
        'Hiragino Mincho Pro', 'Hiragino Mincho ProN',
        'Hiragino Sans', 'Hoefler Text', 'ITF Devanagari',
        'Kailasa', 'Kannada Sangam MN', 'Kefa', 'Khmer Sangam MN',
        'Kohinoor Bangla', 'Kohinoor Devanagari', 'Kohinoor Telugu',
        'Lao Sangam MN', 'Lucida Grande', 'Luminari', 'Malayalam Sangam MN',
        'Marion', 'Marker Felt', 'Menlo', 'Monaco',
        'Mshtakan', 'Mukta Mahee', 'Myanmar Sangam MN',
        'Noteworthy', 'Noto Nastaliq Urdu', 'Optima',
        'Oriya Sangam MN', 'Palatino', 'Papyrus', 'Party LET',
        'Phosphate', 'PingFang HK', 'PingFang SC', 'PingFang TC',
        'Plantagenet Cherokee', 'PT Mono', 'PT Sans', 'PT Sans Caption',
        'PT Sans Narrow', 'PT Serif', 'PT Serif Caption',
        'Rockwell', 'San Francisco', 'Savoye LET', 'SignPainter',
        'Silom', 'Sinhala Sangam MN', 'Skia', 'Snell Roundhand',
        'Sukhumvit Set', 'Superclarendon', 'Symbol',
        'Tamil Sangam MN', 'Telugu Sangam MN', 'Thonburi',
        'Times', 'Trattatello', 'Trebuchet MS', 'Waseem',
        'Zapf Chancery', 'Zapfino', 'System Font',
        // ── Windows / Microsoft Office ───────────────────────────────────────
        'Bahnschrift', 'Book Antiqua', 'Bookman Old Style',
        'Bookshelf Symbol 7', 'Calibri Light', 'Californian FB',
        'Calisto MT', 'Cambria Math', 'Cascadia Code', 'Cascadia Mono',
        'Castellar', 'Centaur', 'Century', 'Century Gothic',
        'Century Schoolbook', 'Colonna MT', 'Cooper Black',
        'Copperplate Gothic Bold', 'Copperplate Gothic Light',
        'Curlz MT', 'Dubai', 'Ebrima', 'Engravers MT',
        'Eras Bold ITC', 'Eras Demi ITC', 'Eras Light ITC',
        'Eras Medium ITC', 'Estrangelo Edessa', 'Euphemia',
        'Felix Titling', 'Footlight MT Light', 'Forte',
        'Franklin Gothic Book', 'Franklin Gothic Demi',
        'Franklin Gothic Demi Cond', 'Franklin Gothic Heavy',
        'Franklin Gothic Medium Cond', 'Freestyle Script',
        'French Script MT', 'Gabriola', 'Gadugi', 'Garamond',
        'Gill Sans MT', 'Gill Sans MT Condensed', 'Gill Sans MT Ext Condensed Bold',
        'Gill Sans Ultra Bold', 'Gill Sans Ultra Bold Condensed',
        'Gloucester MT Extra Condensed', 'Goudy Old Style',
        'Goudy Stout', 'Haettenschweiler', 'Harlow Solid Italic',
        'Harrington', 'High Tower Text', 'HoloLens MDL2 Assets',
        'Imprint MT Shadow', 'Informal Roman', 'Ink Free',
        'Javanese Text', 'Jokerman', 'Juice ITC', 'Kristen ITC',
        'Kunstler Script', 'Lao UI', 'Leelawadee', 'Leelawadee UI',
        'Leelawadee UI Semilight', 'Lucida Bright', 'Lucida Calligraphy',
        'Lucida Fax', 'Lucida Handwriting', 'Lucida Sans Typewriter',
        'Magneto', 'Maiandra GD', 'Malgun Gothic', 'Malgun Gothic Semilight',
        'Mangal', 'Marlett', 'Matura MT Script Capitals',
        'MeiryoUI', 'Meiryo', 'Microsoft Himalaya', 'Microsoft JhengHei',
        'Microsoft JhengHei UI', 'Microsoft New Tai Lue', 'Microsoft PhagsPa',
        'Microsoft Sans Serif', 'Microsoft Tai Le', 'Microsoft Uighur',
        'Microsoft YaHei', 'Microsoft YaHei UI', 'Microsoft Yi Baiti',
        'MingLiU-ExtB', 'Mistral', 'Modern No. 20', 'Mongolian Baiti',
        'Monotype Corsiva', 'MS Gothic', 'MS Mincho', 'MS PGothic',
        'MS PMincho', 'MS Reference Sans Serif', 'MS Reference Specialty',
        'MS UI Gothic', 'MT Extra', 'MV Boli', 'Myanmar Text',
        'Niagara Engraved', 'Niagara Solid', 'Nirmala UI',
        'NSimSun', 'OCR A Extended', 'Old English Text MT',
        'Onyx', 'Palace Script MT', 'Papyrus', 'Parchment',
        'Perpetua', 'Perpetua Titling MT', 'Playbill', 'PMingLiU-ExtB',
        'Poor Richard', 'Pristina', 'Rage Italic', 'Ravie',
        'Rockwell Condensed', 'Rockwell Extra Bold', 'Script MT Bold',
        'Showcard Gothic', 'SimSun-ExtB', 'Sitka', 'Snap ITC',
        'Stencil', 'Stop', 'Sylfaen', 'Symbol',
        'Tempus Sans ITC', 'Tw Cen MT', 'Tw Cen MT Condensed',
        'Tw Cen MT Condensed Extra Bold', 'Viner Hand ITC', 'Vivaldi',
        'Vladimir Script', 'Wide Latin', 'Wingdings', 'Wingdings 2',
        'Wingdings 3', 'Yu Gothic', 'Yu Gothic UI', 'Yu Mincho',
        // ── Common Adobe / creative fonts ────────────────────────────────────
        'Adobe Garamond Pro', 'Adobe Caslon Pro', 'Minion Pro',
        'Myriad Pro', 'Source Code Pro', 'Source Han Sans',
        'Source Han Serif', 'Source Sans Pro', 'Source Serif Pro',
        // ── Common Linux / open-source fonts ─────────────────────────────────
        'DejaVu Sans', 'DejaVu Sans Mono', 'DejaVu Serif',
        'Droid Sans', 'Droid Serif', 'FreeSerif', 'FreeSans', 'FreeMono',
        'Liberation Mono', 'Liberation Sans', 'Liberation Serif',
        'Linux Biolinum O', 'Linux Libertine O',
        'Noto Mono', 'Noto Sans', 'Noto Serif',
        'Open Sans', 'Roboto', 'Ubuntu', 'Ubuntu Mono',
    ].sort();

    const populate = (families) => {
        // Clear all options except the first placeholder
        while (selectEl.options.length > 1) selectEl.remove(1);
        families.forEach(family => {
            const opt = document.createElement('option');
            opt.value = family;
            opt.textContent = family;
            selectEl.appendChild(opt);
        });
    };

    // Populate with fallback immediately so the dropdown is usable right away
    populate(FALLBACK);

    // Attempt to upgrade to the full system font list via Font Access API
    try {
        if (typeof window.queryLocalFonts === 'function') {
            const fonts = await window.queryLocalFonts();
            const families = [...new Set(fonts.map(f => f.family))].sort();
            if (families.length > 0) populate(families);
        }
    } catch (_) { /* permission denied or unsupported — fallback stays */ }
}

/**
 * Renders an HTML snippet to a content-bounds-cropped transparent PNG data URL
 * using SVG foreignObject. Uses a FileReader data URI to avoid canvas taint.
 * @param {string} html
 * @param {string} [font] - optional font-family override applied to all elements
 * @returns {Promise<string>} PNG data URL
 */
export function renderHtmlToDataUrl(html, font = '') {
    return new Promise((resolve, reject) => {
        const CANVAS_SIZE = 2048;
        const PADDING = 24;
        const clean = sanitizeHtml(html);

        // Strip visual effects (shadows, filters) that produce gradient artifacts in tracing.
        // Font override is applied on top.
        const safeFontName = font.replace(/['"]/g, '');
        const safeCss = [
            'box-shadow:none!important',
            'text-shadow:none!important',
            'filter:none!important',
            'backdrop-filter:none!important',
            '-webkit-filter:none!important',
            ...(safeFontName ? [`font-family:"${safeFontName}",system-ui,sans-serif!important`] : [])
        ].join(';');
        const fontPrefix = `<style xmlns="http://www.w3.org/1999/xhtml">*,*::before,*::after{${safeCss}}</style>`;

        // Transparent, large container — content renders top-left, we crop after
        const containerStyle = [
            `width:${CANVAS_SIZE}px`, `height:${CANVAS_SIZE}px`,
            `margin:0`, `padding:${PADDING}px`,
            `display:flex`, `align-items:flex-start`, `justify-content:flex-start`,
            `background:transparent`, `overflow:visible`, `box-sizing:border-box`
        ].join(';');

        const svgMarkup =
            `<?xml version="1.0" encoding="UTF-8"?>` +
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}">` +
            `<foreignObject x="0" y="0" width="${CANVAS_SIZE}" height="${CANVAS_SIZE}">` +
            `<div xmlns="http://www.w3.org/1999/xhtml" style="${containerStyle}">` +
            `${fontPrefix}${clean}` +
            `</div>` +
            `</foreignObject>` +
            `</svg>`;

        const blob = new Blob([svgMarkup], { type: 'image/svg+xml;charset=utf-8' });
        const reader = new FileReader();
        const timeout = setTimeout(() => reject(new Error('Render timeout')), 8000);

        reader.onload = (ev) => {
            const dataUri = ev.target.result;
            const img = new Image();
            img.onload = () => {
                clearTimeout(timeout);
                try {
                    const canvas = document.createElement('canvas');
                    canvas.width = CANVAS_SIZE;
                    canvas.height = CANVAS_SIZE;
                    const ctx = canvas.getContext('2d');
                    // No fillRect — keep alpha channel transparent
                    ctx.drawImage(img, 0, 0, CANVAS_SIZE, CANVAS_SIZE);

                    let imageData;
                    try {
                        imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
                    } catch (_) {
                        // Canvas tainted (browser security) — fall back to full canvas
                        resolve(canvas.toDataURL('image/png'));
                        return;
                    }

                    const bounds = findContentBounds(imageData);
                    if (!bounds) {
                        resolve(canvas.toDataURL('image/png'));
                        return;
                    }

                    // Crop to content bounds (bounds already include the PADDING offset)
                    const pad = PADDING;
                    const x = Math.max(0, bounds.minX - pad);
                    const y = Math.max(0, bounds.minY - pad);
                    const w = Math.min(CANVAS_SIZE - x, bounds.maxX - x + pad * 2);
                    const h = Math.min(CANVAS_SIZE - y, bounds.maxY - y + pad * 2);

                    const cropped = document.createElement('canvas');
                    cropped.width = w;
                    cropped.height = h;
                    cropped.getContext('2d').drawImage(canvas, x, y, w, h, 0, 0, w, h);
                    resolve(cropped.toDataURL('image/png'));
                } catch (err) {
                    reject(err);
                }
            };
            img.onerror = () => { clearTimeout(timeout); reject(new Error('Render failed')); };
            img.src = dataUri;
        };
        reader.onerror = () => { clearTimeout(timeout); reject(new Error('Read failed')); };
        reader.readAsDataURL(blob);
    });
}

/**
 * Factory for the stateful HTML editor controller.
 *
 * @param {object} ls  - logo-tab local state
 * @param {object} le  - logo-tab local elements
 * @param {object} elements - global elements (for sourceImage access when leaving HTML mode)
 * @param {function} syncWorkspaceView
 * @param {function} analyzeColorsClick - triggers full re-analysis after render
 *
 * @returns {{ setHtmlStatus, triggerHtmlRender, scheduleHtmlRender, onHtmlRendered, setHtmlMode }}
 */
export function createHtmlEditor({ ls, le, elements, syncWorkspaceView, analyzeColorsClick }) {

    function setHtmlStatus(text, isError = false) {
        if (!le.htmlStatus) return;
        le.htmlStatus.textContent = text;
        le.htmlStatus.style.color = isError ? '#f87171' : '#9ca3af';
    }

    async function triggerHtmlRender() {
        const html = le.htmlInput ? le.htmlInput.value.trim() : '';
        if (!html) {
            setHtmlStatus('');
            return;
        }
        setHtmlStatus('Rendering…');
        try {
            const font = le.htmlFontSelect ? le.htmlFontSelect.value : '';
            const dataUrl = await renderHtmlToDataUrl(html, font);
            await onHtmlRendered(dataUrl);
            setHtmlStatus('Ready');
        } catch (err) {
            setHtmlStatus('Render failed', true);
            console.warn('HTML logo render error:', err);
        }
    }

    function scheduleHtmlRender() {
        clearTimeout(ls.htmlRenderTimer);
        ls.htmlRenderTimer = setTimeout(triggerHtmlRender, 400);
    }

    async function onHtmlRendered(dataUrl) {
        if (!le.htmlSourceImg) return;

        await new Promise((resolve, reject) => {
            le.htmlSourceImg.onload = resolve;
            le.htmlSourceImg.onerror = reject;
            le.htmlSourceImg.src = dataUrl;
        });
        ls.htmlModeActive = true;
        if (le.svgSourceMirror) {
            le.svgSourceMirror.src = dataUrl;
            le.svgSourceMirror.style.display = '';
        }
        const w = le.htmlSourceImg.naturalWidth;
        const h = le.htmlSourceImg.naturalHeight;
        if (le.originalResolution) le.originalResolution.textContent = `${w}×${h} px`;
        ls.colorsAnalyzed = false;
        ls.layerThicknessById = {};
        await analyzeColorsClick();

        // Scroll the compare panels into view so the result is visible without manual scrolling
        le.svgSourceMirror?.closest('.svg-compare-grid')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function setHtmlMode(active) {
        ls.htmlModeActive = active;
        if (le.htmlModeToggle) {
            le.htmlModeToggle.textContent = active ? 'Switch to Image Mode' : 'Switch to HTML Mode';
        }
        if (!active && elements.sourceImage?.src) {
            if (le.svgSourceMirror) le.svgSourceMirror.src = elements.sourceImage.src;
        }
        syncWorkspaceView();
    }

    // Load system fonts into the dropdown
    loadSystemFonts(le.htmlFontSelect);

    // Re-render when font changes
    if (le.htmlFontSelect) {
        le.htmlFontSelect.addEventListener('change', () => {
            if (le.htmlInput?.value.trim()) scheduleHtmlRender();
        });
    }

    return { setHtmlStatus, triggerHtmlRender, scheduleHtmlRender, onHtmlRendered, setHtmlMode };
}
