import { OBJ_ZOOM_MIN, OBJ_ZOOM_MAX, BED_PRESETS } from './config.js?v=r-0482439758aef41c';
import {
    fitObjScalePlanToGeometryBounds,
    formatObjScalePercent
} from './obj-scale.js?v=r-0482439758aef41c';
import {
    buildObjGeometryBundle,
    buildObjModelPlan,
    retargetObjModelPlanPrintStyle,
    updateObjModelPlanLayerHeights
} from './obj-model-plan.js?v=r-0482439758aef41c';
import { resolveMergedLayerGroups } from './shared/trace-utils.js?v=r-0482439758aef41c';
import { getGeometryBundleBounds } from './shared/print-validation.js?v=r-0482439758aef41c';
import { updateMagnetPocketStatus } from './shared/magnet-pocket-controls.js?v=r-0482439758aef41c';
import {
    createObjGeometrySnapshot,
    objGeometrySnapshotsMatch
} from './shared/obj-geometry-snapshot.js?v=r-0482439758aef41c';

const BED_CONTACT_EPSILON = 0.005;
const BED_FIT_TOLERANCE_MM = 0.05;

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
    onLayerVisibilityChange,
    onExportGeometryInvalidated,
    isTabActive,
    ImageTracer
}) {
    const tracer = ImageTracer || window.ImageTracer;
    const model = modelControls || {};
    const view = viewControls || {};
    // `modelControls` are shared with the other 3D tab, so a background render
    // must not write back into them.
    const ownsSharedModelControls = () => (typeof isTabActive === 'function' ? isTabActive() : true);

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
            // browsers, or headless environments. 2D tracing, SVG, and raster
            // export keep working, but every 3D output (OBJ/STL/3MF and the
            // Bambu handoff) now builds from this preview mesh, so those stay
            // unavailable. The flag lets export3d.js say so instead of reporting
            // a preview that is merely "not ready yet".
            state.objPreview.webglUnavailable = true;
            console.warn('3D preview unavailable: WebGL context could not be created.', err?.message || err);
            setPlaceholder('3D preview unavailable — WebGL is required. 2D exports still work; 3D and Bambu transfer do not.', true);
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
        renderFrame();
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
        state.objPreview.layerMeshes = new Map();
        state.objPreview.lastPlan = null;
        state.objPreview.lastGeometryBundle = null;
        state.objPreview.lastActualBounds = null;
        state.objPreview.lastTriangleCount = 0;
        state.objPreview.topologySnapshot = null;
        state.objPreview.stylePreparationSnapshot = null;
        state.objPreview.exportGeometrySnapshot = null;
        state.objPreview.exportGeometryTransforms = null;
    }

    function addMagnetPocketOverlays(plan, THREERef) {
        const result = plan?.magnetPocketResult;
        const scale = plan?.scalePlan?.scale || 1;
        if (view.objPreviewCanvas) view.objPreviewCanvas.dataset.magnetPocketCount = '0';
        if (!result?.enabled || !result.valid || !result.placements?.length || scale <= 0) return;

        result.placements.forEach((placement) => {
            const height = Math.max(0.05, result.cavityHeight);
            let geometry;
            if (result.config.shape === 'disc') {
                geometry = new THREERef.CylinderGeometry(
                    placement.cavityWidthMm / (2 * scale),
                    placement.cavityWidthMm / (2 * scale),
                    height,
                    32,
                    1,
                    false
                );
                geometry.rotateX(Math.PI / 2);
            } else {
                geometry = new THREERef.BoxGeometry(
                    placement.cavityWidthMm / scale,
                    placement.cavityDepthMm / scale,
                    height
                );
            }

            const material = new THREERef.MeshBasicMaterial({
                color: 0x69a99e,
                depthTest: false,
                depthWrite: false,
                transparent: true,
                opacity: 0.78,
                wireframe: true
            });
            const proxy = new THREERef.Mesh(geometry, material);
            proxy.position.set(
                placement.sourceX + (plan.normalization?.shiftX || 0),
                -placement.sourceY - (plan.normalization?.shiftY || 0),
                result.cavityZStart + (height / 2) + (plan.normalization?.shiftZ || 0)
            );
            proxy.renderOrder = 20;
            proxy.userData.magnetPocketProxy = true;
            state.objPreview.group.add(proxy);
        });
        if (view.objPreviewCanvas) {
            view.objPreviewCanvas.dataset.magnetPocketCount = String(result.placements.length);
        }
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
        // #obj-scale is one slider shared by both 3D tabs. Auto-fit belongs to
        // this tab's objParams; only the active tab may push it to the DOM,
        // otherwise a late background render rewrites the other tab's slider
        // (and the model path reads that slider straight off the DOM).
        if (!ownsSharedModelControls()) return;
        if (model.objScaleSlider) model.objScaleSlider.value = String(roundedPercent);
        if (model.objScaleValue) model.objScaleValue.textContent = formatObjScalePercent(roundedPercent);
    }

    function updateSizeReadout(scalePlan, actualBounds = null) {
        const readouts = [model.objSizeReadout, view.modelSizeReadout].filter(Boolean);
        if (!readouts.length) return;
        if (!scalePlan || !scalePlan.footprintWidth || !scalePlan.footprintDepth) {
            readouts.forEach((readout) => {
                readout.textContent = readout === model.objSizeReadout ? 'Footprint: —' : '—';
                readout.dataset.bedFit = 'unknown';
                delete readout.dataset.printWidth;
                delete readout.dataset.printDepth;
                delete readout.dataset.printHeight;
            });
            return;
        }

        const printWidth = actualBounds?.isValid
            ? actualBounds.width
            : scalePlan.actualFootprintWidth || scalePlan.footprintWidth;
        const printDepth = actualBounds?.isValid
            ? actualBounds.depth
            : scalePlan.actualFootprintDepth || scalePlan.footprintDepth;
        const printHeight = actualBounds?.isValid
            ? actualBounds.height
            : scalePlan.modelHeight || 0;

        let suffix = '';
        if (!scalePlan.fitsBed) {
            const ow = scalePlan.overflowWidth > 0.05 ? ` +${scalePlan.overflowWidth.toFixed(1)}W` : '';
            const od = scalePlan.overflowDepth > 0.05 ? ` +${scalePlan.overflowDepth.toFixed(1)}D` : '';
            const oh = scalePlan.overflowHeight > 0.05 ? ` +${scalePlan.overflowHeight.toFixed(1)}H` : '';
            suffix = ` · exceeds bed${ow}${od}${oh}`;
        } else if (scalePlan.wasAutoFitted) {
            suffix = ` · auto-fit to ${scalePlan.bedLabel} at ${formatObjScalePercent(scalePlan.appliedPercent)}%`;
        } else if (scalePlan.bedLabel) {
            suffix = ` · fits ${scalePlan.bedLabel}`;
        }

        const footprint = `${printWidth.toFixed(1)} × ${printDepth.toFixed(1)} mm`;
        const size = printHeight > 0
            ? `${printWidth.toFixed(1)} × ${printDepth.toFixed(1)} × ${printHeight.toFixed(1)} mm`
            : footprint;
        if (model.objSizeReadout) {
            const heightText = printHeight > 0 ? ` · Height ${printHeight.toFixed(1)} mm` : '';
            model.objSizeReadout.textContent = `Footprint: ${footprint}${heightText}${suffix}`;
        }
        if (view.modelSizeReadout) {
            view.modelSizeReadout.textContent = size;
        }
        readouts.forEach((readout) => {
            readout.dataset.bedFit = scalePlan.fitsBed ? 'fits' : 'overflow';
            readout.dataset.autoFitted = scalePlan.wasAutoFitted ? 'true' : 'false';
            readout.dataset.printWidth = printWidth.toFixed(3);
            readout.dataset.printDepth = printDepth.toFixed(3);
            readout.dataset.printHeight = printHeight.toFixed(3);
            readout.title = !scalePlan.fitsBed
                ? `${size} · Exceeds ${scalePlan.bedLabel}`
                : scalePlan.wasAutoFitted
                    ? `${size} · Auto-fitted to ${scalePlan.bedLabel}`
                    : `${size} · Fits ${scalePlan.bedLabel}`;
        });
    }

    function updateAmsPreflightFromPlan(plan) {
        const filamentCount = plan?.outputLayers?.length || 0;
        if (view.preflightLayers) {
            view.preflightLayers.textContent = filamentCount
                ? `${filamentCount} filament${filamentCount === 1 ? '' : 's'}`
                : '—';
            view.preflightLayers.dataset.amsCapacity = filamentCount > 4 ? 'multiple' : 'single';
        }
        if (!filamentCount || !view.preflightStatus || !view.preflightNote) return;

        const ownsCurrentStatus = [
            'One AMS ready',
            'Additional AMS needed',
            'Style adjusted',
            'Ready to export',
            'Auto-fit ready'
        ].includes(view.preflightStatus.textContent.trim());
        const sizeReadout = view.modelSizeReadout;
        const blockedByGeometry = sizeReadout?.dataset.bedFit === 'overflow'
            || sizeReadout?.dataset.structureWarning === 'true';
        if (!ownsCurrentStatus || blockedByGeometry) return;

        const styleWarnings = (plan.warnings || []).filter((warning) => (
            String(warning?.type || '').startsWith('ams-')
        ));
        if (styleWarnings.length) {
            view.preflightStatus.textContent = 'Style adjusted';
            view.preflightStatus.classList.remove('is-waiting', 'is-ready', 'is-review', 'is-blocked');
            view.preflightStatus.classList.add('is-review');
            view.preflightNote.textContent = styleWarnings.map((warning) => warning.message).join(' ');
            return;
        }

        const fitsOneAms = filamentCount <= 4;
        view.preflightStatus.textContent = fitsOneAms ? 'One AMS ready' : 'Additional AMS needed';
        view.preflightStatus.classList.remove('is-waiting', 'is-ready', 'is-review', 'is-blocked');
        view.preflightStatus.classList.add(fitsOneAms ? 'is-ready' : 'is-review');
        if (fitsOneAms) {
            const styleNote = plan.amsPrintStyle === 'face-down'
                ? 'Preview matches the print orientation: the colored face is against the build plate.'
                : plan.amsPrintStyle === 'full-depth'
                    ? 'Full-depth color keeps colored sidewalls but creates more AMS swap layers.'
                    : 'Thin color surfaces reduce the number of AMS swap layers.';
            view.preflightNote.textContent = `${filamentCount} filament color${filamentCount === 1 ? '' : 's'} fit one AMS. ${styleNote}`;
        } else {
            view.preflightNote.textContent = `${filamentCount} filament colors exceed one 4-slot AMS. Merge colors or confirm a multi-AMS setup in Bambu Studio.`;
        }
    }

    function syncFaceDownToggleFromPlan(plan) {
        const button = view.objFaceDownToggle;
        if (!button || !plan) return;

        const requestedFaceDown = plan.requestedAmsPrintStyle === 'face-down';
        const appliedFaceDown = plan.amsPrintStyle === 'face-down';
        const blocked = requestedFaceDown && !appliedFaceDown;
        const stateLabel = button.querySelector('[data-face-down-state]');
        const warning = (plan.warnings || []).find((item) => item?.type === 'ams-print-style');

        button.classList.toggle('is-active', appliedFaceDown);
        button.classList.toggle('is-blocked', blocked);
        button.classList.remove('is-error');
        button.setAttribute('aria-pressed', String(appliedFaceDown));
        if (blocked) {
            const explanation = warning?.message || 'Review the current base, bezel, and magnet settings.';
            button.setAttribute('aria-label', `Face on Bed could not be applied. ${explanation}`);
            button.title = explanation;
        } else if (appliedFaceDown) {
            button.setAttribute('aria-label', 'Face on Bed is on. Return to the previous raised print style');
            button.title = 'Colored regions share the first layer at Z=0; click to restore the previous raised style.';
        } else {
            button.setAttribute('aria-label', 'Place the colored face flat on the build plate');
            button.title = 'Build every color flush against the plate, with the base continuing as backing.';
        }
        if (stateLabel) stateLabel.textContent = blocked ? 'Blocked' : appliedFaceDown ? 'Active' : 'Off';
    }

    function updateStructureWarning(warnings) {
        const activeWarnings = Array.isArray(warnings) ? warnings.filter(Boolean) : [];
        const structureWarnings = activeWarnings.filter((warning) => (
            warning?.type === 'unsupported-overhang' || warning?.type === 'magnet-pocket'
        ));
        if (view.modelSizeReadout) {
            view.modelSizeReadout.dataset.structureWarning = structureWarnings.length ? 'true' : 'false';
            view.modelSizeReadout.dataset.structureWarningLabel = structureWarnings.some((warning) => warning.type === 'magnet-pocket')
                ? 'Check magnet pockets'
                : 'Check support base';
            view.modelSizeReadout.dataset.structureWarningMessage = structureWarnings
                .map((warning) => warning.message)
                .join(' ');
        }
        if (!model.objStructureWarning) return;
        if (activeWarnings.length === 0) {
            model.objStructureWarning.textContent = '';
            model.objStructureWarning.classList.add('hidden');
            return;
        }

        model.objStructureWarning.textContent = activeWarnings
            .map((warning) => warning.message)
            .join(' ');
        model.objStructureWarning.classList.remove('hidden');
    }

    function updateTriangleEstimate({ triangleCount = 0, decimatePercent = 0 } = {}) {
        if (view.triangleEstimate) {
            view.triangleEstimate.textContent = triangleCount > 0 ? formatTriangleCount(triangleCount) : '—';
            view.triangleEstimate.title = triangleCount > 0
                ? `Approx. ${formatTriangleCount(triangleCount)} triangles`
                : 'Triangle estimate unavailable';
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
        if (!ensureObjPreview()) return;
        clearBuildPlate();
        if (state.objPreview.showBuildPlate) {
            const bed = BED_PRESETS[getSelectedBedKey()] || BED_PRESETS.x1;
            buildBuildPlate(window.THREE, bed);
        }
        renderFrame();
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
        const preview = state.objPreview;
        const selectionSet = getSelectionIndices();
        const hasSelection = selectionSet.size > 0;

        if (!(preview.layerMeshes instanceof Map) || preview.layerMeshes.size === 0) {
            render();
            return;
        }

        preview.lastPlan?.outputLayers?.forEach((layer, outputIndex) => {
            const mesh = preview.layerMeshes.get(layer.outputLayerId);
            if (!mesh) return;
            const isSelected = !hasSelection || selectionSet.has(outputIndex);
            mesh.visible = !(hasSelection && state.objPreview.layerDisplayMode === 'solo' && !isSelected);
            if (mesh.material) {
                mesh.material.transparent = hasSelection && !isSelected;
                mesh.material.opacity = hasSelection && !isSelected ? 0.18 : 1;
                mesh.material.depthWrite = !(hasSelection && !isSelected);
                mesh.material.needsUpdate = true;
            }
        });
        renderFrame();
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
        if (preview.fitTarget) preview.target = preview.fitTarget.clone();
        if (preview.fitLookAtTarget) preview.lookAtTarget = preview.fitLookAtTarget.clone();
        preview.needsFit = false;
        setZoom(1);
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

    function getHiddenSourceLayerIds() {
        if (!(state.hiddenSourceLayerIds instanceof Set)) {
            state.hiddenSourceLayerIds = new Set(state.hiddenSourceLayerIds || []);
        }
        return state.hiddenSourceLayerIds;
    }

    function getPrintableSourceLayerIds() {
        if (!state.tracedata?.layers) return [];
        return state.tracedata.layers
            .map((layer, sourceLayerId) => ({ layer, sourceLayerId }))
            .filter(({ layer }) => Array.isArray(layer) && layer.length > 0)
            .map(({ sourceLayerId }) => sourceLayerId);
    }

    function runLayerVisibilityUpdate() {
        if (typeof onLayerVisibilityChange === 'function') {
            Promise.resolve(onLayerVisibilityChange()).catch((error) => {
                console.error('Layer visibility update failed:', error);
                render();
            });
            return;
        }
        render();
    }

    function setSourceLayersHidden(sourceLayerIds, shouldHide) {
        const ids = Array.from(new Set(sourceLayerIds)).filter(Number.isInteger);
        if (!ids.length) return;

        const hidden = getHiddenSourceLayerIds();
        const visible = getVisibleLayerIndices();
        if (shouldHide && visible.filter((sourceLayerId) => !ids.includes(sourceLayerId)).length === 0) {
            return;
        }

        ids.forEach((sourceLayerId) => {
            if (shouldHide) {
                hidden.add(sourceLayerId);
                state.selectedLayerIndices?.delete(sourceLayerId);
            } else {
                hidden.delete(sourceLayerId);
            }
        });
        state.selectedFinalLayerIndices?.clear();
        runLayerVisibilityUpdate();
    }

    function createVisibilityButton(sourceLayerIds, isHidden, disabled = false) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'layer-visibility-toggle';
        button.disabled = disabled;
        button.setAttribute('aria-pressed', String(!isHidden));
        button.setAttribute('aria-label', isHidden ? 'Show layer' : 'Hide layer');
        button.title = disabled
            ? 'At least one printable layer must remain visible.'
            : isHidden ? 'Show this layer in previews and exports.' : 'Hide this layer from previews and exports.';
        button.innerHTML = isHidden
            ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18M10.6 10.7a2 2 0 002.7 2.7M9.9 4.2A10.7 10.7 0 0112 4c5.5 0 9 5.5 9 5.5a16.6 16.6 0 01-2.2 2.7M6.6 6.6C4.3 8.1 3 10 3 10s3.5 5.5 9 5.5c1 0 2-.2 2.9-.5"/></svg>'
            : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10s3.5-5.5 9-5.5S21 10 21 10s-3.5 5.5-9 5.5S3 10 3 10z"/><circle cx="12" cy="10" r="2.4"/></svg>';
        button.addEventListener('click', () => setSourceLayersHidden(sourceLayerIds, !isHidden));
        return button;
    }

    function appendLayerLabel(row, text, isBackgroundCandidate) {
        const label = document.createElement('span');
        label.className = 'layer-stack-label';

        const name = document.createElement('span');
        name.textContent = text;
        label.appendChild(name);

        if (isBackgroundCandidate) {
            const badge = document.createElement('span');
            badge.className = 'layer-background-badge';
            badge.textContent = 'Background?';
            label.appendChild(badge);
        }

        row.appendChild(label);
    }

    function updateBackgroundLayerAction() {
        const button = view.backgroundLayerToggle;
        if (!button) return;

        const candidate = state.backgroundCandidateSourceLayerId;
        const printableIds = getPrintableSourceLayerIds();
        const hasCandidate = Number.isInteger(candidate) && printableIds.includes(candidate);
        button.hidden = !hasCandidate;
        if (!hasCandidate) return;

        const isHidden = getHiddenSourceLayerIds().has(candidate);
        const visibleCount = getVisibleLayerIndices().length;
        button.textContent = isHidden ? 'Restore background' : 'Hide background';
        button.disabled = !isHidden && visibleCount <= 1;
        button.setAttribute('aria-pressed', String(isHidden));
        button.title = isHidden
            ? 'Restore the detected background layer.'
            : button.disabled
                ? 'At least one printable layer must remain visible.'
                : 'Hide the detected background from previews and exports.';
        button.onclick = () => setSourceLayersHidden([candidate], !isHidden);
    }

    function updateLayerStackPreview(plan, defaultThickness, selectionSet) {
        if (!view.layerStackList || !view.layerStackMeta) return;
        view.layerStackList.innerHTML = '';
        updateBackgroundLayerAction();

        if (!plan || !Array.isArray(plan.outputLayers) || plan.outputLayers.length === 0) {
            view.layerStackMeta.textContent = 'No layers yet';
            if (view.useBaseLayerCheckbox) {
                view.useBaseLayerCheckbox.checked = !!state.useBaseLayer;
                const requiresBase = state.objParams?.amsPrintStyle === 'face-down';
                view.useBaseLayerCheckbox.disabled = requiresBase;
                view.useBaseLayerCheckbox.title = requiresBase
                    ? 'Face-down inlay requires a base filament.'
                    : '';
            }
            if (view.baseLayerSelect) {
                view.baseLayerSelect.innerHTML = '<option value="0">L0</option>';
                view.baseLayerSelect.disabled = !state.useBaseLayer;
            }
            return;
        }

        const hiddenIds = getHiddenSourceLayerIds();
        const visibleCount = getVisibleLayerIndices().length;
        const candidateId = state.backgroundCandidateSourceLayerId;

        if (view.useBaseLayerCheckbox) {
            view.useBaseLayerCheckbox.checked = !!plan.useBaseLayer;
            const requiresBase = plan.requestedAmsPrintStyle === 'face-down';
            view.useBaseLayerCheckbox.disabled = requiresBase;
            view.useBaseLayerCheckbox.title = requiresBase
                ? 'Face-down inlay requires a base filament.'
                : '';
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

        view.layerStackMeta.textContent = `${plan.outputLayers.length} filament${plan.outputLayers.length === 1 ? '' : 's'} · ${plan.maxHeight.toFixed(1)}mm total`;

        plan.outputLayers.forEach((layer, outputIndex) => {
            const row = document.createElement('div');
            row.className = 'layer-stack-item';

            const visibilityButton = createVisibilityButton(
                layer.sourceLayerIds,
                false,
                visibleCount <= layer.sourceLayerIds.length
            );

            const swatch = document.createElement('span');
            swatch.className = 'layer-stack-swatch';
            swatch.style.backgroundColor = `rgb(${layer.color.r},${layer.color.g},${layer.color.b})`;

            const thicknessInput = document.createElement('input');
            thicknessInput.type = 'number';
            thicknessInput.className = 'layer-stack-thickness';
            thicknessInput.value = layer.thickness;
            thicknessInput.min = '0.1';
            thicknessInput.max = '20';
            thicknessInput.step = '0.2';
            const faceDownLayer = plan.amsPrintStyle === 'face-down';
            thicknessInput.disabled = faceDownLayer;
            thicknessInput.title = faceDownLayer
                ? layer.isBase
                    ? 'Face-down bases use the Base thickness control.'
                    : 'Face-down colors share the Color surface thickness control.'
                : layer.isBase ? 'Base thickness (mm)' : 'Color-part thickness (mm)';
            thicknessInput.addEventListener('change', (event) => {
                const nextValue = Math.max(0.1, Math.min(20, Number.parseFloat(event.target.value) || defaultThickness));
                state.layerThicknessById = {
                    ...(state.layerThicknessById || {}),
                    [layer.primarySourceLayerId]: nextValue
                };
                updateLayerHeights();
            });

            const range = document.createElement('span');
            range.className = 'layer-stack-range';
            range.textContent = `${layer.zStart.toFixed(1)}-${layer.zEnd.toFixed(1)}mm`;

            row.appendChild(visibilityButton);
            row.appendChild(swatch);
            appendLayerLabel(
                row,
                layer.isBase ? `${layer.displayLabel} (Base filament)` : layer.displayLabel,
                layer.sourceLayerIds.includes(candidateId)
            );
            row.appendChild(thicknessInput);
            row.appendChild(range);

            if (layer.isBase) row.classList.add('is-base');

            const hasSelection = selectionSet && selectionSet.size > 0;
            const isSelected = selectionSet && selectionSet.has(outputIndex);
            if (hasSelection && !isSelected) row.classList.add('ghosted');
            if (isSelected) row.classList.add('selected');

            view.layerStackList.appendChild(row);
        });

        getPrintableSourceLayerIds()
            .filter((sourceLayerId) => hiddenIds.has(sourceLayerId))
            .forEach((sourceLayerId) => {
                const color = state.tracedata.palette[sourceLayerId];
                const row = document.createElement('div');
                row.className = 'layer-stack-item is-hidden';

                row.appendChild(createVisibilityButton([sourceLayerId], true));

                const swatch = document.createElement('span');
                swatch.className = 'layer-stack-swatch';
                swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
                row.appendChild(swatch);

                appendLayerLabel(row, `Layer ${sourceLayerId}`, sourceLayerId === candidateId);

                const thicknessPlaceholder = document.createElement('span');
                thicknessPlaceholder.className = 'layer-stack-thickness-placeholder';
                thicknessPlaceholder.textContent = '—';
                row.appendChild(thicknessPlaceholder);

                const hiddenLabel = document.createElement('span');
                hiddenLabel.className = 'layer-stack-range';
                hiddenLabel.textContent = 'Hidden';
                row.appendChild(hiddenLabel);

                view.layerStackList.appendChild(row);
            });
    }

    function createTopologySnapshot({ includePrintStyle = true } = {}) {
        const visibleSourceLayerIds = getVisibleLayerIndices();
        const keyParts = [
            visibleSourceLayerIds.join(','),
            JSON.stringify(state.mergeRules || []),
            state.useBaseLayer ? 'base:on' : 'base:off',
            state.baseSourceLayerId ?? '',
            model.objDecimateSlider?.value ?? 0,
            model.objBedSelect?.value ?? 'x1',
            model.objMarginInput?.value ?? 5,
            model.objScaleSlider?.value ?? 100,
            state.sourceRenderScale || 1
        ];
        if (includePrintStyle) {
            keyParts.push(model.objAmsPrintStyle?.value || state.objParams?.amsPrintStyle || 'raised-efficient');
        }
        keyParts.push(
            model.objBezelSelect?.value || state.objParams?.bezelPreset || 'off',
            JSON.stringify(state.objParams?.magnetPocket || null)
        );
        return {
            tracedata: state.tracedata,
            lastOptions: state.lastOptions,
            key: keyParts.join('|')
        };
    }

    function stylePreparationMatchesLastRender() {
        const previous = state.objPreview.stylePreparationSnapshot;
        if (!previous) return false;
        const current = createTopologySnapshot({ includePrintStyle: false });
        return previous.tracedata === current.tracedata
            && previous.lastOptions === current.lastOptions
            && previous.key === current.key;
    }

    function topologyMatchesLastRender() {
        const previous = state.objPreview.topologySnapshot;
        if (!previous) return false;
        const current = createTopologySnapshot();
        return previous.tracedata === current.tracedata
            && previous.lastOptions === current.lastOptions
            && previous.key === current.key;
    }

    function canApplyHeightUpdate() {
        const preview = state.objPreview;
        const plan = preview.lastPlan;
        if (!plan?.outputLayers?.length || !(preview.layerMeshes instanceof Map)) return false;
        if (plan.amsPrintStyle === 'face-down') return false;
        if (plan.bezelSpec?.enabled || plan.magnetPocketResult?.enabled) return false;
        if (!topologyMatchesLastRender()) return false;
        return plan.outputLayers.every((layer) => preview.layerMeshes.has(layer.outputLayerId));
    }

    function updateLayerHeights() {
        if (!canApplyHeightUpdate()) {
            render();
            return false;
        }

        const preview = state.objPreview;
        const plan = preview.lastPlan;
        const defaultValue = model.objThicknessSlider
            ? Number.parseFloat(model.objThicknessSlider.value)
            : 4;
        const defaultThickness = Number.isFinite(defaultValue) ? defaultValue : 4;
        const update = updateObjModelPlanLayerHeights(plan, state, defaultThickness);
        if (!update) {
            render();
            return false;
        }
        onExportGeometryInvalidated?.();

        const exportGeometryTransforms = new Map();
        update.transitions.forEach((transition) => {
            const mesh = preview.layerMeshes.get(transition.outputLayerId);
            const baseline = mesh?.userData?.objHeightBaseline;
            if (!mesh || !baseline) return;

            const baselineDepth = Math.max(0.01, baseline.zEnd - baseline.zStart);
            const nextDepth = Math.max(0.01, transition.nextEnd - transition.nextStart);
            const ratio = nextDepth / baselineDepth;
            mesh.scale.z = ratio;
            mesh.position.z = transition.nextStart - (baseline.zStart * ratio);
            exportGeometryTransforms.set(transition.outputLayerId, {
                scaleZ: ratio,
                translateZ: mesh.position.z
            });

            const layerData = preview.lastGeometryBundle?.layers?.get(transition.outputLayerId);
            const updatedLayer = plan.outputLayers.find(
                (layer) => layer.outputLayerId === transition.outputLayerId
            );
            if (layerData && updatedLayer) {
                layerData.thickness = updatedLayer.thickness;
                layerData.zStart = updatedLayer.zStart;
                layerData.zEnd = updatedLayer.zEnd;
            }
        });

        const previousBounds = preview.lastActualBounds;
        const minZ = previousBounds?.isValid ? previousBounds.minZ : 0;
        const nextBounds = previousBounds?.isValid
            ? {
                ...previousBounds,
                minZ,
                maxZ: minZ + update.totalHeight,
                height: update.totalHeight,
                centerZ: minZ + (update.totalHeight / 2)
            }
            : null;
        preview.lastActualBounds = nextBounds;
        preview.exportGeometryTransforms = exportGeometryTransforms;
        preview.exportGeometrySnapshot = createObjGeometrySnapshot({
            state,
            modelControls: model,
            visibleSourceLayerIds: getVisibleLayerIndices(),
            defaultThickness
        });

        const bed = BED_PRESETS[getSelectedBedKey()] || BED_PRESETS.x1;
        const scalePlan = plan.scalePlan;
        if (scalePlan) {
            const width = nextBounds?.isValid ? nextBounds.width : scalePlan.footprintWidth || 0;
            const depth = nextBounds?.isValid ? nextBounds.depth : scalePlan.footprintDepth || 0;
            scalePlan.modelHeight = update.totalHeight;
            scalePlan.actualFootprintWidth = width;
            scalePlan.actualFootprintDepth = depth;
            scalePlan.overflowWidth = Math.max(0, width - (scalePlan.usableBedWidth || bed.width));
            scalePlan.overflowDepth = Math.max(0, depth - (scalePlan.usableBedDepth || bed.depth));
            scalePlan.overflowHeight = Math.max(0, update.totalHeight - bed.height);
            scalePlan.fitsBed = scalePlan.overflowWidth <= 0.05
                && scalePlan.overflowDepth <= 0.05
                && scalePlan.overflowHeight <= 0.05;
        }

        const selectionSet = getSelectionIndices();
        updateLayerStackPreview(plan, defaultThickness, selectionSet);
        updateSizeReadout(scalePlan, nextBounds);
        updateStructureWarning(plan.warnings);
        updateTriangleEstimate({
            triangleCount: preview.lastTriangleCount,
            decimatePercent: plan.decimatePercent
        });

        const frameState = createFrameState({
            THREERef: window.THREE,
            footprintWidth: nextBounds?.isValid ? nextBounds.width : scalePlan?.footprintWidth || 0,
            footprintDepth: nextBounds?.isValid ? nextBounds.depth : scalePlan?.footprintDepth || 0,
            modelHeight: update.totalHeight,
            bed,
            showBuildPlate: preview.showBuildPlate !== false
        });
        preview.frameMaxDim = frameState.frameMaxDim;
        preview.panScale = frameState.panScale;
        preview.fitTarget = frameState.fitTarget;
        preview.fitLookAtTarget = frameState.lookAtTarget;
        preview.heightUpdateCount = (preview.heightUpdateCount || 0) + 1;
        if (view.objPreviewCanvas) {
            view.objPreviewCanvas.dataset.heightUpdateCount = String(preview.heightUpdateCount);
        }
        renderFrame();
        return true;
    }

    function render({ styleOnly = false } = {}) {
        if (!view.objPreviewCanvas) return false;
        if (!window.THREE || !window.SVGLoader) {
            setPlaceholder('Loading 3D preview...', true);
            scheduleRetry();
            return false;
        }
        if (!ensureObjPreview()) return false;

        const preview = state.objPreview;
        const THREERef = window.THREE;
        const SVGLoader = window.SVGLoader;
        const bufferUtils = window.BufferGeometryUtils || THREERef?.BufferGeometryUtils;
        if (!preview.group || !preview.viewGroup || !THREERef || !SVGLoader || !bufferUtils) return false;

        resize();
        const visibleSourceLayerIds = getVisibleLayerIndices();
        if (!state.tracedata || visibleSourceLayerIds.length === 0) {
            if (preview.exportGeometrySnapshot) onExportGeometryInvalidated?.();
            clearGroup();
            clearBuildPlate();
            setPlaceholder('3D preview will appear after analysis.', true);
            updateLayerStackPreview(null, 0, new Set());
            updateSizeReadout(null);
            updateStructureWarning([]);
            updateTriangleEstimate();
            updateMagnetPocketStatus(model, null);
            if (view.printOrientationNote) view.printOrientationNote.textContent = 'Choose an AMS print style';
            renderFrame();
            return true;
        }

        try {
            const renderStartedAt = performance.now();
            const previousExportSnapshot = preview.exportGeometrySnapshot;
            const reusableStylePlan = styleOnly && stylePreparationMatchesLastRender()
                ? state.objPreview.lastPlan
                : null;
            clearGroup();
            clearBuildPlate();

            const defaultThickness = model.objThicknessSlider ? Number.parseFloat(model.objThicknessSlider.value) : 4;
            const thickness = Number.isFinite(defaultThickness) ? defaultThickness : 4;
            const currentExportSnapshot = createObjGeometrySnapshot({
                state,
                modelControls: model,
                visibleSourceLayerIds,
                defaultThickness: thickness
            });
            if (
                previousExportSnapshot
                && !objGeometrySnapshotsMatch(previousExportSnapshot, currentExportSnapshot)
            ) {
                onExportGeometryInvalidated?.();
            }
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

            const planStartedAt = performance.now();
            let planBuildMode = 'full';
            let plan = reusableStylePlan
                ? retargetObjModelPlanPrintStyle(reusableStylePlan, state, thickness)
                : null;
            if (plan) {
                planBuildMode = 'retarget';
            } else {
                plan = buildObjModelPlan({
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
            }
            const planBuildDuration = performance.now() - planStartedAt;
            syncFaceDownToggleFromPlan(plan);

            if (!plan || plan.outputLayers.length === 0) {
                buildBuildPlate(THREERef, bed);
                setPlaceholder('No printable geometry for current selection.', true);
                updateLayerStackPreview(null, thickness, selectionSet);
                updateSizeReadout(null);
                updateStructureWarning([]);
                updateTriangleEstimate({ decimatePercent });
                updateMagnetPocketStatus(model, plan?.magnetPocketResult || null);
                renderFrame();
                return true;
            }

            if (view.objPreviewCanvas) {
                view.objPreviewCanvas.dataset.amsPrintStyle = plan.amsPrintStyle;
                view.objPreviewCanvas.dataset.previewFace = plan.amsPrintStyle === 'face-down' ? 'bed' : 'print';
            }
            if (view.workflow) {
                view.workflow.dataset.amsPrintStyle = plan.amsPrintStyle;
            }
            if (view.printOrientationNote) {
                view.printOrientationNote.textContent = plan.amsPrintStyle === 'face-down'
                    ? 'Bed orientation · color face underneath'
                    : 'Raised face · drag to rotate';
            }

            const scalePlan = plan.scalePlan;
            if (scalePlan?.wasAutoFitted) {
                syncAppliedScalePercent(scalePlan.appliedPercent);
            }

            const geometryStartedAt = performance.now();
            const geometryBundle = buildObjGeometryBundle(plan, { THREERef, bufferUtils });
            const geometryBuildDuration = performance.now() - geometryStartedAt;
            if (!geometryBundle || geometryBundle.layers.size === 0) {
                buildBuildPlate(THREERef, bed);
                setPlaceholder('No printable geometry for current selection.', true);
                updateLayerStackPreview(plan, thickness, selectionSet);
                updateSizeReadout(scalePlan);
                updateStructureWarning(plan.warnings);
                updateTriangleEstimate({ decimatePercent });
                renderFrame();
                return true;
            }

            let actualBounds = getGeometryBundleBounds(geometryBundle, {
                scaleX: scalePlan.scale,
                scaleY: scalePlan.scale
            });
            if (fitObjScalePlanToGeometryBounds(scalePlan, actualBounds) < 1) {
                syncAppliedScalePercent(scalePlan.appliedPercent);
                actualBounds = getGeometryBundleBounds(geometryBundle, {
                    scaleX: scalePlan.scale,
                    scaleY: scalePlan.scale
                });
            }
            if (actualBounds.isValid) {
                scalePlan.actualFootprintWidth = actualBounds.width;
                scalePlan.actualFootprintDepth = actualBounds.depth;
                scalePlan.modelHeight = actualBounds.height;
                scalePlan.overflowWidth = Math.max(0, actualBounds.width - scalePlan.usableBedWidth);
                scalePlan.overflowDepth = Math.max(0, actualBounds.depth - scalePlan.usableBedDepth);
                scalePlan.overflowHeight = Math.max(0, actualBounds.maxZ - bed.height);
                scalePlan.fitsBed = scalePlan.overflowWidth <= BED_FIT_TOLERANCE_MM
                    && scalePlan.overflowDepth <= BED_FIT_TOLERANCE_MM
                    && scalePlan.overflowHeight <= BED_FIT_TOLERANCE_MM;
            }

            preview.layerMeshes = new Map();
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
                mesh.userData.objHeightBaseline = {
                    zStart: layer.zStart,
                    zEnd: layer.zEnd
                };
                mesh.visible = !(hasSelection && displayMode === 'solo' && !isSelected);
                preview.group.add(mesh);
                preview.layerMeshes.set(layer.outputLayerId, mesh);
            });
            addMagnetPocketOverlays(plan, THREERef);

            preview.group.scale.set(scalePlan.scale, scalePlan.scale, 1);
            preview.group.position.set(
                actualBounds.isValid ? -actualBounds.centerX : 0,
                actualBounds.isValid ? -actualBounds.centerY : 0,
                BED_CONTACT_EPSILON - (actualBounds.isValid ? actualBounds.minZ : 0)
            );
            preview.viewGroup.position.set(preview.panX || 0, preview.panY || 0, 0);
            preview.viewGroup.rotation.set(preview.rotationX, preview.rotationY, 0);

            buildBuildPlate(THREERef, bed);

            const frameState = createFrameState({
                THREERef,
                footprintWidth: actualBounds.isValid ? actualBounds.width : scalePlan.footprintWidth,
                footprintDepth: actualBounds.isValid ? actualBounds.depth : scalePlan.footprintDepth,
                modelHeight: actualBounds.isValid ? actualBounds.height : plan.totalHeight,
                bed,
                showBuildPlate: preview.showBuildPlate !== false
            });

            preview.frameMaxDim = frameState.frameMaxDim;
            preview.panScale = frameState.panScale;
            preview.fitTarget = frameState.fitTarget;
            preview.fitLookAtTarget = frameState.lookAtTarget;

            if (preview.needsFit || !preview.target) {
                preview.target = frameState.fitTarget.clone();
                preview.lookAtTarget = frameState.lookAtTarget.clone();
                preview.needsFit = false;
            }

            preview.lastPlan = plan;
            preview.lastGeometryBundle = geometryBundle;
            preview.lastActualBounds = actualBounds;
            preview.lastTriangleCount = getBundleTriangleCount(geometryBundle);
            preview.topologySnapshot = createTopologySnapshot();
            preview.stylePreparationSnapshot = createTopologySnapshot({ includePrintStyle: false });
            // Auto-fit can update the scale control after the initial snapshot.
            // Capture the final control state so Send can safely reuse this exact
            // finished preview instead of reporting a false "still updating" error.
            preview.exportGeometrySnapshot = createObjGeometrySnapshot({
                state,
                modelControls: model,
                visibleSourceLayerIds,
                defaultThickness: thickness
            });
            preview.exportGeometryTransforms = new Map(
                [...geometryBundle.layers.keys()].map((outputLayerId) => [
                    outputLayerId,
                    { scaleZ: 1, translateZ: 0 }
                ])
            );
            preview.fullRenderCount = (preview.fullRenderCount || 0) + 1;
            if (view.objPreviewCanvas) {
                view.objPreviewCanvas.dataset.fullRenderCount = String(preview.fullRenderCount);
                view.objPreviewCanvas.dataset.planBuildMode = planBuildMode;
                view.objPreviewCanvas.dataset.planBuildMs = planBuildDuration.toFixed(1);
                view.objPreviewCanvas.dataset.geometryBuildMs = geometryBuildDuration.toFixed(1);
                view.objPreviewCanvas.dataset.renderDurationMs = (performance.now() - renderStartedAt).toFixed(1);
            }

            setPlaceholder('', false);
            updateLayerStackPreview(plan, thickness, selectionSet);
            updateSizeReadout(scalePlan, actualBounds);
            updateStructureWarning(plan.warnings);
            updateTriangleEstimate({
                triangleCount: preview.lastTriangleCount,
                decimatePercent
            });
            updateAmsPreflightFromPlan(plan);
            updateMagnetPocketStatus(model, plan.magnetPocketResult);
            renderFrame();
            return true;
        } catch (error) {
            console.error('3D preview failed:', error);
            setPlaceholder('3D preview failed. Try re-analyzing.', true);
            updateTriangleEstimate();
            updateMagnetPocketStatus(model, null);
            return false;
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

    function refreshPreflight() {
        const plan = state.objPreview?.lastPlan;
        if (plan) updateAmsPreflightFromPlan(plan);
    }

    return {
        render,
        updateLayerHeights,
        refreshPreflight,
        resize,
        bindControls,
        fitView,
        recenterView,
        setLayerDisplayMode,
        setTargetLocked
    };
}
