/**
 * Snapshots current slider values into st.initialSliderValues and clears dirty state.
 * @param {object} st - tab-local state (state or ls)
 * @param {object} el - tab-local elements (elements or le)
 */
export function saveInitialSliderValues(st, el) {
    st.initialSliderValues = {
        pathSimplification: el.pathSimplificationSlider.value,
        cornerSharpness: el.cornerSharpnessSlider.value,
        curveStraightness: el.curveStraightnessSlider.value,
        colorPrecision: el.colorPrecisionSlider.value,
        maxColors: el.maxColorsSlider ? el.maxColorsSlider.value : '4'
    };
    st.isDirty = false;
    el.resetBtn.style.display = 'none';
}

/**
 * Updates all slider value readout elements from current slider positions.
 * @param {object} el - tab-local elements (elements or le)
 */
export function updateAllSliderDisplays(el) {
    el.pathSimplificationValue.textContent = el.pathSimplificationSlider.value;
    el.cornerSharpnessValue.textContent = el.cornerSharpnessSlider.value;
    el.curveStraightnessValue.textContent = el.curveStraightnessSlider.value;
    el.colorPrecisionValue.textContent = el.colorPrecisionSlider.value;
    if (el.maxColorsValue && el.maxColorsSlider) {
        el.maxColorsValue.textContent = el.maxColorsSlider.value;
    }
    if (el.objThicknessValue && el.objThicknessSlider) {
        el.objThicknessValue.textContent = el.objThicknessSlider.value;
    }
    if (el.objScaleValue && el.objScaleSlider) {
        el.objScaleValue.textContent = el.objScaleSlider.value;
    }
}

/**
 * Restores sliders to their initial snapshot and triggers re-analysis.
 * @param {object} st - tab-local state (state or ls)
 * @param {object} el - tab-local elements (elements or le)
 */
export function resetSlidersToInitial(st, el) {
    if (!st.initialSliderValues) return;

    el.pathSimplificationSlider.value = st.initialSliderValues.pathSimplification;
    el.cornerSharpnessSlider.value = st.initialSliderValues.cornerSharpness;
    el.curveStraightnessSlider.value = st.initialSliderValues.curveStraightness;
    el.colorPrecisionSlider.value = st.initialSliderValues.colorPrecision;
    if (el.maxColorsSlider) {
        el.maxColorsSlider.value = st.initialSliderValues.maxColors;
    }

    updateAllSliderDisplays(el);

    if (el.sourceImage.src) {
        st.colorsAnalyzed = false;
        if (el.optimizePathsBtn) el.optimizePathsBtn.disabled = true;
        el.analyzeColorsBtn.click();
    }

    st.isDirty = false;
    el.resetBtn.style.display = 'none';
}
