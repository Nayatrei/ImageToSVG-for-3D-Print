import { serializeMagnetPocketConfig } from './magnet-pockets.js?v=r-afbde72383fa3b50';

function readControlValue(control, fallback) {
    return control?.value ?? fallback;
}

/**
 * Builds the identity for printable geometry, independent from camera/view UI.
 * Preview and export both use this contract so export can safely reuse the
 * already-built preview mesh without guessing whether controls have changed.
 */
export function createObjGeometrySnapshot({
    state,
    modelControls = {},
    visibleSourceLayerIds = [],
    defaultThickness = 4
}) {
    const thicknessOverrides = Object.entries(state?.layerThicknessById || {})
        .sort(([left], [right]) => Number(left) - Number(right))
        .map(([sourceLayerId, thickness]) => `${sourceLayerId}:${thickness}`)
        .join(',');

    const key = [
        visibleSourceLayerIds.join(','),
        Number.isFinite(defaultThickness) ? defaultThickness : 4,
        readControlValue(
            modelControls.objBaseThicknessSlider,
            state?.objParams?.baseThickness ?? 2.4
        ),
        readControlValue(
            modelControls.objAmsPrintStyle,
            state?.objParams?.amsPrintStyle ?? 'raised-efficient'
        ),
        thicknessOverrides,
        readControlValue(modelControls.objDecimateSlider, 0),
        readControlValue(modelControls.objBedSelect, 'x1'),
        readControlValue(modelControls.objMarginInput, 5),
        readControlValue(modelControls.objScaleSlider, 100),
        readControlValue(
            modelControls.objBezelSelect,
            state?.objParams?.bezelPreset ?? 'off'
        ),
        serializeMagnetPocketConfig(state?.objParams?.magnetPocket),
        JSON.stringify(state?.mergeRules || []),
        state?.useBaseLayer ? 'base:on' : 'base:off',
        state?.baseSourceLayerId ?? '',
        state?.sourceRenderScale || 1
    ].join('|');

    return {
        tracedata: state?.tracedata || null,
        traceOptions: state?.lastOptions || null,
        key
    };
}

export function objGeometrySnapshotsMatch(left, right) {
    return Boolean(
        left
        && right
        && left.tracedata === right.tracedata
        && left.traceOptions === right.traceOptions
        && left.key === right.key
    );
}
