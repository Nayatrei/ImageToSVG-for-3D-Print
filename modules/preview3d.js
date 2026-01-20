import { OBJ_ZOOM_MIN, OBJ_ZOOM_MAX, BED_PRESETS } from './config.js';
import { buildLayerIndexMap, getLayerIndexForColor } from './obj-layers.js';

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
        const camera = new THREERef.PerspectiveCamera(45, 1, 0.1, 10000);
        const group = new THREERef.Group();
        scene.add(group);

        // Improved lighting for better depth perception
        const ambient = new THREERef.AmbientLight(0xffffff, 0.4);

        // Main key light from upper front-right
        const keyLight = new THREERef.DirectionalLight(0xffffff, 0.8);
        keyLight.position.set(1, -1, 2);

        // Fill light from opposite side (softer)
        const fillLight = new THREERef.DirectionalLight(0xffffff, 0.3);
        fillLight.position.set(-1, 0.5, 1);

        // Rim/back light for edge definition
        const rimLight = new THREERef.DirectionalLight(0xffffff, 0.25);
        rimLight.position.set(0, 1, -1);

        scene.add(ambient, keyLight, fillLight, rimLight);

        state.objPreview.renderer = renderer;
        state.objPreview.scene = scene;
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
            preview.isDragging = true;
            preview.lastX = event.clientX;
            preview.lastY = event.clientY;
            if (canvas.setPointerCapture) canvas.setPointerCapture(event.pointerId);
        };

        const onPointerMove = (event) => {
            if (!preview.isDragging || !preview.group) return;
            const deltaX = event.clientX - preview.lastX;
            const deltaY = event.clientY - preview.lastY;
            preview.lastX = event.clientX;
            preview.lastY = event.clientY;

            if (preview.targetLocked) {
                preview.rotationY += deltaX * 0.01;
                preview.rotationX += deltaY * 0.01;
                preview.group.rotation.set(preview.rotationX, preview.rotationY, 0);
            } else {
                const scale = preview.panScale || 1;
                preview.panX += deltaX * scale;
                preview.panY += -deltaY * scale;
                if (preview.basePosition) {
                    preview.group.position.set(
                        preview.basePosition.x + preview.panX,
                        preview.basePosition.y + preview.panY,
                        preview.basePosition.z
                    );
                }
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

    function clearGroup() {
        const preview = state.objPreview;
        if (!preview.group) return;
        preview.group.children.forEach(child => {
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        });
        preview.group.clear();
    }

    function renderFrame() {
        const preview = state.objPreview;
        if (!preview.renderer || !preview.scene || !preview.camera) return;
        if (preview.target) {
            const base = preview.target.clone();
            const zoomed = base.divideScalar(Math.max(0.5, preview.zoom));
            preview.camera.position.copy(zoomed);
            preview.camera.lookAt(0, 0, 0);
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
        if (!preview.group || !window.THREE) return;
        const THREERef = window.THREE;
        const bbox = new THREERef.Box3().setFromObject(preview.group);
        const size = new THREERef.Vector3();
        bbox.getSize(size);
        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const thickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;
        const maxDim = Math.max(size.x, size.y, size.z, thickness);
        const distance = maxDim * 1.4 + thickness * 2;
        preview.fitTarget = new THREERef.Vector3(0, -distance, distance);
        preview.target = preview.fitTarget.clone();
        preview.panX = 0;
        preview.panY = 0;
        if (preview.basePosition) {
            preview.group.position.copy(preview.basePosition);
        }
        setZoom(1);
        renderFrame();
    }

    function recenterView() {
        const preview = state.objPreview;
        if (!preview.group || !preview.basePosition) return;
        preview.panX = 0;
        preview.panY = 0;
        preview.group.position.copy(preview.basePosition);
        renderFrame();
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

        // Initialize layer thicknesses if not set
        if (!state.layerThicknesses || state.layerThicknesses.length !== layerCount) {
            state.layerThicknesses = new Array(layerCount).fill(defaultThickness);
        }

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
                state.baseLayerIndex = 0;
            }
        }

        // Calculate max height based on base layer mode
        const baseThickness = state.useBaseLayer ? (state.layerThicknesses[state.baseLayerIndex] || defaultThickness) : 0;
        let maxHeight;
        if (state.useBaseLayer) {
            // Total height = base thickness + max of other layers
            const otherThicknesses = state.layerThicknesses.filter((_, i) => i !== state.baseLayerIndex);
            const maxOther = otherThicknesses.length > 0 ? Math.max(...otherThicknesses) : 0;
            maxHeight = (baseThickness + maxOther).toFixed(1);
        } else {
            maxHeight = Math.max(...state.layerThicknesses).toFixed(1);
        }
        elements.layerStackMeta.textContent = `${layerCount} layer${layerCount === 1 ? '' : 's'} · max ${maxHeight}mm`;

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
            thicknessInput.value = state.layerThicknesses[index];
            thicknessInput.min = '0.1';
            thicknessInput.max = '20';
            thicknessInput.step = '0.5';
            thicknessInput.title = 'Layer height (mm)';
            thicknessInput.addEventListener('change', (e) => {
                const newValue = parseFloat(e.target.value) || defaultThickness;
                state.layerThicknesses[index] = Math.max(0.1, Math.min(20, newValue));
                render(); // Re-render with new thickness
            });

            const layerThickness = state.layerThicknesses[index];
            const heightLabel = document.createElement('span');
            heightLabel.className = 'layer-stack-range';
            // Show z-position range based on base layer mode
            if (state.useBaseLayer) {
                if (index === state.baseLayerIndex) {
                    heightLabel.textContent = `0-${layerThickness.toFixed(1)}mm`;
                } else {
                    const zStart = baseThickness;
                    heightLabel.textContent = `${zStart.toFixed(1)}-${(zStart + layerThickness).toFixed(1)}mm`;
                }
            } else {
                heightLabel.textContent = `0-${layerThickness.toFixed(1)}mm`;
            }

            row.appendChild(swatch);
            row.appendChild(label);
            row.appendChild(thicknessInput);
            row.appendChild(heightLabel);

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
        if (!preview.group || !THREERef || !SVGLoader) return;

        resize();
        const dataToExport = getDataToExport();
        if (!state.tracedata || !dataToExport) {
            clearGroup();
            setPlaceholder('3D preview will appear after analysis.', true);
            updateLayerStackPreview(null, 0, new Set());
            renderFrame();
            return;
        }

        try {
            clearGroup();

            const defaultThickness = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
            const thickness = Number.isFinite(defaultThickness) ? defaultThickness : 4;
            const detailValue = elements.objDetailSlider ? parseInt(elements.objDetailSlider.value, 10) : 6;
            const curveSegments = Number.isFinite(detailValue) ? Math.max(1, detailValue) : 6;
            const bedKey = elements.objBedSelect?.value || 'x1';
            const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
            const marginValue = elements.objMarginInput ? parseFloat(elements.objMarginInput.value) : 5;
            const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;
            const selectionSet = getSelectionIndices();
            const hasSelection = selectionSet.size > 0;
            const displayMode = state.objPreview.layerDisplayMode;

            // Initialize layer thicknesses if needed
            const layerCount = dataToExport.palette.length;
            if (!state.layerThicknesses || state.layerThicknesses.length !== layerCount) {
                state.layerThicknesses = new Array(layerCount).fill(thickness);
            }

            // Base layer positioning
            const useBaseLayer = state.useBaseLayer || false;
            const baseLayerIndex = state.baseLayerIndex || 0;
            const baseLayerThickness = useBaseLayer ? (state.layerThicknesses[baseLayerIndex] || thickness) : 0;

            const svgString = tracer.getsvgstring(dataToExport, state.lastOptions);
            const loader = new SVGLoader();
            const svgData = loader.parse(svgString);
            const layerIndexMap = buildLayerIndexMap(dataToExport.palette);

            svgData.paths.forEach((path) => {
                const shapes = SVGLoader.createShapes(path);
                if (!shapes || !shapes.length) return;
                const sourceColor = path.color instanceof THREERef.Color
                    ? path.color
                    : new THREERef.Color(path.color || '#000');
                const layerIndex = getLayerIndexForColor(layerIndexMap, sourceColor.getHexString());
                const layerDepth = state.layerThicknesses[layerIndex] || thickness;
                const isSelected = !hasSelection || selectionSet.has(layerIndex);
                if (hasSelection && displayMode === 'solo' && !isSelected) {
                    return;
                }
                const material = new THREERef.MeshStandardMaterial({
                    color: sourceColor,
                    side: THREERef.DoubleSide,
                    transparent: hasSelection && !isSelected,
                    opacity: hasSelection && !isSelected ? 0.18 : 1
                });
                if (hasSelection && !isSelected) {
                    material.depthWrite = false;
                }

                // Calculate z position based on base layer mode
                let zPosition = 0;
                if (useBaseLayer) {
                    if (layerIndex === baseLayerIndex) {
                        // Base layer starts at z=0
                        zPosition = 0;
                    } else {
                        // Other layers sit on top of the base layer
                        zPosition = baseLayerThickness;
                    }
                }

                shapes.forEach((shape) => {
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

            const bbox = new THREERef.Box3().setFromObject(preview.group);
            const size = new THREERef.Vector3();
            bbox.getSize(size);

            if (size.x > 0 && size.y > 0) {
                const maxWidth = Math.max(1, bed.width - margin * 2);
                const maxDepth = Math.max(1, bed.depth - margin * 2);
                const scale = Math.min(maxWidth / size.x, maxDepth / size.y, 1);
                preview.group.scale.set(scale, scale, 1);
            }

            const centeredBox = new THREERef.Box3().setFromObject(preview.group);
            const center = new THREERef.Vector3();
            centeredBox.getCenter(center);
            preview.basePosition = new THREERef.Vector3(-center.x, -center.y, -center.z);
            preview.panX = 0;
            preview.panY = 0;
            preview.group.position.copy(preview.basePosition);
            preview.group.rotation.set(preview.rotationX, preview.rotationY, 0);

            const finalSize = new THREERef.Vector3();
            centeredBox.getSize(finalSize);
            const maxDim = Math.max(finalSize.x, finalSize.y, finalSize.z, thickness);
            const distance = maxDim * 1.4 + thickness * 2;
            preview.panScale = maxDim > 0 ? maxDim / 300 : 1;
            preview.fitTarget = new THREERef.Vector3(0, -distance, distance);
            preview.target = preview.fitTarget.clone();

            setPlaceholder('', false);
            updateLayerStackPreview(dataToExport, thickness, selectionSet);
            renderFrame();
        } catch (error) {
            console.error('3D preview failed:', error);
            setPlaceholder('3D preview failed. Try re-analyzing.', true);
        }
    }

    function bindControls() {
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
