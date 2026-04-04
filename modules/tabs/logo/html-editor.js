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
  padding:16px 38px; border-radius:999px;
  background-color:#5865f2;
  font-family:system-ui,sans-serif; font-size:24px; font-weight:800;
  color:#f8fafc; letter-spacing:0.08em; text-transform:uppercase; white-space:nowrap;">
  My Brand
</div>`,
    badge: `<div style="
  display:inline-flex; flex-direction:column; align-items:center; justify-content:center;
  width:200px; height:200px; border-radius:24px;
  background-color:#1e293b; border:4px solid #818cf8;
  font-family:system-ui,sans-serif; gap:14px;">
  <div style="
    width:72px; height:72px; border-radius:999px;
    display:flex; align-items:center; justify-content:center;
    background-color:#818cf8;
    color:#111827; font-size:38px; font-weight:900; line-height:1;">
    G
  </div>
  <span style="font-size:22px; font-weight:800; color:#e2e8f0; letter-spacing:0.12em;">LAUNCH</span>
</div>`,
    cta: `<div style="
  display:inline-flex; align-items:center; justify-content:center;
  padding:18px 32px; border-radius:12px;
  background-color:#f59e0b;
  font-family:system-ui,sans-serif; font-size:22px; font-weight:800;
  color:#1c1917; letter-spacing:0.02em; white-space:nowrap;">
  GET STARTED →
