export function ensureLayerThicknesses(state, layerCount, defaultThickness) {
    if (!state.layerThicknesses || state.layerThicknesses.length !== layerCount) {
        state.layerThicknesses = new Array(layerCount).fill(defaultThickness);
    }
    state.layerThicknesses = state.layerThicknesses.map((value) => {
        const numeric = Number.isFinite(value) ? value : parseFloat(value);
        return Math.max(0.1, Number.isFinite(numeric) ? numeric : defaultThickness);
    });
    return state.layerThicknesses;
}

export function computeLayerLayout({
    layerThicknesses,
    useBaseLayer = false,
    baseLayerIndex = 0
}) {
    const count = Array.isArray(layerThicknesses) ? layerThicknesses.length : 0;
    const depths = (layerThicknesses || []).map((value) => Math.max(0.1, value));
    const positions = new Array(count).fill(0);

    if (!count) {
        return {
            depths,
            positions,
            totalHeight: 0,
            maxHeight: 0,
            baseLayerIndex: 0
        };
    }

    const safeBaseIndex = Math.max(0, Math.min(count - 1, baseLayerIndex));

    if (useBaseLayer) {
        const baseDepth = depths[safeBaseIndex];
        for (let i = 0; i < count; i++) {
            positions[i] = i === safeBaseIndex ? 0 : baseDepth;
        }
        const topHeights = depths.map((depth, index) => positions[index] + depth);
        return {
            depths,
            positions,
            totalHeight: Math.max(...topHeights),
            maxHeight: Math.max(...topHeights),
            baseLayerIndex: safeBaseIndex
        };
    }

    let cursor = 0;
    for (let i = 0; i < count; i++) {
        positions[i] = cursor;
        cursor += depths[i];
    }

    return {
        depths,
        positions,
        totalHeight: cursor,
        maxHeight: cursor,
        baseLayerIndex: safeBaseIndex
    };
}
