/*
    Genesis Framework - SVG Creator
    Enhanced converter.js with a decoupled workflow, improved UI feedback,
    and more robust state management.
*/
/* global ImageTracer, chrome */

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM elements ---
    const elements = {
        welcomeScreen: document.getElementById('welcome-screen'),
        mainContent: document.getElementById('main-content'),
        loaderOverlay: document.getElementById('loader-overlay'),
        sourceImage: document.getElementById('source-image'),
        statusText: document.getElementById('status-text'),
        importBtn: document.getElementById('import-btn'),
        fileInput: document.getElementById('file-input'),
        urlInput: document.getElementById('url-input'),
        loadUrlBtn: document.getElementById('load-url-btn'),
        originalResolution: document.getElementById('original-resolution'),
        resolutionNotice: document.getElementById('resolution-notice'),
        generateBtn: document.getElementById('generate-btn'),
        resetBtn: document.getElementById('reset-btn'),
        colorControls: document.getElementById('color-controls'),
        pathControls: document.getElementById('path-controls'),
        pathSimplificationSlider: document.getElementById('path-simplification'),
        pathSimplificationValue: document.getElementById('path-simplification-value'),
        pathSimplificationTooltip: document.getElementById('path-simplification-tooltip'),
        cornerSharpnessSlider: document.getElementById('corner-sharpness'),
        cornerSharpnessValue: document.getElementById('corner-sharpness-value'),
        cornerSharpnessTooltip: document.getElementById('corner-sharpness-tooltip'),
        curveStraightnessSlider: document.getElementById('curve-straightness'),
        curveStraightnessValue: document.getElementById('curve-straightness-value'),
        curveStraightnessTooltip: document.getElementById('curve-straightness-tooltip'),
        colorPrecisionSlider: document.getElementById('color-precision'),
        colorPrecisionValue: document.getElementById('color-precision-value'),
        colorPrecisionTooltip: document.getElementById('color-precision-tooltip'),
        removeBgCheckbox: document.getElementById('remove-bg'),
        svgPreview: document.getElementById('svg-preview'),
        svgPreviewFiltered: document.getElementById('svg-preview-filtered'),
        qualityIndicator: document.getElementById('quality-indicator'),
        selectedLayerText: document.getElementById('selected-layer-text'),
        paletteContainer: document.getElementById('palette-container'),
        paletteRow: document.getElementById('palette-row'),
        outputSection: document.getElementById('output-section'),
        finalPaletteContainer: document.getElementById('final-palette-container'),
        downloadTinkercadBtn: document.getElementById('download-tinkercad-btn'),
        downloadSilhouetteBtn: document.getElementById('download-silhouette-btn'),
        layerMergingSection: document.getElementById('layer-merging-section'),
        mergeRulesContainer: document.getElementById('merge-rules-container'),
        addMergeRuleBtn: document.getElementById('add-merge-rule-btn'),
        combineAndDownloadBtn: document.getElementById('combine-and-download-btn')
    };

    // --- State Management ---
    let state = {
        quantizedData: null,
        tracedata: null,
        originalImageUrl: null,
        bgEstimate: null,
        lastOptions: null,
        silhouetteTracedata: null,
        mergeRules: [],
        initialSliderValues: {},
        isDirty: false,
        selectedLayerIndices: new Set(),
        tooltipTimeout: null,
        isColorStage: true
    };

    const SLIDER_TOOLTIPS = {
        'path-simplification': 'Higher values remove more small details and noise.',
        'corner-sharpness': 'Higher values create crisper, more defined corners.',
        'curve-straightness': 'Higher values make curved lines more straight.',
        'color-precision': 'Higher values find more distinct color layers.'
    };

    // --- Core Functions ---

    function showLoader(show) {
        elements.loaderOverlay.style.display = show ? 'flex' : 'none';
    }

    function showWorkspace(show) {
        elements.welcomeScreen.style.display = show ? 'none' : 'flex';
        elements.mainContent.style.display = show ? 'block' : 'none';
    }

    function saveInitialSliderValues() {
        state.initialSliderValues = {
            pathSimplification: elements.pathSimplificationSlider.value,
            cornerSharpness: elements.cornerSharpnessSlider.value,
            curveStraightness: elements.curveStraightnessSlider.value,
            colorPrecision: elements.colorPrecisionSlider.value,
            removeBg: elements.removeBgCheckbox.checked
        };
        state.isDirty = false;
        elements.resetBtn.style.display = 'none';
    }

    function resetSlidersToInitial() {
        if (!state.initialSliderValues) return;
        
        elements.pathSimplificationSlider.value = state.initialSliderValues.pathSimplification;
        elements.cornerSharpnessSlider.value = state.initialSliderValues.cornerSharpness;
        elements.curveStraightnessSlider.value = state.initialSliderValues.curveStraightness;
        elements.colorPrecisionSlider.value = state.initialSliderValues.colorPrecision;
        elements.removeBgCheckbox.checked = state.initialSliderValues.removeBg;

        updateAllSliderDisplays();
        
        if (elements.sourceImage.src) {
            setWorkflowStage(true); // Go back to color stage
            elements.generateBtn.click();
        }
        
        state.isDirty = false;
        elements.resetBtn.style.display = 'none';
    }

    function updateAllSliderDisplays() {
        elements.pathSimplificationValue.textContent = elements.pathSimplificationSlider.value;
        elements.cornerSharpnessValue.textContent = elements.cornerSharpnessSlider.value;
        elements.curveStraightnessValue.textContent = elements.curveStraightnessSlider.value;
        elements.colorPrecisionValue.textContent = elements.colorPrecisionSlider.value;
    }
    
    const debounce = (fn, ms = 250) => {
        let timeout;
        return (...args) => {
            clearTimeout(timeout);
            timeout = setTimeout(() => fn(...args), ms);
        };
    };

    const debounceTrace = debounce(() => {
        if (!elements.generateBtn.disabled) {
            traceVectorPaths();
        }
    });

    // --- Workflow Stage Management ---
    function setWorkflowStage(isColorStage) {
        state.isColorStage = isColorStage;
        elements.colorControls.disabled = !isColorStage;
        elements.pathControls.disabled = isColorStage;
        
        if (isColorStage) {
            elements.generateBtn.textContent = '1. Analyze Colors';
            elements.colorControls.style.opacity = 1;
            elements.pathControls.style.opacity = 0.5;
        } else {
            elements.generateBtn.textContent = '2. Refine Paths'; // Or hide, or change to "Re-analyze"
            elements.colorControls.style.opacity = 0.5;
            elements.pathControls.style.opacity = 1;
        }
    }

    // --- Main Generation Logic ---
    async function mainButtonClick() {
        if (state.isColorStage) {
            await analyzeColors();
            setWorkflowStage(false); // Move to path stage
            await traceVectorPaths(); // Run initial trace
        } else {
            // This button could be used to go back to color analysis
            setWorkflowStage(true);
        }
    }

    async function analyzeColors() {
        showLoader(true);
        elements.statusText.textContent = '🎨 Analyzing colors...';
        disableDownloadButtons();
        
        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const width = elements.sourceImage.naturalWidth;
                    const height = elements.sourceImage.naturalHeight;
                    if (!width || !height) throw new Error('Invalid image dimensions');

                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(elements.sourceImage, 0, 0, width, height);
                    const imageData = ctx.getImageData(0, 0, width, height);

                    state.bgEstimate = null;
                    if (elements.removeBgCheckbox.checked) {
                        state.bgEstimate = estimateEdgeBackground(imageData);
                        knockOutBackground(imageData, state.bgEstimate, 30);
                    }

                    const options = buildOptimizedOptions();
                    state.lastOptions = options;
                    
                    state.quantizedData = ImageTracer.colorquantization(imageData, options);
                    
                    if (!state.quantizedData || !state.quantizedData.palette) {
                        throw new Error('Color analysis failed.');
                    }
                    
                    displayPalette();
                    prepareMergeUIAfterGeneration();
                    elements.outputSection.style.display = 'block';
                    resolve();

                } catch (error) {
                    console.error('Color analysis error:', error);
                    elements.statusText.textContent = `❌ Error: ${error.message}`;
                    reject(error);
                } finally {
                    showLoader(false);
                }
            }, 50);
        });
    }

    async function traceVectorPaths() {
        if (!state.quantizedData) return;
        showLoader(true);
        elements.statusText.textContent = '✍️ Tracing vector paths...';
        elements.generateBtn.disabled = true;
        
        return new Promise((resolve, reject) => {
            setTimeout(async () => {
                try {
                    const options = buildOptimizedOptions();
                    state.lastOptions = options;
                    
                    const ii = state.quantizedData;
                    const tracedata = {
                        layers: [],
                        palette: ii.palette,
                        width: ii.array[0].length - 2,
                        height: ii.array.length - 2
                    };

                    for (let colornum = 0; colornum < ii.palette.length; colornum++) {
                        const tracedlayer = ImageTracer.batchtracepaths(
                            ImageTracer.internodes(
                                ImageTracer.pathscan(
                                    ImageTracer.layeringstep(ii, colornum),
                                    options.pathomit
                                ),
                                options
                            ),
                            options.ltres,
                            options.qtres
                        );
                        tracedata.layers.push(tracedlayer);
                    }
                    
                    state.tracedata = tracedata;
                    state.silhouetteTracedata = createSolidSilhouette(state.tracedata);

                    renderPreviews();
                    updateFilteredPreview();
                    const quality = assess3DPrintQuality(state.tracedata);
                    updateQualityDisplay(quality);
                    elements.statusText.textContent = `✅ Preview generated!`;
                    enableDownloadButtons();
                    resolve();

                } catch (error) {
                    console.error('Tracing error:', error);
                    elements.statusText.textContent = `❌ Error: ${error.message}`;
                    reject(error);
                } finally {
                    showLoader(false);
                    elements.generateBtn.disabled = false;
                }
            }, 50);
        });
    }


    function buildOptimizedOptions() {
        const P = parseInt(elements.pathSimplificationSlider.value);
        const C = parseInt(elements.cornerSharpnessSlider.value);
        const S = parseInt(elements.curveStraightnessSlider.value);
        const CP = parseInt(elements.colorPrecisionSlider.value);

        const map = (t, a, b) => (a + (b - a) * (t / 100));
        const mapInv = (t, a, b) => (a + (b - a) * (1 - (t / 100)));

        const rel = Math.max(0.5, Math.sqrt(elements.sourceImage.naturalWidth * elements.sourceImage.naturalHeight) / 512);

        let options = Object.assign({}, ImageTracer.optionpresets.default, {
            viewbox: true,
            strokewidth: 0
        });
        
        options.pathomit = Math.round(map(P, 0, 20) * rel);
        options.roundcoords = Math.round(map(P, 1, 3));
        options.blurradius = +map(P, 0, 1.2).toFixed(1);
        options.qtres = +mapInv(C, 4.0, 0.2).toFixed(2);
        options.rightangleenhance = (C >= 50);
        options.ltres = +map(S, 0.2, 8.0).toFixed(2);
        
        options.colorsampling = 2; 
        options.colorquantcycles = Math.max(1, Math.round(map(CP, 3, 10)));
        options.mincolorratio = +mapInv(CP, 0.03, 0.0).toFixed(3);
        options.numberofcolors = Math.max(4, Math.min(20, 4 + Math.round(CP * 0.16)));

        return options;
    }

    // --- UI Update Functions ---

    function renderPreviews() {
        if (!state.tracedata) return;
        const visibleIndices = getVisiblePaletteIndices();
        const previewData = buildTracedataSubset(state.tracedata, visibleIndices)
        const svgString = ImageTracer.getsvgstring(previewData, state.lastOptions);
        elements.svgPreview.data = `data:image/svg+xml;base64,${btoa(svgString)}`;
    }
    
    function updateFilteredPreview() {
        if (!state.tracedata) return;

        let dataToShow = state.tracedata;
        let indicesToRender = Array.from(state.selectedLayerIndices);
        let isMergedPreview = false;

        if (state.mergeRules.length > 0) {
            const visibleIndices = getVisiblePaletteIndices();
            dataToShow = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
            indicesToRender = Array.from({length: dataToShow.palette.length - 1}, (_, i) => i + 1);
            isMergedPreview = true;
        }

        if (indicesToRender.length === 0) {
            elements.svgPreviewFiltered.data = '';
            elements.selectedLayerText.textContent = isMergedPreview ? 'Merged Preview' : 'Select layers to preview';
            return;
        }
        
        const filteredData = buildTracedataSubset(dataToShow, indicesToRender);
        const svgString = ImageTracer.getsvgstring(filteredData, state.lastOptions);
        elements.svgPreviewFiltered.data = `data:image/svg+xml;base64,${btoa(svgString)}`;
        elements.selectedLayerText.textContent = isMergedPreview 
            ? `Merged Preview (${indicesToRender.length} colors)`
            : `Previewing ${indicesToRender.length} layer(s)`;
    }

    function updateQualityDisplay(quality) {
        elements.qualityIndicator.textContent = `${quality.pathCount} paths, ${quality.colorCount} colors`;
    }

    // --- Event Listeners ---

    elements.importBtn.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => loadImage(e.target.result, file.name);
            reader.readAsDataURL(file);
        }
    });

    elements.loadUrlBtn.addEventListener('click', () => {
        const url = elements.urlInput.value.trim();
        if (url) loadImageFromUrl(url);
    });

    elements.generateBtn.addEventListener('click', mainButtonClick);
    elements.resetBtn.addEventListener('click', resetSlidersToInitial);

    document.querySelectorAll('.control-panel input[type="range"]').forEach(slider => {
        slider.addEventListener('input', (e) => {
            if (!state.isDirty) {
                state.isDirty = true;
                elements.resetBtn.style.display = 'inline';
            }
            updateAllSliderDisplays();
            
            const tooltipId = e.target.id + '-tooltip';
            const tooltipEl = document.getElementById(tooltipId);
            if (tooltipEl) {
                tooltipEl.textContent = SLIDER_TOOLTIPS[e.target.id];
                tooltipEl.style.opacity = '1';
                clearTimeout(state.tooltipTimeout);
                state.tooltipTimeout = setTimeout(() => {
                    tooltipEl.style.opacity = '0';
                }, 2000);
            }

            if (state.isColorStage) {
                // No need to debounce, color changes will be applied on next step
            } else {
                debounceTrace();
            }
        });
    });
    
    elements.removeBgCheckbox.addEventListener('input', () => {
        if (!state.isDirty) {
            state.isDirty = true;
            elements.resetBtn.style.display = 'inline';
        }
    });


    // --- Image Loading ---

    function loadImage(src, name) {
        state.originalImageUrl = name;
        elements.sourceImage.src = src;
        state.autoGeneratedOnce = false;
    }

    async function loadImageFromUrl(url) {
        showLoader(true);
        elements.statusText.textContent = '🌐 Fetching image...';
        try {
            let dataUrl;
            if (url.startsWith('data:')) {
                dataUrl = url;
            } else if (typeof chrome !== 'undefined' && chrome.runtime?.connect) {
                dataUrl = await new Promise((resolve, reject) => {
                    const port = chrome.runtime.connect({ name: 'fetchImagePort' });
                    port.postMessage({ type: 'fetchImage', url });
                    port.onMessage.addListener((response) => {
                        if (response.dataUrl) resolve(response.dataUrl);
                        else reject(new Error(response.error || 'Failed to fetch'));
                    });
                });
            } else {
                const response = await fetch(url);
                const blob = await response.blob();
                dataUrl = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onloadend = () => resolve(reader.result);
                    reader.onerror = reject;
                    reader.readAsDataURL(blob);
                });
            }
            loadImage(dataUrl, url.split('/').pop());
        } catch (error) {
            console.error('URL load error:', error);
            elements.statusText.textContent = '❌ Failed to load image from URL.';
            showLoader(false);
        }
    }

    elements.sourceImage.onload = () => {
        showWorkspace(true);
        elements.generateBtn.disabled = false;
        
        const w = elements.sourceImage.naturalWidth;
        const h = elements.sourceImage.naturalHeight;
        elements.originalResolution.textContent = `${w}×${h} px`;
        
        if (w < 512 || h < 512) {
            elements.resolutionNotice.textContent = '⚠️ Low resolution detected. For best results, use images larger than 512x512 pixels.';
            elements.resolutionNotice.style.display = 'block';
        } else {
            elements.resolutionNotice.style.display = 'none';
        }
        
        const hasTransparency = detectTransparency(elements.sourceImage);
        elements.removeBgCheckbox.disabled = hasTransparency;
        elements.removeBgCheckbox.checked = !hasTransparency;
        
        setWorkflowStage(true);
        saveInitialSliderValues();
        elements.generateBtn.click();
        
        showLoader(false);
    };
    
    // --- Utility & Helper Functions ---

    function disableDownloadButtons() {
        [elements.downloadTinkercadBtn, elements.downloadSilhouetteBtn, elements.combineAndDownloadBtn].forEach(btn => {
            if(btn) btn.disabled = true;
        });
    }

    function enableDownloadButtons() {
        [elements.downloadTinkercadBtn, elements.downloadSilhouetteBtn].forEach(btn => {
            if(btn) btn.disabled = false;
        });
        elements.combineAndDownloadBtn.disabled = state.mergeRules.length === 0;
    }

    function getVisiblePaletteIndices() {
        if (!state.tracedata && !state.quantizedData) return [];
        const palette = state.tracedata ? state.tracedata.palette : state.quantizedData.palette;
        const layers = state.tracedata ? state.tracedata.layers : null;

        const indices = [];
        for (let i = 1; i < palette.length; i++) {
            const hasPaths = layers ? layerHasPaths(layers[i]) : true;
            if (!shouldHideColor(palette[i], i) && hasPaths) {
                indices.push(i);
            }
        }
        return indices;
    }

    function shouldHideColor(color, index) {
        if (index === 0) return true;
        const luma = 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
        if (color.a > 180 && luma >= 245) return true;
        if (state.bgEstimate) {
            const distance = Math.abs(color.r - state.bgEstimate.r) + Math.abs(color.g - state.bgEstimate.g) + Math.abs(color.b - state.bgEstimate.b);
            if (distance <= 30) return true;
        }
        return false;
    }
    
    function layerHasPaths(layer) {
        return Array.isArray(layer) && layer.length > 0;
    }
    
    function displayPalette() {
        const paletteSource = state.tracedata || state.quantizedData;
        if (!paletteSource) return;

        elements.paletteContainer.innerHTML = '';
        state.selectedLayerIndices.clear();
        const visibleIndices = getVisiblePaletteIndices();
        if (visibleIndices.length === 0) {
            elements.paletteRow.style.display = 'none';
            return;
        }
        visibleIndices.forEach((index, ord) => {
            const color = paletteSource.palette[index];
            const swatch = document.createElement('div');
            swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500 cursor-pointer transition-all';
            swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
            swatch.title = `Layer ${ord + 1}`;
            swatch.dataset.index = index;
            swatch.addEventListener('click', () => {
                if (state.selectedLayerIndices.has(index)) {
                    state.selectedLayerIndices.delete(index);
                    swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                } else {
                    state.selectedLayerIndices.add(index);
                    swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                }
                updateFilteredPreview();
            });
            elements.paletteContainer.appendChild(swatch);
        });
        elements.paletteRow.style.display = 'block';
    }
    
    function mergeSimilarColors(tracedata, threshold) {
        if (!tracedata || !tracedata.palette) return tracedata;
        const { palette, layers } = tracedata;
        const used = new Array(palette.length).fill(false);
        const groups = [];
        for (let i = 1; i < palette.length; i++) {
            if (used[i]) continue;
            const group = [i];
            used[i] = true;
            const color1 = palette[i];
            for (let j = i + 1; j < palette.length; j++) {
                if (used[j]) continue;
                const color2 = palette[j];
                const distance = Math.sqrt(Math.pow(color1.r - color2.r, 2) + Math.pow(color1.g - color2.g, 2) + Math.pow(color1.b - color2.b, 2));
                if (distance <= threshold) {
                    group.push(j);
                    used[j] = true;
                }
            }
            groups.push(group);
        }
        const newPalette = [palette[0]];
        const newLayers = [layers[0]];
        groups.forEach(group => {
            const repColor = palette[group[0]];
            const mergedPaths = [];
            group.forEach(idx => {
                if (Array.isArray(layers[idx])) {
                    mergedPaths.push(...layers[idx]);
                }
            });
            newPalette.push(repColor);
            newLayers.push(mergedPaths);
        });
        return { ...tracedata, palette: newPalette, layers: newLayers };
    }

    function createSolidSilhouette(tracedata) {
        if (!tracedata) return null;
        const visibleIndices = getVisiblePaletteIndices();
        if (!visibleIndices.length) return null;
        const subset = buildTracedataSubset(tracedata, visibleIndices);
        let mergedPaths = [];
        subset.layers.forEach(layer => { if (Array.isArray(layer)) mergedPaths = mergedPaths.concat(layer); });
        return {
            width: subset.width,
            height: subset.height,
            layers: [mergedPaths],
            palette: [{ r: 0, g: 0, b: 0, a: 255 }]
        };
    }

    function assess3DPrintQuality(tracedata) {
        if (!tracedata) return { pathCount: 0, colorCount: 0 };
        const totalPaths = tracedata.layers.reduce((sum, layer) => sum + (Array.isArray(layer) ? layer.length : 0), 0);
        const visibleColors = countVisibleLayers(tracedata);
        return { pathCount: totalPaths, colorCount: visibleColors };
    }

    function countVisibleLayers(tracedata) {
        if (!tracedata) return 0;
        return getVisiblePaletteIndices().length;
    }

    function buildTracedataSubset(source, indices) {
        if (!source) return null;
        const layers = [];
        const palette = [];
        indices.forEach(idx => {
            if (source.layers[idx] && source.palette[idx]) {
                layers.push(JSON.parse(JSON.stringify(source.layers[idx])));
                palette.push(source.palette[idx]);
            }
        });
        return { ...source, layers, palette };
    }
    
    function detectTransparency(img) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(img.naturalWidth, 100);
        canvas.height = Math.min(img.naturalHeight, 100);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 250) return true;
        }
        return false;
    }

    function estimateEdgeBackground(imageData) {
        const { width, height, data } = imageData;
        let r = 0, g = 0, b = 0, count = 0;
        const step = Math.max(1, Math.floor(Math.min(width, height) / 50));
        const sample = (x, y) => {
            const i = (y * width + x) * 4;
            r += data[i]; g += data[i+1]; b += data[i+2]; count++;
        };
        for (let x = 0; x < width; x += step) { sample(x, 0); sample(x, height - 1); }
        for (let y = 1; y < height - 1; y += step) { sample(0, y); sample(width - 1, y); }
        return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count), a: 255 };
    }

    function knockOutBackground(imageData, bgColor, threshold = 30) {
        const data = imageData.data;
        for (let i = 0; i < data.length; i += 4) {
            const distance = Math.abs(data[i] - bgColor.r) + Math.abs(data[i+1] - bgColor.g) + Math.abs(data[i+2] - bgColor.b);
            if (distance <= threshold) data[i+3] = 0;
        }
    }

    function downloadSVG(svgContent, baseName) {
        const blob = new Blob([svgContent], { type: 'image/svg+xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${baseName || 'converted'}.svg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }
    
    elements.downloadTinkercadBtn.addEventListener('click', () => {
        if (!state.tracedata) return;
        const visibleIndices = getVisiblePaletteIndices();
        if (!visibleIndices.length) return;
        const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
        
        if (state.silhouetteTracedata) {
            const svgStringSilhouette = ImageTracer.getsvgstring(state.silhouetteTracedata, state.lastOptions);
            downloadSVG(svgStringSilhouette, `${imageName}_layer_background`);
        }
        
        visibleIndices.forEach((idx, ordinal) => {
            const singleLayer = buildTracedataSubset(state.tracedata, [idx]);
            downloadSVG(ImageTracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_layer_${ordinal + 1}`);
        });
    });

    elements.downloadSilhouetteBtn.addEventListener('click', () => {
        if (!state.silhouetteTracedata) return;
        const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
        downloadSVG(ImageTracer.getsvgstring(state.silhouetteTracedata, state.lastOptions), `${imageName}_background`);
    });

    // Layer Merging Logic
    function prepareMergeUIAfterGeneration() {
        state.mergeRules = [];
        elements.mergeRulesContainer.innerHTML = '';
        const visibleIndices = getVisiblePaletteIndices();
        if (visibleIndices.length >= 2) {
            elements.layerMergingSection.style.display = 'block';
            elements.addMergeRuleBtn.disabled = false;
        } else {
            elements.layerMergingSection.style.display = 'none';
        }
        elements.combineAndDownloadBtn.disabled = true;
        updateFinalPalette();
    }

    elements.addMergeRuleBtn.addEventListener('click', () => {
        const ruleIndex = state.mergeRules.length;
        const visibleIndices = getVisiblePaletteIndices();
        if (visibleIndices.length < 2) return;

        const defaultRule = { source: 0, target: 1 };
        state.mergeRules.push(defaultRule);

        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 text-sm';
        const optionsHTML = visibleIndices.map((_, ord) => `<option value="${ord}">Layer ${ord + 1}</option>`).join('');
        
        row.innerHTML = `
            <span>Merge</span>
            <span class="w-4 h-4 rounded border border-gray-500" data-swatch="source"></span>
            <select data-rule-index="${ruleIndex}" data-type="source" class="border rounded-md p-1 bg-gray-700 border-gray-600 text-white">${optionsHTML}</select>
            <span>into</span>
            <span class="w-4 h-4 rounded border border-gray-500" data-swatch="target"></span>
            <select data-rule-index="${ruleIndex}" data-type="target" class="border rounded-md p-1 bg-gray-700 border-gray-600 text-white">${optionsHTML}</select>
            <button data-rule-index="${ruleIndex}" class="text-red-500 hover:text-red-400 font-bold text-lg">&times;</button>
        `;
        
        row.querySelector('select[data-type="target"]').value = 1;
        elements.mergeRulesContainer.appendChild(row);
        updateMergeRuleSwatches(row, defaultRule);
        elements.combineAndDownloadBtn.disabled = false;
        updateFinalPalette();
        updateFilteredPreview();
    });

    elements.mergeRulesContainer.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT') {
            const ruleIndex = parseInt(e.target.dataset.ruleIndex);
            const type = e.target.dataset.type;
            state.mergeRules[ruleIndex][type] = parseInt(e.target.value);
            updateMergeRuleSwatches(e.target.parentElement, state.mergeRules[ruleIndex]);
            updateFinalPalette();
            updateFilteredPreview();
        }
    });
    
    elements.mergeRulesContainer.addEventListener('click', (e) => {
        if (e.target.tagName === 'BUTTON') {
            const ruleIndex = parseInt(e.target.dataset.ruleIndex);
            state.mergeRules.splice(ruleIndex, 1);
            e.target.parentElement.remove();
            
            document.querySelectorAll('#merge-rules-container > div').forEach((row, i) => {
                row.querySelectorAll('[data-rule-index]').forEach(el => el.dataset.ruleIndex = i);
            });
            if (state.mergeRules.length === 0) {
                elements.combineAndDownloadBtn.disabled = true;
            }
            updateFinalPalette();
            updateFilteredPreview();
        }
    });
    
    function updateMergeRuleSwatches(row, rule) {
        const visibleIndices = getVisiblePaletteIndices();
        const sourceColor = state.tracedata.palette[visibleIndices[rule.source]];
        const targetColor = state.tracedata.palette[visibleIndices[rule.target]];
        row.querySelector('[data-swatch="source"]').style.backgroundColor = `rgb(${sourceColor.r},${sourceColor.g},${sourceColor.b})`;
        row.querySelector('[data-swatch="target"]').style.backgroundColor = `rgb(${targetColor.r},${targetColor.g},${targetColor.b})`;
    }

    elements.combineAndDownloadBtn.addEventListener('click', () => {
        const visibleIndices = getVisiblePaletteIndices();
        const mergedData = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
        if (!mergedData) return;

        const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
        const newVisibleIndices = Array.from({length: mergedData.palette.length - 1}, (_, i) => i + 1);

        const mergedSilhouette = createSolidSilhouette(mergedData);
        if (mergedSilhouette) {
            downloadSVG(ImageTracer.getsvgstring(mergedSilhouette, state.lastOptions), `${imageName}_final_background`);
        }

        newVisibleIndices.forEach((idx, ord) => {
            const singleLayer = buildTracedataSubset(mergedData, [idx]);
            downloadSVG(ImageTracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_final_layer_${ord + 1}`);
        });
    });

    function createMergedTracedata(sourceData, visibleIndices, rules) {
        if (!sourceData || !visibleIndices || !rules) return sourceData;

        let finalTargets = {};
        visibleIndices.forEach((_, ruleIndex) => finalTargets[ruleIndex] = ruleIndex);

        rules.forEach(rule => {
            let ultimateTarget = rule.target;
            while (finalTargets[ultimateTarget] !== ultimateTarget) {
                ultimateTarget = finalTargets[ultimateTarget];
            }
            finalTargets[rule.source] = ultimateTarget;
        });

        Object.keys(finalTargets).forEach(key => {
            let current = parseInt(key);
            while (finalTargets[current] !== current) {
                current = finalTargets[current];
            }
            finalTargets[key] = current;
        });

        const groups = {};
        visibleIndices.forEach((originalIndex, ruleIndex) => {
            const finalTargetRuleIndex = finalTargets[ruleIndex];
            if (!groups[finalTargetRuleIndex]) {
                groups[finalTargetRuleIndex] = [];
            }
            groups[finalTargetRuleIndex].push(originalIndex);
        });

        const newPalette = [sourceData.palette[0]];
        const newLayers = [sourceData.layers[0]];

        Object.keys(groups).map(Number).sort((a, b) => a - b).forEach(targetRuleIndex => {
            const originalIndicesInGroup = groups[targetRuleIndex];
            const representativeOriginalIndex = visibleIndices[targetRuleIndex];
            
            newPalette.push(sourceData.palette[representativeOriginalIndex]);
            
            let mergedPaths = [];
            originalIndicesInGroup.forEach(originalIndex => {
                if (sourceData.layers[originalIndex]) {
                    mergedPaths.push(...sourceData.layers[originalIndex]);
                }
            });
            newLayers.push(mergedPaths);
        });

        return { ...sourceData, palette: newPalette, layers: newLayers };
    }
    
    function updateFinalPalette() {
        elements.finalPaletteContainer.innerHTML = '';
        if (!state.tracedata) return;

        const visibleIndices = getVisiblePaletteIndices();
        const data = state.mergeRules.length > 0 ? createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules) : state.tracedata;
        const palette = state.mergeRules.length > 0 ? data.palette.slice(1) : visibleIndices.map(i => state.tracedata.palette[i]);

        if (palette.length > 0) {
            palette.forEach((color, i) => {
                const swatch = document.createElement('div');
                swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500';
                swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
                swatch.title = `Final Layer ${i + 1}`;
                elements.finalPaletteContainer.appendChild(swatch);
            });
        }
    }

});