</div>`
};
export const HTML_RENDER_SCALE = 4;

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
    // SVG foreignObject is loaded as strict XML (not HTML) when rendered via img.src.
    // HTML void elements like <br>, <img>, <hr> must be self-closed (<br/>) or the
    // XML parser rejects the entire SVG, causing a silent render failure.
    const HTML_VOID_RE = /<(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)(\s[^>]*)?>/gi;
    return doc.body.innerHTML.replace(HTML_VOID_RE, (_, tag, attrs) => `<${tag}${attrs || ''}/>`);
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

const HTML_COLOR_TOKEN_RE = /#(?:[\da-f]{3,8})\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi;
const HTML_COLOR_STYLE_PROPS = [
    'color',
    'backgroundColor',
    'borderColor',
    'borderTopColor',
    'borderRightColor',
    'borderBottomColor',
    'borderLeftColor',
    'outlineColor',
    'fill',
    'stroke'
];

const FONT_GROUP_LABELS = {
    installed: 'Installed (encoding unknown)',
    latin: 'Latin / General',
    mono: 'Monospace',
    arabic: 'Arabic / Persian',
    hebrew: 'Hebrew',
    indic: 'Indic',
    sea: 'SE Asian',
    korean: '한국어 Korean',
    japanese: '日本語 Japanese',
    chinese: '中文 Chinese',
    cjk: 'CJK (multi-script)',
    symbols: 'Symbols / Emoji'
};

const FONT_GROUP_ORDER = ['installed', 'latin', 'mono', 'arabic', 'hebrew', 'indic', 'sea', 'korean', 'japanese', 'chinese', 'cjk', 'symbols'];

let colorProbeCtx = null;

function getColorProbeCtx() {
    if (!colorProbeCtx) {
        const canvas = document.createElement('canvas');
        canvas.width = 1;
        canvas.height = 1;
        colorProbeCtx = canvas.getContext('2d', { willReadFrequently: true });
    }
    return colorProbeCtx;
}

function normalizeCssColorToken(value) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;

    const probe = document.createElement('span');
    probe.style.color = '';
    probe.style.color = trimmed;
    if (!probe.style.color) return null;

    const ctx = getColorProbeCtx();
    if (!ctx) return null;

    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = probe.style.color;
    ctx.fillRect(0, 0, 1, 1);

    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (a === 0) return null;
    return { r, g, b, a };
}

export function extractDeclaredHtmlColors(raw) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(sanitizeHtml(raw || ''), 'text/html');
    const seen = new Map();

    doc.querySelectorAll('[style]').forEach((el) => {
        const rawStyle = el.getAttribute('style') || '';
        const tokens = new Set(rawStyle.match(HTML_COLOR_TOKEN_RE) || []);

        HTML_COLOR_STYLE_PROPS.forEach((prop) => {
            const value = el.style[prop];
            if (value) tokens.add(value);
        });

        tokens.forEach((token) => {
            const color = normalizeCssColorToken(token);
            if (!color) return;
            seen.set(`${color.r},${color.g},${color.b}`, {
                r: color.r,
                g: color.g,
                b: color.b,
                a: 255
            });
        });
    });

    return [...seen.values()];
}

function inferFontGroup(family) {
    const name = family.toLowerCase();

    if (/emoji|wingdings|bookshelf symbol|marlett|symbol/.test(name)) return 'symbols';
    if (/mono|code|console|courier|typewriter|menlo|monaco|ocr a|cascadia/.test(name)) return 'mono';
    if (/arab|nastaliq|uighur|waseem|farah|dubai|mishafi/.test(name)) return 'arabic';
    if (/hebrew/.test(name)) return 'hebrew';
    if (/devanagari|bangla|gujarati|gurmukhi|kannada|malayalam|oriya|sinhala|tamil|telugu|mangal|nirmala|sangam|kohinoor|mukta/.test(name)) return 'indic';
    if (/khmer|lao|myanmar|thonburi|sukhumvit|silom/.test(name)) return 'sea';
    if (/malgun|apple sd gothic neo|nanum|noto sans kr|noto serif kr|spoqa|나눔|본고딕|kopub|sandoll|gmarket|uhbee|bm /.test(name)) return 'korean';
    if (/hiragino|meiryo|ms gothic|ms mincho|ms pgothic|ms pmincho|yu gothic|yu mincho|osaka|noto sans jp|noto serif jp|biz ud/.test(name)) return 'japanese';
    if (/pingfang|microsoft jhenghei|microsoft yahei|mingliu|nsimsun|simsun|noto sans sc|noto sans tc|noto serif sc|noto serif tc/.test(name)) return 'chinese';
    if (/source han|baiti/.test(name)) return 'cjk';
    return 'latin';
}

function populateGroupedFontSelect(selectEl, fallbackEntries, installedFamilies = []) {
    const previousValue = selectEl.value;
    const placeholder = selectEl.options[0]?.cloneNode(true) || new Option('— default —', '');

    selectEl.innerHTML = '';
    selectEl.appendChild(placeholder);

    const installedSet = new Set(installedFamilies.map((family) => family.toLowerCase()));
    const groups = new Map();

    if (installedFamilies.length) {
        installedFamilies.forEach((family) => {
            const inferred = inferFontGroup(family);
            // Only put in 'installed' when we have no script-specific knowledge (inferred as latin)
            const targetGroup = inferred === 'latin' ? 'installed' : inferred;
            const items = groups.get(targetGroup) || [];
            items.push({ family, group: targetGroup });
            groups.set(targetGroup, items);
        });
    }

    fallbackEntries.forEach((entry) => {
        if (installedSet.has(entry.family.toLowerCase())) return;
        const items = groups.get(entry.group) || [];
        items.push(entry);
        groups.set(entry.group, items);
    });

    FONT_GROUP_ORDER.forEach((groupKey) => {
        const entries = groups.get(groupKey);
        if (!entries?.length) return;

        const optgroup = document.createElement('optgroup');
        optgroup.label = FONT_GROUP_LABELS[groupKey];

        entries.forEach((entry) => {
            const opt = document.createElement('option');
            opt.value = entry.family;
            opt.textContent = entry.family;
            optgroup.appendChild(opt);
        });

        selectEl.appendChild(optgroup);
    });

    if (previousValue && [...selectEl.options].some((option) => option.value === previousValue)) {
        selectEl.value = previousValue;
    }
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
    const FALLBACK_FONT_FAMILIES = [
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

    const fallbackEntries = FALLBACK_FONT_FAMILIES.map((family) => {
        const group = inferFontGroup(family);
        return {
            family,
            group,
            coverageLabel: FONT_GROUP_LABELS[group]
        };
    });

    // ── Font picker state ────────────────────────────────────────────────────
    let _pickerEntries = fallbackEntries;
    let _pickerActiveGroup = 'all';

    const searchEl  = document.getElementById('logo-html-font-search');
    const pillsEl   = document.getElementById('logo-html-font-pills');
    const accessBtn = document.getElementById('logo-html-font-access-btn');

    function rebuildSelect(query, group) {
        const prev = selectEl.value;
        selectEl.innerHTML = '';
        selectEl.appendChild(new Option('— default —', ''));

        let entries = _pickerEntries;
        if (group && group !== 'all') entries = entries.filter(e => e.group === group);
        if (query) {
            const q = query.toLowerCase();
            entries = entries.filter(e => e.family.toLowerCase().includes(q));
        }

        const groups = new Map();
        entries.forEach(e => {
            const list = groups.get(e.group) || [];
            list.push(e);
            groups.set(e.group, list);
        });

        FONT_GROUP_ORDER.forEach(key => {
            const list = groups.get(key);
            if (!list?.length) return;
            const og = document.createElement('optgroup');
            og.label = FONT_GROUP_LABELS[key];
            list.forEach(e => og.appendChild(new Option(e.family, e.family)));
            selectEl.appendChild(og);
        });

        if (prev && [...selectEl.options].some(o => o.value === prev)) selectEl.value = prev;
    }

    function buildPills() {
        if (!pillsEl) return;
        pillsEl.innerHTML = '';

        const availGroups = new Set(_pickerEntries.map(e => e.group));
        const pill = (label, group) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.dataset.group = group;
            const active = group === _pickerActiveGroup;
            b.className = `font-pill text-xs px-2 py-0.5 rounded-full border ${active ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-600 text-gray-300 hover:border-blue-400'}`;
            b.addEventListener('click', () => {
                _pickerActiveGroup = group;
                pillsEl.querySelectorAll('.font-pill').forEach(p => {
                    const on = p.dataset.group === group;
                    p.className = `font-pill text-xs px-2 py-0.5 rounded-full border ${on ? 'border-blue-500 bg-blue-500 text-white' : 'border-gray-600 text-gray-300 hover:border-blue-400'}`;
                });
                rebuildSelect(searchEl?.value || '', group);
            });
            return b;
        };

        pillsEl.appendChild(pill('All', 'all'));
        FONT_GROUP_ORDER.forEach(key => {
            if (!availGroups.has(key)) return;
            const short = FONT_GROUP_LABELS[key].split(' ')[0]; // "한국어", "Latin", etc.
            pillsEl.appendChild(pill(short, key));
        });
        pillsEl.classList.remove('hidden');
    }

    function applyFontData(installedFamilies) {
        const installedSet = new Set(installedFamilies.map(f => f.toLowerCase()));
        const installedEntries = installedFamilies.map(family => {
            const inferred = inferFontGroup(family);
            return { family, group: inferred === 'latin' ? 'installed' : inferred };
        });
        const extraFallback = fallbackEntries.filter(e => !installedSet.has(e.family.toLowerCase()));
        _pickerEntries = [...installedEntries, ...extraFallback];
        rebuildSelect(searchEl?.value || '', _pickerActiveGroup);
        buildPills();
        if (accessBtn) accessBtn.classList.add('hidden');
    }

    // Wire up search
    if (searchEl) {
        searchEl.addEventListener('input', () => rebuildSelect(searchEl.value, _pickerActiveGroup));
    }

    // Initial render with fallback list
    rebuildSelect('', 'all');
    buildPills();

    // Attempt to upgrade to the full system font list via Font Access API
    async function tryLoadFonts() {
        if (accessBtn) { accessBtn.textContent = 'Loading…'; accessBtn.classList.remove('hidden'); }
        try {
            if (typeof window.queryLocalFonts === 'function') {
                const fonts = await window.queryLocalFonts();
                const families = [...new Set(fonts.map(f => f.family))].sort((a, b) => a.localeCompare(b));
                if (families.length > 0) {
                    applyFontData(families);
                    if (accessBtn) accessBtn.classList.add('hidden');
                } else if (accessBtn) {
                    accessBtn.textContent = 'Load system fonts';
                }
            } else {
                console.warn('[html-editor] window.queryLocalFonts not available — requires Chrome 103+ with local-fonts permission');
                if (accessBtn) { accessBtn.textContent = 'Load system fonts'; accessBtn.classList.remove('hidden'); }
            }
        } catch (err) {
            console.warn('[html-editor] queryLocalFonts failed:', err);
            if (accessBtn) { accessBtn.textContent = 'Load system fonts'; accessBtn.classList.remove('hidden'); }
        }
    }

    if (accessBtn) {
        accessBtn.addEventListener('click', tryLoadFonts);
    }

    // Auto-attempt on load (Chrome will show permission prompt first time)
    tryLoadFonts();
}

