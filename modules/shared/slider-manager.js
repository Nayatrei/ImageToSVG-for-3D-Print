import {
    normalizeTraceControls,
    readTraceControls,
    updateTraceControlUi,
    writeTraceControls
} from './trace-controls.js';

/**
 * Snapshots current trace-control values into st.initialSliderValues and clears dirty state.
 * @param {object} st - tab-local state (state or ls)
 * @param {object} el - tab-local elements (elements or le)
 */
export function saveInitialSliderValues(st, el) {
    st.initialSliderValues = readTraceControls(el);
    st.traceControls = normalizeTraceControls(st.initialSliderValues);
    st.isDirty = false;
    if (el.resetBtn) el.resetBtn.style.display = 'none';
}

/**
 * Updates all trace control value readouts and helper copy from the current UI state.
 * @param {object} st - tab-local state (state or ls)
 * @param {object} el - tab-local elements (elements or le)
 * @param {object} [options]
 */
export function updateAllSliderDisplays(st, el, options = {}) {
    const controls = readTraceControls(el);
    st.traceControls = controls;
    updateTraceControlUi(el, controls, options);
}

/**
 * Restores trace controls to their initial snapshot.
 * @param {object} st - tab-local state (state or ls)
 * @param {object} el - tab-local elements (elements or le)
 */
export function resetSlidersToInitial(st, el) {
    if (!st.initialSliderValues) return;

    writeTraceControls(el, st.initialSliderValues);
    updateAllSliderDisplays(st, el);

    st.isDirty = false;
    if (el.resetBtn) el.resetBtn.style.display = 'none';
}
