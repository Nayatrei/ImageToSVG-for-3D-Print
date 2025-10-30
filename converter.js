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
        savePngBtn: document.getElementById('save-png-btn'),
        saveJpgBtn: document.getElementById('save-jpg-btn'),
        saveSvgBtn: document.getElementById('save-svg-btn'),
        originalResolution: document.getElementById('original-resolution'),
        resolutionNotice: document.getElementById('resolution-notice'),
        analyzeColorsBtn: document.getElementById('analyze-colors-btn'),
        optimizePathsBtn: document.getElementById('optimize-paths-btn'),
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
        svgPreview: document.getElementById('svg-preview'),
        svgPreviewFiltered: document.getElementById('svg-preview-filtered'),
        previewResolution: document.getElementById('preview-resolution'),
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
        combineAndDownloadBtn: document.getElementById('combine-and-download-btn'),
        downloadCombinedLayersBtn: document.getElementById('download-combined-layers-btn')
    };

    // --- State Management ---
    let state = {
        quantizedData: null,
        tracedata: null,
        originalImageUrl: null,
        lastOptions: null,
        silhouetteTracedata: null,
        mergeRules: [],
        initialSliderValues: {},
        isDirty: false,
        selectedLayerIndices: new Set(),
        selectedFinalLayerIndices: new Set(),
        tooltipTimeout: null,
        colorsAnalyzed: false,
        zoom: {
            all: { scale: 1, x: 0, y: 0, isDragging: false },
            selected: { scale: 1, x: 0, y: 0, isDragging: false }
        }
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
        elements.mainContent.style.display = show ? 'flex' : 'none';
    }

    function saveInitialSliderValues() {
        state.initialSliderValues = {
            pathSimplification: elements.pathSimplificationSlider.value,
            cornerSharpness: elements.cornerSharpnessSlider.value,
            curveStraightness: elements.curveStraightnessSlider.value,
            colorPrecision: elements.colorPrecisionSlider.value
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

        updateAllSliderDisplays();
        
        if (elements.sourceImage.src) {
            state.colorsAnalyzed = false;
            elements.optimizePathsBtn.disabled = true;
            elements.analyzeColorsBtn.click();
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

    const debounceOptimizePaths = debounce(() => {
        if (state.colorsAnalyzed && !elements.optimizePathsBtn.disabled) {
            optimizePathsClick();
        }
    });

    // --- Main Generation Logic ---
    async function analyzeColorsClick() {
        await analyzeColors();
        state.colorsAnalyzed = true;
        elements.optimizePathsBtn.disabled = false;
        // Auto-trigger path optimization after color analysis
        await optimizePathsClick();
    }

    async function optimizePathsClick() {
        if (!state.quantizedData) return;
        await traceVectorPaths();
    }

    async function analyzeColors() {
        showLoader(true);
        elements.statusText.textContent = 'Analyzing colors...';
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

                    const options = buildOptimizedOptions();
                    state.lastOptions = options;
                    
                    state.quantizedData = ImageTracer.colorquantization(imageData, options);
                    
                    if (!state.quantizedData || !state.quantizedData.palette) {
                        throw new Error('Color analysis failed.');
                    }
                    
                    resolve();

                } catch (error) {
                    console.error('Color analysis error:', error);
                    elements.statusText.textContent = `Error: ${error.message}`;
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
        elements.statusText.textContent = 'Tracing vector paths...';
        elements.optimizePathsBtn.disabled = true;
        
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

                    // Now display palette based on traced data
                    displayPalette();
                    prepareMergeUIAfterGeneration();
                    elements.outputSection.style.display = 'flex';

                    renderPreviews();
                    updateFilteredPreview();
                    const quality = assess3DPrintQuality(state.tracedata);
                    updateQualityDisplay(quality);
                    elements.statusText.textContent = 'Preview generated!';
                    enableDownloadButtons();
                    resolve();

                } catch (error) {
                    console.error('Tracing error:', error);
                    elements.statusText.textContent = `Error: ${error.message}`;
                    reject(error);
                } finally {
                    showLoader(false);
                    elements.optimizePathsBtn.disabled = false;
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

    // --- Zoom and Pan Functions ---
    
    function setupZoomControls() {
        // Zoom button event listeners
        document.getElementById('zoom-in-all').addEventListener('click', () => zoomPreview('all', 1.25));
        document.getElementById('zoom-out-all').addEventListener('click', () => zoomPreview('all', 0.8));
        document.getElementById('zoom-reset-all').addEventListener('click', () => resetZoom('all'));
        
        document.getElementById('zoom-in-selected').addEventListener('click', () => zoomPreview('selected', 1.25));
        document.getElementById('zoom-out-selected').addEventListener('click', () => zoomPreview('selected', 0.8));
        document.getElementById('zoom-reset-selected').addEventListener('click', () => resetZoom('selected'));
        
        // Pan/drag functionality for both preview containers
        setupPanControls('all');
        setupPanControls('selected');
        
        // Initialize zoom displays
        updateZoomDisplay('all');
        updateZoomDisplay('selected');
    }
    
    function zoomPreview(type, factor) {
        const zoomState = state.zoom[type];
        const newScale = Math.max(0.1, Math.min(5, zoomState.scale * factor));
        zoomState.scale = newScale;
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }
    
    function resetZoom(type) {
        const zoomState = state.zoom[type];
        zoomState.scale = 1;
        zoomState.x = 0;
        zoomState.y = 0;
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }
    
    function updatePreviewTransform(type) {
        const container = document.querySelector(`[data-preview="${type}"]`);
        const content = container.querySelector('.preview-content');
        const zoomState = state.zoom[type];
        
        content.style.transform = `translate(${zoomState.x}px, ${zoomState.y}px) scale(${zoomState.scale})`;
        
        // Update container classes
        if (zoomState.scale > 1) {
            container.classList.add('zoomed');
        } else {
            container.classList.remove('zoomed');
        }
    }
    
    function updateZoomDisplay(type) {
        const zoomLevel = Math.round(state.zoom[type].scale * 100);
        const resetButton = document.getElementById(`zoom-reset-${type}`);
        resetButton.textContent = `${zoomLevel}%`;
        
        // Update button states
        const zoomInBtn = document.getElementById(`zoom-in-${type}`);
        const zoomOutBtn = document.getElementById(`zoom-out-${type}`);
        
        zoomInBtn.disabled = state.zoom[type].scale >= 5;
        zoomOutBtn.disabled = state.zoom[type].scale <= 0.1;
    }
    
    function setupPanControls(type) {
        const container = document.querySelector(`[data-preview="${type}"]`);
        const content = container.querySelector('.preview-content');
        let startX, startY, initialX, initialY;
        
        // Mouse events
        content.addEventListener('mousedown', (e) => {
            if (state.zoom[type].scale <= 1) return;
            
            e.preventDefault();
            state.zoom[type].isDragging = true;
            container.classList.add('dragging');
            
            startX = e.clientX;
            startY = e.clientY;
            initialX = state.zoom[type].x;
            initialY = state.zoom[type].y;
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!state.zoom[type].isDragging) return;
            
            e.preventDefault();
            const deltaX = e.clientX - startX;
            const deltaY = e.clientY - startY;
            
            state.zoom[type].x = initialX + deltaX;
            state.zoom[type].y = initialY + deltaY;
            
            updatePreviewTransform(type);
        });
        
        document.addEventListener('mouseup', () => {
            if (state.zoom[type].isDragging) {
                state.zoom[type].isDragging = false;
                container.classList.remove('dragging');
            }
        });
        
        // Touch events for mobile
        content.addEventListener('touchstart', (e) => {
            if (state.zoom[type].scale <= 1) return;
            
            e.preventDefault();
            state.zoom[type].isDragging = true;
            container.classList.add('dragging');
            
            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            initialX = state.zoom[type].x;
            initialY = state.zoom[type].y;
        }, { passive: false });
        
        document.addEventListener('touchmove', (e) => {
            if (!state.zoom[type].isDragging) return;
            
            e.preventDefault();
            const touch = e.touches[0];
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            
            state.zoom[type].x = initialX + deltaX;
            state.zoom[type].y = initialY + deltaY;
            
            updatePreviewTransform(type);
        }, { passive: false });
        
        document.addEventListener('touchend', () => {
            if (state.zoom[type].isDragging) {
                state.zoom[type].isDragging = false;
                container.classList.remove('dragging');
            }
        });
        
        // Wheel zoom
        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            const factor = e.deltaY > 0 ? 0.9 : 1.1;
            zoomPreview(type, factor);
        });
    }

    // --- SVG to PNG Conversion ---
    
    function svgToPng(svgString, maxSize = null) {
        return new Promise((resolve, reject) => {
            // Get selected resolution or use default
            const selectedRes = maxSize || parseInt(elements.previewResolution?.value || '512');
            const maxWidth = selectedRes;
            const maxHeight = selectedRes;
            
            // Create SVG blob
            const svgBlob = new Blob([svgString], { type: 'image/svg+xml' });
            const url = URL.createObjectURL(svgBlob);
            
            // Create image element
            const img = new Image();
            img.onload = () => {
                try {
                    // Calculate dimensions while maintaining aspect ratio
                    let { width, height } = img;
                    const aspectRatio = width / height;
                    
                    // Ensure minimum size while maintaining aspect ratio
                    if (width > height) {
                        if (width < maxWidth) {
                            width = maxWidth;
                            height = width / aspectRatio;
                        }
                        if (width > maxWidth) {
                            width = maxWidth;
                            height = width / aspectRatio;
                        }
                    } else {
                        if (height < maxHeight) {
                            height = maxHeight;
                            width = height * aspectRatio;
                        }
                        if (height > maxHeight) {
                            height = maxHeight;
                            width = height * aspectRatio;
                        }
                    }
                    
                    // Create canvas and draw
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    
                    const ctx = canvas.getContext('2d');
                    ctx.fillStyle = 'white';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                    
                    // Convert to PNG data URL
                    const pngDataUrl = canvas.toDataURL('image/png');
                    URL.revokeObjectURL(url);
                    resolve(pngDataUrl);
                    
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

    // --- UI Update Functions ---

    async function renderPreviews() {
        if (!state.tracedata) return;
        
        try {
            const visibleIndices = getVisibleLayerIndices();
            const previewData = buildTracedataSubset(state.tracedata, visibleIndices);
            const svgString = ImageTracer.getsvgstring(previewData, state.lastOptions);
            
            const pngDataUrl = await svgToPng(svgString);
            elements.svgPreview.src = pngDataUrl;
            elements.svgPreview.style.display = 'block';
            
        } catch (error) {
            console.error('Preview rendering failed:', error);
            elements.svgPreview.style.display = 'none';
        }
    }
    
    async function updateFilteredPreview() {
        if (!state.tracedata) return;

        let dataToShow = state.tracedata;
        let indicesToRender = [];

        if (state.mergeRules.length > 0) {
            const visibleIndices = getVisibleLayerIndices();
            dataToShow = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
            
            // Use selected final layers if any, otherwise show selected original layers
            if (state.selectedFinalLayerIndices.size > 0) {
                indicesToRender = Array.from(state.selectedFinalLayerIndices);
                elements.selectedLayerText.textContent = `Final Preview (${indicesToRender.length} layer(s))`;
            } else {
                indicesToRender = Array.from(state.selectedLayerIndices);
                elements.selectedLayerText.textContent = state.selectedLayerIndices.size > 0 
                    ? `Previewing ${indicesToRender.length} original layer(s)` 
                    : 'Select final layers to preview';
            }
        } else {
            // Original mode - use selected original layers
            indicesToRender = Array.from(state.selectedLayerIndices);
            elements.selectedLayerText.textContent = state.selectedLayerIndices.size > 0
                ? `Previewing ${indicesToRender.length} layer(s)`
                : 'Select layers to preview';
        }

        if (indicesToRender.length === 0) {
            elements.svgPreviewFiltered.style.display = 'none';
            return;
        }
        
        try {
            const filteredData = buildTracedataSubset(dataToShow, indicesToRender);
            const svgString = ImageTracer.getsvgstring(filteredData, state.lastOptions);
            
            const pngDataUrl = await svgToPng(svgString);
            elements.svgPreviewFiltered.src = pngDataUrl;
            elements.svgPreviewFiltered.style.display = 'block';
            
        } catch (error) {
            console.error('Filtered preview rendering failed:', error);
            elements.svgPreviewFiltered.style.display = 'none';
        }
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

    elements.analyzeColorsBtn.addEventListener('click', analyzeColorsClick);
    elements.optimizePathsBtn.addEventListener('click', optimizePathsClick);
    elements.resetBtn.addEventListener('click', resetSlidersToInitial);

    // Zoom control event listeners
    setupZoomControls();

    // Resolution change listener
    if (elements.previewResolution) {
        elements.previewResolution.addEventListener('change', () => {
            // Regenerate both previews with new resolution
            if (state.tracedata) {
                renderPreviews();
                updateFilteredPreview();
            }
        });
    }

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

            // If color precision changes, we need to re-analyze colors
            if (e.target.id === 'color-precision') {
                if (state.colorsAnalyzed && elements.sourceImage.src) {
                    state.colorsAnalyzed = false;
                    elements.optimizePathsBtn.disabled = true;
                    // Don't auto-trigger, let user click the button
                }
            } else {
                // For path-related settings, auto-optimize paths if colors are already analyzed
                if (state.colorsAnalyzed) {
                    debounceOptimizePaths();
                }
            }
        });
    });

    // --- Image Loading ---

    function loadImage(src, name) {
        state.originalImageUrl = name;
        elements.sourceImage.src = src;
    }

    async function loadImageFromUrl(url) {
        showLoader(true);
        elements.statusText.textContent = 'Fetching image...';
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
            elements.statusText.textContent = 'Failed to load image from URL.';
            showLoader(false);
        }
    }

    elements.sourceImage.onload = () => {
        showWorkspace(true);
        elements.analyzeColorsBtn.disabled = false;
        
        const w = elements.sourceImage.naturalWidth;
        const h = elements.sourceImage.naturalHeight;
        elements.originalResolution.textContent = `${w}×${h} px`;
        // Enable original save buttons once image is loaded
        if (elements.savePngBtn) elements.savePngBtn.disabled = false;
        if (elements.saveJpgBtn) elements.saveJpgBtn.disabled = false;
        if (elements.saveSvgBtn) elements.saveSvgBtn.disabled = false;
        
        if (w < 512 || h < 512) {
            elements.resolutionNotice.textContent = 'Low resolution detected. For best results, use images larger than 512x512 pixels.';
            elements.resolutionNotice.style.display = 'block';
        } else {
            elements.resolutionNotice.style.display = 'none';
        }
        
        state.colorsAnalyzed = false;
        elements.optimizePathsBtn.disabled = true;
        saveInitialSliderValues();
        elements.analyzeColorsBtn.click();
        
        showLoader(false);
    };
    
    // --- Utility & Helper Functions ---

    function disableDownloadButtons() {
        [elements.downloadTinkercadBtn, elements.downloadSilhouetteBtn, elements.combineAndDownloadBtn, elements.downloadCombinedLayersBtn].forEach(btn => {
            if(btn) btn.disabled = true;
        });
    }

    function enableDownloadButtons() {
        [elements.downloadTinkercadBtn, elements.downloadSilhouetteBtn].forEach(btn => {
            if(btn) btn.disabled = false;
        });
        elements.combineAndDownloadBtn.disabled = state.mergeRules.length === 0;
        if (elements.downloadCombinedLayersBtn) elements.downloadCombinedLayersBtn.disabled = false;
    }

    // NEW: Get visible layer indices based on traced data (only layers with actual paths)
    function getVisibleLayerIndices() {
        if (!state.tracedata) return [];
        
        const indices = [];
        for (let i = 0; i < state.tracedata.layers.length; i++) {
            if (layerHasPaths(state.tracedata.layers[i])) {
                indices.push(i);
            }
        }
        return indices;
    }
    
    function layerHasPaths(layer) {
        return Array.isArray(layer) && layer.length > 0;
    }
    
    // NEW: Display palette based on traced data only
    function displayPalette() {
        if (!state.tracedata) return;
        
        elements.paletteContainer.innerHTML = '';
        state.selectedLayerIndices.clear();
        const visibleIndices = getVisibleLayerIndices();
        
        if (visibleIndices.length === 0) {
            elements.paletteRow.style.display = 'none';
            return;
        }

        visibleIndices.forEach((index) => {
            const color = state.tracedata.palette[index];
            
            // Create container for swatch and label
            const container = document.createElement('div');
            container.className = 'flex flex-col items-center gap-1';
            
            const swatch = document.createElement('div');
            swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500 cursor-pointer transition-all';
            swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
            
            // Special styling for layer 0 (background)
            if (index === 0) {
                swatch.className += ' background-layer';
                swatch.title = `Layer ${index} (Background)`;
            } else {
                swatch.title = `Layer ${index}`;
            }
            
            // Layer number label (initially hidden)
            const label = document.createElement('div');
            label.className = 'text-xs text-gray-400 opacity-0 transition-opacity';
            label.textContent = `Layer ${index}`;
            
            swatch.dataset.index = index;
            swatch.addEventListener('click', () => {
                if (state.selectedLayerIndices.has(index)) {
                    state.selectedLayerIndices.delete(index);
                    swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.add('opacity-0');
                } else {
                    state.selectedLayerIndices.add(index);
                    swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.remove('opacity-0');
                }
                updateFilteredPreview();
            });
            
            container.appendChild(swatch);
            container.appendChild(label);
            elements.paletteContainer.appendChild(container);
        });
        elements.paletteRow.style.display = 'block';
    }

    function createSolidSilhouette(tracedata) {
        if (!tracedata) return null;
        const visibleIndices = getVisibleLayerIndices();
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
        const visibleColors = getVisibleLayerIndices().length;
        return { pathCount: totalPaths, colorCount: visibleColors };
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

    // Save Original Image as PNG/JPG with same pixel dimensions
    function downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    function getImageBaseName() {
        const name = (state.originalImageUrl || 'image').split(/[\\/]/).pop() || 'image';
        return name.replace(/\.[^/.]+$/, '') || 'image';
    }

    function drawImageToCanvas(img) {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        return canvas;
    }

    function saveOriginalAsPNG() {
        if (!elements.sourceImage?.src) return;
        const canvas = drawImageToCanvas(elements.sourceImage);
        canvas.toBlob((blob) => {
            if (!blob) return;
            downloadBlob(blob, `${getImageBaseName()}.png`);
            elements.statusText.textContent = 'Saved original as PNG.';
        }, 'image/png');
    }

    function saveOriginalAsJPG() {
        if (!elements.sourceImage?.src) return;
        const canvas = drawImageToCanvas(elements.sourceImage);
        const quality = 0.92; // default high quality
        canvas.toBlob((blob) => {
            if (!blob) return;
            downloadBlob(blob, `${getImageBaseName()}.jpg`);
            elements.statusText.textContent = 'Saved original as JPG.';
        }, 'image/jpeg', quality);
    }

    // Save Original Image wrapped as raw SVG (unoptimized raster embedded in SVG)
    function saveOriginalAsSVG() {
        if (!elements.sourceImage?.src) return;
        const w = elements.sourceImage.naturalWidth || 0;
        const h = elements.sourceImage.naturalHeight || 0;
        if (!w || !h) return;
        const href = elements.sourceImage.src;
        const svg = `<?xml version="1.0" encoding="UTF-8"?>\n` +
            `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
            `<image x="0" y="0" width="${w}" height="${h}" href="${href}" xlink:href="${href}"/>` +
            `</svg>`;
        downloadSVG(svg, `${getImageBaseName()}`);
        elements.statusText.textContent = 'Saved original as SVG (raw).';
    }

    if (elements.savePngBtn) elements.savePngBtn.addEventListener('click', saveOriginalAsPNG);
    if (elements.saveJpgBtn) elements.saveJpgBtn.addEventListener('click', saveOriginalAsJPG);
    if (elements.saveSvgBtn) elements.saveSvgBtn.addEventListener('click', saveOriginalAsSVG);
    
    elements.downloadTinkercadBtn.addEventListener('click', () => {
        if (!state.tracedata) return;
        const visibleIndices = getVisibleLayerIndices();
        if (!visibleIndices.length) return;
        const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
        
        // Download each layer separately
        visibleIndices.forEach((idx) => {
            const singleLayer = buildTracedataSubset(state.tracedata, [idx]);
            const layerName = idx === 0 ? 'background' : `layer_${idx}`;
            downloadSVG(ImageTracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_${layerName}`);
        });
    });

    elements.downloadSilhouetteBtn.addEventListener('click', () => {
        if (!state.silhouetteTracedata) return;
        const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
        downloadSVG(ImageTracer.getsvgstring(state.silhouetteTracedata, state.lastOptions), `${imageName}_silhouette`);
    });

    // Download a single optimized SVG combining all visible (or merged) layers into one file
    if (elements.downloadCombinedLayersBtn) {
        elements.downloadCombinedLayersBtn.addEventListener('click', () => {
            if (!state.tracedata) return;
            const visibleIndices = getVisibleLayerIndices();
            if (!visibleIndices.length) return;

            const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');

            // Use merged data if merge rules are present; otherwise use all visible layers
            let dataToExport;
            if (state.mergeRules && state.mergeRules.length > 0) {
                dataToExport = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
            } else {
                dataToExport = buildTracedataSubset(state.tracedata, visibleIndices);
            }

            if (!dataToExport) return;
            const svgString = ImageTracer.getsvgstring(dataToExport, state.lastOptions);
            downloadSVG(svgString, `${imageName}_combined_layers`);
        });
    }

    // Layer Merging Logic
    function prepareMergeUIAfterGeneration() {
        state.mergeRules = [];
        state.selectedFinalLayerIndices.clear();
        elements.mergeRulesContainer.innerHTML = '';
        const visibleIndices = getVisibleLayerIndices();
        // Now include all layers (including background) for merging
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
        const visibleIndices = getVisibleLayerIndices();
        // Now include all layers (including background) for merging
        if (visibleIndices.length < 2) return;

        const defaultRule = { source: 0, target: 1 }; // These are indices into visibleIndices array
        state.mergeRules.push(defaultRule);

        const row = document.createElement('div');
        row.className = 'flex items-center gap-2 text-sm';
        const optionsHTML = visibleIndices.map((idx, ord) => {
            const label = idx === 0 ? `Layer ${idx} (Background)` : `Layer ${idx}`;
            return `<option value="${ord}">${label}</option>`;
        }).join('');
        
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
        updateMergeRuleSwatches(row, defaultRule, visibleIndices);
        elements.combineAndDownloadBtn.disabled = false;
        updateFinalPalette();
        updateFilteredPreview();
    });

    elements.mergeRulesContainer.addEventListener('change', (e) => {
        if (e.target.tagName === 'SELECT') {
            const ruleIndex = parseInt(e.target.dataset.ruleIndex);
            const type = e.target.dataset.type;
            state.mergeRules[ruleIndex][type] = parseInt(e.target.value);
            const visibleIndices = getVisibleLayerIndices();
            updateMergeRuleSwatches(e.target.parentElement, state.mergeRules[ruleIndex], visibleIndices);
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
    
    function updateMergeRuleSwatches(row, rule, allVisibleIndices) {
        const sourceIndex = allVisibleIndices[rule.source];
        const targetIndex = allVisibleIndices[rule.target];
        const sourceColor = state.tracedata.palette[sourceIndex];
        const targetColor = state.tracedata.palette[targetIndex];
        row.querySelector('[data-swatch="source"]').style.backgroundColor = `rgb(${sourceColor.r},${sourceColor.g},${sourceColor.b})`;
        row.querySelector('[data-swatch="target"]').style.backgroundColor = `rgb(${targetColor.r},${targetColor.g},${targetColor.b})`;
    }

    elements.combineAndDownloadBtn.addEventListener('click', () => {
        const visibleIndices = getVisibleLayerIndices();
        const mergedData = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
        if (!mergedData) return;

        const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');
        
        // Download background layer
        if (mergedData.layers[0] && layerHasPaths(mergedData.layers[0])) {
            const backgroundLayer = buildTracedataSubset(mergedData, [0]);
            downloadSVG(ImageTracer.getsvgstring(backgroundLayer, state.lastOptions), `${imageName}_final_background`);
        }

        // Download merged layers (excluding background)
        const finalIndices = [];
        for (let i = 1; i < mergedData.layers.length; i++) {
            if (layerHasPaths(mergedData.layers[i])) {
                finalIndices.push(i);
            }
        }

        finalIndices.forEach((idx, ord) => {
            const singleLayer = buildTracedataSubset(mergedData, [idx]);
            downloadSVG(ImageTracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_final_layer_${ord + 1}`);
        });
    });

    function createMergedTracedata(sourceData, visibleIndices, rules) {
        if (!sourceData || !visibleIndices || !rules) return sourceData;

        // Now work with all visible indices (including background)
        let finalTargets = {};
        visibleIndices.forEach((_, ruleIndex) => finalTargets[ruleIndex] = ruleIndex);

        rules.forEach(rule => {
            let ultimateTarget = rule.target;
            while (finalTargets[ultimateTarget] !== ultimateTarget) {
                ultimateTarget = finalTargets[ultimateTarget];
            }
            finalTargets[rule.source] = ultimateTarget;
        });

        // Resolve all chains
        Object.keys(finalTargets).forEach(key => {
            let current = parseInt(key);
            while (finalTargets[current] !== current) {
                current = finalTargets[current];
            }
            finalTargets[key] = current;
        });

        // Group layers
        const groups = {};
        visibleIndices.forEach((originalIndex, ruleIndex) => {
            const finalTargetRuleIndex = finalTargets[ruleIndex];
            if (!groups[finalTargetRuleIndex]) {
                groups[finalTargetRuleIndex] = [];
            }
            groups[finalTargetRuleIndex].push(originalIndex);
        });

        // Build new tracedata
        const newPalette = [];
        const newLayers = [];

        // Add merged layers in order
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
        state.selectedFinalLayerIndices.clear();
        if (!state.tracedata) return;

        const visibleIndices = getVisibleLayerIndices();
        let palette;
        
        if (state.mergeRules.length > 0) {
            const data = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
            palette = data.palette;
        } else {
            palette = visibleIndices.map(i => state.tracedata.palette[i]);
        }

        if (palette.length > 0) {
            palette.forEach((color, i) => {
                // Create container for swatch and label
                const container = document.createElement('div');
                container.className = 'flex flex-col items-center gap-1';
                
                const swatch = document.createElement('div');
                swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500 cursor-pointer transition-all';
                swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
                
                // Layer number label (initially hidden)
                const label = document.createElement('div');
                label.className = 'text-xs text-gray-400 opacity-0 transition-opacity';
                
                if (state.mergeRules.length > 0) {
                    // Find original layer index for this final layer
                    const visibleIndices = getVisibleLayerIndices();
                    let finalTargets = {};
                    visibleIndices.forEach((_, ruleIndex) => finalTargets[ruleIndex] = ruleIndex);
                    
                    state.mergeRules.forEach(rule => {
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
                    
                    const sortedTargets = Object.keys(groups).map(Number).sort((a, b) => a - b);
                    if (i < sortedTargets.length) {
                        const targetRuleIndex = sortedTargets[i];
                        const originalIndices = groups[targetRuleIndex];
                        const representativeIndex = visibleIndices[targetRuleIndex];
                        
                        if (originalIndices.length > 1) {
                            label.textContent = `Merged (${originalIndices.map(idx => idx === 0 ? 'BG' : idx).join('+')})`;
                        } else {
                            label.textContent = representativeIndex === 0 ? 'Background' : `Layer ${representativeIndex}`;
                        }
                        
                        if (representativeIndex === 0) {
                            swatch.className += ' background-layer';
                            swatch.title = originalIndices.length > 1 ? 
                                `Merged layer including background` : 'Background Layer';
                        } else {
                            swatch.title = originalIndices.length > 1 ? 
                                `Merged layers: ${originalIndices.join(', ')}` : `Layer ${representativeIndex}`;
                        }
                    }
                } else {
                    const originalIndex = visibleIndices[i];
                    label.textContent = originalIndex === 0 ? 'Background' : `Layer ${originalIndex}`;
                    
                    if (originalIndex === 0) {
                        swatch.className += ' background-layer';
                        swatch.title = 'Background Layer';
                    } else {
                        swatch.title = `Layer ${originalIndex}`;
                    }
                }
                
                swatch.dataset.index = i;
                swatch.addEventListener('click', () => {
                    if (state.selectedFinalLayerIndices.has(i)) {
                        state.selectedFinalLayerIndices.delete(i);
                        swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                        label.classList.add('opacity-0');
                    } else {
                        state.selectedFinalLayerIndices.add(i);
                        swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                        label.classList.remove('opacity-0');
                    }
                    updateFilteredPreview();
                });
                
                container.appendChild(swatch);
                container.appendChild(label);
                elements.finalPaletteContainer.appendChild(container);
            });
        }
    }

    // Check for stored image URL from context menu on page load
    if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.get(['imageUrlToConvert'], (result) => {
            if (result.imageUrlToConvert) {
                elements.urlInput.value = result.imageUrlToConvert;
                loadImageFromUrl(result.imageUrlToConvert);
                // Clear the stored URL
                chrome.storage.local.remove('imageUrlToConvert');
            }
        });
    }

});
