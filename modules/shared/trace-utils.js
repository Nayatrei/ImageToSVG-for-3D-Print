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
 * Resolves visible layer indices into merged output groups.
 * Merge rules operate on the ordinal positions within visibleIndices.
 * Returned groups preserve the target layer's original source-layer id
 * as the stable output identity.
 *
 * @param {number[]} visibleIndices
 * @param {{source:number,target:number}[]} rules
 * @returns {Array<{ outputLayerId:number, primarySourceLayerId:number, sourceLayerIds:number[] }>}
 */
export function resolveMergedLayerGroups(visibleIndices, rules = []) {
    if (!Array.isArray(visibleIndices) || visibleIndices.length === 0) return [];

    if (!Array.isArray(rules) || rules.length === 0) {
        return visibleIndices.map((sourceLayerId) => ({
            outputLayerId: sourceLayerId,
            primarySourceLayerId: sourceLayerId,
            sourceLayerIds: [sourceLayerId]
        }));
    }

    const finalTargets = {};
    visibleIndices.forEach((_, ruleIndex) => {
        finalTargets[ruleIndex] = ruleIndex;
    });

    rules.forEach((rule) => {
        const source = Number.parseInt(rule?.source, 10);
        const target = Number.parseInt(rule?.target, 10);
        if (!Number.isInteger(source) || !Number.isInteger(target)) return;
        if (!(source in finalTargets) || !(target in finalTargets)) return;

        let ultimateTarget = target;
        while (finalTargets[ultimateTarget] !== ultimateTarget) {
            ultimateTarget = finalTargets[ultimateTarget];
        }
        finalTargets[source] = ultimateTarget;
    });

    Object.keys(finalTargets).forEach((key) => {
        let current = Number.parseInt(key, 10);
        while (finalTargets[current] !== current) {
            current = finalTargets[current];
        }
        finalTargets[key] = current;
    });

    const groups = {};
    visibleIndices.forEach((sourceLayerId, ruleIndex) => {
        const targetRuleIndex = finalTargets[ruleIndex];
        if (!groups[targetRuleIndex]) groups[targetRuleIndex] = [];
        groups[targetRuleIndex].push(sourceLayerId);
    });

    return Object.keys(groups)
        .map(Number)
        .sort((a, b) => a - b)
        .map((targetRuleIndex) => {
            const primarySourceLayerId = visibleIndices[targetRuleIndex];
            return {
                outputLayerId: primarySourceLayerId,
                primarySourceLayerId,
                sourceLayerIds: groups[targetRuleIndex].slice()
            };
        });
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
    const groups = resolveMergedLayerGroups(visibleIndices, rules);
    const newPalette = [];
    const newLayers = [];

    groups.forEach((group) => {
        newPalette.push(sourceData.palette[group.primarySourceLayerId]);

        let mergedPaths = [];
        group.sourceLayerIds.forEach((sourceLayerId) => {
            if (sourceData.layers[sourceLayerId]) {
                mergedPaths = mergedPaths.concat(sourceData.layers[sourceLayerId]);
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
