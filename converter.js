document.addEventListener('DOMContentLoaded', () => {
    // --- DOM elements ---
    const elements = {
        welcomeScreen: document.getElementById('welcome-screen'),
        mainContent: document.getElementById('main-content'),
        loaderOverlay: document.getElementById('loader-overlay'),
        workspace: document.querySelector('.workspace'),
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
        maxColorsSlider: document.getElementById('max-colors'),
        maxColorsValue: document.getElementById('max-colors-value'),
        maxColorsTooltip: document.getElementById('max-colors-tooltip'),
        toggleFidelityBtn: document.getElementById('toggle-fidelity-btn'),
        svgPreview: document.getElementById('svg-preview'),
        svgPreviewFiltered: document.getElementById('svg-preview-filtered'),
        previewResolution: document.getElementById('preview-resolution'),
        qualityIndicator: document.getElementById('quality-indicator'),
        selectedLayerText: document.getElementById('selected-layer-text'),
        paletteContainer: document.getElementById('palette-container'),
        paletteRow: document.getElementById('palette-row'),
        outputSection: document.getElementById('output-section'),
        finalPaletteContainer: document.getElementById('final-palette-container'),
        downloadSilhouetteBtn: document.getElementById('download-silhouette-btn'),
        layerMergingSection: document.getElementById('layer-merging-section'),
        mergeRulesContainer: document.getElementById('merge-rules-container'),
        addMergeRuleBtn: document.getElementById('add-merge-rule-btn'),
        combineAndDownloadBtn: document.getElementById('combine-and-download-btn'),
        downloadCombinedLayersBtn: document.getElementById('download-combined-layers-btn'),
        exportTabs: document.querySelectorAll('.segmented-control-tab'),
        exportPanels: document.querySelectorAll('.export-panel'),
        resizeChips: document.querySelectorAll('.resize-chip'),
        resizeCustomInput: document.getElementById('resize-custom'),
        applyCustomResizeBtn: document.getElementById('apply-custom-resize'),
        saveResizedPngBtn: document.getElementById('save-resized-png-btn'),
        saveResizedJpgBtn: document.getElementById('save-resized-jpg-btn'),
        saveResizedTgaBtn: document.getElementById('save-resized-tga-btn'),
        preserveAlphaCheckbox: document.getElementById('preserve-alpha'),
        exportSizeCurrent: document.getElementById('export-size-current'),
        exportSizeTarget: document.getElementById('export-size-target'),
        sizeEstPng: document.getElementById('size-est-png'),
        sizeEstJpg: document.getElementById('size-est-jpg'),
        sizeEstTga: document.getElementById('size-est-tga'),
        objThicknessSlider: document.getElementById('obj-thickness'),
        objThicknessValue: document.getElementById('obj-thickness-value'),
        exportObjBtn: document.getElementById('export-obj-btn'),
        objBedSelect: document.getElementById('obj-bed'),
        objMarginInput: document.getElementById('obj-margin'),
        availableLayersContent: document.getElementById('available-layers-content'),
        finalPaletteContent: document.getElementById('final-palette-content'),
        toggleAvailableLayersBtn: document.getElementById('toggle-available-layers'),
        toggleFinalPaletteBtn: document.getElementById('toggle-final-palette'),
        exportLayersBtn: document.getElementById('export-layers-btn')
    };

    // --- State Management ---
    let state = {
        quantizedData: null,
        tracedata: null,
        originalImageUrl: null,
        originalImageFormat: null,
        originalImageSize: null,
        lastOptions: null,
        silhouetteTracedata: null,
        mergeRules: [],
        initialSliderValues: {},
        isDirty: false,
        selectedLayerIndices: new Set(),
        selectedFinalLayerIndices: new Set(),
        tooltipTimeout: null,
        colorsAnalyzed: false,
        exportScale: 100,
        preserveAlpha: true,
        showAvailableLayers: true,
        showFinalPalette: true,
        highFidelity: false,
        zoom: {
            all: { scale: 1, x: 0, y: 0, isDragging: false },
            selected: { scale: 1, x: 0, y: 0, isDragging: false }
        }
    };

    const SLIDER_TOOLTIPS = {
        'path-simplification': 'Higher values remove more small details and noise.',
        'corner-sharpness': 'Higher values create crisper, more defined corners.',
        'curve-straightness': 'Higher values make curved lines more straight.',
        'color-precision': 'Higher values find more distinct color layers.',
        'max-colors': 'Caps the maximum number of colors created.'
    };

    // --- Core Functions ---

    function showLoader(show) {
        elements.loaderOverlay.style.display = show ? 'flex' : 'none';
    }

    function showWorkspace(show) {
        if (show) {
            elements.welcomeScreen.style.display = 'none';
            elements.mainContent.classList.remove('hidden');
        } else {
            elements.welcomeScreen.style.display = 'flex';
            elements.mainContent.classList.add('hidden');
        }
    }

    function saveInitialSliderValues() {
        state.initialSliderValues = {
            pathSimplification: elements.pathSimplificationSlider.value,
            cornerSharpness: elements.cornerSharpnessSlider.value,
            curveStraightness: elements.curveStraightnessSlider.value,
            colorPrecision: elements.colorPrecisionSlider.value,
            maxColors: elements.maxColorsSlider ? elements.maxColorsSlider.value : '4'
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
        if (elements.maxColorsSlider) {
            elements.maxColorsSlider.value = state.initialSliderValues.maxColors;
        }

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
        if (elements.maxColorsValue && elements.maxColorsSlider) {
            elements.maxColorsValue.textContent = elements.maxColorsSlider.value;
        }
        if (elements.objThicknessValue && elements.objThicknessSlider) {
            elements.objThicknessValue.textContent = elements.objThicknessSlider.value;
        }
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

    function switchExportTab(target) {
        elements.exportTabs.forEach(btn => {
            const isActive = btn.dataset.tab === target;
            btn.classList.toggle('active', isActive);
        });
        elements.exportPanels.forEach(panel => {
            const isVisible = panel.id === `tab-${target}`;
            panel.classList.toggle('hidden', !isVisible);
        });

        // Show/hide appropriate footer based on active tab
        const svgExportFooter = document.getElementById('svg-export-footer');
        const rasterDownloadFooter = document.getElementById('download-footer');
        
        if (svgExportFooter) {
            svgExportFooter.classList.toggle('hidden', target !== 'svg');
        }
        if (rasterDownloadFooter) {
            rasterDownloadFooter.classList.toggle('hidden', target !== 'raster');
        }

        // Update segmented control indicator
        updateSegmentedControlIndicator();

        if (target === 'raster') {
            setAvailableLayersVisible(false);
            setFinalPaletteVisible(false);
            // Render RGBA channels when switching to raster tab
            renderRGBAChannels();
        } else {
            setAvailableLayersVisible(true);
            setFinalPaletteVisible(true);
        }
    }

    function setHighFidelity(enabled) {
        state.highFidelity = !!enabled;
        if (elements.toggleFidelityBtn) {
            elements.toggleFidelityBtn.textContent = state.highFidelity ? 'High Fidelity: On' : 'High Fidelity: Off';
            elements.toggleFidelityBtn.classList.toggle('btn-primary', state.highFidelity);
            elements.toggleFidelityBtn.classList.toggle('btn-secondary', !state.highFidelity);
        }
        if (elements.maxColorsSlider) {
            elements.maxColorsSlider.value = state.highFidelity ? '8' : '4';
            if (!state.isDirty) {
                state.isDirty = true;
                elements.resetBtn.style.display = 'inline';
            }
            updateAllSliderDisplays();
        }
    }

    function updateSegmentedControlIndicator() {
        const activeTab = document.querySelector('.segmented-control-tab.active');
        const indicator = document.querySelector('.segmented-control-indicator');

        if (!activeTab || !indicator) return;

        const tabRect = activeTab.getBoundingClientRect();
        const containerRect = activeTab.parentElement.getBoundingClientRect();
        const offsetLeft = tabRect.left - containerRect.left;

        indicator.style.width = `${tabRect.width}px`;
        indicator.style.transform = `translateX(${offsetLeft}px)`;
    }


    function updateExportScaleDisplay() {
        const dims = getBaseDimensions();
        if (!dims) {
            if (elements.exportSizeCurrent) elements.exportSizeCurrent.textContent = '—';
            if (elements.exportSizeTarget) elements.exportSizeTarget.textContent = '—';
            updateSizeEstimates(null);
            return;
        }
        const target = getScaledDimensions(dims, state.exportScale);

        // Update various display elements
        if (elements.exportSizeCurrent) {
            elements.exportSizeCurrent.textContent = `${dims.width}×${dims.height}px`;
        }
        if (elements.exportSizeTarget) {
            elements.exportSizeTarget.textContent = `${target.width}×${target.height}px`;
        }

        // Update new export scale display
        const exportScaleDisplay = document.getElementById('export-scale-display');
        if (exportScaleDisplay) {
            exportScaleDisplay.textContent = `(${state.exportScale}%)`;
        }

        // Update original dimensions info
        const originalDims = document.getElementById('original-dims');
        if (originalDims) {
            originalDims.textContent = `${dims.width}×${dims.height}`;
        }

        // Calculate and display aspect ratio
        const originalAspect = document.getElementById('original-aspect');
        if (originalAspect) {
            const gcd = (a, b) => b === 0 ? a : gcd(b, a % b);
            const divisor = gcd(dims.width, dims.height);
            const aspectW = dims.width / divisor;
            const aspectH = dims.height / divisor;
            originalAspect.textContent = `${aspectW}:${aspectH}`;
        }

        // Update original format
        const originalFormat = document.getElementById('original-format');
        if (originalFormat) {
            originalFormat.textContent = state.originalImageFormat || '—';
        }

        // Update original file size
        const originalFileSize = document.getElementById('original-file-size');
        if (originalFileSize) {
            originalFileSize.textContent = state.originalImageSize ? formatBytes(state.originalImageSize) : '—';
        }

        updateSizeEstimates(target);
    }

    function getBaseDimensions() {
        if (state.tracedata?.width && state.tracedata?.height) {
            return { width: state.tracedata.width, height: state.tracedata.height };
        }
        if (elements.sourceImage?.naturalWidth && elements.sourceImage?.naturalHeight) {
            return { width: elements.sourceImage.naturalWidth, height: elements.sourceImage.naturalHeight };
        }
        return null;
    }

    function getScaledDimensions(dims, scale) {
        return {
            width: Math.max(1, Math.round(dims.width * (scale / 100))),
            height: Math.max(1, Math.round(dims.height * (scale / 100)))
        };
    }

    function setExportScale(scale) {
        state.exportScale = Math.min(500, Math.max(1, Math.round(scale)));
        elements.resizeChips.forEach(chip => {
            chip.classList.toggle('active', parseInt(chip.dataset.scale) === state.exportScale);
        });
        updateExportScaleDisplay();
    }

    function getDataToExport() {
        if (!state.tracedata) return null;
        const visibleIndices = getVisibleLayerIndices();
        if (!visibleIndices.length) return null;
        if (state.mergeRules && state.mergeRules.length > 0) {
            return createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
        }
        return buildTracedataSubset(state.tracedata, visibleIndices);
    }

    // Store channel data for switching
    const channelDataCache = {
        red: null,
        green: null,
        blue: null,
        alpha: null,
        width: 0,
        height: 0
    };

    // Render RGBA channel previews
    function renderRGBAChannels() {
        const sourceImage = elements.sourceImage;
        if (!sourceImage || !sourceImage.complete || !sourceImage.naturalWidth) return;

        // Create a temporary canvas to extract image data
        const tempCanvas = document.createElement('canvas');
        const tempCtx = tempCanvas.getContext('2d');
        tempCanvas.width = sourceImage.naturalWidth;
        tempCanvas.height = sourceImage.naturalHeight;
        tempCtx.drawImage(sourceImage, 0, 0);

        const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imageData.data;

        // Store dimensions
        channelDataCache.width = tempCanvas.width;
        channelDataCache.height = tempCanvas.height;

        // Create and store each channel's image data
        const channels = ['red', 'green', 'blue', 'alpha'];
        channels.forEach(channel => {
            const channelData = tempCtx.createImageData(tempCanvas.width, tempCanvas.height);

            for (let i = 0; i < data.length; i += 4) {
                let value;
                if (channel === 'red') {
                    value = data[i];
                } else if (channel === 'green') {
                    value = data[i + 1];
                } else if (channel === 'blue') {
                    value = data[i + 2];
                } else if (channel === 'alpha') {
                    value = data[i + 3];
                }

                // Set grayscale value
                channelData.data[i] = value;
                channelData.data[i + 1] = value;
                channelData.data[i + 2] = value;
                channelData.data[i + 3] = 255; // Full opacity
            }

            channelDataCache[channel] = channelData;
        });

        // Display the currently active channel
        displayChannel('red');
    }

    // Display specific channel on canvas
    function displayChannel(channel) {
        const canvas = document.getElementById('rgba-preview-canvas');
        if (!canvas || !channelDataCache[channel]) return;

        canvas.width = channelDataCache.width;
        canvas.height = channelDataCache.height;
        const ctx = canvas.getContext('2d');
        ctx.putImageData(channelDataCache[channel], 0, 0);
    }

    async function saveRaster(type = 'png') {
        // Direct raster resize from original image - no vectorization needed
        if (!elements.sourceImage || !elements.sourceImage.src) {
            elements.statusText.textContent = 'No image loaded.';
            return;
        }

        const dims = getBaseDimensions();
        if (!dims) return;
        const target = getScaledDimensions(dims, state.exportScale);
        const preserveAlpha = !!state.preserveAlpha;

        try {
            // Create canvas and resize original image directly
            const canvas = document.createElement('canvas');
            canvas.width = target.width;
            canvas.height = target.height;
            const ctx = canvas.getContext('2d');

            // Fill white background if not preserving alpha
            if (!preserveAlpha) {
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, target.width, target.height);
            }

            // Draw resized image
            ctx.drawImage(elements.sourceImage, 0, 0, target.width, target.height);

            // Export based on type
            if (type === 'png') {
                canvas.toBlob((blob) => {
                    if (blob) {
                        downloadBlob(blob, `${getImageBaseName()}_${target.width}x${target.height}.png`);
                        elements.statusText.textContent = `Saved PNG at ${target.width}×${target.height}.`;
                    }
                }, 'image/png');
            } else if (type === 'jpg') {
                canvas.toBlob((blob) => {
                    if (blob) {
                        downloadBlob(blob, `${getImageBaseName()}_${target.width}x${target.height}.jpg`);
                        elements.statusText.textContent = `Saved JPG at ${target.width}×${target.height}.`;
                    }
                }, 'image/jpeg', 0.92);
            } else if (type === 'tga') {
                const pngDataUrl = canvas.toDataURL('image/png');
                const tgaBlob = await pngDataUrlToTgaBlob(pngDataUrl, preserveAlpha);
                downloadBlob(tgaBlob, `${getImageBaseName()}_${target.width}x${target.height}.tga`);
                elements.statusText.textContent = `Saved TGA at ${target.width}×${target.height}.${preserveAlpha ? ' Includes alpha.' : ''}`;
            }
        } catch (error) {
            console.error('Raster export failed:', error);
            elements.statusText.textContent = 'Failed to export image.';
        }
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
                    const dominantColorCount = estimateDominantColors(imageData);
                    if (dominantColorCount) {
                        options.numberofcolors = Math.max(2, Math.min(options.numberofcolors, dominantColorCount));
                    }
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

    function estimateDominantColors(imageData) {
        const width = imageData.width;
        const height = imageData.height;
        if (!width || !height) return null;

        const data = imageData.data;
        const maxSamples = 4096;
        const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
        const counts = new Map();
        let samples = 0;

        for (let y = 0; y < height; y += step) {
            for (let x = 0; x < width; x += step) {
                const idx = (y * width + x) * 4;
                const a = data[idx + 3];
                if (a < 16) continue;
                const r = data[idx] >> 3;
                const g = data[idx + 1] >> 3;
                const b = data[idx + 2] >> 3;
                const key = (r << 10) | (g << 5) | b;
                counts.set(key, (counts.get(key) || 0) + 1);
                samples++;
            }
        }

        if (!samples) return null;

        const bucketsAll = Array.from(counts.values()).sort((a, b) => b - a);
        const minBucketRatio = state.highFidelity ? 0.003 : 0.006;
        const minBucketCount = Math.max(2, Math.round(samples * minBucketRatio));
        const buckets = bucketsAll.filter(count => count >= minBucketCount);
        const selectedBuckets = buckets.length ? buckets : bucketsAll;
        const total = selectedBuckets.reduce((sum, count) => sum + count, 0);
        const targetCoverage = state.highFidelity ? 0.992 : 0.985;
        let cumulative = 0;
        let colorCount = 0;

        for (const count of selectedBuckets) {
            cumulative += count;
            colorCount++;
            if (cumulative / total >= targetCoverage) break;
        }

        return Math.max(1, Math.min(colorCount, selectedBuckets.length));
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

                    // Show output section
                    elements.outputSection.style.display = 'flex';

                    // Initialize segmented control indicator
                    setTimeout(() => updateSegmentedControlIndicator(), 100);

                    // Render previews
                    await renderPreviews();
                    await updateFilteredPreview();

                    const quality = assess3DPrintQuality(state.tracedata);
                    updateQualityDisplay(quality);
                    elements.statusText.textContent = 'Preview generated!';
                    enableDownloadButtons();
                    updateExportScaleDisplay();
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
        const MC = elements.maxColorsSlider ? parseInt(elements.maxColorsSlider.value) : 4;

        const map = (t, a, b) => (a + (b - a) * (t / 100));
        const mapInv = (t, a, b) => (a + (b - a) * (1 - (t / 100)));

        const rel = Math.max(0.5, Math.sqrt(elements.sourceImage.naturalWidth * elements.sourceImage.naturalHeight) / 512);
        const detailScale = Math.min(rel, state.highFidelity ? 1.0 : 1.4);

        let options = Object.assign({}, ImageTracer.optionpresets.default, {
            viewbox: true,
            strokewidth: 0
        });
        
        options.pathomit = Math.round(map(P, 0, state.highFidelity ? 6 : 10) * detailScale);
        options.roundcoords = Math.round(map(P, 1, state.highFidelity ? 2 : 3));
        options.blurradius = +map(P, 0, state.highFidelity ? 0.8 : 1.2).toFixed(1);
        options.qtres = +mapInv(C, state.highFidelity ? 2.5 : 4.0, state.highFidelity ? 0.15 : 0.2).toFixed(2);
        options.rightangleenhance = (C >= 50);
        options.ltres = +map(S, state.highFidelity ? 0.15 : 0.2, state.highFidelity ? 6.0 : 8.0).toFixed(2);
        
        options.colorsampling = 2; 
        options.colorquantcycles = Math.max(1, Math.round(map(CP, state.highFidelity ? 4 : 3, state.highFidelity ? 12 : 10)));
        options.mincolorratio = +mapInv(CP, 0.03, 0.0).toFixed(3);
        options.numberofcolors = Math.max(4, Math.min(20, 4 + Math.round(CP * 0.16)));
        if (!Number.isNaN(MC)) {
            options.numberofcolors = Math.max(2, Math.min(options.numberofcolors, MC));
        }

        return options;
    }

    // --- Zoom and Pan Functions ---
    
    function setupZoomControls() {
        // Zoom button event listeners
        const zoomInAll = document.getElementById('zoom-in-all');
        const zoomOutAll = document.getElementById('zoom-out-all');
        const zoomResetAll = document.getElementById('zoom-reset-all');
        const zoomInSelected = document.getElementById('zoom-in-selected');
        const zoomOutSelected = document.getElementById('zoom-out-selected');
        const zoomResetSelected = document.getElementById('zoom-reset-selected');

        if (zoomInAll) zoomInAll.addEventListener('click', () => zoomPreview('all', 1.25));
        if (zoomOutAll) zoomOutAll.addEventListener('click', () => zoomPreview('all', 0.8));
        if (zoomResetAll) zoomResetAll.addEventListener('click', () => resetZoom('all'));

        if (zoomInSelected) zoomInSelected.addEventListener('click', () => zoomPreview('selected', 1.25));
        if (zoomOutSelected) zoomOutSelected.addEventListener('click', () => zoomPreview('selected', 0.8));
        if (zoomResetSelected) zoomResetSelected.addEventListener('click', () => resetZoom('selected'));

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
        if (resetButton) {
            resetButton.textContent = `${zoomLevel}%`;
        }

        // Update button states
        const zoomInBtn = document.getElementById(`zoom-in-${type}`);
        const zoomOutBtn = document.getElementById(`zoom-out-${type}`);

        if (zoomInBtn) zoomInBtn.disabled = state.zoom[type].scale >= 5;
        if (zoomOutBtn) zoomOutBtn.disabled = state.zoom[type].scale <= 0.1;
    }
    
    function setupPanControls(type) {
        const container = document.querySelector(`[data-preview="${type}"]`);
        if (!container) return; // Preview containers don't exist in new design
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
    
    function svgToPng(svgString, maxSize = null, fixedSize = null, preserveAlpha = false) {
        return new Promise((resolve, reject) => {
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
                    let width;
                    let height;
                    if (fixedSize && fixedSize.width && fixedSize.height) {
                        width = fixedSize.width;
                        height = fixedSize.height;
                    } else {
                        // Calculate dimensions while maintaining aspect ratio
                        width = img.width || img.naturalWidth;
                        height = img.height || img.naturalHeight;
                        const aspectRatio = width / height;
                        
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
                    }
                    
                    // Create canvas and draw
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    
                    const ctx = canvas.getContext('2d');
                    if (!preserveAlpha) {
                        ctx.fillStyle = 'white';
                        ctx.fillRect(0, 0, width, height);
                    }
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
        if (!elements.svgPreview) return; // Preview not in new minimal design

        try {
            const visibleIndices = getVisibleLayerIndices();
            const previewData = buildTracedataSubset(state.tracedata, visibleIndices);
            const svgString = ImageTracer.getsvgstring(previewData, state.lastOptions);

            const pngDataUrl = await svgToPng(svgString);
            elements.svgPreview.src = pngDataUrl;
            elements.svgPreview.style.display = 'block';

        } catch (error) {
            console.error('Preview rendering failed:', error);
            if (elements.svgPreview) elements.svgPreview.style.display = 'none';
        }
    }
    
    async function updateFilteredPreview() {
        if (!state.tracedata) return;
        if (!elements.svgPreviewFiltered) return; // Preview not in new minimal design

        let dataToShow = state.tracedata;
        let indicesToRender = [];

        if (state.mergeRules.length > 0) {
            const visibleIndices = getVisibleLayerIndices();
            dataToShow = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);

            // Use selected final layers if any, otherwise show selected original layers
            if (state.selectedFinalLayerIndices.size > 0) {
                indicesToRender = Array.from(state.selectedFinalLayerIndices);
                if (elements.selectedLayerText) elements.selectedLayerText.textContent = `Final Preview (${indicesToRender.length} layer(s))`;
            } else {
                indicesToRender = Array.from(state.selectedLayerIndices);
                if (elements.selectedLayerText) elements.selectedLayerText.textContent = state.selectedLayerIndices.size > 0
                    ? `Previewing ${indicesToRender.length} original layer(s)`
                    : 'Select final layers to preview';
            }
        } else {
            // Original mode - use selected original layers
            indicesToRender = Array.from(state.selectedLayerIndices);
            if (elements.selectedLayerText) elements.selectedLayerText.textContent = state.selectedLayerIndices.size > 0
                ? `Previewing ${indicesToRender.length} layer(s)`
                : 'Select layers to preview';
        }

        if (indicesToRender.length === 0) {
            if (elements.svgPreviewFiltered) elements.svgPreviewFiltered.style.display = 'none';
            return;
        }
        
        try {
            const filteredData = buildTracedataSubset(dataToShow, indicesToRender);
            const svgString = ImageTracer.getsvgstring(filteredData, state.lastOptions);

            const pngDataUrl = await svgToPng(svgString);
            if (elements.svgPreviewFiltered) {
                elements.svgPreviewFiltered.src = pngDataUrl;
                elements.svgPreviewFiltered.style.display = 'block';
            }

        } catch (error) {
            console.error('Filtered preview rendering failed:', error);
            if (elements.svgPreviewFiltered) elements.svgPreviewFiltered.style.display = 'none';
        }
    }

    function updateQualityDisplay(quality) {
        if (elements.qualityIndicator) {
            elements.qualityIndicator.textContent = `${quality.pathCount} paths, ${quality.colorCount} colors`;
        }
    }

    // --- Event Listeners ---

    elements.importBtn.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', (event) => {
        const file = event.target.files[0];
        if (file) {
            // Reset previous image info
            resetImageInfo();

            // Store file info
            state.originalImageFormat = getImageFormat(file.name, null);
            state.originalImageSize = file.size;

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
    if (elements.toggleFidelityBtn) {
        elements.toggleFidelityBtn.addEventListener('click', () => {
            setHighFidelity(!state.highFidelity);
            if (state.colorsAnalyzed && elements.sourceImage.src) {
                state.colorsAnalyzed = false;
                elements.optimizePathsBtn.disabled = true;
                elements.statusText.textContent = 'Fidelity changed. Re-analyze colors.';
            }
        });
    }
    elements.exportTabs.forEach(btn => {
        btn.addEventListener('click', () => {
            switchExportTab(btn.dataset.tab);
        });
    });
    if (elements.objThicknessSlider && elements.objThicknessValue) {
        elements.objThicknessValue.textContent = elements.objThicknessSlider.value;
        elements.objThicknessSlider.addEventListener('input', () => {
            elements.objThicknessValue.textContent = elements.objThicknessSlider.value;
        });
    }
    if (elements.exportObjBtn) {
        elements.exportObjBtn.addEventListener('click', () => exportAsOBJ());
    }
    elements.resizeChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const scale = parseInt(chip.dataset.scale);
            if (!isNaN(scale)) setExportScale(scale);
        });
    });
    if (elements.applyCustomResizeBtn) {
        elements.applyCustomResizeBtn.addEventListener('click', () => {
            const val = parseInt(elements.resizeCustomInput.value);
            if (!isNaN(val)) setExportScale(val);
        });
    }
    if (elements.saveResizedPngBtn) elements.saveResizedPngBtn.addEventListener('click', () => saveRaster('png'));
    if (elements.saveResizedJpgBtn) elements.saveResizedJpgBtn.addEventListener('click', () => saveRaster('jpg'));
    if (elements.saveResizedTgaBtn) elements.saveResizedTgaBtn.addEventListener('click', () => saveRaster('tga'));
    if (elements.preserveAlphaCheckbox) {
        elements.preserveAlphaCheckbox.checked = state.preserveAlpha;
        elements.preserveAlphaCheckbox.addEventListener('change', () => {
            state.preserveAlpha = elements.preserveAlphaCheckbox.checked;
            updateExportScaleDisplay();
        });
    }
    if (elements.toggleAvailableLayersBtn) {
        elements.toggleAvailableLayersBtn.addEventListener('click', () => setAvailableLayersVisible(!state.showAvailableLayers));
    }
    if (elements.toggleFinalPaletteBtn) {
        elements.toggleFinalPaletteBtn.addEventListener('click', () => setFinalPaletteVisible(!state.showFinalPalette));
    }

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

            // If color settings change, we need to re-analyze colors
            if (e.target.id === 'color-precision' || e.target.id === 'max-colors') {
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

    function setupWorkspaceDragAndDrop() {
        if (!elements.workspace) return;

        const clearDragState = () => elements.workspace.classList.remove('drag-over');

        elements.workspace.addEventListener('dragover', (e) => {
            e.preventDefault();
            elements.workspace.classList.add('drag-over');
        });

        elements.workspace.addEventListener('dragleave', clearDragState);

        elements.workspace.addEventListener('drop', (e) => {
            e.preventDefault();
            clearDragState();

            const dt = e.dataTransfer;
            if (dt?.files?.length) {
                const file = Array.from(dt.files).find(f => f.type.startsWith('image/'));
                if (file) {
                    // Reset previous image info
                    resetImageInfo();

                    // Store file info
                    state.originalImageFormat = getImageFormat(file.name, null);
                    state.originalImageSize = file.size;

                    const reader = new FileReader();
                    reader.onload = (ev) => loadImage(ev.target.result, file.name);
                    reader.readAsDataURL(file);
                    return;
                }
            }

            const url = dt?.getData('text/uri-list') || dt?.getData('text/plain');
            if (url) {
                loadImageFromUrl(url.trim());
            }
        });
    }

    setupWorkspaceDragAndDrop();

    // --- Image Loading ---

    function loadImage(src, name) {
        state.originalImageUrl = name;

        // Set format/size if not already set (from file upload)
        // For URL loads, we calculate from the data URL
        if (!state.originalImageFormat) {
            state.originalImageFormat = getImageFormat(name, src);
        }
        if (!state.originalImageSize) {
            state.originalImageSize = getDataUrlSize(src);
        }

        elements.sourceImage.src = src;
    }

    function resetImageInfo() {
        state.originalImageFormat = null;
        state.originalImageSize = null;
    }

    async function loadImageFromUrl(url) {
        // Reset previous image info
        resetImageInfo();

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

        // Enable raster export buttons immediately (no vectorization needed)
        if (elements.saveResizedPngBtn) elements.saveResizedPngBtn.disabled = false;
        if (elements.saveResizedJpgBtn) elements.saveResizedJpgBtn.disabled = false;
        if (elements.saveResizedTgaBtn) elements.saveResizedTgaBtn.disabled = false;

        // Render RGBA channels for raster tab
        renderRGBAChannels();

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
        
        updateExportScaleDisplay();
        if (elements.exportTabs) {
            const activeTab = Array.from(elements.exportTabs).find(b => b.classList.contains('active'));
            const tabName = activeTab?.dataset.tab;
            if (tabName === 'raster') {
                setAvailableLayersVisible(false);
                setFinalPaletteVisible(false);
            }
        }
        
        showLoader(false);
    };
    
    // --- Utility & Helper Functions ---

    function disableDownloadButtons() {
        // Only disable SVG export buttons (raster buttons stay enabled once image is loaded)
        [
            elements.exportLayersBtn,
            elements.downloadSilhouetteBtn,
            elements.combineAndDownloadBtn,
            elements.downloadCombinedLayersBtn,
            elements.exportObjBtn
        ].forEach(btn => {
            if(btn) btn.disabled = true;
        });
    }

    function enableDownloadButtons() {
        // Enable SVG export buttons after vectorization completes
        [
            elements.exportLayersBtn,
            elements.downloadSilhouetteBtn,
            elements.exportObjBtn
        ].forEach(btn => {
            if(btn) btn.disabled = false;
        });
        if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = state.mergeRules.length === 0;
        if (elements.downloadCombinedLayersBtn) elements.downloadCombinedLayersBtn.disabled = false;

        // Raster buttons are already enabled from image load, no need to re-enable

        if (elements.exportTabs) {
            const activeTab = Array.from(elements.exportTabs).find(b => b.classList.contains('active'));
            const tabName = activeTab?.dataset.tab;
            if (tabName === 'raster') {
                setAvailableLayersVisible(false);
                setFinalPaletteVisible(false);
            }
        }
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

    function buildMtl(materials, name) {
        if (!materials || materials.size === 0) return '';
        let output = `# ${name}.mtl\n`;
        materials.forEach((material) => {
            const color = material.color || { r: 0, g: 0, b: 0 };
            output += `newmtl ${material.name}\n`;
            output += `Ka 0 0 0\n`;
            output += `Kd ${color.r.toFixed(4)} ${color.g.toFixed(4)} ${color.b.toFixed(4)}\n`;
            output += `Ks 0 0 0\n`;
            output += `d 1\n`;
            output += `illum 1\n\n`;
        });
        return output;
    }

    const BED_PRESETS = {
        x1: { width: 256, depth: 256, label: 'Bambu X1/X1C' },
        a1mini: { width: 180, depth: 180, label: 'Bambu A1 mini' },
        h2d: { width: 325, depth: 320, label: 'Bambu H2D (single nozzle)' }
    };

    async function exportAsOBJ() {
        if (!state.tracedata) {
            elements.statusText.textContent = 'Analyze colors before exporting OBJ.';
            return;
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const OBJExporter = window.OBJExporter || window.THREE?.OBJExporter;
        const THREERef = window.THREE;

        if (!SVGLoader || !OBJExporter || !THREERef) {
            elements.statusText.textContent = 'OBJ export libraries are still loading.';
            return;
        }

        const dataToExport = getDataToExport();
        if (!dataToExport) {
            elements.statusText.textContent = 'No layers available for OBJ export.';
            return;
        }

        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const thickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;
        const bedKey = elements.objBedSelect?.value || 'x1';
        const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
        const marginValue = elements.objMarginInput ? parseFloat(elements.objMarginInput.value) : 5;
        const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;

        try {
            showLoader(true);
            elements.statusText.textContent = 'Exporting OBJ...';

            const svgString = ImageTracer.getsvgstring(dataToExport, state.lastOptions);
            const loader = new SVGLoader();
            const svgData = loader.parse(svgString);
            const group = new THREERef.Group();
            const materials = new Map();

            svgData.paths.forEach((path) => {
                const shapes = SVGLoader.createShapes(path);
                if (!shapes || !shapes.length) return;

                const sourceColor = path.color instanceof THREERef.Color
                    ? path.color
                    : new THREERef.Color(path.color || '#000');
                const hex = sourceColor.getHexString();

                let material = materials.get(hex);
                if (!material) {
                    material = new THREERef.MeshStandardMaterial({ color: sourceColor });
                    material.name = `mat_${hex}`;
                    materials.set(hex, material);
                }

                shapes.forEach((shape) => {
                    const geometry = new THREERef.ExtrudeGeometry(shape, {
                        depth: thickness,
                        bevelEnabled: false
                    });
                    geometry.rotateX(Math.PI);
                    const mesh = new THREERef.Mesh(geometry, material);
                    group.add(mesh);
                });
            });

            const bbox = new THREERef.Box3().setFromObject(group);
            const size = new THREERef.Vector3();
            bbox.getSize(size);
            if (size.x > 0 && size.y > 0) {
                const maxWidth = Math.max(1, bed.width - margin * 2);
                const maxDepth = Math.max(1, bed.depth - margin * 2);
                const scale = Math.min(maxWidth / size.x, maxDepth / size.y, 1);
                if (scale < 1) {
                    group.scale.set(scale, scale, 1);
                }
            }

            const exporter = new OBJExporter();
            group.updateMatrixWorld(true);
            let obj = exporter.parse(group);
            const baseName = `${getImageBaseName()}_extruded_${Math.round(thickness)}mm`;
            const mtl = buildMtl(materials, baseName);

            if (mtl) {
                obj = `mtllib ${baseName}.mtl\n` + obj;
                downloadBlob(new Blob([mtl], { type: 'text/plain' }), `${baseName}.mtl`);
            }

            downloadBlob(new Blob([obj], { type: 'text/plain' }), `${baseName}.obj`);
            elements.statusText.textContent = 'OBJ export complete.';
        } catch (error) {
            console.error('OBJ export failed:', error);
            elements.statusText.textContent = 'Failed to export OBJ.';
        } finally {
            showLoader(false);
        }
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

    function dataUrlToBlob(dataUrl) {
        const parts = dataUrl.split(',');
        const mimeMatch = parts[0].match(/:(.*?);/);
        const mime = mimeMatch ? mimeMatch[1] : 'image/png';
        const binary = atob(parts[1]);
        const len = binary.length;
        const u8arr = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
            u8arr[i] = binary.charCodeAt(i);
        }
        return new Blob([u8arr], { type: mime });
    }

    function pngToJpgDataUrl(pngDataUrl, quality = 0.92) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = 'white';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.onerror = reject;
            img.src = pngDataUrl;
        });
    }

    function pngDataUrlToTgaBlob(pngDataUrl, includeAlpha) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                if (!includeAlpha) {
                    ctx.fillStyle = 'white';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                }
                ctx.drawImage(img, 0, 0);
                const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const hasAlpha = includeAlpha;

                const header = new Uint8Array(18);
                header[2] = 2; // uncompressed true-color
                header[12] = width & 0xff;
                header[13] = (width >> 8) & 0xff;
                header[14] = height & 0xff;
                header[15] = (height >> 8) & 0xff;
                header[16] = hasAlpha ? 32 : 24;
                // Image descriptor: alpha bits + origin (bit 5 = 1 for top-left origin)
                header[17] = hasAlpha ? (8 | 0x20) : 0x20; // 0x20 = top-left origin flag

                const pixelSize = hasAlpha ? 4 : 3;
                const imageSize = width * height * pixelSize;
                const pixels = new Uint8Array(imageSize);
                for (let i = 0, p = 0; i < data.length; i += 4, p += pixelSize) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const a = data[i + 3];
                    pixels[p] = b;
                    pixels[p + 1] = g;
                    pixels[p + 2] = r;
                    if (hasAlpha) pixels[p + 3] = a;
                }

                const tgaData = new Uint8Array(header.length + pixels.length);
                tgaData.set(header, 0);
                tgaData.set(pixels, header.length);
                resolve(new Blob([tgaData], { type: 'image/x-tga' }));
            };
            img.onerror = reject;
            img.src = pngDataUrl;
        });
    }

    function estimateSizeBytes(width, height, format, alpha) {
        if (!width || !height) return 0;
        const channels = alpha ? 4 : 3;
        const rawBytes = width * height * channels;
        let factor = 1;
        if (format === 'png') factor = 0.45; // rough compression heuristic
        if (format === 'jpg') factor = 0.16; // jpeg compression (~10:1–8:1)
        if (format === 'tga') factor = 1.0; // uncompressed true color
        return Math.max(1, Math.round(rawBytes * factor));
    }

    function formatBytes(bytes) {
        if (!bytes || bytes < 0) return '—';
        if (bytes < 1024) return `${bytes} B`;
        const kb = bytes / 1024;
        if (kb < 1024) return `${kb.toFixed(1)} KB`;
        const mb = kb / 1024;
        return `${mb.toFixed(1)} MB`;
    }

    function updateSizeEstimates(targetDims) {
        if (!elements.sizeEstPng || !elements.sizeEstJpg || !elements.sizeEstTga) return;
        if (!targetDims) {
            elements.sizeEstPng.textContent = '—';
            elements.sizeEstJpg.textContent = '—';
            elements.sizeEstTga.textContent = '—';
            return;
        }
        const alpha = !!state.preserveAlpha;
        elements.sizeEstPng.textContent = formatBytes(estimateSizeBytes(targetDims.width, targetDims.height, 'png', alpha));
        elements.sizeEstJpg.textContent = formatBytes(estimateSizeBytes(targetDims.width, targetDims.height, 'jpg', false));
        elements.sizeEstTga.textContent = formatBytes(estimateSizeBytes(targetDims.width, targetDims.height, 'tga', alpha));
    }

    function setAvailableLayersVisible(show) {
        state.showAvailableLayers = show;
        if (elements.availableLayersContent) {
            elements.availableLayersContent.style.display = show ? 'block' : 'none';
        }
        if (elements.toggleAvailableLayersBtn) {
            elements.toggleAvailableLayersBtn.textContent = show ? 'Hide' : 'Show';
        }
    }

    function setFinalPaletteVisible(show) {
        state.showFinalPalette = show;
        if (elements.finalPaletteContent) {
            elements.finalPaletteContent.style.display = show ? 'block' : 'none';
        }
        if (elements.toggleFinalPaletteBtn) {
            elements.toggleFinalPaletteBtn.textContent = show ? 'Hide' : 'Show';
        }
    }

    function getImageBaseName() {
        const name = (state.originalImageUrl || 'image').split(/[\\/]/).pop() || 'image';
        return name.replace(/\.[^/.]+$/, '') || 'image';
    }

    // Extract format from filename or data URL
    function getImageFormat(filename, dataUrl) {
        // Try to get from filename extension
        if (filename) {
            const match = filename.match(/\.([^.]+)$/);
            if (match) {
                return match[1].toUpperCase();
            }
        }

        // Try to get from data URL MIME type
        if (dataUrl && dataUrl.startsWith('data:')) {
            const match = dataUrl.match(/^data:image\/([^;]+)/);
            if (match) {
                return match[1].toUpperCase();
            }
        }

        return 'Unknown';
    }

    // Calculate file size from data URL
    function getDataUrlSize(dataUrl) {
        if (!dataUrl || !dataUrl.startsWith('data:')) return 0;

        // Extract base64 data
        const base64Data = dataUrl.split(',')[1];
        if (!base64Data) return 0;

        // Calculate actual bytes from base64
        // Base64 encoding inflates size by ~33%, so we reverse that
        let size = base64Data.length * 0.75;

        // Account for padding characters
        const padding = (base64Data.match(/=/g) || []).length;
        size -= padding;

        return Math.round(size);
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

    // Smart "Export Layers" button - uses merged data if rules exist, otherwise uses original data
    if (elements.exportLayersBtn) {
        elements.exportLayersBtn.addEventListener('click', () => {
            if (!state.tracedata) return;
            const visibleIndices = getVisibleLayerIndices();
            if (!visibleIndices.length) return;

            const imageName = (state.originalImageUrl || 'image').split(/[\\/]/).pop().replace(/\.[^/.]+$/, '');

            // Smart behavior: use merged data if rules exist, otherwise use original
            if (state.mergeRules && state.mergeRules.length > 0) {
                // Export merged layers
                const mergedData = createMergedTracedata(state.tracedata, visibleIndices, state.mergeRules);
                const layerIndices = [];
                for (let i = 0; i < mergedData.layers.length; i++) {
                    if (layerHasPaths(mergedData.layers[i])) {
                        layerIndices.push(i);
                    }
                }

                layerIndices.forEach((idx) => {
                    const singleLayer = buildTracedataSubset(mergedData, [idx]);
                    const layerName = idx === 0 ? 'background' : `layer_${idx}`;
                    downloadSVG(ImageTracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_final_${layerName}`);
                });
            } else {
                // Export original visible layers
                visibleIndices.forEach((idx) => {
                    const singleLayer = buildTracedataSubset(state.tracedata, [idx]);
                    const layerName = idx === 0 ? 'background' : `layer_${idx}`;
                    downloadSVG(ImageTracer.getsvgstring(singleLayer, state.lastOptions), `${imageName}_${layerName}`);
                });
            }
        });
    }

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
        if (elements.mergeRulesContainer) elements.mergeRulesContainer.innerHTML = '';
        const visibleIndices = getVisibleLayerIndices();
        // Now include all layers (including background) for merging
        if (visibleIndices.length >= 2) {
            if (elements.layerMergingSection) elements.layerMergingSection.style.display = 'block';
            if (elements.addMergeRuleBtn) elements.addMergeRuleBtn.disabled = false;
        } else {
            if (elements.layerMergingSection) elements.layerMergingSection.style.display = 'none';
        }
        if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = true;
        updateFinalPalette();
    }

    if (elements.addMergeRuleBtn) {
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
            if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = false;
            updateFinalPalette();
            updateFilteredPreview();
        });
    }

    if (elements.mergeRulesContainer) {
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
                    if (elements.combineAndDownloadBtn) elements.combineAndDownloadBtn.disabled = true;
                }
                updateFinalPalette();
                updateFilteredPreview();
            }
        });
    }
    
    function updateMergeRuleSwatches(row, rule, allVisibleIndices) {
        const sourceIndex = allVisibleIndices[rule.source];
        const targetIndex = allVisibleIndices[rule.target];
        const sourceColor = state.tracedata.palette[sourceIndex];
        const targetColor = state.tracedata.palette[targetIndex];
        row.querySelector('[data-swatch="source"]').style.backgroundColor = `rgb(${sourceColor.r},${sourceColor.g},${sourceColor.b})`;
        row.querySelector('[data-swatch="target"]').style.backgroundColor = `rgb(${targetColor.r},${targetColor.g},${targetColor.b})`;
    }

    if (elements.combineAndDownloadBtn) {
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
    }

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

    switchExportTab('svg');
    setExportScale(state.exportScale);
    setAvailableLayersVisible(true);
    setFinalPaletteVisible(true);
    setHighFidelity(state.highFidelity);
    updateExportScaleDisplay();

    // Update segmented control indicator on window resize
    window.addEventListener('resize', () => updateSegmentedControlIndicator());

    // Collapsible layers section toggle
    const layersToggle = document.getElementById('layers-toggle');
    const layersSection = document.getElementById('layers-section');
    if (layersToggle && layersSection) {
        layersToggle.addEventListener('click', () => {
            layersSection.classList.toggle('collapsed');
            layersToggle.classList.toggle('expanded');
            const isExpanded = !layersSection.classList.contains('collapsed');
            layersToggle.querySelector('span').textContent = isExpanded ? 'Click to collapse' : 'Click to expand';
        });
    }

    // RGBA channel tab switching
    const channelTabs = document.querySelectorAll('.rgba-channel-tab');
    channelTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const channel = tab.dataset.channel;

            // Update active state
            channelTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Display the selected channel
            displayChannel(channel);
        });
    });

    // Sync inline alpha checkboxes with preserve-alpha state
    const preserveAlphaPng = document.getElementById('preserve-alpha-png');
    const preserveAlphaTga = document.getElementById('preserve-alpha-tga');

    if (preserveAlphaPng) {
        preserveAlphaPng.checked = state.preserveAlpha;
        preserveAlphaPng.addEventListener('change', () => {
            state.preserveAlpha = preserveAlphaPng.checked || preserveAlphaTga?.checked;
            updateExportScaleDisplay();
        });
    }

    if (preserveAlphaTga) {
        preserveAlphaTga.checked = state.preserveAlpha;
        preserveAlphaTga.addEventListener('change', () => {
            state.preserveAlpha = preserveAlphaTga.checked || preserveAlphaPng?.checked;
            updateExportScaleDisplay();
        });
    }

    // Keep old preserve-alpha checkbox working if it exists (backward compatibility)
    if (elements.preserveAlphaCheckbox) {
        elements.preserveAlphaCheckbox.checked = state.preserveAlpha;
        elements.preserveAlphaCheckbox.addEventListener('change', () => {
            state.preserveAlpha = elements.preserveAlphaCheckbox.checked;
            if (preserveAlphaPng) preserveAlphaPng.checked = state.preserveAlpha;
            if (preserveAlphaTga) preserveAlphaTga.checked = state.preserveAlpha;
            updateExportScaleDisplay();
        });
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
