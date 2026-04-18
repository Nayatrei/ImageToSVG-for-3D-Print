import { OBJ_ZOOM_MIN, OBJ_ZOOM_MAX, BED_PRESETS } from './config.js';
import { formatObjScalePercent } from './obj-scale.js';
import { buildObjGeometryBundle, buildObjModelPlan } from './obj-model-plan.js?v=20260412b';
import { resolveMergedLayerGroups } from './shared/trace-utils.js';

const BED_CONTACT_EPSILON = 0.005;

function createFrameState({ THREERef, footprintWidth, footprintDepth, modelHeight, bed, showBuildPlate }) {
    const frameMaxDim = Math.max(
        footprintWidth,
        footprintDepth,
        showBuildPlate === false ? 120 : bed.width * 0.95,
        showBuildPlate === false ? 120 : bed.depth * 0.95
    );
    const lift = Math.max(modelHeight * 0.65, 10);
    const distance = frameMaxDim * 1.1 + lift * 2.2;

    return {
        frameMaxDim,
        panScale: frameMaxDim > 0 ? frameMaxDim / 320 : 1,
        fitTarget: new THREERef.Vector3(0, -distance * 0.82, distance * 1.08 + lift),
        lookAtTarget: new THREERef.Vector3(0, 0, BED_CONTACT_EPSILON + Math.max(modelHeight * 0.35, 2))
    };
}

function getApproxTriangleCount(geometry) {
    if (!geometry) return 0;
    if (geometry.index) return Math.round(geometry.index.count / 3);
    const position = geometry.getAttribute('position');
    return position ? Math.round(position.count / 3) : 0;
}

function getBundleTriangleCount(geometryBundle) {
    if (!geometryBundle?.layers) return 0;
    let total = 0;
    geometryBundle.layers.forEach((layerData) => {
        total += getApproxTriangleCount(layerData.geometry);
    });
    return total;
}

function formatTriangleCount(value) {
    const count = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
    return count.toLocaleString();
}

