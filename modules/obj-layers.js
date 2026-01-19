export function buildLayerIndexMap(palette) {
    const map = new Map();
    if (!Array.isArray(palette)) return map;
    palette.forEach((color, index) => {
        if (!color) return;
        const r = Math.max(0, Math.min(255, color.r ?? 0));
        const g = Math.max(0, Math.min(255, color.g ?? 0));
        const b = Math.max(0, Math.min(255, color.b ?? 0));
        const hex = ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
        map.set(hex, index);
    });
    return map;
}

export function getLayerIndexForColor(layerIndexMap, hex) {
    if (!layerIndexMap || !hex) return 0;
    const key = hex.toLowerCase();
    if (layerIndexMap.has(key)) return layerIndexMap.get(key);
    const nextIndex = layerIndexMap.size;
    layerIndexMap.set(key, nextIndex);
    return nextIndex;
}
