import { OBJ_ZOOM_MIN, OBJ_ZOOM_MAX, BED_PRESETS } from './config.js';
import { buildLayerIndexMap, getLayerIndexForColor } from './obj-layers.js';
import { ensureLayerThicknesses, computeLayerLayout } from './layer-layout.js';
import { computeObjScalePlan } from './obj-scale.js';

const BED_TOP_Z = 0;
const BED_CONTACT_EPSILON = 0.005;

export function createObjPreview({
    state,
    elements,
    getDataToExport,
    getVisibleLayerIndices,
    ImageTracer
}) {
    const tracer = ImageTracer || window.ImageTracer;

    function ensureObjPreview() {
        if (state.objPreview.renderer) return true;
        if (!elements.objPreviewCanvas) return false;

        const THREERef = window.THREE;
        const SVGLoader = window.SVGLoader;
        if (!THREERef || !SVGLoader) return false;

        const renderer = new THREERef.WebGLRenderer({
            canvas: elements.objPreviewCanvas,
            antialias: true,
            alpha: true
        });
        renderer.setPixelRatio(window.devicePixelRatio || 1);

        const scene = new THREERef.Scene();
        const viewGroup = new THREERef.Group();
        const bedGroup = new THREERef.Group();
        const camera = new THREERef.PerspectiveCamera(45, 1, 0.1, 10000);
        const group = new THREERef.Group();
        viewGroup.add(bedGroup);
        viewGroup.add(group);
        scene.add(viewGroup);

        const ambient = new THREERef.AmbientLight(0xffffff, 0.52);
        const hemiLight = new THREERef.HemisphereLight(0xcbd5e1, 0x111827, 0.5);

        // Main key light from upper front-right
        const keyLight = new THREERef.DirectionalLight(0xffffff, 1);
        keyLight.position.set(1.2, -1.5, 2.4);

        // Fill light from opposite side (softer)
        const fillLight = new THREERef.DirectionalLight(0xffffff, 0.34);
        fillLight.position.set(-1.2, 0.7, 1.1);

        // Rim/back light for edge definition
        const rimLight = new THREERef.DirectionalLight(0xffffff, 0.28);
        rimLight.position.set(0.3, 1.3, 1.4);

        scene.add(ambient, hemiLight, keyLight, fillLight, rimLight);

        state.objPreview.renderer = renderer;
        state.objPreview.scene = scene;
        state.objPreview.viewGroup = viewGroup;
        state.objPreview.bedGroup = bedGroup;
        state.objPreview.camera = camera;
        state.objPreview.group = group;

        bindObjPreviewInteractions();
        resize();
        return true;
    }

    function bindObjPreviewInteractions() {
        const preview = state.objPreview;
        const canvas = elements.objPreviewCanvas;
        if (!canvas || preview.interactionsBound) return;

        preview.interactionsBound = true;

        const onPointerDown = (event) => {
            // Left (0) = rotate, Middle (1) = pan
            if (event.button !== 0 && event.button !== 1) return;
            preview.isDragging = true;
            preview.dragButton = event.button;
            preview.lastX = event.clientX;
            preview.lastY = event.clientY;
            event.preventDefault();
            if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
        };

        const onPointerMove = (event) => {
            if (!preview.isDragging || !preview.viewGroup) return;
            const deltaX = event.clientX - preview.lastX;
            const deltaY = event.clientY - preview.lastY;
            preview.lastX = event.clientX;
            preview.lastY = event.clientY;

            const isPan = preview.dragButton === 1;
            if (!isPan) {
                // Left drag → orbit/rotate
                preview.rotationY += deltaX * 0.01;
                preview.rotationX += deltaY * 0.01;
                preview.viewGroup.rotation.set(preview.rotationX, preview.rotationY, 0);
            } else {
                // Middle drag → pan
                const scale = preview.panScale || 1;
                preview.panX += deltaX * scale;
                preview.panY += -deltaY * scale;
                preview.viewGroup.position.set(preview.panX, preview.panY, 0);
            }
            renderFrame();
        };

        const onPointerUp = (event) => {
            preview.isDragging = false;
            if (canvas.releasePointerCapture) canvas.releasePointerCapture(event.pointerId);
        };

        const onWheel = (event) => {
            event.preventDefault();
            const delta = Math.sign(event.deltaY);
            setZoom(preview.zoom * (delta > 0 ? 1.08 : 0.92));
        };

        canvas.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('pointerleave', onPointerUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }

    function resize() {
        const preview = state.objPreview;
        if (!preview.renderer || !preview.camera || !elements.objPreviewCanvas) return;
        const container = elements.objPreviewCanvas.parentElement;
        if (!container) return;
        const width = container.clientWidth || 1;
        const height = container.clientHeight || 1;
        preview.renderer.setSize(width, height, false);
        preview.camera.aspect = width / height;
        preview.camera.updateProjectionMatrix();
    }

    function disposeObjectGroup(group) {
        if (!group) return;
        group.traverse((child) => {
            if (child === group) return;
            if (child.geometry) child.geometry.dispose();
            if (child.material) {
                if (Array.isArray(child.material)) {
                    child.material.forEach((material) => material?.dispose?.());
                } else {
                    child.material.dispose();
                }
            }
        });
        group.clear();
    }

    function clearGroup() {
        disposeObjectGroup(state.objPreview.group);
    }

    function clearBuildPlate() {
        disposeObjectGroup(state.objPreview.bedGroup);
    }

    function renderFrame() {
        const preview = state.objPreview;
        if (!preview.renderer || !preview.scene || !preview.camera) return;
        if (preview.target) {
            const base = preview.target.clone();
            const zoomed = base.divideScalar(Math.max(0.5, preview.zoom));
            preview.camera.position.copy(zoomed);
            if (preview.lookAtTarget) {
                preview.camera.lookAt(preview.lookAtTarget);
            } else {
                preview.camera.lookAt(0, 0, 0);
            }
        }
        preview.renderer.render(preview.scene, preview.camera);
    }

    function setPlaceholder(text, show = true) {
        if (!elements.objPreviewPlaceholder) return;
        elements.objPreviewPlaceholder.textContent = text;
        elements.objPreviewPlaceholder.style.display = show ? 'flex' : 'none';
    }

    function scheduleRetry() {
        if (state.objPreview.retryScheduled) return;
        state.objPreview.retryScheduled = true;
        setTimeout(() => {
            state.objPreview.retryScheduled = false;
            render();
        }, 300);
    }

    function setZoom(value) {
        const preview = state.objPreview;
        const next = Math.min(OBJ_ZOOM_MAX, Math.max(OBJ_ZOOM_MIN, value));
        preview.zoom = next;
        renderFrame();
    }

    function getSelectedBedKey() {
        const sharedKey = elements.objBedSelect?.value;
        if (sharedKey && BED_PRESETS[sharedKey]) return sharedKey;
        const previewKey = elements.objPreviewBedSelect?.value;
        if (previewKey && BED_PRESETS[previewKey]) return previewKey;
        return 'x1';
    }

    function syncBedPresetControl() {
        const bedKey = getSelectedBedKey();
        if (elements.objPreviewBedSelect && elements.objPreviewBedSelect.value !== bedKey) {
            elements.objPreviewBedSelect.value = bedKey;
        }
    }

    function updateBuildPlateToggleButton() {
        if (!elements.objBuildPlateToggle) return;
        const showBuildPlate = state.objPreview.showBuildPlate !== false;
        elements.objBuildPlateToggle.classList.toggle('active', showBuildPlate);
        elements.objBuildPlateToggle.setAttribute('aria-pressed', showBuildPlate ? 'true' : 'false');
        elements.objBuildPlateToggle.title = showBuildPlate ? 'Hide build plate' : 'Show build plate';
    }

    function updateSizeReadout(scalePlan) {
        if (!elements.objSizeReadout) return;
        if (!scalePlan || !scalePlan.footprintWidth || !scalePlan.footprintDepth) {
            elements.objSizeReadout.textContent = 'Footprint: —';
            return;
        }
        let suffix = '';
        if (!scalePlan.fitsBed) {
            const ow = scalePlan.overflowWidth > 0.05 ? ` +${scalePlan.overflowWidth.toFixed(1)}W` : '';
            const od = scalePlan.overflowDepth > 0.05 ? ` +${scalePlan.overflowDepth.toFixed(1)}D` : '';
            suffix = ` · exceeds bed${ow}${od}`;
        }
        elements.objSizeReadout.textContent = `Footprint: ${scalePlan.footprintWidth.toFixed(1)} × ${scalePlan.footprintDepth.toFixed(1)} mm${suffix}`;
    }

    function setBuildPlateVisible(showBuildPlate) {
        state.objPreview.showBuildPlate = !!showBuildPlate;
        updateBuildPlateToggleButton();
        render();
    }

    function setBedPreset(bedKey) {
        if (!BED_PRESETS[bedKey]) return;
        if (elements.objPreviewBedSelect && elements.objPreviewBedSelect.value !== bedKey) {
            elements.objPreviewBedSelect.value = bedKey;
        }
        if (elements.objBedSelect && elements.objBedSelect.value !== bedKey) {
            elements.objBedSelect.value = bedKey;
            elements.objBedSelect.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        render();
    }

    function updateLayerModeButtons() {
        if (elements.objModeGhost) {
            elements.objModeGhost.classList.toggle('active', state.objPreview.layerDisplayMode === 'ghost');
        }
        if (elements.objModeSolo) {
            elements.objModeSolo.classList.toggle('active', state.objPreview.layerDisplayMode === 'solo');
        }
    }

    function setLayerDisplayMode(mode) {
        state.objPreview.layerDisplayMode = mode === 'solo' ? 'solo' : 'ghost';
        updateLayerModeButtons();
        render();
    }

    function updateTargetLockButton() {
        if (elements.objTargetLock) {
            elements.objTargetLock.classList.toggle('active', state.objPreview.targetLocked);
            elements.objTargetLock.textContent = state.objPreview.targetLocked ? 'Lock' : 'Pan';
        }
    }

    function setTargetLocked(locked) {
        state.objPreview.targetLocked = !!locked;
        updateTargetLockButton();
    }

    function fitView() {
        const preview = state.objPreview;
        if (!preview.viewGroup || !window.THREE) return;

        // Reset pan/zoom immediately so the next render uses a fresh frame.
        preview.panX = 0;
        preview.panY = 0;
        if (preview.viewGroup) preview.viewGroup.position.set(0, 0, 0);
        setZoom(1);

        // If a scale slider is present, reset it to 100% and let the dispatched
        // 'input' event drive updateFilteredPreview() → render().  Nulling target
        // first means render() will auto-set the camera to the freshly-computed
        // fitTarget for the newly-scaled model — no need to call renderFrame() here.
        if (elements.objScaleSlider) {
            elements.objScaleSlider.value = '100';
            if (elements.objScaleValue) elements.objScaleValue.textContent = '100';
            preview.target = null;  // force render() to auto-fit
            elements.objScaleSlider.dispatchEvent(new Event('input', { bubbles: true }));
            return;
        }

        // Fallback for contexts without a scale slider: fit based on current geometry.
        if (!preview.group) return;
        const THREERef = window.THREE;
        const bbox = new THREERef.Box3().setFromObject(preview.group);
        const size = new THREERef.Vector3();
        bbox.getSize(size);
        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const thickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;
        const frameMaxDim = preview.frameMaxDim || Math.max(size.x, size.y, 120);
        const lift = Math.max(size.z * 0.65, thickness * 2, 10);
        const distance = frameMaxDim * 1.1 + lift * 2.2;
        preview.fitTarget = new THREERef.Vector3(0, -distance * 0.82, distance * 1.08 + lift);
        preview.target = preview.fitTarget.clone();
        preview.lookAtTarget = new THREERef.Vector3(0, 0, 5);
        renderFrame();
    }

    function recenterView() {
        const preview = state.objPreview;
        if (!preview.viewGroup) return;
        preview.panX = 0;
        preview.panY = 0;
        preview.viewGroup.position.set(0, 0, 0);
        renderFrame();
    }

    function createGridLines({ THREERef, width, depth, step, color, opacity, elevation }) {
        const vertices = [];
        const halfWidth = width / 2;
        const halfDepth = depth / 2;

        for (let x = -halfWidth; x <= halfWidth + 0.001; x += step) {
            vertices.push(x, -halfDepth, elevation, x, halfDepth, elevation);
        }

        for (let y = -halfDepth; y <= halfDepth + 0.001; y += step) {
            vertices.push(-halfWidth, y, elevation, halfWidth, y, elevation);
        }

        const geometry = new THREERef.BufferGeometry();
        geometry.setAttribute('position', new THREERef.Float32BufferAttribute(vertices, 3));
        const material = new THREERef.LineBasicMaterial({
            color,
            transparent: true,
            opacity
        });
        return new THREERef.LineSegments(geometry, material);
    }

    function buildBuildPlate(THREERef, bed) {
        const preview = state.objPreview;
        if (!preview.bedGroup || preview.showBuildPlate === false) return;

        const plateThickness = 4;
        const skirt = new THREERef.Mesh(
            new THREERef.BoxGeometry(bed.width + 8, bed.depth + 8, 1.4),
            new THREERef.MeshStandardMaterial({
                color: 0x11151c,
                roughness: 0.95,
                metalness: 0.05
            })
        );
        skirt.position.z = -plateThickness - 0.7;

        const plate = new THREERef.Mesh(
            new THREERef.BoxGeometry(bed.width, bed.depth, plateThickness),
            new THREERef.MeshStandardMaterial({
                color: 0x20242d,
                roughness: 0.92,
                metalness: 0.08
            })
        );
        plate.position.z = -plateThickness / 2;

        const minorGrid = createGridLines({
            THREERef,
            width: bed.width,
            depth: bed.depth,
            step: 10,
            color: 0x4b5563,
            opacity: 0.42,
            elevation: 0.05
        });

        const majorGrid = createGridLines({
            THREERef,
            width: bed.width,
            depth: bed.depth,
            step: 50,
            color: 0xd1d5db,
            opacity: 0.18,
            elevation: 0.08
        });

        const edgeLines = new THREERef.LineSegments(
            new THREERef.EdgesGeometry(new THREERef.BoxGeometry(bed.width, bed.depth, plateThickness)),
            new THREERef.LineBasicMaterial({
                color: 0x9ca3af,
                transparent: true,
                opacity: 0.3
            })
        );
        edgeLines.position.z = -plateThickness / 2;

        preview.bedGroup.add(skirt, plate, minorGrid, majorGrid, edgeLines);
    }


    function getSelectionIndices() {
        if (!state.tracedata) return new Set();
        if (state.mergeRules.length > 0) {
            if (state.selectedFinalLayerIndices.size > 0) {
                return new Set(state.selectedFinalLayerIndices);
            }
            if (state.selectedLayerIndices.size > 0) {
                const visibleIndices = getVisibleLayerIndices();
                const mapping = buildMergedLayerMapping(visibleIndices, state.mergeRules);
                const selected = new Set();
                state.selectedLayerIndices.forEach((originalIndex) => {
                    const mergedIndex = mapping.originalToMerged.get(originalIndex);
                    if (mergedIndex !== undefined) selected.add(mergedIndex);
                });
                return selected;
            }
        }
        return new Set(state.selectedLayerIndices);
    }

    function buildMergedLayerMapping(visibleIndices, rules) {
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

        const sortedTargets = Object.keys(groups).map(Number).sort((a, b) => a - b);
        const targetToMerged = new Map();
        sortedTargets.forEach((targetRuleIndex, mergedIndex) => {
            targetToMerged.set(targetRuleIndex, mergedIndex);
        });

        const originalToMerged = new Map();
        visibleIndices.forEach((originalIndex, ruleIndex) => {
            const targetRuleIndex = finalTargets[ruleIndex];
            const mergedIndex = targetToMerged.get(targetRuleIndex);
            if (mergedIndex !== undefined) {
                originalToMerged.set(originalIndex, mergedIndex);
            }
        });

        const groupsByMerged = {};
        sortedTargets.forEach((targetRuleIndex, mergedIndex) => {
            groupsByMerged[mergedIndex] = groups[targetRuleIndex];
        });

        return { groups: groupsByMerged, originalToMerged };
    }

    function updateLayerStackPreview(dataToExport, defaultThickness, selectionSet) {
        if (!elements.layerStackList || !elements.layerStackMeta) return;
        elements.layerStackList.innerHTML = '';

        if (!dataToExport || !Array.isArray(dataToExport.palette) || dataToExport.palette.length === 0) {
            elements.layerStackMeta.textContent = 'No layers yet';
            // Clear base layer select
            if (elements.baseLayerSelect) {
                elements.baseLayerSelect.innerHTML = '<option value="0">L0</option>';
            }
            return;
        }

        const layerCount = dataToExport.palette.length;

        const layerThicknesses = ensureLayerThicknesses(state, layerCount, defaultThickness);
        const layout = computeLayerLayout({
            layerThicknesses,
            useBaseLayer: state.useBaseLayer,
            baseLayerIndex: state.baseLayerIndex
        });
        state.baseLayerIndex = layout.baseLayerIndex;

        // Populate base layer select options
        if (elements.baseLayerSelect) {
            const currentValue = elements.baseLayerSelect.value;
            elements.baseLayerSelect.innerHTML = '';
            for (let i = 0; i < layerCount; i++) {
                const option = document.createElement('option');
                option.value = i;
                option.textContent = `L${i}`;
                elements.baseLayerSelect.appendChild(option);
            }
            // Restore previous selection if still valid
            if (parseInt(currentValue, 10) < layerCount) {
                elements.baseLayerSelect.value = currentValue;
                state.baseLayerIndex = parseInt(currentValue, 10);
            } else {
                state.baseLayerIndex = layout.baseLayerIndex;
            }
            elements.baseLayerSelect.value = String(state.baseLayerIndex);
        }

        elements.layerStackMeta.textContent = `${layerCount} layer${layerCount === 1 ? '' : 's'} · max ${layout.maxHeight.toFixed(1)}mm`;

        let mergedGroups = null;
        if (state.mergeRules.length > 0) {
            const visibleIndices = getVisibleLayerIndices();
            mergedGroups = buildMergedLayerMapping(visibleIndices, state.mergeRules).groups;
        }

        dataToExport.palette.forEach((color, index) => {
            const row = document.createElement('div');
            row.className = 'layer-stack-item';

            const swatch = document.createElement('span');
            swatch.className = 'layer-stack-swatch';
            swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;

            const label = document.createElement('span');
            label.className = 'layer-stack-label';
            let orderText = `L${index}`;
            // Add base badge if this is the base layer
            if (state.useBaseLayer && index === state.baseLayerIndex) {
                orderText += ' (Base)';
            }
            if (mergedGroups) {
                const sourceIndices = mergedGroups[index] || [];
                if (sourceIndices.length > 1) {
                    label.textContent = `${orderText} (${sourceIndices.join('+')})`;
                } else {
                    label.textContent = orderText;
                }
            } else {
                label.textContent = orderText;
            }

            // Thickness input (height from base)
            const thicknessInput = document.createElement('input');
            thicknessInput.type = 'number';
            thicknessInput.className = 'layer-stack-thickness';
            thicknessInput.value = layerThicknesses[index];
            thicknessInput.min = '0.1';
            thicknessInput.max = '20';
            thicknessInput.step = '0.5';
            thicknessInput.title = 'Layer height (mm)';
            thicknessInput.addEventListener('change', (e) => {
                const newValue = parseFloat(e.target.value) || defaultThickness;
                state.layerThicknesses[index] = Math.max(0.1, Math.min(20, newValue));
                render(); // Re-render with new thickness
            });

            const layerThickness = layerThicknesses[index];
            const heightLabel = document.createElement('span');
            heightLabel.className = 'layer-stack-range';
            const zStart = layout.positions[index];
            heightLabel.textContent = `${zStart.toFixed(1)}-${(zStart + layerThickness).toFixed(1)}mm`;

            row.appendChild(swatch);
            row.appendChild(label);
            row.appendChild(thicknessInput);
            row.appendChild(heightLabel);

            if (state.useBaseLayer && index === state.baseLayerIndex) {
                row.classList.add('is-base');
            }

            const hasSelection = selectionSet && selectionSet.size > 0;
            const isSelected = selectionSet && selectionSet.has(index);
            if (hasSelection && !isSelected) {
                row.classList.add('ghosted');
            }
            if (isSelected) {
                row.classList.add('selected');
            }

            elements.layerStackList.appendChild(row);
        });
    }

    function render() {
        if (!elements.objPreviewCanvas) return;
        if (!window.THREE || !window.SVGLoader) {
            setPlaceholder('Loading 3D preview...', true);
            scheduleRetry();
            return;
        }
        if (!ensureObjPreview()) return;

        const preview = state.objPreview;
        const THREERef = window.THREE;
        const SVGLoader = window.SVGLoader;
        if (!preview.group || !preview.viewGroup || !THREERef || !SVGLoader) return;

        resize();
        const dataToExport = getDataToExport();
        if (!state.tracedata || !dataToExport) {
            clearGroup();
            clearBuildPlate();
            setPlaceholder('3D preview will appear after analysis.', true);
            updateLayerStackPreview(null, 0, new Set());
            updateSizeReadout(null);
            renderFrame();
            return;
        }

        try {
            clearGroup();
            clearBuildPlate();

            const defaultThickness = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
            const thickness = Number.isFinite(defaultThickness) ? defaultThickness : 4;
            const detailValue = elements.objDetailSlider ? parseInt(elements.objDetailSlider.value, 10) : 6;
            const curveSegments = Number.isFinite(detailValue) ? Math.max(1, detailValue) : 6;
            const bedKey = getSelectedBedKey();
            const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
            const marginValue = elements.objMarginInput ? parseFloat(elements.objMarginInput.value) : 5;
            const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;
            const scaleValue = elements.objScaleSlider ? parseFloat(elements.objScaleSlider.value) : 100;
            const selectionSet = getSelectionIndices();
            const hasSelection = selectionSet.size > 0;
            const displayMode = state.objPreview.layerDisplayMode;

            syncBedPresetControl();
            updateBuildPlateToggleButton();

            const layerCount = dataToExport.palette.length;
            const layerThicknesses = ensureLayerThicknesses(state, layerCount, thickness);
            const layout = computeLayerLayout({
                layerThicknesses,
                useBaseLayer: state.useBaseLayer,
                baseLayerIndex: state.baseLayerIndex
            });
            state.baseLayerIndex = layout.baseLayerIndex;

            const svgString = tracer.getsvgstring(dataToExport, state.lastOptions);
            const loader = new SVGLoader();
            const svgData = loader.parse(svgString);
            const layerIndexMap = buildLayerIndexMap(dataToExport.palette);

            // — Pass 1: group shapes by layer index and find SVG bounding box —
            const shapesByLayer = new Map();
            let svgMinX = Infinity, svgMinY = Infinity, svgMaxX = -Infinity, svgMaxY = -Infinity;

            svgData.paths.forEach((path) => {
                const shapes = SVGLoader.createShapes(path);
                if (!shapes || !shapes.length) return;
                const sourceColor = path.color instanceof THREERef.Color
                    ? path.color
                    : new THREERef.Color(path.color || '#000');
                const layerIndex = getLayerIndexForColor(layerIndexMap, sourceColor.getHexString());
                if (!shapesByLayer.has(layerIndex)) {
                    shapesByLayer.set(layerIndex, { color: sourceColor, shapes: [] });
                }
                shapes.forEach((shape) => {
                    shapesByLayer.get(layerIndex).shapes.push(shape);
                    shape.getPoints(16).forEach((pt) => {
                        if (pt.x < svgMinX) svgMinX = pt.x;
                        if (pt.y < svgMinY) svgMinY = pt.y;
                        if (pt.x > svgMaxX) svgMaxX = pt.x;
                        if (pt.y > svgMaxY) svgMaxY = pt.y;
                    });
                });
            });

            const svgBoundsValid = svgMaxX > svgMinX && svgMaxY > svgMinY;

            // — Pass 2: build geometry — base layer → solid plate, others → path extrusions —
            shapesByLayer.forEach(({ color: sourceColor, shapes }, layerIndex) => {
                const layerDepth = layout.depths[layerIndex] || thickness;
                const isSelected = !hasSelection || selectionSet.has(layerIndex);
                if (hasSelection && displayMode === 'solo' && !isSelected) return;
                const paletteColor = dataToExport.palette[layerIndex];
                const materialColor = paletteColor
                    ? new THREERef.Color(paletteColor.r / 255, paletteColor.g / 255, paletteColor.b / 255)
                    : sourceColor;

                const material = new THREERef.MeshStandardMaterial({
                    color: materialColor,
                    side: THREERef.DoubleSide,
                    transparent: hasSelection && !isSelected,
                    opacity: hasSelection && !isSelected ? 0.18 : 1
                });
                if (hasSelection && !isSelected) material.depthWrite = false;

                const zPosition = layout.positions[layerIndex] || 0;

                // Base layer → solid rectangular plate covering the full design footprint
                const isBase = state.useBaseLayer && layerIndex === state.baseLayerIndex;
                const shapesToExtrude = (isBase && svgBoundsValid)
                    ? [(() => {
                        const plate = new THREERef.Shape();
                        plate.moveTo(svgMinX, svgMinY);
                        plate.lineTo(svgMaxX, svgMinY);
                        plate.lineTo(svgMaxX, svgMaxY);
                        plate.lineTo(svgMinX, svgMaxY);
                        plate.closePath();
                        return plate;
                    })()]
                    : shapes;

                shapesToExtrude.forEach((shape) => {
                    const geometry = new THREERef.ExtrudeGeometry(shape, {
                        depth: layerDepth,
                        curveSegments,
                        bevelEnabled: false
                    });
                    geometry.rotateX(Math.PI);
                    geometry.computeVertexNormals();
                    const mesh = new THREERef.Mesh(geometry, material);
                    mesh.position.z = zPosition;
                    preview.group.add(mesh);
                });
            });

            const hasPreviewGeometry = preview.group.children.some((child) => child?.isMesh && child.geometry);
            if (!hasPreviewGeometry) {
                buildBuildPlate(THREERef, bed);

                preview.basePosition = new THREERef.Vector3(0, 0, 0);
                preview.panX = 0;
                preview.panY = 0;
                preview.group.position.copy(preview.basePosition);
                preview.viewGroup.position.set(0, 0, 0);
                preview.viewGroup.rotation.set(preview.rotationX, preview.rotationY, 0);

                const frameMaxDim = preview.showBuildPlate === false
                    ? 120
                    : Math.max(bed.width, bed.depth, 120);
                const lift = Math.max(thickness * 2, 10);
                const distance = frameMaxDim * 1.1 + lift * 2.2;
                preview.frameMaxDim = frameMaxDim;
                preview.panScale = frameMaxDim / 320;
                preview.lookAtTarget = new THREERef.Vector3(0, 0, 5);
                preview.fitTarget = new THREERef.Vector3(0, -distance * 0.82, distance * 1.08 + lift);
                preview.target = preview.fitTarget.clone();

                setPlaceholder('No printable geometry for current selection.', true);
                updateLayerStackPreview(dataToExport, thickness, selectionSet);
                updateSizeReadout(null);
                renderFrame();
                return;
            }

            const bbox = new THREERef.Box3().setFromObject(preview.group);
            const size = new THREERef.Vector3();
            bbox.getSize(size);

            const scalePlan = computeObjScalePlan({
                rawWidth: size.x,
                rawDepth: size.y,
                bedKey,
                margin,
                scalePercent: scaleValue
            });
            preview.group.scale.set(scalePlan.scale, scalePlan.scale, 1);
            updateSizeReadout(scalePlan);

            const centeredBox = new THREERef.Box3().setFromObject(preview.group);
            const finalSize = new THREERef.Vector3();
            centeredBox.getSize(finalSize);

            // Stable XY anchor: use the SVG footprint centre (not the 3D mesh centroid,
            // which shifts when a backing-plate rect is added or layer heights change).
            const svgCenterX = (svgMinX + svgMaxX) / 2 * scalePlan.scale;
            const svgCenterY = (svgMinY + svgMaxY) / 2 * scalePlan.scale;

            // Stable Z anchor: always seat the bottom of the model at the bed surface.
            // Do not vary this formula by showBuildPlate — toggling the plate must not
            // shift the model in Z.
            const zOffset = (BED_TOP_Z + BED_CONTACT_EPSILON) - centeredBox.min.z;
            preview.basePosition = new THREERef.Vector3(-svgCenterX, -svgCenterY, zOffset);
            if (preview.panX === undefined) preview.panX = 0;
            if (preview.panY === undefined) preview.panY = 0;
            preview.group.position.copy(preview.basePosition);
            preview.viewGroup.position.set(preview.panX, preview.panY, 0);
            preview.viewGroup.rotation.set(preview.rotationX, preview.rotationY, 0);

            buildBuildPlate(THREERef, bed);

            // frameMaxDim is based on XY footprint only — excluding model height and
            // raw thickness — so that panScale stays stable when layer depths change.
            const frameMaxDim = Math.max(
                finalSize.x,
                finalSize.y,
                preview.showBuildPlate === false ? 120 : bed.width * 0.95,
                preview.showBuildPlate === false ? 120 : bed.depth * 0.95
            );
            const lift = Math.max(finalSize.z * 0.65, thickness * 2, 10);
            const distance = frameMaxDim * 1.1 + lift * 2.2;
            preview.frameMaxDim = frameMaxDim;
            preview.panScale = frameMaxDim > 0 ? frameMaxDim / 320 : 1;
            preview.fitTarget = new THREERef.Vector3(0, -distance * 0.82, distance * 1.08 + lift);
            // Only set camera target and look-at on first render — prevents jumping when
            // layer heights, scale, margin, bed, or backing change while the user has
            // already positioned the camera.  The Fit button provides explicit reframing.
            if (!preview.target) {
                preview.target = preview.fitTarget.clone();
                // Stable look-at: fixed height above the bed surface (world Z=5).
                // Does not depend on model height so it never drifts when layers change.
                preview.lookAtTarget = new THREERef.Vector3(0, 0, 5);
            }

            setPlaceholder('', false);
            updateLayerStackPreview(dataToExport, thickness, selectionSet);
            renderFrame();
        } catch (error) {
            console.error('3D preview failed:', error);
            setPlaceholder('3D preview failed. Try re-analyzing.', true);
        }
    }

    function bindControls() {
        if (elements.objBuildPlateToggle) {
            elements.objBuildPlateToggle.addEventListener('click', () => {
                setBuildPlateVisible(state.objPreview.showBuildPlate === false);
            });
        }
        if (elements.objPreviewBedSelect) {
            elements.objPreviewBedSelect.addEventListener('change', (event) => {
                setBedPreset(event.target.value);
            });
        }
        if (elements.objBedSelect) {
            elements.objBedSelect.addEventListener('change', () => {
                syncBedPresetControl();
            });
        }
        if (elements.objFitView) {
            elements.objFitView.addEventListener('click', () => fitView());
        }
        if (elements.objRecenter) {
            elements.objRecenter.addEventListener('click', () => recenterView());
        }
        if (elements.objTargetLock) {
            elements.objTargetLock.addEventListener('click', () => {
                setTargetLocked(!state.objPreview.targetLocked);
            });
        }
        if (elements.objModeGhost) {
            elements.objModeGhost.addEventListener('click', () => setLayerDisplayMode('ghost'));
        }
        if (elements.objModeSolo) {
            elements.objModeSolo.addEventListener('click', () => setLayerDisplayMode('solo'));
        }
        updateLayerModeButtons();
        updateTargetLockButton();
        updateBuildPlateToggleButton();
        syncBedPresetControl();
    }

    return {
        render,
        resize,
        bindControls,
        fitView,
        recenterView,
        setLayerDisplayMode,
        setTargetLocked
    };
}