export function createObjPreview({
    state,
    modelControls,
    viewControls,
    getDataToExport,
    getVisibleLayerIndices,
    ImageTracer
}) {
    const tracer = ImageTracer || window.ImageTracer;
    const model = modelControls || {};
    const view = viewControls || {};

    function ensureObjPreview() {
        if (state.objPreview.renderer) return true;
        if (state.objPreview.webglUnavailable) return false;
        if (!view.objPreviewCanvas) return false;

        const THREERef = window.THREE;
        const SVGLoader = window.SVGLoader;
        if (!THREERef || !SVGLoader) return false;

        let renderer;
        try {
            renderer = new THREERef.WebGLRenderer({
                canvas: view.objPreviewCanvas,
                antialias: true,
                alpha: true
            });
        } catch (err) {
            // WebGL context creation can fail on old hardware, privacy-hardened
            // browsers, or headless environments. Degrade gracefully: skip 3D
            // preview but keep 2D analysis and export paths working.
            state.objPreview.webglUnavailable = true;
            console.warn('3D preview unavailable: WebGL context could not be created.', err?.message || err);
            setPlaceholder('3D preview unavailable — WebGL is required. 2D export still works.', true);
            return false;
        }
        renderer.setPixelRatio(window.devicePixelRatio || 1);

        const scene = new THREERef.Scene();
        const viewGroup = new THREERef.Group();
        const bedGroup = new THREERef.Group();
        const group = new THREERef.Group();
        const camera = new THREERef.PerspectiveCamera(45, 1, 0.1, 10000);

        viewGroup.add(bedGroup);
        viewGroup.add(group);
        scene.add(viewGroup);

        const ambient = new THREERef.AmbientLight(0xffffff, 0.52);
        const hemiLight = new THREERef.HemisphereLight(0xcbd5e1, 0x111827, 0.5);
        const keyLight = new THREERef.DirectionalLight(0xffffff, 1);
        const fillLight = new THREERef.DirectionalLight(0xffffff, 0.34);
        const rimLight = new THREERef.DirectionalLight(0xffffff, 0.28);

        keyLight.position.set(1.2, -1.5, 2.4);
        fillLight.position.set(-1.2, 0.7, 1.1);
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
        const canvas = view.objPreviewCanvas;
        if (!canvas || preview.interactionsBound) return;

        preview.interactionsBound = true;

        const onPointerDown = (event) => {
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

            const isPan = preview.dragButton === 1 || preview.targetLocked === false;
            if (isPan) {
                const scale = preview.panScale || 1;
                preview.panX += deltaX * scale;
                preview.panY += -deltaY * scale;
                preview.viewGroup.position.set(preview.panX, preview.panY, 0);
            } else {
                preview.rotationY += deltaX * 0.01;
                preview.rotationX += deltaY * 0.01;
                preview.viewGroup.rotation.set(preview.rotationX, preview.rotationY, 0);
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
        canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    }

    function resize() {
        const preview = state.objPreview;
        if (!preview.renderer || !preview.camera || !view.objPreviewCanvas) return;
        const container = view.objPreviewCanvas.parentElement;
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
        if (!view.objPreviewPlaceholder) return;
        view.objPreviewPlaceholder.textContent = text;
        view.objPreviewPlaceholder.style.display = show ? 'flex' : 'none';
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
        preview.zoom = Math.min(OBJ_ZOOM_MAX, Math.max(OBJ_ZOOM_MIN, value));
        renderFrame();
    }

    function getSelectedBedKey() {
        const bedKey = model.objBedSelect?.value;
        if (bedKey && BED_PRESETS[bedKey]) return bedKey;
        return 'x1';
    }

    function syncBedPresetControl() {
        const bedKey = getSelectedBedKey();
        if (view.objPreviewBedSelect && view.objPreviewBedSelect.value !== bedKey) {
            view.objPreviewBedSelect.value = bedKey;
        }
    }

    function updateBuildPlateToggleButton() {
        if (!view.objBuildPlateToggle) return;
        const showBuildPlate = state.objPreview.showBuildPlate !== false;
        view.objBuildPlateToggle.classList.toggle('active', showBuildPlate);
        view.objBuildPlateToggle.setAttribute('aria-pressed', showBuildPlate ? 'true' : 'false');
        view.objBuildPlateToggle.title = showBuildPlate ? 'Hide build plate' : 'Show build plate';
    }

    function syncAppliedScalePercent(appliedPercent) {
        if (!Number.isFinite(appliedPercent)) return;
        const roundedPercent = Number.parseFloat(
            (appliedPercent >= 1 ? appliedPercent.toFixed(1) : appliedPercent.toFixed(2))
        );
        if (!Number.isFinite(roundedPercent)) return;

        state.objParams.scale = roundedPercent;
        if (model.objScaleSlider) model.objScaleSlider.value = String(roundedPercent);
        if (model.objScaleValue) model.objScaleValue.textContent = formatObjScalePercent(roundedPercent);
    }

    function updateSizeReadout(scalePlan) {
        if (!model.objSizeReadout) return;
        if (!scalePlan || !scalePlan.footprintWidth || !scalePlan.footprintDepth) {
            model.objSizeReadout.textContent = 'Footprint: —';
            return;
        }

        let suffix = '';
        if (scalePlan.wasAutoFitted) {
            suffix = ` · auto-fit to ${scalePlan.bedLabel} at ${formatObjScalePercent(scalePlan.appliedPercent)}%`;
        } else if (!scalePlan.fitsBed) {
            const ow = scalePlan.overflowWidth > 0.05 ? ` +${scalePlan.overflowWidth.toFixed(1)}W` : '';
            const od = scalePlan.overflowDepth > 0.05 ? ` +${scalePlan.overflowDepth.toFixed(1)}D` : '';
            suffix = ` · exceeds bed${ow}${od}`;
        } else if (scalePlan.bedLabel) {
            suffix = ` · fits ${scalePlan.bedLabel}`;
        }

        model.objSizeReadout.textContent = `Footprint: ${scalePlan.footprintWidth.toFixed(1)} × ${scalePlan.footprintDepth.toFixed(1)} mm${suffix}`;
    }

    function updateStructureWarning(warnings) {
        if (!model.objStructureWarning) return;
        if (!Array.isArray(warnings) || warnings.length === 0) {
            model.objStructureWarning.textContent = '';
            model.objStructureWarning.classList.add('hidden');
            return;
        }

        if (warnings.length === 1) {
            model.objStructureWarning.textContent = warnings[0].message;
        } else {
            model.objStructureWarning.textContent = `${warnings.length} output layers extend beyond the selected support base footprint.`;
        }
        model.objStructureWarning.classList.remove('hidden');
    }

    function updateTriangleEstimate({ triangleCount = 0, decimatePercent = 0 } = {}) {
        if (view.triangleEstimate) {
            view.triangleEstimate.textContent = `Approx. triangles: ${triangleCount > 0 ? formatTriangleCount(triangleCount) : '—'}`;
        }

        if (view.triangleControlsHint) {
            const baseHint = 'Reduce triangles with more Small Shape Cleanup, more Curve Straightness, fewer Output Colors, or Mesh Detail Reduction.';
            view.triangleControlsHint.textContent = decimatePercent > 0
                ? `${baseHint} Mesh Detail Reduction is currently ${decimatePercent}%.`
                : `${baseHint} Corner Sharpness usually preserves detail instead of lowering it.`;
        }
    }

    function setBuildPlateVisible(showBuildPlate) {
        state.objPreview.showBuildPlate = !!showBuildPlate;
        updateBuildPlateToggleButton();
        render();
    }

    function setBedPreset(bedKey) {
        if (!BED_PRESETS[bedKey]) return;
        if (view.objPreviewBedSelect && view.objPreviewBedSelect.value !== bedKey) {
            view.objPreviewBedSelect.value = bedKey;
        }
        if (model.objBedSelect && model.objBedSelect.value !== bedKey) {
            model.objBedSelect.value = bedKey;
            model.objBedSelect.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        render();
    }

    function updateLayerModeButtons() {
        if (view.objModeGhost) {
            view.objModeGhost.classList.toggle('active', state.objPreview.layerDisplayMode === 'ghost');
        }
        if (view.objModeSolo) {
            view.objModeSolo.classList.toggle('active', state.objPreview.layerDisplayMode === 'solo');
        }
    }

    function setLayerDisplayMode(mode) {
        state.objPreview.layerDisplayMode = mode === 'solo' ? 'solo' : 'ghost';
        updateLayerModeButtons();
        render();
    }

    function updateTargetLockButton() {
        if (!view.objTargetLock) return;
        view.objTargetLock.classList.toggle('active', state.objPreview.targetLocked);
        view.objTargetLock.textContent = state.objPreview.targetLocked ? 'Lock' : 'Pan';
    }

    function setTargetLocked(locked) {
        state.objPreview.targetLocked = !!locked;
        updateTargetLockButton();
    }

    function fitView() {
        const preview = state.objPreview;
        if (!preview.viewGroup) return;

        preview.panX = 0;
        preview.panY = 0;
        preview.viewGroup.position.set(0, 0, 0);
        preview.needsFit = true;
        setZoom(1);
        render();
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
        const visibleSourceLayerIds = getVisibleLayerIndices();
        const outputGroups = resolveMergedLayerGroups(visibleSourceLayerIds, state.mergeRules || []);

        if (state.selectedFinalLayerIndices.size > 0) {
            return new Set(state.selectedFinalLayerIndices);
        }

        if (state.selectedLayerIndices.size === 0) return new Set();

        const selected = new Set();
        outputGroups.forEach((group, outputIndex) => {
            if (group.sourceLayerIds.some((sourceLayerId) => state.selectedLayerIndices.has(sourceLayerId))) {
                selected.add(outputIndex);
            }
        });
        return selected;
    }

    function updateLayerStackPreview(plan, defaultThickness, selectionSet) {
        if (!view.layerStackList || !view.layerStackMeta) return;
        view.layerStackList.innerHTML = '';

        if (!plan || !Array.isArray(plan.outputLayers) || plan.outputLayers.length === 0) {
            view.layerStackMeta.textContent = 'No layers yet';
            if (view.useBaseLayerCheckbox) {
                view.useBaseLayerCheckbox.checked = !!state.useBaseLayer;
            }
            if (view.baseLayerSelect) {
                view.baseLayerSelect.innerHTML = '<option value="0">L0</option>';
                view.baseLayerSelect.disabled = !state.useBaseLayer;
            }
            return;
        }

        if (view.useBaseLayerCheckbox) {
            view.useBaseLayerCheckbox.checked = !!plan.useBaseLayer;
        }

        if (view.baseLayerSelect) {
            view.baseLayerSelect.innerHTML = '';
            plan.outputLayers.forEach((layer) => {
                const option = document.createElement('option');
                option.value = String(layer.primarySourceLayerId);
                option.textContent = layer.displayLabel;
                view.baseLayerSelect.appendChild(option);
            });
            const nextValue = String(state.baseSourceLayerId ?? plan.outputLayers[0].primarySourceLayerId);
            view.baseLayerSelect.value = nextValue;
            view.baseLayerSelect.disabled = !plan.useBaseLayer;
        }

        view.layerStackMeta.textContent = `${plan.outputLayers.length} layer${plan.outputLayers.length === 1 ? '' : 's'} · max ${plan.maxHeight.toFixed(1)}mm`;

        plan.outputLayers.forEach((layer, outputIndex) => {
            const row = document.createElement('div');
            row.className = 'layer-stack-item';

            const swatch = document.createElement('span');
            swatch.className = 'layer-stack-swatch';
            swatch.style.backgroundColor = `rgb(${layer.color.r},${layer.color.g},${layer.color.b})`;

            const label = document.createElement('span');
            label.className = 'layer-stack-label';
            label.textContent = layer.isBase ? `${layer.displayLabel} (Support Base)` : layer.displayLabel;

            const thicknessInput = document.createElement('input');
            thicknessInput.type = 'number';
            thicknessInput.className = 'layer-stack-thickness';
            thicknessInput.value = layer.thickness;
            thicknessInput.min = '0.1';
            thicknessInput.max = '20';
            thicknessInput.step = '0.5';
            thicknessInput.title = 'Layer height (mm)';
            thicknessInput.addEventListener('change', (event) => {
                const nextValue = Math.max(0.1, Math.min(20, Number.parseFloat(event.target.value) || defaultThickness));
                state.layerThicknessById = {
                    ...(state.layerThicknessById || {}),
                    [layer.primarySourceLayerId]: nextValue
                };
                render();
            });

            const range = document.createElement('span');
            range.className = 'layer-stack-range';
            range.textContent = `${layer.zStart.toFixed(1)}-${layer.zEnd.toFixed(1)}mm`;

            row.appendChild(swatch);
            row.appendChild(label);
            row.appendChild(thicknessInput);
            row.appendChild(range);

            if (layer.isBase) row.classList.add('is-base');

            const hasSelection = selectionSet && selectionSet.size > 0;
            const isSelected = selectionSet && selectionSet.has(outputIndex);
            if (hasSelection && !isSelected) row.classList.add('ghosted');
            if (isSelected) row.classList.add('selected');

            view.layerStackList.appendChild(row);
        });
    }

    function render() {
        if (!view.objPreviewCanvas) return;
        if (!window.THREE || !window.SVGLoader) {
            setPlaceholder('Loading 3D preview...', true);
            scheduleRetry();
            return;
        }
        if (!ensureObjPreview()) return;

        const preview = state.objPreview;
        const THREERef = window.THREE;
        const SVGLoader = window.SVGLoader;
        const bufferUtils = window.BufferGeometryUtils || THREERef?.BufferGeometryUtils;
        if (!preview.group || !preview.viewGroup || !THREERef || !SVGLoader || !bufferUtils) return;

        resize();
        const visibleSourceLayerIds = getVisibleLayerIndices();
        if (!state.tracedata || visibleSourceLayerIds.length === 0) {
            clearGroup();
            clearBuildPlate();
            setPlaceholder('3D preview will appear after analysis.', true);
            updateLayerStackPreview(null, 0, new Set());
            updateSizeReadout(null);
            updateStructureWarning([]);
            updateTriangleEstimate();
            renderFrame();
            return;
        }

        try {
            clearGroup();
            clearBuildPlate();

            const defaultThickness = model.objThicknessSlider ? Number.parseFloat(model.objThicknessSlider.value) : 4;
            const thickness = Number.isFinite(defaultThickness) ? defaultThickness : 4;
            const bedKey = getSelectedBedKey();
            const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
            const marginValue = model.objMarginInput ? Number.parseFloat(model.objMarginInput.value) : 5;
            const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;
            const scaleValue = model.objScaleSlider ? Number.parseFloat(model.objScaleSlider.value) : 100;
            const decimateValue = model.objDecimateSlider ? Number.parseFloat(model.objDecimateSlider.value) : 0;
            const decimatePercent = Number.isFinite(decimateValue) ? Math.max(0, Math.min(100, decimateValue)) : 0;
            const selectionSet = getSelectionIndices();
            const hasSelection = selectionSet.size > 0;
            const displayMode = state.objPreview.layerDisplayMode;

            syncBedPresetControl();
            updateBuildPlateToggleButton();

            const plan = buildObjModelPlan({
                state,
                tracer,
                SVGLoader,
                THREERef,
                defaultThickness: thickness,
                visibleSourceLayerIds,
                decimatePercent,
                bedKey,
                margin,
                scalePercent: scaleValue,
                sourceScale: state.sourceRenderScale || 1,
                bezelPreset: model.objBezelSelect?.value || state.objParams?.bezelPreset || 'off'
            });

            if (!plan || plan.outputLayers.length === 0) {
                buildBuildPlate(THREERef, bed);
                setPlaceholder('No printable geometry for current selection.', true);
                updateLayerStackPreview(null, thickness, selectionSet);
                updateSizeReadout(null);
                updateStructureWarning([]);
                updateTriangleEstimate({ decimatePercent });
                renderFrame();
                return;
            }

            const scalePlan = plan.scalePlan;
            if (scalePlan?.wasAutoFitted) {
                syncAppliedScalePercent(scalePlan.appliedPercent);
            }

            const geometryBundle = buildObjGeometryBundle(plan, { THREERef, bufferUtils });
            if (!geometryBundle || geometryBundle.layers.size === 0) {
                buildBuildPlate(THREERef, bed);
                setPlaceholder('No printable geometry for current selection.', true);
                updateLayerStackPreview(plan, thickness, selectionSet);
                updateSizeReadout(scalePlan);
                updateStructureWarning(plan.warnings);
                updateTriangleEstimate({ decimatePercent });
                renderFrame();
                return;
            }

            plan.outputLayers.forEach((layer, outputIndex) => {
                const layerData = geometryBundle.layers.get(layer.outputLayerId);
                if (!layerData) {
                    return;
                }

                const isSelected = !hasSelection || selectionSet.has(outputIndex);
                const material = new THREERef.MeshStandardMaterial({
                    color: new THREERef.Color(layer.color.r / 255, layer.color.g / 255, layer.color.b / 255),
                    side: THREERef.DoubleSide,
                    transparent: hasSelection && !isSelected,
                    opacity: hasSelection && !isSelected ? 0.18 : 1
                });
                if (hasSelection && !isSelected) material.depthWrite = false;

                const mesh = new THREERef.Mesh(layerData.geometry, material);
                mesh.visible = !(hasSelection && displayMode === 'solo' && !isSelected);
                preview.group.add(mesh);
            });

            preview.group.scale.set(scalePlan.scale, scalePlan.scale, 1);
            preview.group.position.set(0, 0, BED_CONTACT_EPSILON);
            preview.viewGroup.position.set(preview.panX || 0, preview.panY || 0, 0);
            preview.viewGroup.rotation.set(preview.rotationX, preview.rotationY, 0);

            buildBuildPlate(THREERef, bed);

            const frameState = createFrameState({
                THREERef,
                footprintWidth: scalePlan.footprintWidth,
                footprintDepth: scalePlan.footprintDepth,
                modelHeight: plan.totalHeight,
                bed,
                showBuildPlate: preview.showBuildPlate !== false
            });

            preview.frameMaxDim = frameState.frameMaxDim;
            preview.panScale = frameState.panScale;
            preview.fitTarget = frameState.fitTarget;

            if (preview.needsFit || !preview.target) {
                preview.target = frameState.fitTarget.clone();
                preview.lookAtTarget = frameState.lookAtTarget.clone();
                preview.needsFit = false;
            }

            setPlaceholder('', false);
            updateLayerStackPreview(plan, thickness, selectionSet);
            updateSizeReadout(scalePlan);
            updateStructureWarning(plan.warnings);
            updateTriangleEstimate({
                triangleCount: getBundleTriangleCount(geometryBundle),
                decimatePercent
            });
            renderFrame();
        } catch (error) {
            console.error('3D preview failed:', error);
            setPlaceholder('3D preview failed. Try re-analyzing.', true);
            updateTriangleEstimate();
        }
    }

    function bindControls() {
        if (view.objBuildPlateToggle) {
            view.objBuildPlateToggle.addEventListener('click', () => {
                setBuildPlateVisible(state.objPreview.showBuildPlate === false);
            });
        }
        if (view.objPreviewBedSelect) {
            view.objPreviewBedSelect.addEventListener('change', (event) => {
                setBedPreset(event.target.value);
            });
        }
        if (model.objBedSelect) {
            model.objBedSelect.addEventListener('change', () => {
                syncBedPresetControl();
            });
        }
        if (view.objFitView) {
            view.objFitView.addEventListener('click', () => fitView());
        }
        if (view.objRecenter) {
            view.objRecenter.addEventListener('click', () => recenterView());
        }
        if (view.objTargetLock) {
            view.objTargetLock.addEventListener('click', () => {
                setTargetLocked(!state.objPreview.targetLocked);
            });
        }
        if (view.objModeGhost) {
            view.objModeGhost.addEventListener('click', () => setLayerDisplayMode('ghost'));
        }
        if (view.objModeSolo) {
            view.objModeSolo.addEventListener('click', () => setLayerDisplayMode('solo'));
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
