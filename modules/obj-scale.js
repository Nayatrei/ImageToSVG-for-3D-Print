import { BED_PRESETS } from './config.js';

const OBJ_SCALE_MIN = 0.1;
const OBJ_SCALE_MAX = 200;
const OBJ_SOURCE_UNIT_TO_MM = 0.25;

export function clampObjScalePercent(value) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    return Math.min(OBJ_SCALE_MAX, Math.max(OBJ_SCALE_MIN, numeric));
}

export function formatObjScalePercent(value) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    if (!Number.isFinite(numeric)) return '0';
    if (numeric >= 10) return numeric.toFixed(1).replace(/\.0$/, '');
    if (numeric >= 1) return numeric.toFixed(1).replace(/\.0$/, '');
    return numeric.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function computeMaxFitScalePercent({
    rawWidth,
    rawDepth,
    bedKey,
    margin,
    sourceScale = 1
}) {
    const width = Number.isFinite(rawWidth) ? Math.max(0, rawWidth) : 0;
    const depth = Number.isFinite(rawDepth) ? Math.max(0, rawDepth) : 0;
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 5;
    const normalizedSourceScale = Number.isFinite(sourceScale) && sourceScale > 0 ? sourceScale : 1;
    const selectedBed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
    const usableBedWidth = Math.max(1, selectedBed.width - safeMargin * 2);
    const usableBedDepth = Math.max(1, selectedBed.depth - safeMargin * 2);

    if (width <= 0 || depth <= 0) return OBJ_SCALE_MAX;

    const widthAt100Percent = width * (OBJ_SOURCE_UNIT_TO_MM / normalizedSourceScale);
    const depthAt100Percent = depth * (OBJ_SOURCE_UNIT_TO_MM / normalizedSourceScale);

    const widthPercent = widthAt100Percent > 0
        ? (usableBedWidth / widthAt100Percent) * 100
        : OBJ_SCALE_MAX;
    const depthPercent = depthAt100Percent > 0
        ? (usableBedDepth / depthAt100Percent) * 100
        : OBJ_SCALE_MAX;

    return Math.max(0, Math.min(widthPercent, depthPercent));
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
            appliedPercent: requestedPercent,
            maxFitPercent: OBJ_SCALE_MAX,
            wasAutoFitted: false,
            footprintWidth: 0,
            footprintDepth: 0,
            fitsBed: true,
            overflowWidth: 0,
            overflowDepth: 0,
            usableBedWidth,
            usableBedDepth,
            bedLabel: selectedBed.label
        };
    }

    const maxFitPercent = computeMaxFitScalePercent({
        rawWidth: width,
        rawDepth: depth,
        bedKey,
        margin: safeMargin,
        sourceScale: normalizedSourceScale
    });
    const appliedPercent = Math.min(requestedPercent, maxFitPercent);
    const finalScale = (appliedPercent / 100) * (OBJ_SOURCE_UNIT_TO_MM / normalizedSourceScale);
    const footprintWidth = width * finalScale;
    const footprintDepth = depth * finalScale;
    const fitsBed = footprintWidth <= usableBedWidth + 1e-6 && footprintDepth <= usableBedDepth + 1e-6;

    return {
        scale: finalScale,
        requestedPercent,
        appliedPercent,
        maxFitPercent,
        wasAutoFitted: appliedPercent + 1e-6 < requestedPercent,
        footprintWidth,
        footprintDepth,
        fitsBed,
        overflowWidth: Math.max(0, footprintWidth - usableBedWidth),
        overflowDepth: Math.max(0, footprintDepth - usableBedDepth),
        usableBedWidth,
        usableBedDepth,
        bedLabel: selectedBed.label
    };
}
