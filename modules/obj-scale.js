import { BED_PRESETS } from './config.js';

const OBJ_SCALE_MIN = 25;
const OBJ_SCALE_MAX = 200;
const OBJ_SOURCE_UNIT_TO_MM = 0.25;

export function clampObjScalePercent(value) {
    const numeric = Number.isFinite(value) ? value : 100;
    return Math.min(OBJ_SCALE_MAX, Math.max(OBJ_SCALE_MIN, numeric));
}

export function computeObjScalePlan({
    rawWidth,
    rawDepth,
    bedKey,
    margin,
    scalePercent,
    sourceScale = 1
}) {
    const width = Number.isFinite(rawWidth) ? Math.max(0, rawWidth) : 0;
    const depth = Number.isFinite(rawDepth) ? Math.max(0, rawDepth) : 0;
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 5;
    const requestedPercent = clampObjScalePercent(scalePercent);
    const normalizedSourceScale = Number.isFinite(sourceScale) && sourceScale > 0 ? sourceScale : 1;
    const selectedBed = BED_PRESETS[bedKey] || BED_PRESETS.x1;

    const usableBedWidth = Math.max(1, selectedBed.width - safeMargin * 2);
    const usableBedDepth = Math.max(1, selectedBed.depth - safeMargin * 2);

    if (width <= 0 || depth <= 0) {
        return {
            scale: (requestedPercent / 100) * (OBJ_SOURCE_UNIT_TO_MM / normalizedSourceScale),
            requestedPercent,
            footprintWidth: 0,
            footprintDepth: 0,
            fitsBed: true,
            overflowWidth: 0,
            overflowDepth: 0,
            usableBedWidth,
            usableBedDepth
        };
    }

    const finalScale = (requestedPercent / 100) * (OBJ_SOURCE_UNIT_TO_MM / normalizedSourceScale);
    const footprintWidth = width * finalScale;
    const footprintDepth = depth * finalScale;
    const fitsBed = footprintWidth <= usableBedWidth && footprintDepth <= usableBedDepth;

    return {
        scale: finalScale,
        requestedPercent,
        footprintWidth,
        footprintDepth,
        fitsBed,
        overflowWidth: Math.max(0, footprintWidth - usableBedWidth),
        overflowDepth: Math.max(0, footprintDepth - usableBedDepth),
        usableBedWidth,
        usableBedDepth
    };
}
