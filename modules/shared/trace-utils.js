/**
 * General-purpose debounce utility.
 */
export const debounce = (fn, ms = 250) => {
    let timeout;
    return (...args) => {
        clearTimeout(timeout);
        timeout = setTimeout(() => fn(...args), ms);
    };
};

/**
 * Returns true if a tracedata layer has any paths.
 */
export function layerHasPaths(layer) {
    return Array.isArray(layer) && layer.length > 0;
}

/**
 * Builds a tracedata object containing only the given layer indices.
 */
export function buildTracedataSubset(source, indices) {
    if (!source) return null;
    const layers = [];
    const palette = [];
    indices.forEach((idx) => {
        if (source.layers[idx] && source.palette[idx]) {
            layers.push(JSON.parse(JSON.stringify(source.layers[idx])));
            palette.push(source.palette[idx]);
        }
    });
    return { ...source, layers, palette };
}

/**
 * Applies merge rules to collapse layers together, returning a new tracedata object.
 */
export function createMergedTracedata(sourceData, visibleIndices, rules) {
    if (!sourceData || !visibleIndices || !rules) return sourceData;

    const finalTargets = {};
    visibleIndices.forEach((_, ruleIndex) => {
        finalTargets[ruleIndex] = ruleIndex;
    });

    rules.forEach((rule) => {
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

    const groups = {};
    visibleIndices.forEach((originalIndex, ruleIndex) => {
        const finalTargetRuleIndex = finalTargets[ruleIndex];
        if (!groups[finalTargetRuleIndex]) {
            groups[finalTargetRuleIndex] = [];
        }
        groups[finalTargetRuleIndex].push(originalIndex);
    });

    const newPalette = [];
    const newLayers = [];
    Object.keys(groups).map(Number).sort((a, b) => a - b).forEach((targetRuleIndex) => {
        const originalIndicesInGroup = groups[targetRuleIndex];
        const representativeOriginalIndex = visibleIndices[targetRuleIndex];

        newPalette.push(sourceData.palette[representativeOriginalIndex]);

        let mergedPaths = [];
        originalIndicesInGroup.forEach((originalIndex) => {
            if (sourceData.layers[originalIndex]) {
                mergedPaths = mergedPaths.concat(sourceData.layers[originalIndex]);
            }
        });
        newLayers.push(mergedPaths);
    });

    return { ...sourceData, palette: newPalette, layers: newLayers };
}

/**
 * Creates a single-color silhouette tracedata from all visible layers.
 * @param {object} tracedata
 * @param {function} getVisibleLayerIndices - () => number[]
 */
export function createSolidSilhouette(tracedata, getVisibleLayerIndices) {
    if (!tracedata) return null;
    const visibleIndices = getVisibleLayerIndices();
    if (!visibleIndices.length) return null;
    const subset = buildTracedataSubset(tracedata, visibleIndices);
    let mergedPaths = [];
    subset.layers.forEach((layer) => {
        if (Array.isArray(layer)) mergedPaths = mergedPaths.concat(layer);
    });
    return {
        width: subset.width,
        height: subset.height,
        layers: [mergedPaths],
        palette: [{ r: 0, g: 0, b: 0, a: 255 }]
    };
}

/**
 * Returns { pathCount, colorCount } quality metrics for 3D printing.
 * @param {object} tracedata
 * @param {function} getVisibleLayerIndices - () => number[]
 */
export function assess3DPrintQuality(tracedata, getVisibleLayerIndices) {
    if (!tracedata) return { pathCount: 0, colorCount: 0 };
    const totalPaths = tracedata.layers.reduce(
        (sum, layer) => sum + (Array.isArray(layer) ? layer.length : 0), 0
    );
    const visibleColors = getVisibleLayerIndices().length;
    return { pathCount: totalPaths, colorCount: visibleColors };
}
