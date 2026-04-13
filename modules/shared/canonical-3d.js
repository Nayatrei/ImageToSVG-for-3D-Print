import { BED_PRESETS, OBJ_DEFAULT_ROTATION } from '../config.js';

export function getCanonicalRawExtrudeTranslation(plan, {
    offsetX = 0,
    offsetY = 0,
    zStart = 0,
    depth = 0
} = {}) {
    const shiftX = plan?.normalization?.shiftX || 0;
    const shiftY = plan?.normalization?.shiftY || 0;
    const shiftZ = plan?.normalization?.shiftZ || 0;

    return {
        x: shiftX + offsetX,
        y: -shiftY - offsetY,
        z: depth + zStart + shiftZ
    };
}

export function applyCanonicalRawExtrudeTransform(geometry, plan, options = {}) {
    if (!geometry) return geometry;
    const translation = getCanonicalRawExtrudeTranslation(plan, options);
    geometry.rotateX(Math.PI);
    geometry.translate(translation.x, translation.y, translation.z);
    return geometry;
}

export function getCanonicalBedCenter(bedKey = 'x1') {
    const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
    return {
        x: bed.width / 2,
        y: bed.depth / 2,
        z: 0,
        bed
    };
}

export function getDefaultPreviewRotation() {
    return { ...OBJ_DEFAULT_ROTATION };
}
