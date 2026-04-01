import { buildTracedataSubset, createMergedTracedata, layerHasPaths } from './trace-utils.js';

/**
 * Creates a palette display and merge-rule manager for a tab.
 *
 * @param {object} st   - tab-local state (state or ls)
 * @param {object} el   - tab-local elements (elements or le)
 * @param {function} getVisibleLayerIndices  - () => number[]
 * @param {function} updateFilteredPreview  - () => void
 *
 * @returns {{ displayPalette, prepareMergeUIAfterGeneration, updateMergeRuleSwatches, updateFinalPalette }}
 */
export function createPaletteManager({ st, el, getVisibleLayerIndices, updateFilteredPreview }) {

    function displayPalette() {
        if (!st.tracedata) return;

        el.paletteContainer.innerHTML = '';
        st.selectedLayerIndices.clear();
        const visibleIndices = getVisibleLayerIndices();

        if (visibleIndices.length === 0) {
            el.paletteRow.style.display = 'none';
            return;
        }

        visibleIndices.forEach((index) => {
            const color = st.tracedata.palette[index];
            const container = document.createElement('div');
            container.className = 'flex flex-col items-center gap-1';

            const swatch = document.createElement('div');
            swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500 cursor-pointer transition-all';
            swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;
            swatch.title = `Layer ${index}`;
            swatch.dataset.index = index;

            const label = document.createElement('div');
            label.className = 'text-xs text-gray-400 opacity-0 transition-opacity';
            label.textContent = `Layer ${index}`;

            swatch.addEventListener('click', () => {
                if (st.selectedLayerIndices.has(index)) {
                    st.selectedLayerIndices.delete(index);
                    swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.add('opacity-0');
                } else {
                    st.selectedLayerIndices.add(index);
                    swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.remove('opacity-0');
                }
                updateFilteredPreview();
            });

            container.appendChild(swatch);
            container.appendChild(label);
            el.paletteContainer.appendChild(container);
        });
        el.paletteRow.style.display = 'block';
    }

    function prepareMergeUIAfterGeneration() {
        st.mergeRules = [];
        st.selectedFinalLayerIndices.clear();
        if (el.mergeRulesContainer) el.mergeRulesContainer.innerHTML = '';
        const visibleIndices = getVisibleLayerIndices();
        if (visibleIndices.length >= 2) {
            if (el.layerMergingSection) el.layerMergingSection.style.display = 'block';
            if (el.addMergeRuleBtn) el.addMergeRuleBtn.disabled = false;
        } else {
            if (el.layerMergingSection) el.layerMergingSection.style.display = 'none';
        }
        if (el.combineAndDownloadBtn) el.combineAndDownloadBtn.disabled = true;
        updateFinalPalette();
    }

    function updateMergeRuleSwatches(row, rule, allVisibleIndices) {
        const sourceIndex = allVisibleIndices[rule.source];
        const targetIndex = allVisibleIndices[rule.target];
        const sourceColor = st.tracedata.palette[sourceIndex];
        const targetColor = st.tracedata.palette[targetIndex];
        row.querySelector('[data-swatch="source"]').style.backgroundColor = `rgb(${sourceColor.r},${sourceColor.g},${sourceColor.b})`;
        row.querySelector('[data-swatch="target"]').style.backgroundColor = `rgb(${targetColor.r},${targetColor.g},${targetColor.b})`;
    }

    function updateFinalPalette() {
        el.finalPaletteContainer.innerHTML = '';
        st.selectedFinalLayerIndices.clear();
        if (!st.tracedata) return;

        const visibleIndices = getVisibleLayerIndices();
        let palette;

        if (st.mergeRules.length > 0) {
            const data = createMergedTracedata(st.tracedata, visibleIndices, st.mergeRules);
            palette = data.palette;
        } else {
            palette = visibleIndices.map(i => st.tracedata.palette[i]);
        }

        if (!palette.length) return;

        // Build group info for labels (only needed when merge rules exist)
        let groups = null;
        let sortedTargets = null;
        if (st.mergeRules.length > 0) {
            const visible = getVisibleLayerIndices();
            const finalTargets = {};
            visible.forEach((_, ruleIndex) => { finalTargets[ruleIndex] = ruleIndex; });

            st.mergeRules.forEach((rule) => {
                let ultimateTarget = rule.target;
                while (finalTargets[ultimateTarget] !== ultimateTarget) {
                    ultimateTarget = finalTargets[ultimateTarget];
                }
                finalTargets[rule.source] = ultimateTarget;
            });

            Object.keys(finalTargets).forEach((key) => {
                let current = parseInt(key, 10);
                while (finalTargets[current] !== current) {
                    current = finalTargets[current];
                }
                finalTargets[key] = current;
            });

            groups = {};
            visible.forEach((originalIndex, ruleIndex) => {
                const t = finalTargets[ruleIndex];
                if (!groups[t]) groups[t] = [];
                groups[t].push(originalIndex);
            });
            sortedTargets = Object.keys(groups).map(Number).sort((a, b) => a - b);
        }

        palette.forEach((color, i) => {
            const container = document.createElement('div');
            container.className = 'flex flex-col items-center gap-1';

            const swatch = document.createElement('div');
            swatch.className = 'w-8 h-8 rounded border-2 border-gray-700 ring-1 ring-gray-500 cursor-pointer transition-all';
            swatch.style.backgroundColor = `rgb(${color.r},${color.g},${color.b})`;

            const label = document.createElement('div');
            label.className = 'text-xs text-gray-400 opacity-0 transition-opacity';

            if (groups && sortedTargets && i < sortedTargets.length) {
                const targetRuleIndex = sortedTargets[i];
                const originalIndices = groups[targetRuleIndex];
                const representativeIndex = visibleIndices[targetRuleIndex];

                label.textContent = originalIndices.length > 1
                    ? `Merged (${originalIndices.join('+')})`
                    : `Layer ${representativeIndex}`;
                swatch.title = originalIndices.length > 1
                    ? `Merged layers: ${originalIndices.join(', ')}`
                    : `Layer ${representativeIndex}`;
            } else {
                const originalIndex = visibleIndices[i];
                label.textContent = `Layer ${originalIndex}`;
                swatch.title = `Layer ${originalIndex}`;
            }

            swatch.dataset.index = i;
            swatch.addEventListener('click', () => {
                if (st.selectedFinalLayerIndices.has(i)) {
                    st.selectedFinalLayerIndices.delete(i);
                    swatch.classList.remove('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.add('opacity-0');
                } else {
                    st.selectedFinalLayerIndices.add(i);
                    swatch.classList.add('ring-2', 'ring-offset-2', 'ring-blue-500', 'border-white');
                    label.classList.remove('opacity-0');
                }
                updateFilteredPreview();
            });

            container.appendChild(swatch);
            container.appendChild(label);
            el.finalPaletteContainer.appendChild(container);
        });
    }

    return { displayPalette, prepareMergeUIAfterGeneration, updateMergeRuleSwatches, updateFinalPalette };
}
