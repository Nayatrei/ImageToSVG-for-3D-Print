import { BED_PRESETS } from './config.js';

const OBJ_SCALE_MIN = 25;
const OBJ_SCALE_MAX = 200;

export function clampObjScalePercent(value) {
    const numeric = Number.isFinite(value) ? value : 100;
    return Math.min(OBJ_SCALE_MAX, Math.max(OBJ_SCALE_MIN, numeric));
}

export function computeObjScalePlan({
    rawWidth,
    rawDepth,
    bedKey,
    margin,
    scalePercent
}) {
    const width = Number.isFinite(rawWidth) ? Math.max(0, rawWidth) : 0;
    const depth = Number.isFinite(rawDepth) ? Math.max(0, rawDepth) : 0;
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 5;
    const requestedPercent = clampObjScalePercent(scalePercent);
    const baselineBed = BED_PRESETS.x1;
    const selectedBed = BED_PRESETS[bedKey] || baselineBed;

    if (width <= 0 || depth <= 0) {
        return {
            scale: 1,
            requestedPercent,
            footprintWidth: 0,
            footprintDepth: 0,
            wasClamped: false
        };
    }

    const baselineWidth = Math.max(1, baselineBed.width - safeMargin * 2);
    const baselineDepth = Math.max(1, baselineBed.depth - safeMargin * 2);
    const selectedWidth = Math.max(1, selectedBed.width - safeMargin * 2);
    const selectedDepth = Math.max(1, selectedBed.depth - safeMargin * 2);

    const baselineScale = Math.min(baselineWidth / width, baselineDepth / depth, 1);
    const requestedScale = baselineScale * (requestedPercent / 100);
    const maxSelectedScale = Math.min(selectedWidth / width, selectedDepth / depth, 1);
    const finalScale = Math.min(requestedScale, maxSelectedScale);

    return {
        scale: finalScale,
        requestedPercent,
        footprintWidth: width * finalScale,
        footprintDepth: depth * finalScale,
        wasClamped: finalScale + 1e-6 < requestedScale
    };
}
