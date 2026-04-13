import { formatObjScalePercent } from '../obj-scale.js';

/**
 * Manages synchronization between AppState and UI elements.
 * This ensures that common parameters (like OBJ scale) are consistent
 * across multiple tabs and sidebar sections.
 */
export function createUiSyncer({ state, elements }) {
    
    /**
     * Updates all UI elements related to OBJ parameters to match current state.
     */
    function syncObjParamsToUi() {
        const p = state.objParams;
        if (!p) return;

        const el = elements.shared3d;
        if (!el) return;

        if (el.objScaleSlider) el.objScaleSlider.value = p.scale;
        if (el.objScaleValue) el.objScaleValue.textContent = formatObjScalePercent(p.scale);
        
        if (el.objThicknessSlider) el.objThicknessSlider.value = p.thickness;
        if (el.objThicknessValue) el.objThicknessValue.textContent = p.thickness;

        if (el.objBedSelect) el.objBedSelect.value = p.bedKey;
        if (el.objMarginInput) el.objMarginInput.value = p.margin;
        if (el.objBezelSelect) el.objBezelSelect.value = p.bezelPreset || 'off';
    }

    /**
     * Listen for changes on any of the shared UI elements and update state.
     */
    function bindShared3dEvents(onUpdate) {
        const el = elements.shared3d;
        if (!el) return;

        const wrapUpdate = () => {
            if (typeof onUpdate === 'function') onUpdate();
        };

        if (el.objScaleSlider) {
            el.objScaleSlider.addEventListener('input', () => {
                state.objParams.scale = Number.parseFloat(el.objScaleSlider.value);
                if (el.objScaleValue) el.objScaleValue.textContent = formatObjScalePercent(state.objParams.scale);
                wrapUpdate();
            });
        }

        if (el.objThicknessSlider) {
            el.objThicknessSlider.addEventListener('input', () => {
                state.objParams.thickness = Number.parseFloat(el.objThicknessSlider.value);
                if (el.objThicknessValue) el.objThicknessValue.textContent = state.objParams.thickness;
                wrapUpdate();
            });
        }

        if (el.objBedSelect) {
            el.objBedSelect.addEventListener('change', () => {
                state.objParams.bedKey = el.objBedSelect.value;
                wrapUpdate();
            });
        }

        if (el.objMarginInput) {
            el.objMarginInput.addEventListener('input', () => {
                state.objParams.margin = Number.parseFloat(el.objMarginInput.value) || 0;
                wrapUpdate();
            });
        }

        if (el.objBezelSelect) {
            el.objBezelSelect.addEventListener('change', () => {
                state.objParams.bezelPreset = el.objBezelSelect.value || 'off';
                wrapUpdate();
            });
        }
    }

    return {
        syncObjParamsToUi,
        bindShared3dEvents
    };
}
