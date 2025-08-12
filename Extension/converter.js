/* global ImageTracer, chrome */

document.addEventListener('DOMContentLoaded', () => {
  // --- DOM elements ---
  const elements = {
    sourceImage: document.getElementById('source-image'),
    statusText: document.getElementById('status-text'),
    generateBtn: document.getElementById('generate-btn'),
    downloadPreviewBtn: document.getElementById('download-preview-btn'),
    downloadFilteredBtn: document.getElementById('download-filtered-btn'),

    presetSelect: document.getElementById('preset'),
    presetStrengthSlider: document.getElementById('preset-strength'),
    presetStrengthValue: document.getElementById('preset-strength-value'),
    removeBgCheckbox: document.getElementById('remove-bg'),
    ignoreNearWhiteCheckbox: document.getElementById('ignore-near-white'),

    colorToleranceSlider: document.getElementById('color-tolerance'),
    colorToleranceValue: document.getElementById('color-tolerance-value'),
    colorDerived: document.getElementById('color-derived'),

    maxDimSelect: document.getElementById('max-dimension'),

    svgPreview: document.getElementById('svg-preview'),
    svgPreviewFiltered: document.getElementById('svg-preview-filtered'),

    importBtn: document.getElementById('import-btn'),
    fileInput: document.getElementById('file-input'),

    paletteContainer: document.getElementById('palette-container'),
    paletteRow: document.getElementById('palette-row'),

    silhouetteColor: document.getElementById('silhouette-color'),
    downloadSilhouetteBtn: document.getElementById('download-silhouette-btn'),
    downloadEachColorBtn: document.getElementById('download-each-color-btn'),

    // Online URL input elements
    urlInput: document.getElementById('url-input'),
    loadUrlBtn: document.getElementById('load-url-btn')
  };

  // --- Config ---
  const MIN_COLORS = 2;
  const MAX_COLORS = 64;
  // UI 0..1 -> effective tolerance 0.8..1.2
  const TOL_EFF_MIN = 0.8;
  const TOL_EFF_MAX = 1.2;
  // Background knockout threshold
  const BG_THRESHOLD = 30;
  // Near-white filter (IRL anti-aliased slivers)
  const NEAR_WHITE_LUMA = 245; // 0..255

  // --- State ---
  let tracedata = null;
  let originalImageUrl = null;
  let bgEstimate = null;
  let lastOptions = null;

  // --- UI helpers ---
  const setupSlider = (slider, valueDisplay, decimals = 0) => {
    slider.addEventListener('input', () => {
      valueDisplay.textContent = parseFloat(slider.value).toFixed(decimals);
    });
  };
  setupSlider(elements.presetStrengthSlider, elements.presetStrengthValue, 1);
  setupSlider(elements.colorToleranceSlider, elements.colorToleranceValue, 2);

  const uiToEffectiveTolerance = (s) => TOL_EFF_MIN + (TOL_EFF_MAX - TOL_EFF_MIN) * s;
  const colorsFromEffectiveTolerance = (tEff) => {
    const raw = MIN_COLORS + (MAX_COLORS - MIN_COLORS) * (1 - tEff);
    const n = Math.round(raw);
    return Math.max(MIN_COLORS, Math.min(MAX_COLORS, n));
  };

  // --- converter.js  (add near where `elements` are wired) ---
// Debounced re-generation when preset strength slider moves
const debounce = (fn, ms = 180) => {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
};

// Reuse the existing "Generate Preview" click path
const regenFromSlider = debounce(() => {
  // if a run is already in progress, skip this tick
  if (elements.generateBtn.disabled) return;
  elements.generateBtn.click();
}, 180);

// Update continuously while dragging the preset strength slider
if (elements.presetStrengthSlider) {
  elements.presetStrengthSlider.addEventListener('input', regenFromSlider);
  // And once more on release (for trackpads that coalesce events)
  elements.presetStrengthSlider.addEventListener('change', regenFromSlider);
}


  // --- Color helpers ---
  const rgbDist = (r1, g1, b1, r2, g2, b2) => {
    const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
    return Math.sqrt(dr * dr + dg * dg + db * db);
  };
  const luma = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const isNearWhite = (c) => c.a > 180 && luma(c) >= NEAR_WHITE_LUMA;
  const isBgLikeColor = (c) =>
    c.a < 10 || (bgEstimate && rgbDist(c.r, c.g, c.b, bgEstimate.r, bgEstimate.g, bgEstimate.b) <= BG_THRESHOLD);

  const layerHasPaths = (layer) => Array.isArray(layer) && layer.length > 0;

  const shouldHideColor = (c, index) => {
    if (index === 0) return true;               // never show background index
    if (elements.ignoreNearWhiteCheckbox.checked && isNearWhite(c)) return true;
    if (isBgLikeColor(c)) return true;          // when BG knockout is on
    return false;
  };

  const countVisiblePalette = () => {
    if (!tracedata) return 0;
    let count = 0;
    for (let i = 1; i < tracedata.palette.length; i++) {
      const c = tracedata.palette[i];
      if (shouldHideColor(c, i)) continue;
      if (!layerHasPaths(tracedata.layers[i])) continue;
      count++;
    }
    return count;
  };

  const updateDerivedColorsHint = () => {
    const s = parseFloat(elements.colorToleranceSlider.value);
    const tEff = uiToEffectiveTolerance(s);
    const n = colorsFromEffectiveTolerance(tEff);
    const shown = tracedata ? countVisiblePalette() : null;
    elements.colorDerived.textContent =
      `→ colors: ${n} (eff: ${tEff.toFixed(2)})${shown !== null ? ` | shown: ${shown}` : ''}`;
  };
  elements.colorToleranceSlider.addEventListener('input', updateDerivedColorsHint);
  elements.ignoreNearWhiteCheckbox.addEventListener('change', () => {
    if (tracedata) {
      displayPalette();          // refresh palette visibility
      updateFilteredPreview();
      updateDerivedColorsHint();
    }
  });
  updateDerivedColorsHint();

  // --- Image loading via background.js flow ---
  const loadImageFromContextMenu = async () => {
    elements.statusText.textContent = 'Requesting image from background.';
    const data = await chrome.storage.local.get('imageUrlToConvert');
    if (!data.imageUrlToConvert) {
      elements.statusText.textContent = 'No image URL found. You can also import one.';
      return;
    }
    originalImageUrl = data.imageUrlToConvert;

    const port = chrome.runtime.connect({ name: 'fetchImagePort' });
    port.postMessage({ type: 'fetchImage', url: originalImageUrl });
    port.onMessage.addListener((response) => {
      if (response.dataUrl) {
        elements.statusText.textContent = 'Image data received. Loading...';
        elements.sourceImage.src = response.dataUrl;
      } else {
        elements.statusText.textContent = `Error: ${response.error || 'Could not load image.'}`;
      }
      port.disconnect();
    });
  };

  // --- Local import ---
  elements.importBtn.addEventListener('click', () => elements.fileInput.click());
  elements.fileInput.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;

    elements.statusText.textContent = 'Loading imported image...';
    const reader = new FileReader();
    reader.onload = (e) => {
      elements.sourceImage.src = e.target.result;
      originalImageUrl = file.name;
    };
    reader.onerror = () => {
      elements.statusText.textContent = 'Error loading imported image.';
    };
    reader.readAsDataURL(file);
  });

  elements.sourceImage.onload = () => {
    elements.sourceImage.style.display = 'block';
    elements.generateBtn.disabled = false;
    elements.statusText.textContent = 'Image loaded. Auto-generating initial preview.';
    elements.colorToleranceSlider.value = '0';
    elements.colorToleranceValue.textContent = '0.00';
    updateDerivedColorsHint();
    elements.generateBtn.click();
  };

  // Online URL loader
  const loadImageFromUrl = async (url) => {
    if (!url) return;
    elements.statusText.textContent = 'Fetching remote image...';
    originalImageUrl = url;
    try {
      // If the URL is already a DataURL (base64), assign it directly
      if (url.startsWith('data:')) {
        elements.sourceImage.src = url;
        elements.statusText.textContent = 'Remote image loaded.';
        return;
      }
      // Use extension background fetch when available (bypassing CORS)
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.connect) {
        const port = chrome.runtime.connect({ name: 'fetchImagePort' });
        return await new Promise((resolve, reject) => {
          let handled = false;
          port.postMessage({ type: 'fetchImage', url });
          port.onMessage.addListener((response) => {
            handled = true;
            if (response.dataUrl) {
              elements.sourceImage.src = response.dataUrl;
              elements.statusText.textContent = 'Remote image loaded.';
              resolve();
            } else {
              elements.statusText.textContent = `Error: ${response.error || 'Could not load image.'}`;
              reject(new Error(response.error || 'Could not load image'));
            }
            port.disconnect();
          });
          // Timeout fallback (10s)
          setTimeout(() => {
            if (!handled) {
              port.disconnect();
              reject(new Error('Timeout fetching remote image.'));
            }
          }, 10000);
        });
      }
      // Fallback: direct fetch via CORS or proxy
      let resp;
      try {
        // Attempt a CORS fetch with polite headers
        resp = await fetch(url, {
          mode: 'cors',
          headers: {
            'User-Agent': 'Mozilla/5.0',
            'Referer': url
          }
        });
        if (!resp.ok) throw new Error(`Status ${resp.status}`);
      } catch (_e) {
        // If direct fetch fails (likely CORS), try via a CORS proxy.
        // Use images.weserv.nl which fetches remote images when provided an encoded URL.
        const proxied = 'https://images.weserv.nl/?url=' + encodeURIComponent(url);
        resp = await fetch(proxied);
        if (!resp.ok) throw new Error(`Proxy fetch failed: ${resp.status}`);
      }
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Failed to read blob'));
        reader.readAsDataURL(blob);
      });
      elements.sourceImage.src = dataUrl;
      elements.statusText.textContent = 'Remote image loaded.';
    } catch (err) {
      console.error(err);
      elements.statusText.textContent = `Error loading remote image.`;
    }
  };

  elements.loadUrlBtn?.addEventListener('click', () => {
    const url = elements.urlInput?.value?.trim();
    if (!url) {
      alert('Please enter an image URL.');
      return;
    }
    loadImageFromUrl(url);
  });

  // --- Background knockout utilities ---
  const estimateEdgeBackground = (imgd) => {
    const { width, height, data } = imgd;
    let r = 0, g = 0, b = 0, count = 0;
    const step = Math.max(1, Math.floor(Math.min(width, height) / 50));
    const sample = (x, y) => {
      const i = (y * width + x) * 4;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
    };
    for (let x = 0; x < width; x += step) { sample(x, 0); sample(x, height - 1); }
    for (let y = 0; y < height; y += step) { sample(0, y); sample(width - 1, y); }
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), a: 255 };
  };

  const knockOutBackground = (imgd, bg, threshold = BG_THRESHOLD) => {
    const d = imgd.data;
    for (let i = 0; i < d.length; i += 4) {
      if (rgbDist(d[i], d[i + 1], d[i + 2], bg.r, bg.g, bg.b) <= threshold) {
        d[i + 3] = 0; // transparent
      }
    }
  };

  // Build a tracedata subset by palette indices (keeps order)
  const buildTracedataSubset = (srcTracedata, indices) => {
    if (!srcTracedata) return null;
    const sorted = [...indices].sort((a, b) => a - b);
    const layers = [];
    const palette = [];
    for (const idx of sorted) {
      if (srcTracedata.layers[idx] && srcTracedata.palette[idx]) {
        layers.push(srcTracedata.layers[idx]);
        palette.push(srcTracedata.palette[idx]);
      }
    }
    return { ...srcTracedata, layers: JSON.parse(JSON.stringify(layers)), palette };
  };

  // --- Palette UI ---
  const displayPalette = () => {
    if (!tracedata) return;
    const { palette, layers } = tracedata;
    elements.paletteContainer.innerHTML = '';

    palette.forEach((color, index) => {
      if (shouldHideColor(color, index)) return;
      if (!layerHasPaths(layers[index])) return;

      const label = document.createElement('label');
      label.style.display = 'inline-block';
      label.style.margin = '4px 6px';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = true;
      checkbox.dataset.index = index;

      const swatch = document.createElement('span');
      swatch.style.display = 'inline-block';
      swatch.style.width = '18px';
      swatch.style.height = '18px';
      swatch.style.backgroundColor = `rgba(${color.r},${color.g},${color.b},${color.a / 255})`;
      swatch.style.border = '1px solid #ccc';
      swatch.style.verticalAlign = 'middle';
      swatch.style.marginLeft = '6px';

      label.appendChild(checkbox);
      label.appendChild(swatch);
      elements.paletteContainer.appendChild(label);
    });

    elements.paletteRow.style.display = 'table-row';
  };

  const getSelectedPaletteIndices = () =>
    Array.from(elements.paletteContainer.querySelectorAll('input[type="checkbox"]:checked'))
      .map(cb => parseInt(cb.dataset.index, 10));

  const getVisiblePaletteIndicesAll = () => {
    if (!tracedata) return [];
    return tracedata.palette
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !shouldHideColor(c, i) && layerHasPaths(tracedata.layers[i]))
      .map(({ i }) => i);
  };

  const updateFilteredPreview = () => {
    if (!tracedata) {
      elements.svgPreviewFiltered.data = '';
      return;
    }
    const selected = getSelectedPaletteIndices();
    const filtered = selected.length
      ? buildTracedataSubset(tracedata, selected)
      : { ...tracedata, layers: [], palette: [] };

    const preset = elements.presetSelect.value;
    const options = { ...ImageTracer.optionpresets[preset], viewbox: true };
    const svgString = ImageTracer.getsvgstring(filtered, options);
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    elements.svgPreviewFiltered.data = URL.createObjectURL(blob);
  };
  elements.paletteContainer.addEventListener('change', updateFilteredPreview);

  // --- Generate action ---
  elements.generateBtn.addEventListener('click', () => {
    if (!elements.sourceImage.src) return;

    elements.statusText.textContent = 'Generating SVG preview.';
    elements.generateBtn.disabled = true;
    elements.downloadPreviewBtn.disabled = true;
    elements.downloadFilteredBtn.disabled = true;
    elements.downloadSilhouetteBtn.disabled = true;
    elements.downloadEachColorBtn.disabled = true;
    elements.paletteRow.style.display = 'none';

    setTimeout(() => {
      try {
        // Canvas
        let width = elements.sourceImage.naturalWidth;
        let height = elements.sourceImage.naturalHeight;
        const maxDim = parseInt(elements.maxDimSelect.value, 10);
        if (maxDim > 0 && (width > maxDim || height > maxDim)) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.floor(width * ratio);
          height = Math.floor(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(elements.sourceImage, 0, 0, width, height);
        const imageData = ctx.getImageData(0, 0, width, height);

        // Optional background knockout
        bgEstimate = null;
        if (elements.removeBgCheckbox.checked) {
          bgEstimate = estimateEdgeBackground(imageData);
          knockOutBackground(imageData, bgEstimate, BG_THRESHOLD);
        }

        // Blend preset options
        const defaults = ImageTracer.optionpresets['default'];
        const presetOptions = ImageTracer.optionpresets[elements.presetSelect.value];
        const strength = parseFloat(elements.presetStrengthSlider.value);
        const blendedOptions = {};
        for (const key in defaults) {
          if (typeof defaults[key] === 'number' && presetOptions.hasOwnProperty(key)) {
            blendedOptions[key] = defaults[key] + (presetOptions[key] - defaults[key]) * strength;
          } else {
            blendedOptions[key] = (presetOptions[key] !== undefined) ? presetOptions[key] : defaults[key];
          }
        }

        // Map UI -> effective tolerance -> number of colors (with clamping)
        const s = parseFloat(elements.colorToleranceSlider.value);
        const tEff = uiToEffectiveTolerance(s);
        const numColors = colorsFromEffectiveTolerance(tEff);

        lastOptions = {
          ...blendedOptions,
          numberofcolors: numColors,
          blurradius: 0,
          viewbox: true
        };

        // --- Preset refinements ---
        // Determine which preset is selected and adjust numeric options based on slider strength.
        const preset = elements.presetSelect.value;
        const strengthVal = parseFloat(elements.presetStrengthSlider.value);
        // Helper for linear interpolation
        const lerp = (a, b, t) => a + (b - a) * t;
        if (preset === 'sharp') {
          /*
            Sharp preset refinement:
            - Dramatically tighten straight and curve thresholds as the slider increases.
            - Use extremely low ltres/qtres at full strength for razor‑sharp fidelity.
            - Progressively lower pathomit so small paths are kept at high strength.
            - Disable smoothing and blur entirely.
            The range of ltres/qtres spans from 1 (no refinement) to 0.0005 for a visibly crisper trace.
          */
          lastOptions.ltres = lerp(1.0, 0.0005, strengthVal);
          lastOptions.qtres = lerp(1.0, 0.0005, strengthVal);
          lastOptions.pathomit = Math.round(lerp(12, 0, strengthVal));
          lastOptions.rightangleenhance = true;
          lastOptions.linefilter = false;
          lastOptions.blurradius = 0;
          lastOptions.blurdelta = 20;
        } else if (preset === 'curvy') {
          /*
            Curvy preset refinement:
            - Increase ltres/qtres dramatically as the slider increases to simplify shapes and smooth curves.
            - At full strength the thresholds reach very high values (e.g. 20) for a soft, blob‑like look.
            - Pathomit increases to remove tiny specks when strong smoothing is desired.
            - Enable line filtering and apply a pre‑blur whose radius grows with the slider.
            These ranges make the slider effect very noticeable between 0 and 1.
          */
          lastOptions.ltres = lerp(1.0, 20.0, strengthVal);
          lastOptions.qtres = lerp(1.0, 18.0, strengthVal);
          lastOptions.pathomit = Math.round(lerp(0, 25, strengthVal));
          lastOptions.rightangleenhance = false;
          lastOptions.linefilter = true;
          lastOptions.blurradius = Math.round(lerp(0, 6, strengthVal));
          lastOptions.blurdelta = Math.round(lerp(20, 50, strengthVal));
        }

        tracedata = ImageTracer.imagedataToTracedata(imageData, lastOptions);

        displayPalette();

        // Preview = all visible colors unless BG is removed (we already hide/bg-like)
        const keep = getVisiblePaletteIndicesAll();
        const previewData = keep.length ? buildTracedataSubset(tracedata, keep) : { ...tracedata, layers: [], palette: [] };

        const svgString = ImageTracer.getsvgstring(previewData, lastOptions);
        const blob = new Blob([svgString], { type: 'image/svg+xml' });
        elements.svgPreview.data = URL.createObjectURL(blob);

        elements.statusText.textContent = 'Preview generated. Ready to download.';
        elements.downloadPreviewBtn.disabled = false;
        elements.downloadFilteredBtn.disabled = false;
        elements.downloadSilhouetteBtn.disabled = false;
        elements.downloadEachColorBtn.disabled = false;

        updateFilteredPreview();
        updateDerivedColorsHint();
      } catch (err) {
        console.error('Conversion Error:', err);
        elements.statusText.textContent = 'Error during conversion.';
      } finally {
        elements.generateBtn.disabled = false;
      }
    }, 10);
  });

  // --- Downloads ---
  const createDownload = (url, filename) => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const defaultBaseName = (suffix) => {
    let base = 'converted';
    try {
      const path = new URL(originalImageUrl).pathname;
      base = path.split('/').pop().replace(/\.[^/.]+$/, '') || base;
    } catch (_) { /* keep default */ }
    return `${base}_${suffix}.svg`;
  };

  const hexToRGBA = (hex) => {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
    return { r, g, b, a: 255 };
  };

  elements.downloadPreviewBtn.addEventListener('click', () => {
    if (!elements.svgPreview.data) return alert('No SVG data available.');
    createDownload(elements.svgPreview.data, defaultBaseName('preview'));
  });

  elements.downloadFilteredBtn.addEventListener('click', () => {
    if (!elements.svgPreviewFiltered.data) return alert('No SVG data available.');
    createDownload(elements.svgPreviewFiltered.data, defaultBaseName('filtered'));
  });

  // Silhouette: all visible layers → one solid color
  elements.downloadSilhouetteBtn.addEventListener('click', () => {
    if (!tracedata) return alert('Generate a preview first.');
    const keep = getVisiblePaletteIndicesAll();
    if (!keep.length) return alert('No visible layers to export.');

    const subset = buildTracedataSubset(tracedata, keep);
    // Use solid black for silhouette now that color picker is removed
    const monoColor = { r: 0, g: 0, b: 0, a: 255 };
    const mono = { ...subset, palette: subset.palette.map(() => monoColor) };

    const svgString = ImageTracer.getsvgstring(mono, lastOptions || { viewbox: true });
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    createDownload(url, defaultBaseName('silhouette'));
  });

  // Each visible color → one SVG
  elements.downloadEachColorBtn.addEventListener('click', () => {
    if (!tracedata) return alert('Generate a preview first.');
    const keepAll = getVisiblePaletteIndicesAll();
    if (!keepAll.length) return alert('No visible layers to export.');

    keepAll.forEach((idx, ordinal) => {
      const single = buildTracedataSubset(tracedata, [idx]);
      const c = single.palette[0];
      const hex = [c.r, c.g, c.b]
        .map(v => v.toString(16).padStart(2, '0'))
        .join('');
      const svgString = ImageTracer.getsvgstring(single, lastOptions || { viewbox: true });
      const blob = new Blob([svgString], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      // Use ordinal (1‑based) and color hex for filename: originalname_layer1_ff0000.svg
      createDownload(url, defaultBaseName(`layer${ordinal + 1}_${hex}`));
    });
  });

  // Regenerate when these toggles change
  elements.removeBgCheckbox.addEventListener('change', () => {
    if (elements.sourceImage.src) elements.generateBtn.click();
  });

  // Init
  loadImageFromContextMenu();
});
