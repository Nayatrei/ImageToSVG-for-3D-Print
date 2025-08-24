
(function(){
  'use strict';

  var el = function(id){ return document.getElementById(id); };
  var elements = {
    sourceImage: el('source-image'),
    statusText: el('status-text'),
    generateBtn: el('generate-btn'),
    presetSelect: el('preset'),
    pathSimplificationSlider: el('path-simplification'),
    pathSimplificationValue: el('path-simplification-value'),
    cornerSharpnessSlider: el('corner-sharpness'),
    cornerSharpnessValue: el('corner-sharpness-value'),
    curveStraightnessSlider: el('curve-straightness'),
    curveStraightnessValue: el('curve-straightness-value'),
    colorPrecisionSlider: el('color-precision'),
    colorPrecisionValue: el('color-precision-value'),
    colorFeedback: el('color-feedback'),
    removeBgCheckbox: el('remove-bg'),
    importBtn: el('import-btn'),
    fileInput: el('file-input'),
    urlInput: el('url-input'),
    loadUrlBtn: el('load-url-btn'),
    svgPreview: el('svg-preview'),
    svgPreviewFiltered: el('svg-preview-filtered'),
    qualityIndicator: el('quality-indicator'),
    colorButtonsRow: el('color-buttons-row'),
    downloadTinkercadBtn: el('download-tinkercad-btn'),
    downloadSilhouetteBtn: el('download-silhouette-btn'),
    originalResolution: el('original-resolution'),
    scaledResolution: el('scaled-resolution')
  };

  var originalImageUrl = '';
  var tracedata = null;
  var lastOptions = null;
  var visibleLayerIndices = [];
  var MAX_DIM = 2048;

  function setStatus(msg){ if(elements.statusText){ elements.statusText.textContent = msg; } }
  function clamp(v, min, max){ return Math.max(min, Math.min(max, v)); }
  function map01(v){ return clamp(v/100, 0, 1); }

  function setupSlider(slider, display, decimals){
    if(!slider || !display) return;
    var dec = (typeof decimals === 'number') ? decimals : 0;
    function update(){
      var val = parseFloat(slider.value||'0');
      display.textContent = val.toFixed(dec);
    }
    slider.addEventListener('input', update);
    update();
  }

  function dataURLFromBlob(blob){
    return new Promise(function(resolve, reject){
      var fr = new FileReader();
      fr.onload = function(){ resolve(fr.result); };
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  }

  function loadImageFromDataURL(url){
    return new Promise(function(resolve, reject){
      var img = elements.sourceImage;
      img.onload = function(){ resolve(img); };
      img.onerror = reject;
      img.src = url;
    });
  }

  async function loadImageFromUrl(url){
    setStatus('🌐 Fetching image from URL...');
    try{
      var resp = await fetch(url, {mode:'cors'});
      if(!resp.ok) throw new Error('HTTP '+resp.status);
      var blob = await resp.blob();
      var dataURL = await dataURLFromBlob(blob);
      await loadImageFromDataURL(dataURL);
      originalImageUrl = url;
      setStatus('✅ Image loaded from URL.');
      if(elements.generateBtn) elements.generateBtn.disabled = false;
      showOriginalResolution();
    }catch(e){
      try{
        elements.sourceImage.crossOrigin = 'anonymous';
        await new Promise(function(res, rej){
          elements.sourceImage.onload = res;
          elements.sourceImage.onerror = rej;
          elements.sourceImage.src = url;
        });
        originalImageUrl = url;
        setStatus('⚠️ Loaded image directly (canvas may be tainted by CORS).');
        if(elements.generateBtn) elements.generateBtn.disabled = false;
        showOriginalResolution();
      }catch(err){
        console.error(err);
        setStatus('❌ Failed to load URL image. Try downloading and using Import.');
      }
    }
  }

  function showOriginalResolution(){
    if(!elements.originalResolution || !elements.sourceImage.naturalWidth) return;
    elements.originalResolution.textContent =
      'Original: ' + elements.sourceImage.naturalWidth + '×' + elements.sourceImage.naturalHeight + ' px';
  }

  function autoscaleToCanvas(img){
    var w = img.naturalWidth, h = img.naturalHeight;
    var scale = 1;
    if(Math.max(w,h) > MAX_DIM){ scale = MAX_DIM / Math.max(w,h); }
    var sw = Math.round(w*scale), sh = Math.round(h*scale);
    var c = document.createElement('canvas');
    c.width = sw; c.height = sh;
    var ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, sw, sh);
    if(elements.scaledResolution){
      if(scale < 1) elements.scaledResolution.textContent = 'Scaled: ' + sw + '×' + sh + ' px (auto for stability)';
      else elements.scaledResolution.textContent = 'Scaled: ' + sw + '×' + sh + ' px';
    }
    return c;
  }

  function buildOptions(){
    var ps = parseFloat(elements.pathSimplificationSlider ? elements.pathSimplificationSlider.value : 60);
    var cs = parseFloat(elements.cornerSharpnessSlider ? elements.cornerSharpnessSlider.value : 50);
    var st = parseFloat(elements.curveStraightnessSlider ? elements.curveStraightnessSlider.value : 50);
    var cp = parseFloat(elements.colorPrecisionSlider ? elements.colorPrecisionSlider.value : 60);

    var ncolors = 2 + Math.round(map01(cp) * 6);
    var ltres = 4.0 - 3.5*map01(cs);
    var qtres = 4.0 - 3.5*map01(st);
    var pathomit = Math.round(ps/4);

    var preset = elements.presetSelect ? elements.presetSelect.value : '3dprint';
    var base = {
      scale: 1,
      roundcoords: 2,
      viewbox: true,
      rightangleenhance: preset !== 'curvy',
      colorsampling: 0,
      numberofcolors: ncolors,
      ltres: ltres,
      qtres: qtres,
      pathomit: pathomit
    };
    if(preset === 'curvy'){
      base.rightangleenhance = false;
    }else if(preset === 'sharp'){
      base.ltres = Math.max(0.5, ltres*0.7);
      base.qtres = Math.max(0.5, qtres*0.7);
      base.pathomit = Math.max(0, pathomit-2);
    }
    return base;
  }

  function tracedataSubset(td, keepIndices){
    var subset = { width: td.width, height: td.height, palette: [], layers: [] };
    subset.palette = td.palette.slice();
    for(var i=0;i<td.layers.length;i++){
      if(keepIndices.indexOf(i) !== -1){
        subset.layers.push(td.layers[i]);
      }else{
        subset.layers.push({lines:[], paths:[]});
      }
    }
    return subset;
  }

  function countPaths(td){
    var total = 0;
    for(var i=0;i<td.layers.length;i++){
      var layer = td.layers[i];
      if(layer && layer.paths) total += layer.paths.length;
    }
    return total;
  }

  function updateQuality(td){
    if(!elements.qualityIndicator) return;
    var total = countPaths(td);
    var msg = 'Paths: '+total;
    if(total > 300) msg += '  |  ⚠️ Complex – consider higher Simplification.';
    elements.qualityIndicator.textContent = msg;
  }

  function renderPreviews(td, options){
    var svgAll = ImageTracer.getsvgstring(td, options);
    if(elements.svgPreview) elements.svgPreview.data = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgAll);

    var subset = tracedataSubset(td, visibleLayerIndices.length ? visibleLayerIndices : []);
    var svgSel = ImageTracer.getsvgstring(subset, options);
    if(elements.svgPreviewFiltered) elements.svgPreviewFiltered.data = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgSel);
  }

  function buildLayerButtons(td){
    if(!elements.colorButtonsRow) return;
    elements.colorButtonsRow.innerHTML = '';
    visibleLayerIndices = [];
    for(var i=0; i<td.layers.length; i++){
      (function(idx){
        var btn = document.createElement('button');
        btn.textContent = 'Layer ' + (idx+1);
        btn.dataset.active = '1';
        btn.style.marginRight = '6px';
        btn.addEventListener('click', function(){
          if(btn.dataset.active === '1'){
            btn.dataset.active = '0';
            btn.style.opacity = '0.5';
            var p = visibleLayerIndices.indexOf(idx);
            if(p !== -1) visibleLayerIndices.splice(p,1);
          }else{
            btn.dataset.active = '1';
            btn.style.opacity = '1';
            if(visibleLayerIndices.indexOf(idx) === -1) visibleLayerIndices.push(idx);
          }
          renderPreviews(tracedata, lastOptions);
        });
        visibleLayerIndices.push(idx);
        elements.colorButtonsRow.appendChild(btn);
      })(i);
    }
  }

  function downloadSVGString(svgString, filename){
    var blob = new Blob([svgString], {type: 'image/svg+xml'});
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename + '.svg';
    document.body.appendChild(a);
    a.click();
    setTimeout(function(){ URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function createSilhouette(td){
    var merged = tracedataSubset(td, []);
    merged.layers = td.layers.map(function(l){ return l; });
    merged.palette = td.palette.map(function(){ return {r:0,g:0,b:0,a:255}; });
    return merged;
  }

  if(elements.importBtn){
    elements.importBtn.addEventListener('click', function(){
      if(elements.fileInput) elements.fileInput.click();
    });
  }
  if(elements.fileInput){
    elements.fileInput.addEventListener('change', function(e){
      var file = e.target.files && e.target.files[0];
      if(!file) return;
      if(!file.type || !file.type.startsWith('image/')){
        alert('Please select an image file.');
        return;
      }
      setStatus('📁 Loading your image...');
      var fr = new FileReader();
      fr.onload = function(ev){
        loadImageFromDataURL(ev.target.result).then(function(){
          setStatus('✅ Image loaded.');
          if(elements.generateBtn) elements.generateBtn.disabled = false;
          if(elements.originalResolution) elements.originalResolution.textContent =
            'Original: ' + elements.sourceImage.naturalWidth + '×' + elements.sourceImage.naturalHeight + ' px';
        }).catch(function(err){
          console.error(err);
          setStatus('❌ Failed to load the image.');
        });
      };
      fr.readAsDataURL(file);
    });
  }

  if(elements.loadUrlBtn){
    elements.loadUrlBtn.addEventListener('click', function(){
      var url = elements.urlInput ? (elements.urlInput.value||'').trim() : '';
      if(!url){ alert('Enter an image URL.'); return; }
      loadImageFromUrl(url);
    });
  }

  setupSlider(elements.pathSimplificationSlider, elements.pathSimplificationValue, 0);
  setupSlider(elements.cornerSharpnessSlider, elements.cornerSharpnessValue, 0);
  setupSlider(elements.curveStraightnessSlider, elements.curveStraightnessValue, 0);
  setupSlider(elements.colorPrecisionSlider, elements.colorPrecisionValue, 0);

  if(elements.generateBtn){
    elements.generateBtn.addEventListener('click', function(){
      if(!elements.sourceImage || !elements.sourceImage.naturalWidth){
        alert('Load an image first.'); return;
      }
      setStatus('🧠 Converting...');
      try{
        var canvas = autoscaleToCanvas(elements.sourceImage);
        var imgd = ImageTracer.getImgdata(canvas);
        var options = buildOptions();
        lastOptions = options;
        tracedata = ImageTracer.imagedataToTracedata(imgd, options);

        visibleLayerIndices = [];
        for(var i=0;i<tracedata.layers.length;i++) visibleLayerIndices.push(i);

        buildLayerButtons(tracedata);
        renderPreviews(tracedata, options);
        updateQuality(tracedata);
        setStatus('✅ Preview ready. Use Download buttons to export.');
        if(elements.downloadTinkercadBtn) elements.downloadTinkercadBtn.disabled = false;
        if(elements.downloadSilhouetteBtn) elements.downloadSilhouetteBtn.disabled = false;
      }catch(err){
        console.error(err);
        setStatus('❌ Conversion failed. Try a simpler or smaller image.');
      }
    });
  }

  if(elements.downloadTinkercadBtn){
    elements.downloadTinkercadBtn.addEventListener('click', function(){
      if(!tracedata || !lastOptions){
        alert('Generate a preview first.'); return;
      }
      var base = 'image';
      if(originalImageUrl){
        try{
          var parts = originalImageUrl.split(/[\\/]/);
          base = parts[parts.length-1].replace(/\.[^/.]+$/, '') || 'image';
        }catch(e){}
      }

      var sil = createSilhouette(tracedata);
      var svgSil = ImageTracer.getsvgstring(sil, lastOptions);
      downloadSVGString(svgSil, base + '_layer_background');

      var selected = visibleLayerIndices.length ? visibleLayerIndices.slice() : [];
      if(selected.length === 0){
        for(var i=0;i<tracedata.layers.length;i++){
          var sub = tracedataSubset(tracedata, [i]);
          var svg = ImageTracer.getsvgstring(sub, lastOptions);
          downloadSVGString(svg, base + '_layer' + (i+1));
        }
      }else{
        for(var k=0;k<selected.length;k++){
          var idx = selected[k];
          var sub2 = tracedataSubset(tracedata, [idx]);
          var svg2 = ImageTracer.getsvgstring(sub2, lastOptions);
          downloadSVGString(svg2, base + '_layer' + (idx+1));
        }
      }
      setStatus('🎭 Background and layer files downloaded.');
    });
  }

  if(elements.downloadSilhouetteBtn){
    elements.downloadSilhouetteBtn.addEventListener('click', function(){
      if(!tracedata || !lastOptions){
        alert('Generate a preview first.'); return;
      }
      var sil = createSilhouette(tracedata);
      var svg = ImageTracer.getsvgstring(sil, lastOptions);
      downloadSVGString(svg, 'solid-base-silhouette');
      setStatus('🎭 Solid background downloaded.');
    });
  }

  setStatus('Ready for 3D printing magic! ✨');
})();