/**
 * Renders an HTML snippet to a content-bounds-cropped transparent PNG data URL
 * using SVG foreignObject. Uses a FileReader data URI to avoid canvas taint.
 * @param {string} html
 * @param {string} [font] - optional font-family override applied to all elements
 * @returns {Promise<string>} PNG data URL
 */
export function renderHtmlToDataUrl(html, font = '', widthPx = 0) {
    return new Promise((resolve, reject) => {
        const CANVAS_SIZE = 4096;
        const PADDING = 32;
        const RENDER_SCALE = HTML_RENDER_SCALE;
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
            'text-rendering:geometricPrecision!important',
            '-webkit-font-smoothing:antialiased!important',
            ...(safeFontName ? [`font-family:"${safeFontName}",system-ui,sans-serif!important`] : [])
        ].join(';');
        const fontPrefix = `<style xmlns="http://www.w3.org/1999/xhtml">*,*::before,*::after{${safeCss}}</style>`;
        const scaledWrapperStyle = [
            'display:inline-block',
            ...(widthPx > 0 ? [`width:${widthPx}px`] : []),
            `transform:scale(${RENDER_SCALE})`,
            'transform-origin:top left'
        ].join(';');

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
            `${fontPrefix}<div style="${scaledWrapperStyle}">${clean}</div>` +
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
                    const contentWidth = bounds.maxX - bounds.minX + 1;
                    const contentHeight = bounds.maxY - bounds.minY + 1;
                    const w = Math.max(1, Math.min(CANVAS_SIZE - x, contentWidth + pad * 2));
                    const h = Math.max(1, Math.min(CANVAS_SIZE - y, contentHeight + pad * 2));

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
        stopCountdownVisual();
        clearTimeout(ls.htmlRenderTimer);
        const html = le.htmlInput ? le.htmlInput.value.trim() : '';
        if (!html) {
            setHtmlStatus('');
            return;
        }
        setHtmlStatus('Rendering…');
        try {
            const font = le.htmlFontSelect ? le.htmlFontSelect.value : '';
            const widthPx = le.htmlWidthSlider ? parseInt(le.htmlWidthSlider.value, 10) : 0;
            const dataUrl = await renderHtmlToDataUrl(html, font, widthPx);
            await onHtmlRendered(dataUrl);
            setHtmlStatus('Ready');
        } catch (err) {
            setHtmlStatus('Render failed', true);
            console.warn('HTML logo render error:', err);
        }
    }

    const RENDER_DELAY = 4000;
    const COUNTDOWN_CIRCUMFERENCE = 31.42; // 2 * π * r (r=5)

    function startCountdownVisual() {
        const svg = le.htmlCountdown;
        const arc = le.htmlCountdownArc;
        if (!svg || !arc) return;
        svg.style.display = '';
        arc.setAttribute('stroke-dashoffset', '0');
        const start = performance.now();
        if (ls.htmlCountdownRaf) cancelAnimationFrame(ls.htmlCountdownRaf);
        function tick(now) {
            const t = Math.min((now - start) / RENDER_DELAY, 1);
            arc.setAttribute('stroke-dashoffset', String(COUNTDOWN_CIRCUMFERENCE * t));
            if (t < 1) ls.htmlCountdownRaf = requestAnimationFrame(tick);
        }
        ls.htmlCountdownRaf = requestAnimationFrame(tick);
    }

    function stopCountdownVisual() {
        if (ls.htmlCountdownRaf) {
            cancelAnimationFrame(ls.htmlCountdownRaf);
            ls.htmlCountdownRaf = null;
        }
        if (le.htmlCountdown) le.htmlCountdown.style.display = 'none';
    }

    function scheduleHtmlRender() {
        clearTimeout(ls.htmlRenderTimer);
        startCountdownVisual();
        ls.htmlRenderTimer = setTimeout(() => {
            stopCountdownVisual();
            triggerHtmlRender();
        }, RENDER_DELAY);
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
        ls.sourceRenderScale = HTML_RENDER_SCALE;
        if (le.originalResolution) le.originalResolution.textContent = `${w}×${h} px`;
        ls.colorsAnalyzed = false;
        ls.layerThicknessById = {};
        if (le.analyzeColorsBtn) {
            le.analyzeColorsBtn.disabled = false;
        }
        await analyzeColorsClick();

        // Scroll the compare panels into view so the result is visible without manual scrolling
        le.svgSourceMirror?.closest('.svg-compare-grid')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    // Render source preview only (no full pipeline) — used by width slider for instant feedback
    async function triggerSourcePreview() {
        const html = le.htmlInput?.value.trim();
        if (!html) return;
        try {
            const font = le.htmlFontSelect?.value || '';
            const widthPx = le.htmlWidthSlider ? parseInt(le.htmlWidthSlider.value, 10) : 0;
            const dataUrl = await renderHtmlToDataUrl(html, font, widthPx);
            if (le.htmlSourceImg) le.htmlSourceImg.src = dataUrl;
            if (le.svgSourceMirror) {
                le.svgSourceMirror.src = dataUrl;
                le.svgSourceMirror.style.display = '';
            }
        } catch (err) {
            console.warn('[html-editor] source preview render error:', err);
        }
    }

    function setHtmlMode(active) {
        ls.htmlModeActive = active;
        if (!active) {
            ls.sourceRenderScale = 1;
        }
        if (le.htmlModeToggle) {
            le.htmlModeToggle.textContent = active ? 'Switch to Image Mode' : 'Switch to HTML Mode';
        }
        if (!active && elements.sourceImage?.src) {
            if (le.svgSourceMirror) le.svgSourceMirror.src = elements.sourceImage.src;
        }
        syncWorkspaceView();
    }

    // Wire style shortcut buttons — wrap selection or insert placeholder
    document.querySelectorAll('.logo-html-style-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const el = le.htmlInput;
            if (!el) return;
            const tag = btn.dataset.tag || '';
            if (!tag) return;
            const isSelf = tag.endsWith('/'); // self-closing like br/
            const start = el.selectionStart;
            const end = el.selectionEnd;
            let inserted;
            if (isSelf) {
                inserted = `<${tag}>`;
                el.setRangeText(inserted, start, end, 'end');
            } else {
                const selected = el.value.substring(start, end);
                const placeholder = selected || 'text';
                inserted = `<${tag}>${placeholder}</${tag}>`;
                el.setRangeText(inserted, start, end, 'end');
                // Select the inner text so user can immediately type
                if (!selected) {
                    const inner_start = start + tag.length + 2;
                    el.setSelectionRange(inner_start, inner_start + placeholder.length);
                }
            }
            el.focus();
            el.dispatchEvent(new Event('input'));
        });
    });

    // Style guide toggle
    const styleGuideToggle = document.getElementById('logo-html-style-guide-toggle');
    const styleGuidePanel = document.getElementById('logo-html-style-guide');
    if (styleGuideToggle && styleGuidePanel) {
        styleGuideToggle.addEventListener('click', () => {
            styleGuidePanel.classList.toggle('hidden');
        });
    }

    // Load system fonts into the dropdown
    loadSystemFonts(le.htmlFontSelect);

    // Re-render when font changes
    if (le.htmlFontSelect) {
        le.htmlFontSelect.addEventListener('change', () => {
            if (le.htmlInput?.value.trim()) scheduleHtmlRender();
        });
    }

    return { setHtmlStatus, triggerHtmlRender, scheduleHtmlRender, onHtmlRendered, setHtmlMode, triggerSourcePreview };
}
