
/* Converter.js — minimal, working build aligned to converter.html (clean version) */
/* global ImageTracer */

document.addEventListener('DOMContentLoaded', () => {
  // ---- Elements ----
  const el = {
    img: document.getElementById('source-image'),
    status: document.getElementById('status-text'),
    gen: document.getElementById('generate-btn'),
    preset: document.getElementById('preset'),
    simp: document.getElementById('path-simplification'),
    simpVal: document.getElementById('path-simplification-value'),
    sharp: document.getElementById('corner-sharpness'),
    sharpVal: document.getElementById('corner-sharpness-value'),
    straight: document.getElementById('curve-straightness'),
    straightVal: document.getElementById('curve-straightness-value'),
    cprec: document.getElementById('color-precision'),
    cprecVal: document.getElementById('color-precision-value'),
    cprecFeedback: document.getElementById('color-feedback'),
    removeBg: document.getElementById('remove-bg'),
    prevAll: document.getElementById('svg-preview'),
    prevSel: document.getElementById('svg-preview-filtered'),
    qinfo: document.getElementById('quality-indicator'),
    importBtn: document.getElementById('import-btn'),
    file: document.getElementById('file-input'),
    urlText: document.getElementById('url-input'),
    urlBtn: document.getElementById('load-url-btn'),
    dlZip: document.getElementById('download-tinkercad-btn'),
    dlSil: document.getElementById('download-silhouette-btn'),
    colorRow: document.getElementById('color-buttons-row'),
    origRes: document.getElementById('original-resolution'),
    scaledRes: document.getElementById('scaled-resolution')
  };

  // ---- State ----
  let imageURL = null;
  let tracedata = null;
  let lastOptions = null;
  let visibleSet = new Set(); // palette indices that are visible

  // ---- Helpers ----
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  function createBlobURL(text, type='image/svg+xml') {
    const blob = new Blob([text], { type });
    return URL.createObjectURL(blob);
  }

  function setObjectData(obj, svgString) {
    const url = createBlobURL(svgString);
    obj.setAttribute('data', url);
  }

  function setStatus(msg) {
    if (el.status) el.status.textContent = msg;
  }

  function enableGenerate() {
    if (el.gen) el.gen.disabled = !el.img.src;
  }

  function mapOptions() {
    // Slider inputs 0..100 -> ImageTracer options
    const simp = Number(el.simp?.value || 60); // higher -> simpler
    const straight = Number(el.straight?.value || 50);
    const sharp = Number(el.sharp?.value || 50);
    const cprec = Number(el.cprec?.value || 60);

    // Derive core thresholds
    const ltres = 0.5 + (simp/100) * 5.0;    // line threshold
    const qtres = 0.2 + (straight/100) * 3.8; // curve threshold
    const pathomit = Math.round((simp/100) * 20); // omit tiny paths

    // Colors: map 0..100 -> 2..9 colors
    const numberofcolors = Math.round(2 + (cprec/100)*7);

    const opts = {
      ltres, qtres, pathomit,
      numberofcolors,
      mincolorratio: 0.01,
      rightangleenhance: sharp >= 50,
      scale: 1,
      strokewidth: 0,
      linefilter: true,
      roundcoords: 2
    };

    // Preset adjustments
    const p = el.preset?.value || '3dprint';
    if (p === '3dprint') {
      opts.numberofcolors = clamp(numberofcolors, 2, 6);
      opts.rightangleenhance = true;
      opts.linefilter = true;
    } else if (p === 'curvy') {
      opts.ltres = Math.max(3, ltres);
      opts.qtres = Math.max(2.5, qtres);
      opts.rightangleenhance = false;
    } else if (p === 'sharp') {
      opts.ltres = Math.max(0.8, ltres*0.7);
      opts.qtres = Math.max(0.5, qtres*0.6);
      opts.rightangleenhance = true;
    } else if (p === 'standard') {
      // ImageTracer defaults mostly
    }

    return opts;
  }

  function getCanvasFromImage(img) {
    const maxDim = 2048; // simple safeguard
    const w0 = img.naturalWidth || img.width;
    const h0 = img.naturalHeight || img.height;
    el.origRes.textContent = `Original: ${w0}×${h0}px`;

    let w = w0, h = h0;
    if (Math.max(w0,h0) > maxDim) {
      const s = maxDim / Math.max(w0,h0);
      w = Math.round(w0*s);
      h = Math.round(h0*s);
      el.scaledRes.textContent = `Scaled: ${w}×${h}px (auto)`;
    } else {
      el.scaledRes.textContent = `Scaled: ${w}×${h}px`;
    }

    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    return c;
  }

  function buildSubset(td, indices) {
    // Keep only layers whose 'colorindex' is in indices
    const layers = td.layers.map(layer => ({
      paths: layer.paths.filter(p => indices.has(p.colorindex))
    }));
    // Palette unchanged (renderer ignores unused colors)
    return { ...td, layers };
  }

  function guessBackgroundIndex(td) {
    // rough heuristic: color index with the most paths
    const counts = new Map();
    td.layers.forEach(layer => {
      layer.paths.forEach(p => {
        counts.set(p.colorindex, (counts.get(p.colorindex)||0)+1);
      });
    });
    let best = 0, bestk = 0;
    counts.forEach((v,k)=>{ if (v>best) { best=v; bestk=k; } });
    return bestk;
  }

  function refreshColorToggles(td) {
    el.colorRow.innerHTML = '';
    const unique = new Set();
    td.layers.forEach(layer => layer.paths.forEach(p => unique.add(p.colorindex)));
    const indices = Array.from(unique).sort((a,b)=>a-b);
    if (visibleSet.size === 0) indices.forEach(i => visibleSet.add(i));

    indices.forEach((idx, i) => {
      const btn = document.createElement('button');
      btn.className = 'color-btn active';
      btn.textContent = `Layer ${i+1}`;
      btn.dataset.index = String(idx);
      btn.addEventListener('click', () => {
        if (visibleSet.has(idx)) {
          visibleSet.delete(idx);
          btn.classList.remove('active');
        } else {
          visibleSet.add(idx);
          btn.classList.add('active');
        }
        updateFilteredPreview();
      });
      el.colorRow.appendChild(btn);
    });
  }

  function updateFilteredPreview() {
    if (!tracedata) return;
    const subset = buildSubset(tracedata, visibleSet);
    const svg = ImageTracer.getsvgstring(subset, lastOptions);
    setObjectData(el.prevSel, svg);

    // quality indicator: path count
    let paths = 0;
    subset.layers.forEach(l => paths += l.paths.length);
    el.qinfo.textContent = `Visible paths: ${paths}`;
  }

  function updateAllPreview() {
    if (!tracedata) return;
    const svg = ImageTracer.getsvgstring(tracedata, lastOptions);
    setObjectData(el.prevAll, svg);

    let paths = 0;
    tracedata.layers.forEach(l => paths += l.paths.length);
    el.qinfo.textContent = `Total paths: ${paths}`;
  }

  function download(filename, text, mime='image/svg+xml') {
    const url = createBlobURL(text, mime);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(()=>{
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 0);
  }

  // ---- Actions ----

  // file import
  el.importBtn?.addEventListener('click', () => el.file?.click());

  el.file?.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    el.img.onload = () => {
      imageURL = url;
      enableGenerate();
      setStatus('Image loaded. Ready to generate.');
    };
    el.img.crossOrigin = 'anonymous';
    el.img.src = url;
  });

  // url import
  el.urlBtn?.addEventListener('click', () => {
    const url = (el.urlText?.value || '').trim();
    if (!url) return alert('Paste an image URL first.');
    el.img.onload = () => {
      imageURL = url;
      enableGenerate();
      setStatus('Image loaded from URL. Ready to generate.');
    };
    el.img.crossOrigin = 'anonymous';
    el.img.src = url;
  });

  // slider labels
  function bindSlider(input, label, cb){
    if (!input || !label) return;
    const f = () => { label.textContent = `${input.value}%`; if (cb) cb(); };
    input.addEventListener('input', f);
    f();
  }
  bindSlider(el.simp, el.simpVal);
  bindSlider(el.sharp, el.sharpVal);
  bindSlider(el.straight, el.straightVal);
  bindSlider(el.cprec, el.cprecVal, () => {
    const v = Number(el.cprec.value);
    let text = 'Balanced detail for layered prints.';
    if (v < 30) text = 'Fewer colors → fewer layers.';
    else if (v > 80) text = 'More colors → more layers (slower).';
    el.cprecFeedback.textContent = text;
  });

  // generate
  el.gen?.addEventListener('click', () => {
    if (!el.img.src) return alert('Load an image first.');
    setStatus('Processing...');
    const canvas = getCanvasFromImage(el.img);
    const ctx = canvas.getContext('2d');
    const imgd = ctx.getImageData(0,0,canvas.width, canvas.height);
    lastOptions = mapOptions();

    tracedata = ImageTracer.imagedataToTracedata(imgd, lastOptions);

    // optional remove bg
    if (el.removeBg?.checked) {
      const bg = guessBackgroundIndex(tracedata);
      visibleSet = new Set(Array.from(new Set(
        [].concat(...tracedata.layers.map(l => l.paths.map(p=>p.colorindex)))
      )).filter(i => i !== bg));
    } else {
      visibleSet = new Set(
        [].concat(...tracedata.layers.map(l => l.paths.map(p=>p.colorindex)))
      );
    }

    refreshColorToggles(tracedata);
    updateAllPreview();
    updateFilteredPreview();
    el.dlZip.disabled = false;
    el.dlSil.disabled = false;
    setStatus('Preview generated. You can download layers for Tinkercad.');
  });

  // download silhouette
  el.dlSil?.addEventListener('click', () => {
    if (!tracedata) return alert('Generate a preview first.');
    const subset = buildSubset(tracedata, visibleSet.size?visibleSet:new Set([0]));
    // map all palette colors to black to ensure solid background feel
    const td = JSON.parse(JSON.stringify(subset));
    td.palette = td.palette.map(()=>({r:0,g:0,b:0,a:255}));
    const svg = ImageTracer.getsvgstring(td, lastOptions);
    download('solid-base-silhouette.svg', svg);
    setStatus('🎭 Solid background downloaded (use as base in Tinkercad).');
  });

  // download all layers (multiple files)
  el.dlZip?.addEventListener('click', async () => {
    if (!tracedata) return alert('Generate a preview first.');
    const indices = Array.from(visibleSet.values()).sort((a,b)=>a-b);
    if (indices.length === 0) return alert('No visible layers to export.');

    // base name
    let base = 'image';
    if (imageURL) {
      try { base = imageURL.split('/').pop().split('?')[0].replace(/\.[^/.]+$/,'') || 'image'; } catch {}
    }

    // 1) Background silhouette
    const subset = buildSubset(tracedata, new Set(indices));
    const silTd = JSON.parse(JSON.stringify(subset));
    silTd.palette = silTd.palette.map(()=>({r:0,g:0,b:0,a:255}));
    const svgSil = ImageTracer.getsvgstring(silTd, lastOptions);

    // 2) Each layer separately
    const svgs = indices.map((idx, i) => {
      const single = buildSubset(tracedata, new Set([idx]));
      return { name: `${base}_layer${i+1}.svg`, text: ImageTracer.getsvgstring(single, lastOptions) };
    });

    // Download each separately (simple approach per UI copy)
    download(`${base}_background.svg`, svgSil);
    svgs.forEach(f => download(f.name, f.text));
    setStatus(`🎭 Background and ${indices.length} layer files downloaded.`);
  });

  // initial
  enableGenerate();
  setStatus('Ready for 3D printing magic! ✨');
});
