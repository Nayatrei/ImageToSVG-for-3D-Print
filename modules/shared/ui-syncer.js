import { formatObjScalePercent } from '../obj-scale.js?v=r-78ade4c03db6e3a2';
import { syncAmsPrintStyleControls } from './ams-print-style.js?v=r-78ade4c03db6e3a2';
import { syncMagnetPocketControls } from './magnet-pocket-controls.js?v=r-78ade4c03db6e3a2';

/**
 * The 3D sidebar (#obj-scale, #obj-thickness, #obj-bed, the magnet panel, …) is
 * ONE set of DOM nodes handed to both the SVG and the Logo tab controllers,
 * while each tab owns its own `objParams`. That only stays coherent if the
 * shared nodes are repainted from the active tab's state every time a tab is
 * activated — the model/export path still reads several of these values
 * straight off the DOM, so the DOM is what must follow the active tab.
 *
 * Setting `.value` programmatically fires no input/change event, so this never
 * re-enters the tabs' own handlers.
 *
 * @param {object} args
 * @param {object} args.tabState - the activating tab's state (root state for
 *   the SVG tab, `state.logo` for the Logo tab).
 * @param {object} args.controls - that tab's merged element map, which includes
 *   the shared 3D controls.
 */
export function syncShared3dControls({ tabState, controls }) {
    const params = tabState?.objParams;
    if (!params || !controls) return;

    // Owns amsPrintStyle, baseThickness, thickness, and the Face on Bed toggle.
    syncAmsPrintStyleControls({ rootState: tabState, tabState, controls });

    if (controls.objScaleSlider) {
        controls.objScaleSlider.value = String(params.scale ?? 100);
    }
    if (controls.objScaleValue) {
        controls.objScaleValue.textContent = formatObjScalePercent(params.scale ?? 100);
    }
    if (controls.objDecimateSlider) {
        controls.objDecimateSlider.value = String(params.decimate ?? 0);
    }
    if (controls.objDecimateValue) {
        controls.objDecimateValue.textContent = String(params.decimate ?? 0);
    }
    if (controls.objBedSelect) {
        controls.objBedSelect.value = params.bedKey || 'x1';
    }
    if (controls.objMarginInput) {
        controls.objMarginInput.value = String(params.margin ?? 5);
    }
    if (controls.objBezelSelect) {
        controls.objBezelSelect.value = params.bezelPreset || 'off';
    }

    const magnetConfig = syncMagnetPocketControls(controls, params.magnetPocket);
    if (magnetConfig) params.magnetPocket = magnetConfig;
}
