import { resolveMergedLayerGroups } from './shared/trace-utils.js?v=r-afbde72383fa3b50';
import { buildShapesFromTracedataLayers, buildWeldedShapeSet } from './shared/silhouette-builder.js?v=r-afbde72383fa3b50';
import { computeObjScalePlan } from './obj-scale.js?v=r-afbde72383fa3b50';
import { applyCanonicalRawExtrudeTransform } from './shared/canonical-3d.js?v=r-afbde72383fa3b50';
import {
    getAmsPrintStylePreset,
    normalizeAmsPrintStyle
} from './config.js?v=r-afbde72383fa3b50';
import {
    BEZEL_PRESETS,
    DEFAULT_PRINT_PROFILE,
    analyzeMaskComponents,
    clampBezelPreset,
    closeMaskData,
    countMaskPixels,
    createMaskSpace,
    hasMaskPixels,
    intersectMaskData,
    rasterizeShapeSetToMask,
    resolveBezelMaskSet,
    splitMaskByPrintability,
    traceMaskDataToShapeSet
} from './shared/print-geometry.js?v=r-afbde72383fa3b50';
import {
    normalizeMagnetPocketConfig,
    resolveMagnetPocketPlan
} from './shared/magnet-pockets.js?v=r-afbde72383fa3b50';

const DEFAULT_CURVE_SEGMENTS = 6;
const BOUNDS_POINT_DIVISIONS = 16;
const TRIANGULATION_POINT_DIVISIONS = 12;
const MIN_SIMPLIFIED_POINT_DIVISIONS = 2;

function clampThickness(value, defaultThickness) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    const fallback = Number.isFinite(defaultThickness) ? defaultThickness : 4;
    return Math.max(0.1, Math.min(20, Number.isFinite(numeric) ? numeric : fallback));
}

function hasExplicitThickness(state, sourceLayerId) {
    return Object.prototype.hasOwnProperty.call(state?.layerThicknessById || {}, sourceLayerId);
}

function unionMaskData(maskSpace, masks) {
    const length = Math.max(0, (maskSpace?.width || 0) * (maskSpace?.height || 0));
    const result = new Uint8Array(length);
    (Array.isArray(masks) ? masks : []).forEach((mask) => {
        if (!(mask instanceof Uint8Array) || mask.length !== length) return;
        for (let index = 0; index < length; index++) {
            if (mask[index]) result[index] = 255;
        }
    });
    return result;
}

function subtractMaskData(baseMask, subtractMask) {
    if (!(baseMask instanceof Uint8Array)) return new Uint8Array();
    const result = new Uint8Array(baseMask.length);
    for (let index = 0; index < baseMask.length; index++) {
        result[index] = baseMask[index] && !subtractMask?.[index] ? 255 : 0;
    }
    return result;
}

function clampDecimatePercent(value) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    return Math.max(0, Math.min(100, Number.isFinite(numeric) ? numeric : 0));
}

function getCurveSegmentsForDecimation(decimatePercent) {
    const normalized = clampDecimatePercent(decimatePercent) / 100;
    return Math.max(1, Math.round(DEFAULT_CURVE_SEGMENTS - ((DEFAULT_CURVE_SEGMENTS - 1) * normalized)));
}

function getPointDivisionsForDecimation(decimatePercent) {
    const normalized = clampDecimatePercent(decimatePercent) / 100;
    return Math.max(
        MIN_SIMPLIFIED_POINT_DIVISIONS,
        Math.round(TRIANGULATION_POINT_DIVISIONS - ((TRIANGULATION_POINT_DIVISIONS - MIN_SIMPLIFIED_POINT_DIVISIONS) * normalized))
    );
}

function normalizePathPoints(points) {
    if (!Array.isArray(points) || points.length === 0) return [];

    const normalized = [];
    points.forEach((point) => {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        const previous = normalized[normalized.length - 1];
        if (previous && Math.abs(previous.x - point.x) < 1e-6 && Math.abs(previous.y - point.y) < 1e-6) {
            return;
        }
        normalized.push({ x: point.x, y: point.y });
    });

    if (normalized.length > 1) {
        const first = normalized[0];
        const last = normalized[normalized.length - 1];
        if (Math.abs(first.x - last.x) < 1e-6 && Math.abs(first.y - last.y) < 1e-6) {
            normalized.pop();
        }
    }

    return normalized;
}

function getPathBounds(points) {
    return points.reduce((bounds, point) => ({
        minX: Math.min(bounds.minX, point.x),
        minY: Math.min(bounds.minY, point.y),
        maxX: Math.max(bounds.maxX, point.x),
        maxY: Math.max(bounds.maxY, point.y)
    }), {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    });
}

function getPointLineDistance(point, lineStart, lineEnd) {
    const dx = lineEnd.x - lineStart.x;
    const dy = lineEnd.y - lineStart.y;
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) {
        return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
    }

    const numerator = Math.abs((dy * point.x) - (dx * point.y) + (lineEnd.x * lineStart.y) - (lineEnd.y * lineStart.x));
    return numerator / Math.hypot(dx, dy);
}

function simplifyPolyline(points, tolerance) {
    if (!Array.isArray(points) || points.length <= 2 || tolerance <= 0) return points.slice();

    let maxDistance = 0;
    let splitIndex = -1;
    const start = points[0];
    const end = points[points.length - 1];

    for (let index = 1; index < points.length - 1; index++) {
        const distance = getPointLineDistance(points[index], start, end);
        if (distance > maxDistance) {
            maxDistance = distance;
            splitIndex = index;
        }
    }

    if (maxDistance <= tolerance || splitIndex === -1) {
        return [start, end];
    }

    const left = simplifyPolyline(points.slice(0, splitIndex + 1), tolerance);
    const right = simplifyPolyline(points.slice(splitIndex), tolerance);
    return left.slice(0, -1).concat(right);
}

function simplifyPolygonPoints(points, decimatePercent) {
    const normalizedPoints = normalizePathPoints(points);
    if (normalizedPoints.length <= 3 || clampDecimatePercent(decimatePercent) <= 0) return normalizedPoints;

    const bounds = getPathBounds(normalizedPoints);
    const maxDimension = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1);
    const tolerance = maxDimension * (clampDecimatePercent(decimatePercent) / 100) * 0.01;
    if (tolerance <= 0) return normalizedPoints;

    const ring = normalizedPoints.concat(normalizedPoints[0]);
    const simplified = simplifyPolyline(ring, tolerance);
    const reopened = simplifyPolyline(
        simplified.slice(0, -1).concat(simplified[0]),
        tolerance * 0.5
    ).slice(0, -1);

    return reopened.length >= 3 ? reopened : normalizedPoints;
}

function buildLinearPath(points, THREERef, isShape = false, decimatePercent = 0) {
    const normalizedPoints = simplifyPolygonPoints(points, decimatePercent);
    if (normalizedPoints.length < 3) return null;

    const path = isShape ? new THREERef.Shape() : new THREERef.Path();
    path.moveTo(normalizedPoints[0].x, normalizedPoints[0].y);
    normalizedPoints.slice(1).forEach((point) => {
        path.lineTo(point.x, point.y);
    });
    path.closePath();
    return path;
}

function simplifyShape(shape, THREERef, decimatePercent) {
    if (!shape || !THREERef || clampDecimatePercent(decimatePercent) <= 0) return shape;

    const pointDivisions = Math.max(BOUNDS_POINT_DIVISIONS, getPointDivisionsForDecimation(decimatePercent));
    const extracted = shape.extractPoints(pointDivisions);
    const simplifiedShape = buildLinearPath(extracted.shape, THREERef, true, decimatePercent);
    if (!simplifiedShape) return shape;

    extracted.holes.forEach((holePoints) => {
        const simplifiedHole = buildLinearPath(holePoints, THREERef, false, decimatePercent);
        if (simplifiedHole) simplifiedShape.holes.push(simplifiedHole);
    });

    return simplifiedShape;
}

function updateBoundsFromPoints(bounds, points) {
    if (!Array.isArray(points)) return bounds;
    points.forEach((point) => {
        if (!point) return;
        if (point.x < bounds.minX) bounds.minX = point.x;
        if (point.y < bounds.minY) bounds.minY = point.y;
        if (point.x > bounds.maxX) bounds.maxX = point.x;
        if (point.y > bounds.maxY) bounds.maxY = point.y;
    });
    return bounds;
}

function createEmptyBounds() {
    return {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
}

function finalizeBounds(bounds) {
    const isValid = bounds.maxX > bounds.minX && bounds.maxY > bounds.minY;
    if (!isValid) {
        return {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
            width: 0,
            depth: 0,
            centerX: 0,
            centerY: 0,
            isValid: false
        };
    }

    return {
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY,
        width: bounds.maxX - bounds.minX,
        depth: bounds.maxY - bounds.minY,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2,
        isValid: true
    };
}

function buildShapesForSourceLayer({ tracedata, sourceLayerId, tracer, options, SVGLoader, THREERef }) {
    return buildShapesFromTracedataLayers({
        tracedata,
        layerIndices: [sourceLayerId],
        tracer,
        options,
        SVGLoader,
        THREERef
    });
}

function buildBoundsFromShapes(shapes, offsetX = 0, offsetY = 0) {
    const bounds = createEmptyBounds();
    (Array.isArray(shapes) ? shapes : []).forEach((shape) => {
        if (!shape?.extractPoints) return;
        const extracted = shape.extractPoints(BOUNDS_POINT_DIVISIONS);
        updateBoundsFromPoints(bounds, extracted.shape.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY })));
        extracted.holes.forEach((hole) => {
            updateBoundsFromPoints(bounds, hole.map((point) => ({ x: point.x + offsetX, y: point.y + offsetY })));
        });
    });
    return finalizeBounds(bounds);
}

function simplifyShapeSet(shapes, THREERef, decimatePercent) {
    if (!Array.isArray(shapes) || shapes.length === 0) return [];
    return shapes.map((shape) => simplifyShape(shape, THREERef, decimatePercent)).filter(Boolean);
}

function buildLayerTriangles(shapes, THREERef, offsetX = 0, offsetY = 0) {
    const triangles = [];
    if (!Array.isArray(shapes) || !THREERef?.ShapeUtils) return triangles;

    shapes.forEach((shape) => {
        const extracted = shape.extractPoints(TRIANGULATION_POINT_DIVISIONS);
        const contour = extracted.shape.map((point) => new THREERef.Vector2(point.x + offsetX, point.y + offsetY));
        const holes = extracted.holes.map((hole) => hole.map((point) => new THREERef.Vector2(point.x + offsetX, point.y + offsetY)));
        if (contour.length < 3) return;

        const faces = THREERef.ShapeUtils.triangulateShape(contour, holes);
        const vertices = contour.concat(...holes);
        faces.forEach(([a, b, c]) => {
            const vA = vertices[a];
            const vB = vertices[b];
            const vC = vertices[c];
            if (!vA || !vB || !vC) return;
            triangles.push([vA, vB, vC]);
        });
    });

    return triangles;
}

function pointInTriangle(point, triangle) {
    const [a, b, c] = triangle;
    const denominator = ((b.y - c.y) * (a.x - c.x)) + ((c.x - b.x) * (a.y - c.y));
    if (Math.abs(denominator) < 1e-9) return false;

    const alpha = (((b.y - c.y) * (point.x - c.x)) + ((c.x - b.x) * (point.y - c.y))) / denominator;
    const beta = (((c.y - a.y) * (point.x - c.x)) + ((a.x - c.x) * (point.y - c.y))) / denominator;
    const gamma = 1 - alpha - beta;
    const epsilon = 1e-6;
    return alpha >= -epsilon && beta >= -epsilon && gamma >= -epsilon;
}

function buildTriangleSamples([a, b, c], THREERef) {
    const midpoint = (start, end) => new THREERef.Vector2((start.x + end.x) / 2, (start.y + end.y) / 2);
    return [
        a,
        b,
        c,
        midpoint(a, b),
        midpoint(b, c),
        midpoint(c, a),
        new THREERef.Vector2((a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3)
    ];
}

function triangleSetContainsPoint(point, triangles) {
    return triangles.some((triangle) => pointInTriangle(point, triangle));
}

function getTriangleArea([a, b, c]) {
    return Math.abs(
        ((b.x - a.x) * (c.y - a.y)) - ((c.x - a.x) * (b.y - a.y))
    ) / 2;
}

function getLayerFootprintArea(layer, THREERef) {
    const triangles = buildLayerTriangles(
        layer?.footprintShapes,
        THREERef,
        layer?.footprintOffsetX || 0,
        layer?.footprintOffsetY || 0
    );
    if (!triangles.length) return 0;
    return triangles.reduce((sum, triangle) => sum + getTriangleArea(triangle), 0);
}

function detectBaseOutputLayer(outputLayers, THREERef) {
    if (!Array.isArray(outputLayers) || outputLayers.length === 0) return null;

    let detectedLayer = outputLayers[0];
    let maxArea = -1;

    outputLayers.forEach((layer) => {
        const area = getLayerFootprintArea(layer, THREERef);
        if (area > maxArea + 1e-6) {
            maxArea = area;
            detectedLayer = layer;
        }
    });

    return detectedLayer;
}

function validateSupportFootprint(outputLayers, resolvedBaseOutputLayer, THREERef) {
    if (!resolvedBaseOutputLayer || !THREERef) return [];

    const baseTriangles = buildLayerTriangles(
        resolvedBaseOutputLayer.footprintShapes,
        THREERef,
        resolvedBaseOutputLayer.footprintOffsetX || 0,
        resolvedBaseOutputLayer.footprintOffsetY || 0
    );
    if (!baseTriangles.length) return [];

    return outputLayers
        .filter((layer) => !layer.isBase)
        .flatMap((layer) => {
            const layerTriangles = buildLayerTriangles(
                layer.footprintShapes,
                THREERef,
                layer.footprintOffsetX || 0,
                layer.footprintOffsetY || 0
            );
            const hasUnsupportedArea = layerTriangles.some((triangle) => {
                const samples = buildTriangleSamples(triangle, THREERef);
                return samples.some((sample) => !triangleSetContainsPoint(sample, baseTriangles));
            });

            if (!hasUnsupportedArea) return [];
            return [{
                type: 'unsupported-overhang',
                outputLayerId: layer.outputLayerId,
                sourceLayerIds: layer.sourceLayerIds.slice(),
                label: layer.displayLabel,
                message: `${layer.displayLabel} extends beyond the selected support base footprint.`
            }];
        });
}

export function ensureLayerThicknessById(state, sourceLayerIds, defaultThickness) {
    const overrides = (state.layerThicknessById && typeof state.layerThicknessById === 'object')
        ? { ...state.layerThicknessById }
        : {};
    const legacy = Array.isArray(state.layerThicknesses) ? state.layerThicknesses : null;
    const resolved = {};

    sourceLayerIds.forEach((sourceLayerId) => {
        const legacyValue = legacy && legacy[sourceLayerId] !== undefined
            ? legacy[sourceLayerId]
            : undefined;
        const hasOverride = overrides[sourceLayerId] !== undefined;
        const value = hasOverride ? overrides[sourceLayerId] : legacyValue;
        resolved[sourceLayerId] = clampThickness(
            value,
            defaultThickness
        );
        if (!hasOverride && legacyValue !== undefined) {
            overrides[sourceLayerId] = resolved[sourceLayerId];
        }
    });

    // Keep only explicit per-layer values in state. Layers without an override
    // continue to follow the global Color surface thickness control.
    state.layerThicknessById = overrides;
    state.layerThicknesses = null;
    return resolved;
}

/**
 * Repositions an existing model plan after height-only edits. XY topology,
 * masks, triangulation, and repair results remain valid, so callers can reuse
 * their current meshes and apply the returned affine Z transforms.
 */
export function updateObjModelPlanLayerHeights(plan, state, defaultThickness) {
    if (!plan?.outputLayers?.length || !state) return null;
    if (plan.amsPrintStyle === 'face-down') return null;

    const sourceLayerIds = Array.isArray(plan.visibleSourceLayerIds)
        ? plan.visibleSourceLayerIds
        : plan.outputLayers.flatMap((layer) => layer.sourceLayerIds || []);
    const thicknessById = ensureLayerThicknessById(state, sourceLayerIds, defaultThickness);
    const transitions = [];
    const baseLayer = plan.resolvedBaseOutputLayerId === null || plan.resolvedBaseOutputLayerId === undefined
        ? null
        : plan.outputLayers.find((layer) => layer.outputLayerId === plan.resolvedBaseOutputLayerId) || null;

    plan.outputLayers.forEach((layer) => {
        const previousStart = layer.zStart;
        const previousEnd = layer.zEnd;
        const layerDefault = layer.outputLayerId === baseLayer?.outputLayerId
            ? clampThickness(state.objParams?.baseThickness, plan.baseThickness || 2.4)
            : defaultThickness;
        layer.thickness = clampThickness(
            hasExplicitThickness(state, layer.primarySourceLayerId)
                ? thicknessById[layer.primarySourceLayerId]
                : layerDefault,
            layerDefault
        );
        thicknessById[layer.primarySourceLayerId] = layer.thickness;
        transitions.push({
            outputLayerId: layer.outputLayerId,
            previousStart,
            previousEnd,
            nextStart: 0,
            nextEnd: 0
        });
    });

    if (baseLayer) {
        const baseExtraHeight = plan.bezelSpec?.enabled ? plan.bezelSpec.extraHeightMm || 0 : 0;
        plan.outputLayers.forEach((layer) => {
            if (layer.outputLayerId === baseLayer.outputLayerId) {
                layer.isBase = true;
                layer.zStart = 0;
                layer.zEnd = layer.thickness + baseExtraHeight;
            } else {
                layer.isBase = false;
                layer.zStart = baseLayer.thickness;
                layer.zEnd = baseLayer.thickness + layer.thickness;
            }
        });
    } else {
        let cursor = 0;
        plan.outputLayers.forEach((layer) => {
            layer.isBase = false;
            layer.zStart = cursor;
            layer.zEnd = cursor + layer.thickness;
            cursor = layer.zEnd;
        });
    }

    plan.outputLayers.forEach((layer) => {
        const transition = transitions.find((entry) => entry.outputLayerId === layer.outputLayerId);
        transition.nextStart = layer.zStart;
        transition.nextEnd = layer.zEnd;

        if (Array.isArray(layer.geometrySegments) && layer.geometrySegments.length === 1) {
            layer.geometrySegments[0].zStart = layer.zStart;
            layer.geometrySegments[0].depth = layer.thickness;
        }
    });

    plan.thicknessById = thicknessById;
    plan.totalHeight = plan.outputLayers.reduce(
        (maxHeight, layer) => Math.max(maxHeight, layer.zEnd),
        0
    );
    plan.maxHeight = plan.totalHeight;

    return {
        plan,
        transitions,
        totalHeight: plan.totalHeight
    };
}

function cloneLayerForPrintStyle(layer) {
    return {
        ...layer,
        sourceLayerIds: Array.isArray(layer.sourceLayerIds) ? layer.sourceLayerIds.slice() : [],
        repairActions: Array.isArray(layer.repairActions)
            ? layer.repairActions.map((action) => ({ ...action }))
            : [],
        componentStats: layer.componentStats ? { ...layer.componentStats } : null,
        geometrySegments: Array.isArray(layer.geometrySegments)
            ? layer.geometrySegments.map((segment) => ({ ...segment }))
            : []
    };
}

function getLayerSimplifyTolerance(layer) {
    const segment = Array.isArray(layer?.geometrySegments)
        ? layer.geometrySegments.find((entry) => Number.isFinite(entry?.simplifyTolerance))
        : null;
    return segment?.simplifyTolerance ?? null;
}

function buildFrontBaseMask(supportBaseMask, detailMasks) {
    const frontBaseMask = new Uint8Array(supportBaseMask.length);
    for (let index = 0; index < supportBaseMask.length; index++) {
        if (!supportBaseMask[index]) continue;
        let occupiedByDetail = false;
        for (let maskIndex = 0; maskIndex < detailMasks.length; maskIndex++) {
            if (detailMasks[maskIndex][index]) {
                occupiedByDetail = true;
                break;
            }
        }
        if (!occupiedByDetail) frontBaseMask[index] = 255;
    }
    return frontBaseMask;
}

/**
 * Reuses the expensive, style-independent mask preparation from the previous
 * preview. Only the AMS preset's Z layout and extrusion segments are rebuilt.
 * Export continues to use buildObjModelPlan() as the authoritative cold path.
 */
export function retargetObjModelPlanPrintStyle(previousPlan, state, defaultThickness) {
    if (!previousPlan?.outputLayers?.length || !state?.objParams) return null;
    if (!previousPlan.useBaseLayer || previousPlan.resolvedBaseOutputLayerId === null) return null;
    if (previousPlan.bezelSpec?.enabled || previousPlan.magnetPocketResult?.enabled) return null;

    const outputLayers = previousPlan.outputLayers.map(cloneLayerForPrintStyle);
    const baseLayer = outputLayers.find(
        (layer) => layer.outputLayerId === previousPlan.resolvedBaseOutputLayerId
    );
    if (!baseLayer?.printMask || !(baseLayer.printMask instanceof Uint8Array) || !baseLayer.printMaskSpace) {
        return null;
    }

    const detailLayers = outputLayers.filter((layer) => layer.outputLayerId !== baseLayer.outputLayerId);
    const maskLength = baseLayer.printMask.length;
    const masksAreReusable = detailLayers.every((layer) => (
        layer.printMask instanceof Uint8Array
        && layer.printMask.length === maskLength
        && layer.printMaskSpace === baseLayer.printMaskSpace
    ));
    if (!masksAreReusable) return null;

    const requestedAmsPrintStyle = normalizeAmsPrintStyle(state.objParams.amsPrintStyle);
    const preset = getAmsPrintStylePreset(requestedAmsPrintStyle);
    const sourceLayerIds = Array.isArray(previousPlan.visibleSourceLayerIds)
        ? previousPlan.visibleSourceLayerIds.slice()
        : outputLayers.flatMap((layer) => layer.sourceLayerIds || []);
    const thicknessById = ensureLayerThicknessById(state, sourceLayerIds, defaultThickness);
    const warnings = (previousPlan.warnings || []).filter(
        (warning) => !String(warning?.type || '').startsWith('ams-')
    );
    const requestedBaseThickness = clampThickness(state.objParams.baseThickness, preset.baseThickness);
    const baseSimplifyTolerance = getLayerSimplifyTolerance(baseLayer);

    baseLayer.isBase = true;
    baseLayer.thickness = requestedBaseThickness;
    thicknessById[baseLayer.primarySourceLayerId] = baseLayer.thickness;

    if (requestedAmsPrintStyle === 'face-down') {
        const minimumBackingThickness = 0.2;
        const minimumColorDepth = 0.2;
        const baseThickness = Math.max(
            requestedBaseThickness,
            minimumBackingThickness + minimumColorDepth
        );
        if (Math.abs(baseThickness - requestedBaseThickness) > 1e-6) {
            warnings.push({
                type: 'ams-base-depth',
                message: `Base thickness increased to ${baseThickness.toFixed(1)}mm so the face-down backing remains printable.`
            });
        }
        baseLayer.thickness = baseThickness;
        thicknessById[baseLayer.primarySourceLayerId] = baseThickness;

        const requestedColorDepth = clampThickness(defaultThickness, preset.colorThickness);
        const colorDepth = Math.max(
            minimumColorDepth,
            Math.min(requestedColorDepth, Math.max(minimumColorDepth, baseThickness - minimumBackingThickness))
        );
        if (Math.abs(colorDepth - requestedColorDepth) > 1e-6) {
            warnings.push({
                type: 'ams-color-depth',
                message: `Color surface reduced to ${colorDepth.toFixed(1)}mm so the backing remains printable.`
            });
        }

        const frontBaseMask = buildFrontBaseMask(
            baseLayer.printMask,
            detailLayers.map((layer) => layer.printMask)
        );
        baseLayer.geometrySegments = [];
        if (hasMaskPixels(frontBaseMask)) {
            baseLayer.geometrySegments.push({
                maskData: frontBaseMask,
                maskSpace: baseLayer.printMaskSpace,
                zStart: 0,
                depth: colorDepth,
                simplifyTolerance: baseSimplifyTolerance
            });
        }
        if (baseThickness - colorDepth > 0.001) {
            baseLayer.geometrySegments.push({
                maskData: baseLayer.printMask,
                maskSpace: baseLayer.printMaskSpace,
                zStart: colorDepth,
                depth: baseThickness - colorDepth,
                simplifyTolerance: baseSimplifyTolerance
            });
        }
        baseLayer.zStart = 0;
        baseLayer.zEnd = baseThickness;

        detailLayers.forEach((layer) => {
            const simplifyTolerance = getLayerSimplifyTolerance(layer);
            layer.isBase = false;
            layer.thickness = colorDepth;
            layer.zStart = 0;
            layer.zEnd = colorDepth;
            layer.geometrySegments = [{
                maskData: layer.printMask,
                maskSpace: layer.printMaskSpace,
                zStart: 0,
                depth: colorDepth,
                simplifyTolerance
            }];
            thicknessById[layer.primarySourceLayerId] = colorDepth;
        });
    } else {
        baseLayer.geometrySegments = [{
            maskData: baseLayer.printMask,
            maskSpace: baseLayer.printMaskSpace,
            zStart: 0,
            depth: baseLayer.thickness,
            simplifyTolerance: baseSimplifyTolerance
        }];
        baseLayer.zStart = 0;
        baseLayer.zEnd = baseLayer.thickness;

        detailLayers.forEach((layer) => {
            const layerDefault = defaultThickness;
            const nextThickness = clampThickness(
                hasExplicitThickness(state, layer.primarySourceLayerId)
                    ? thicknessById[layer.primarySourceLayerId]
                    : layerDefault,
                layerDefault
            );
            const simplifyTolerance = getLayerSimplifyTolerance(layer);
            layer.isBase = false;
            layer.thickness = nextThickness;
            layer.zStart = baseLayer.thickness;
            layer.zEnd = baseLayer.thickness + nextThickness;
            layer.geometrySegments = [{
                maskData: layer.printMask,
                maskSpace: layer.printMaskSpace,
                zStart: layer.zStart,
                depth: nextThickness,
                simplifyTolerance
            }];
            thicknessById[layer.primarySourceLayerId] = nextThickness;
        });
    }

    state.useBaseLayer = true;
    state.baseSourceLayerId = baseLayer.primarySourceLayerId;
    state.autoBaseLayerSelectionPending = false;

    const totalHeight = outputLayers.reduce(
        (maxHeight, layer) => Math.max(maxHeight, layer.zEnd),
        0
    );
    const colorLayerDepth = requestedAmsPrintStyle === 'face-down'
        ? detailLayers[0]?.thickness || 0
        : null;

    return {
        ...previousPlan,
        outputLayers,
        visibleSourceLayerIds: sourceLayerIds,
        thicknessById,
        requestedAmsPrintStyle,
        amsPrintStyle: requestedAmsPrintStyle,
        faceDownOnBed: requestedAmsPrintStyle === 'face-down',
        baseThickness: baseLayer.thickness,
        colorLayerDepth,
        useBaseLayer: true,
        baseSourceLayerId: baseLayer.primarySourceLayerId,
        totalHeight,
        maxHeight: totalHeight,
        scalePlan: previousPlan.scalePlan
            ? { ...previousPlan.scalePlan, modelHeight: totalHeight }
            : previousPlan.scalePlan,
        warnings
    };
}

function migrateLegacyBaseSourceLayerId(state, outputLayers, detectedBaseOutputLayer) {
    if (Number.isInteger(state.baseSourceLayerId)) return;
    const legacyIndex = Number.parseInt(state.baseLayerIndex, 10);
    if (Number.isInteger(legacyIndex) && legacyIndex >= 0 && legacyIndex < outputLayers.length) {
        state.baseSourceLayerId = outputLayers[legacyIndex].primarySourceLayerId;
        return;
    }
    state.baseSourceLayerId = detectedBaseOutputLayer?.primarySourceLayerId ?? outputLayers[0]?.primarySourceLayerId ?? null;
}

function getPrintThresholds(maskSpace, printProfile) {
    const pixelsPerMm = maskSpace?.pixelsPerMm || printProfile.maskResolutionPxPerMm || 24;
    const maxBezelWidthMm = Math.max(
        0,
        ...Object.values(BEZEL_PRESETS).map((preset) => preset?.widthMm || 0)
    );
    const supportCloseRadiusPx = Math.max(
        1,
        Math.ceil((Math.max(printProfile.minHoleWidthMm, printProfile.minSupportContactWidthMm) * pixelsPerMm) / 2)
    );
    const detailCloseRadiusPx = Math.max(1, Math.ceil((printProfile.minHoleWidthMm * pixelsPerMm) / 2));
    const featureProbeRadiusPx = Math.max(1, Math.ceil((printProfile.minFeatureWidthMm * pixelsPerMm) / 2));
    const minAreaPx = Math.max(1, Math.ceil(printProfile.minIslandAreaMm2 * pixelsPerMm * pixelsPerMm));
    const maxBezelWidthPx = Math.max(0, Math.ceil(maxBezelWidthMm * pixelsPerMm));

    return {
        supportCloseRadiusPx,
        detailCloseRadiusPx,
        featureProbeRadiusPx,
        minAreaPx,
        maxPaddingPx: Math.max(4, supportCloseRadiusPx, detailCloseRadiusPx, maxBezelWidthPx) + 2
    };
}

function buildLayerRecord(group, state, thicknessById, rawShapes, shapeSet, defaultThickness) {
    const fallbackBounds = shapeSet?.bounds?.isValid
        ? shapeSet.bounds
        : buildBoundsFromShapes(shapeSet?.shapes || [], shapeSet?.offsetX || 0, shapeSet?.offsetY || 0);

    return {
        outputLayerId: group.outputLayerId,
        primarySourceLayerId: group.primarySourceLayerId,
        sourceLayerIds: group.sourceLayerIds.slice(),
        color: state.tracedata.palette[group.primarySourceLayerId],
        thickness: clampThickness(thicknessById[group.primarySourceLayerId], defaultThickness),
        rawShapes,
        rawShapeSet: shapeSet,
        shapes: (shapeSet?.shapes || []).slice(),
        shapeOffsetX: shapeSet?.offsetX || 0,
        shapeOffsetY: shapeSet?.offsetY || 0,
        footprintShapes: (shapeSet?.shapes || []).slice(),
        footprintOffsetX: shapeSet?.offsetX || 0,
        footprintOffsetY: shapeSet?.offsetY || 0,
        bounds: fallbackBounds,
        displayLabel: group.sourceLayerIds.length > 1
            ? `L${group.primarySourceLayerId} (${group.sourceLayerIds.join('+')})`
            : `L${group.primarySourceLayerId}`,
        geometrySegments: [],
        printMask: null,
        printMaskSpace: null,
        repairActions: [],
        componentStats: {
            originalCount: 0,
            printableCount: 0,
            absorbedCount: 0
        },
        zStart: 0,
        zEnd: 0,
        isBase: false,
        providesGeneratedSupportFootprint: false
    };
}

function getDetailDecimatePercent(decimatePercent) {
    return Math.min(clampDecimatePercent(decimatePercent), 35);
}

function getMaskLoopSimplifyTolerance(decimatePercent, pixelsPerUnit, {
    baseTolerancePx = 0,
    maxExtraTolerancePx = 0,
    minimumTolerancePx = 0
} = {}) {
    if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) return null;

    const normalized = clampDecimatePercent(decimatePercent) / 100;
    const tolerancePx = Math.max(
        minimumTolerancePx,
        baseTolerancePx + (maxExtraTolerancePx * normalized)
    );

    return tolerancePx > 0
        ? tolerancePx / pixelsPerUnit
        : null;
}

function getSimplifiedShapes(shapeSet, THREERef, decimatePercent) {
    if (!shapeSet?.shapes?.length) return [];
    const simplified = simplifyShapeSet(shapeSet.shapes, THREERef, decimatePercent);
    return simplified.length ? simplified : shapeSet.shapes.slice();
}

function getMaskDifferenceCount(leftMask, rightMask) {
    const size = Math.max(leftMask?.length || 0, rightMask?.length || 0);
    let count = 0;
    for (let index = 0; index < size; index++) {
        if ((leftMask?.[index] || 0) !== (rightMask?.[index] || 0)) count++;
    }
    return count;
}

function buildShapeSetFromMask({
    maskData,
    maskSpace,
    fallbackShapeSet,
    tracer,
    options,
    SVGLoader,
    THREERef,
    decimatePercent = 0
}) {
    if (hasMaskPixels(maskData)) {
        const tracedShapeSet = traceMaskDataToShapeSet({
            maskSpace,
            maskData,
            tracer,
            options,
            SVGLoader,
            THREERef
        });
        const shapes = getSimplifiedShapes(tracedShapeSet, THREERef, decimatePercent);
        if (shapes.length) {
            return {
                shapes,
                bounds: buildBoundsFromShapes(shapes, 0, 0),
                offsetX: 0,
                offsetY: 0,
                tracedata: tracedShapeSet.tracedata,
                traceOptions: tracedShapeSet.traceOptions
            };
        }
    }

    const fallbackShapes = getSimplifiedShapes(fallbackShapeSet, THREERef, decimatePercent);
    return {
        shapes: fallbackShapes,
        bounds: buildBoundsFromShapes(
            fallbackShapes,
            fallbackShapeSet?.offsetX || 0,
            fallbackShapeSet?.offsetY || 0
        ),
        offsetX: fallbackShapeSet?.offsetX || 0,
        offsetY: fallbackShapeSet?.offsetY || 0,
        tracedata: fallbackShapeSet?.tracedata || null,
        traceOptions: fallbackShapeSet?.traceOptions || null
    };
}

function appendTriangle(positions, a, b, c) {
    positions.push(
        a.x, a.y, a.z,
        b.x, b.y, b.z,
        c.x, c.y, c.z
    );
}

function simplifyMaskLoop(loop) {
    const simplified = Array.isArray(loop) ? loop.slice() : [];
    if (simplified.length < 3) return simplified;

    let changed = true;
    while (changed && simplified.length >= 3) {
        changed = false;
        for (let index = 0; index < simplified.length; index++) {
            const previous = simplified[(index - 1 + simplified.length) % simplified.length];
            const current = simplified[index];
            const next = simplified[(index + 1) % simplified.length];
            const crossProduct = (
                ((current.x - previous.x) * (next.y - current.y))
                - ((current.y - previous.y) * (next.x - current.x))
            );
            const collinear = Math.abs(crossProduct) < 1e-9;
            if (!collinear) continue;
            simplified.splice(index, 1);
            changed = true;
            break;
        }
    }

    return simplified;
}

function computePolygonArea(points) {
    if (!Array.isArray(points) || points.length < 3) return 0;
    let area = 0;
    for (let index = 0; index < points.length; index++) {
        const current = points[index];
        const next = points[(index + 1) % points.length];
        area += (current.x * next.y) - (current.y * next.x);
    }
    return area / 2;
}

function pointInPolygon(point, polygon) {
    if (!point || !Array.isArray(polygon) || polygon.length < 3) return false;
    let inside = false;
    for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index++) {
        const current = polygon[index];
        const previous = polygon[previousIndex];
        const intersects = ((current.y > point.y) !== (previous.y > point.y))
            && (point.x < (((previous.x - current.x) * (point.y - current.y)) / ((previous.y - current.y) || 1e-12)) + current.x);
        if (intersects) inside = !inside;
    }
    return inside;
}

function buildPathFromPoints(points, THREERef, isShape = false) {
    if (!Array.isArray(points) || points.length < 3) return null;
    const path = isShape ? new THREERef.Shape() : new THREERef.Path();
    path.moveTo(points[0].x, points[0].y);
    for (let index = 1; index < points.length; index++) {
        path.lineTo(points[index].x, points[index].y);
    }
    path.closePath();
    return path;
}

function simplifyExtrusionLoop(points, tolerance) {
    if (!Array.isArray(points) || points.length < 4 || tolerance <= 0) return points.slice();
    const ring = points.concat(points[0]);
    const simplified = simplifyPolyline(ring, tolerance).slice(0, -1);
    const cleaned = simplifyMaskLoop(simplified);
    return cleaned.length >= 3 ? cleaned : points.slice();
}

// Two same-colour regions that touch only at a diagonal pixel corner produce two
// separate contours that share one grid point. Extruding them and welding vertices
// (mergeVertices at 1e-5) then fuses that point into a single vertical edge shared
// by four side walls — a non-manifold pinch. Nudging every repeated contour point
// into its own polygon by a sub-visible amount keeps the two shells apart.
const PINCH_QUANTIZE_SCALE = 1e-5;
const PINCH_SEPARATION_EPSILON = 1e-3;
const PINCH_SEPARATION_MIN = 1e-4;

function getPinchPointKey(point) {
    return `${Math.round(point.x / PINCH_QUANTIZE_SCALE)},${Math.round(point.y / PINCH_QUANTIZE_SCALE)}`;
}

function getInwardOffsetDirection(points, vertexIndex, orientation) {
    const count = points.length;
    const current = points[vertexIndex];
    const previous = points[(vertexIndex - 1 + count) % count];
    const next = points[(vertexIndex + 1) % count];

    const inX = current.x - previous.x;
    const inY = current.y - previous.y;
    const outX = next.x - current.x;
    const outY = next.y - current.y;
    const inLength = Math.hypot(inX, inY);
    const outLength = Math.hypot(outX, outY);
    if (inLength <= 0 || outLength <= 0) return null;

    // Left-hand normals of both adjacent edges. Their sum bisects the interior
    // angle and stays inside for reflex corners too, unlike a plain edge bisector.
    const normalInX = (-inY / inLength) * orientation;
    const normalInY = (inX / inLength) * orientation;
    const normalOutX = (-outY / outLength) * orientation;
    const normalOutY = (outX / outLength) * orientation;

    let dirX = normalInX + normalOutX;
    let dirY = normalInY + normalOutY;
    let length = Math.hypot(dirX, dirY);
    if (length < 1e-9) {
        // Degenerate spike: fall back to the normal of one adjacent edge, already
        // oriented by the polygon's signed-area sign.
        dirX = normalInX;
        dirY = normalInY;
        length = Math.hypot(dirX, dirY);
        if (length < 1e-9) return null;
    }

    const magnitude = Math.max(
        PINCH_SEPARATION_MIN,
        Math.min(PINCH_SEPARATION_EPSILON, Math.min(inLength, outLength) * 0.25)
    );
    return {
        x: (dirX / length) * magnitude,
        y: (dirY / length) * magnitude
    };
}

/**
 * Pure helper. Given a set of closed 2D contours, returns a new set in which no
 * coordinate (quantized to PINCH_QUANTIZE_SCALE) is visited more than once. The
 * first occurrence stays put; every later occurrence — in the same loop or in
 * another one — moves into its own polygon along the interior angle bisector.
 * Input arrays and points are never mutated.
 *
 * @param {Array<Array<{x:number,y:number}>>} loops
 * @returns {{loops: Array<Array<{x:number,y:number}>>, separatedCount: number}}
 */
export function separatePinchPoints(loops) {
    const source = Array.isArray(loops) ? loops : [];
    const result = source.map((loop) => (Array.isArray(loop) ? loop.map((point) => ({ x: point.x, y: point.y })) : []));

    const seen = new Set();
    const duplicates = [];
    source.forEach((loop, loopIndex) => {
        if (!Array.isArray(loop) || loop.length < 3) return;
        loop.forEach((point, vertexIndex) => {
            if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
            const key = getPinchPointKey(point);
            if (seen.has(key)) {
                duplicates.push({ loopIndex, vertexIndex });
                return;
            }
            seen.add(key);
        });
    });

    let separatedCount = 0;
    const orientations = new Map();
    duplicates.forEach(({ loopIndex, vertexIndex }) => {
        if (!orientations.has(loopIndex)) {
            orientations.set(loopIndex, computePolygonArea(source[loopIndex]) >= 0 ? 1 : -1);
        }
        const offset = getInwardOffsetDirection(source[loopIndex], vertexIndex, orientations.get(loopIndex));
        if (!offset) return;
        const target = result[loopIndex][vertexIndex];
        target.x += offset.x;
        target.y += offset.y;
        separatedCount += 1;
    });

    return { loops: result, separatedCount };
}

function stripClosingPoint(ring) {
    const points = (ring || []).map((point) => ({ x: point.x, y: point.y }));
    if (points.length > 1) {
        const first = points[0];
        const last = points[points.length - 1];
        if (Math.abs(first.x - last.x) < PINCH_QUANTIZE_SCALE && Math.abs(first.y - last.y) < PINCH_QUANTIZE_SCALE) {
            points.pop();
        }
    }
    return points;
}

// SVG tracer path counterpart of separatePinchPoints. Returns the original shapes
// untouched when nothing is pinched, so ordinary artwork is never rebuilt.
function separateShapePinchPoints(shapes, curveSegments, THREERef) {
    const list = Array.isArray(shapes) ? shapes.filter(Boolean) : [];
    if (!list.length || !THREERef?.Shape) return list;

    const divisions = Number.isFinite(curveSegments) && curveSegments > 0 ? curveSegments : 12;
    const extracted = [];
    const rings = [];
    for (const shape of list) {
        if (typeof shape.extractPoints !== 'function') return list;
        const points = shape.extractPoints(divisions);
        const contour = stripClosingPoint(points?.shape);
        if (contour.length < 3) return list;
        const holes = (points?.holes || []).map(stripClosingPoint);
        extracted.push({ contour, holes });
        rings.push(contour, ...holes);
    }

    const separation = separatePinchPoints(rings);
    if (!separation.separatedCount) return list;

    let cursor = 0;
    const rebuilt = extracted.map(({ holes }) => {
        const contourPoints = separation.loops[cursor];
        cursor += 1;
        const holePoints = holes.map(() => {
            const ring = separation.loops[cursor];
            cursor += 1;
            return ring;
        });
        const shape = buildPathFromPoints(contourPoints, THREERef, true);
        if (!shape) return null;
        holePoints.forEach((ring) => {
            const holePath = buildPathFromPoints(ring, THREERef, false);
            if (holePath) shape.holes.push(holePath);
        });
        return shape;
    }).filter(Boolean);

    return rebuilt.length === list.length ? rebuilt : list;
}

function extractMaskLoops(maskSpace, maskData) {
    if (!maskSpace || !(maskData instanceof Uint8Array) || !hasMaskPixels(maskData)) return [];

    const width = maskSpace.width || 0;
    const height = maskSpace.height || 0;
    const outgoing = new Map();
    const edges = [];
    const directionPriority = {
        R: ['D', 'R', 'U', 'L'],
        D: ['L', 'D', 'R', 'U'],
        L: ['U', 'L', 'D', 'R'],
        U: ['R', 'U', 'L', 'D']
    };

    const isFilled = (row, column) => {
        if (row < 0 || row >= height || column < 0 || column >= width) return false;
        return !!maskData[(row * width) + column];
    };

    const addEdge = (startX, startY, endX, endY) => {
        const direction = endX > startX ? 'R' : endX < startX ? 'L' : endY > startY ? 'D' : 'U';
        const edge = {
            startX,
            startY,
            endX,
            endY,
            direction,
            key: `${startX},${startY}|${endX},${endY}`
        };
        edges.push(edge);
        const startKey = `${startX},${startY}`;
        const bucket = outgoing.get(startKey) || [];
        bucket.push(edge);
        outgoing.set(startKey, bucket);
    };

    for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
            if (!isFilled(row, column)) continue;
            if (!isFilled(row - 1, column)) addEdge(column, row, column + 1, row);
            if (!isFilled(row, column + 1)) addEdge(column + 1, row, column + 1, row + 1);
            if (!isFilled(row + 1, column)) addEdge(column + 1, row + 1, column, row + 1);
            if (!isFilled(row, column - 1)) addEdge(column, row + 1, column, row);
        }
    }

    const used = new Set();
    const loops = [];

    edges.forEach((seedEdge) => {
        if (used.has(seedEdge.key)) return;

        const loop = [{ x: seedEdge.startX, y: seedEdge.startY }];
        let current = seedEdge;
        used.add(current.key);

        while (true) {
            loop.push({ x: current.endX, y: current.endY });
            if (current.endX === seedEdge.startX && current.endY === seedEdge.startY) break;

            const candidates = (outgoing.get(`${current.endX},${current.endY}`) || []).filter((edge) => !used.has(edge.key));
            if (!candidates.length) break;

            let nextEdge = null;
            for (const direction of directionPriority[current.direction]) {
                nextEdge = candidates.find((edge) => edge.direction === direction) || null;
                if (nextEdge) break;
            }
            if (!nextEdge) break;

            used.add(nextEdge.key);
            current = nextEdge;
        }

        if (loop.length < 4) return;
        if (loop[0].x === loop[loop.length - 1].x && loop[0].y === loop[loop.length - 1].y) {
            loop.pop();
        }
        const simplified = simplifyMaskLoop(loop);
        if (simplified.length >= 4) loops.push(simplified);
    });

    return loops;
}

function buildMaskExtrusionGeometries({
    maskSpace,
    maskData,
    zStart,
    depth,
    plan,
    THREERef,
    simplifyTolerance = null
}) {
    if (!maskSpace || !(maskData instanceof Uint8Array) || !hasMaskPixels(maskData) || !THREERef) return null;

    const pixelsPerUnit = maskSpace.pixelsPerUnit || 1;
    const shiftX = plan?.normalization?.shiftX || 0;
    const shiftY = plan?.normalization?.shiftY || 0;
    const shiftZ = plan?.normalization?.shiftZ || 0;
    const contourTolerance = Number.isFinite(simplifyTolerance) && simplifyTolerance > 0
        ? simplifyTolerance
        : (1.25 / pixelsPerUnit);
    const tracedLoops = extractMaskLoops(maskSpace, maskData).map((loop) => {
        const sourcePoints = loop.map((point) => ({
            x: maskSpace.originX + (point.x / pixelsPerUnit),
            y: maskSpace.originY + (point.y / pixelsPerUnit)
        }));
        return {
            sourcePoints,
            localPoints: simplifyExtrusionLoop(sourcePoints.map((point) => ({
                x: point.x + shiftX,
                y: -point.y - shiftY
            })), contourTolerance),
            area: computePolygonArea(sourcePoints)
        };
    }).filter((loop) => Math.abs(loop.area) > 1e-9);

    if (!tracedLoops.length) return null;

    // Runs after simplifyExtrusionLoop on purpose: contourTolerance is ~25x the
    // separation epsilon, so a nudge applied earlier would be erased by
    // Douglas-Peucker, and simplification can create new shared points itself.
    const separation = separatePinchPoints(tracedLoops.map((loop) => loop.localPoints));
    const loops = separation.separatedCount
        ? tracedLoops.map((loop, index) => ({ ...loop, localPoints: separation.loops[index] }))
        : tracedLoops;

    const outers = loops
        .filter((loop) => loop.area > 0)
        .map((loop) => ({ ...loop, holes: [], absArea: Math.abs(loop.area) }))
        .sort((left, right) => right.absArea - left.absArea);
    const holes = loops.filter((loop) => loop.area < 0);

    holes.forEach((hole) => {
        const container = outers
            .filter((outer) => pointInPolygon(hole.sourcePoints[0], outer.sourcePoints))
            .sort((left, right) => left.absArea - right.absArea)[0];
        if (container) container.holes.push(hole);
    });

    const extrusionDepth = Math.max(0.01, Number.isFinite(depth) ? depth : 0.01);
    const zOffset = Number.isFinite(zStart) ? zStart : 0;
    const geometries = [];

    outers.forEach((outer) => {
        const contour = outer.localPoints.map((point) => ({ x: point.x, y: point.y }));
        if (!THREERef.ShapeUtils.isClockWise(contour)) contour.reverse();
        if (contour.length < 3) return;

        const holes = [];
        outer.holes.forEach((hole) => {
            const holePoints = hole.localPoints.map((point) => ({ x: point.x, y: point.y }));
            if (THREERef.ShapeUtils.isClockWise(holePoints)) holePoints.reverse();
            if (holePoints.length >= 3) holes.push(holePoints);
        });

        const shape = buildPathFromPoints(contour, THREERef, true);
        if (!shape) return;
        holes.forEach((ring) => {
            const holePath = buildPathFromPoints(ring, THREERef, false);
            if (holePath) shape.holes.push(holePath);
        });

        const geometry = new THREERef.ExtrudeGeometry(shape, {
            depth: extrusionDepth,
            curveSegments: 1,
            bevelEnabled: false
        });
        geometry.translate(0, 0, zOffset + shiftZ);
        geometry.computeVertexNormals();
        geometries.push(geometry);
    });

    return geometries;
}

export function buildObjModelPlan({
    state,
    tracer,
    SVGLoader,
    THREERef,
    defaultThickness,
    visibleSourceLayerIds,
    decimatePercent = 0,
    bedKey = state?.objParams?.bedKey || 'x1',
    margin = state?.objParams?.margin ?? 5,
    scalePercent = state?.objParams?.scale ?? 100,
    sourceScale = state?.sourceRenderScale || 1,
    printProfile = DEFAULT_PRINT_PROFILE,
    bezelPreset = state?.objParams?.bezelPreset ?? 'off',
    magnetPocket = state?.objParams?.magnetPocket
}) {
    if (!state?.tracedata || !tracer || !SVGLoader || !THREERef) return null;
    if (!Array.isArray(visibleSourceLayerIds) || visibleSourceLayerIds.length === 0) return null;

    const sourceLayerIds = visibleSourceLayerIds.slice();
    const requestedAmsPrintStyle = normalizeAmsPrintStyle(state.objParams?.amsPrintStyle);
    const amsPrintStylePreset = getAmsPrintStylePreset(requestedAmsPrintStyle);
    const requestedBaseThickness = clampThickness(
        state.objParams?.baseThickness,
        amsPrintStylePreset.baseThickness
    );
    const thicknessById = ensureLayerThicknessById(state, sourceLayerIds, defaultThickness);
    const outputGroups = resolveMergedLayerGroups(sourceLayerIds, state.mergeRules || []);
    const shapeCache = new Map();
    const rawBounds = createEmptyBounds();
    const normalizedDecimatePercent = clampDecimatePercent(decimatePercent);
    const normalizedMagnetPocket = normalizeMagnetPocketConfig(magnetPocket);

    sourceLayerIds.forEach((sourceLayerId) => {
        const cached = buildShapesForSourceLayer({
            tracedata: state.tracedata,
            sourceLayerId,
            tracer,
            options: state.lastOptions,
            SVGLoader,
            THREERef
        });
        shapeCache.set(sourceLayerId, cached);
        if (cached.bounds.isValid) {
            updateBoundsFromPoints(rawBounds, [
                { x: cached.bounds.minX, y: cached.bounds.minY },
                { x: cached.bounds.maxX, y: cached.bounds.maxY }
            ]);
        }
    });

    const normalizedBounds = finalizeBounds(rawBounds);
    const scalePlan = computeObjScalePlan({
        rawWidth: normalizedBounds.width,
        rawDepth: normalizedBounds.depth,
        bedKey,
        margin,
        scalePercent,
        sourceScale
    });
    const maskSpaceBase = createMaskSpace({
        bounds: normalizedBounds,
        pixelsPerUnit: Math.max(1, scalePlan.scale * printProfile.maskResolutionPxPerMm),
        pixelsPerMm: printProfile.maskResolutionPxPerMm,
        paddingPx: 4
    });
    const thresholds = getPrintThresholds(maskSpaceBase, printProfile);
    const maskSpace = createMaskSpace({
        bounds: normalizedBounds,
        pixelsPerUnit: Math.max(1, scalePlan.scale * printProfile.maskResolutionPxPerMm),
        pixelsPerMm: printProfile.maskResolutionPxPerMm,
        paddingPx: thresholds.maxPaddingPx
    });

    const outputLayers = outputGroups.map((group) => {
        const rawShapes = [];
        group.sourceLayerIds.forEach((sourceLayerId) => {
            const sourceShapes = shapeCache.get(sourceLayerId)?.shapes || [];
            rawShapes.push(...sourceShapes);
        });
        const weldedShapeSet = buildWeldedShapeSet({
            shapes: rawShapes,
            tracer,
            options: state.lastOptions,
            SVGLoader,
            THREERef
        });
        return buildLayerRecord(group, state, thicknessById, rawShapes, weldedShapeSet, defaultThickness);
    });

    const detectedBaseOutputLayer = detectBaseOutputLayer(outputLayers, THREERef);

    // A face-down inlay is one assembled sign: the selected base color fills
    // the front around the details and continues as the backing. Do not allow
    // this style to degrade into an unrelated stack of independent Z layers.
    if (requestedAmsPrintStyle === 'face-down' && detectedBaseOutputLayer) {
        state.useBaseLayer = true;
    }

    if (state.autoBaseLayerSelectionPending && detectedBaseOutputLayer) {
        state.useBaseLayer = true;
        state.baseSourceLayerId = detectedBaseOutputLayer.primarySourceLayerId;
        state.autoBaseLayerSelectionPending = false;
    }

    migrateLegacyBaseSourceLayerId(state, outputLayers, detectedBaseOutputLayer);

    let resolvedBaseOutputLayer = null;
    if ((state.useBaseLayer || normalizedMagnetPocket.enabled) && outputLayers.length > 0) {
        resolvedBaseOutputLayer = outputLayers.find((layer) => layer.sourceLayerIds.includes(state.baseSourceLayerId));
        if (!resolvedBaseOutputLayer) {
            resolvedBaseOutputLayer = detectedBaseOutputLayer || outputLayers[0];
            state.baseSourceLayerId = resolvedBaseOutputLayer.primarySourceLayerId;
        }
    }

    if (resolvedBaseOutputLayer) {
        const baseSourceLayerId = resolvedBaseOutputLayer.primarySourceLayerId;
        resolvedBaseOutputLayer.thickness = clampThickness(
            hasExplicitThickness(state, baseSourceLayerId)
                ? thicknessById[baseSourceLayerId]
                : requestedBaseThickness,
            requestedBaseThickness
        );
        thicknessById[baseSourceLayerId] = resolvedBaseOutputLayer.thickness;
    }

    const finalizedOutputLayers = [];
    const repairSummary = {
        supportBaseClosedGaps: false,
        supportBaseComponents: 0,
        preservedDetailLayers: 0,
        mergedDetailLayers: 0,
        absorbedDetailComponents: 0,
        clippedForBezelLayers: 0,
        bezelApplied: false,
        bezelSkippedReason: ''
    };

    let supportBaseMask = null;
    let supportBaseShapeSet = null;
    let innerMask = null;
    let bezelMaskData = null;
    let bezelShapeSet = null;
    let magnetPocketResult = {
        enabled: false,
        valid: true,
        config: normalizedMagnetPocket,
        placements: [],
        errors: [],
        warnings: [],
        pauseZ: null
    };
    let bezelSpec = {
        enabled: false,
        widthMm: 0,
        extraHeightMm: 0,
        effectiveWidthMm: 0,
        skippedReason: 'Bezel disabled.'
    };

    if (resolvedBaseOutputLayer) {
        supportBaseShapeSet = buildWeldedShapeSet({
            shapes: outputLayers.flatMap((layer) => layer.rawShapes || []),
            tracer,
            options: state.lastOptions,
            SVGLoader,
            THREERef
        });

        const rawSupportBaseMask = rasterizeShapeSetToMask({
            shapes: supportBaseShapeSet.shapes,
            offsetX: supportBaseShapeSet.offsetX || 0,
            offsetY: supportBaseShapeSet.offsetY || 0,
            maskSpace
        });
        const repairedSupportBaseMask = closeMaskData(maskSpace, rawSupportBaseMask, thresholds.supportCloseRadiusPx);
        supportBaseMask = hasMaskPixels(repairedSupportBaseMask) ? repairedSupportBaseMask : rawSupportBaseMask.slice();
        repairSummary.supportBaseClosedGaps = getMaskDifferenceCount(rawSupportBaseMask, supportBaseMask) > 0;
        repairSummary.supportBaseComponents = analyzeMaskComponents(maskSpace, supportBaseMask).length;

        const repairedSupportShapeSet = buildShapeSetFromMask({
            maskData: supportBaseMask,
            maskSpace,
            fallbackShapeSet: supportBaseShapeSet,
            tracer,
            options: state.lastOptions,
            SVGLoader,
            THREERef,
            decimatePercent: normalizedDecimatePercent
        });

        resolvedBaseOutputLayer.shapes = repairedSupportShapeSet.shapes;
        resolvedBaseOutputLayer.shapeOffsetX = repairedSupportShapeSet.offsetX || 0;
        resolvedBaseOutputLayer.shapeOffsetY = repairedSupportShapeSet.offsetY || 0;
        resolvedBaseOutputLayer.footprintShapes = repairedSupportShapeSet.shapes.slice();
        resolvedBaseOutputLayer.footprintOffsetX = repairedSupportShapeSet.offsetX || 0;
        resolvedBaseOutputLayer.footprintOffsetY = repairedSupportShapeSet.offsetY || 0;
        resolvedBaseOutputLayer.bounds = repairedSupportShapeSet.bounds;
        resolvedBaseOutputLayer.printMask = supportBaseMask;
        resolvedBaseOutputLayer.printMaskSpace = maskSpace;
        resolvedBaseOutputLayer.providesGeneratedSupportFootprint = true;
        resolvedBaseOutputLayer.repairActions = repairSummary.supportBaseClosedGaps
            ? [{ type: 'closed-support-gaps', pixelsChanged: getMaskDifferenceCount(rawSupportBaseMask, supportBaseMask) }]
            : [];
        resolvedBaseOutputLayer.componentStats = {
            originalCount: analyzeMaskComponents(maskSpace, rawSupportBaseMask).length,
            printableCount: repairSummary.supportBaseComponents,
            absorbedCount: 0
        };

        magnetPocketResult = resolveMagnetPocketPlan({
            config: normalizedMagnetPocket,
            supportMask: supportBaseMask,
            maskSpace,
            requestedBaseThickness: resolvedBaseOutputLayer.thickness
        });
        if (magnetPocketResult.enabled && magnetPocketResult.valid) {
            resolvedBaseOutputLayer.thickness = magnetPocketResult.effectiveBaseThickness;
            resolvedBaseOutputLayer.repairActions.push({
                type: 'applied-magnet-pockets',
                count: magnetPocketResult.placements.length,
                mode: magnetPocketResult.config.mode,
                shape: magnetPocketResult.config.shape
            });
        }

        const bezelMaskSet = resolveBezelMaskSet({
            maskSpace,
            baseMask: supportBaseMask,
            bezelPreset,
            printProfile
        });
        innerMask = bezelMaskSet.innerMask;
        bezelMaskData = bezelMaskSet.bezelMask;
        bezelSpec = bezelMaskSet.bezelSpec;
        repairSummary.bezelApplied = bezelSpec.enabled;
        repairSummary.bezelSkippedReason = bezelSpec.skippedReason || '';

        if (bezelSpec.enabled) {
            bezelShapeSet = buildShapeSetFromMask({
                maskData: bezelMaskData,
                maskSpace,
                fallbackShapeSet: null,
                tracer,
                options: state.lastOptions,
                SVGLoader,
                THREERef,
                decimatePercent: Math.min(normalizedDecimatePercent, 20)
            });

            if (!bezelShapeSet.shapes.length) {
                bezelShapeSet = null;
                bezelMaskData = null;
                bezelSpec = {
                    ...bezelSpec,
                    enabled: false,
                    effectiveWidthMm: 0,
                    skippedReason: 'Bezel band could not be traced cleanly.'
                };
                repairSummary.bezelApplied = false;
                repairSummary.bezelSkippedReason = bezelSpec.skippedReason;
            } else {
                resolvedBaseOutputLayer.repairActions.push({
                    type: 'applied-bezel',
                    preset: clampBezelPreset(bezelPreset),
                    widthMm: bezelSpec.effectiveWidthMm,
                    extraHeightMm: bezelSpec.extraHeightMm
                });
            }
        }
    }

    const layerManifest = [];

    outputLayers.forEach((layer) => {
        if (resolvedBaseOutputLayer && layer.outputLayerId === resolvedBaseOutputLayer.outputLayerId) {
            layer.isBase = true;
            const baseSimplifyTolerance = getMaskLoopSimplifyTolerance(
                normalizedDecimatePercent,
                maskSpace.pixelsPerUnit,
                {
                    baseTolerancePx: 0,
                    maxExtraTolerancePx: 3,
                    minimumTolerancePx: 1.5
                }
            );
            const pocketIsApplied = magnetPocketResult.enabled
                && magnetPocketResult.valid
                && magnetPocketResult.carvedBaseMask;

            if (pocketIsApplied) {
                layer.geometrySegments = [];
                if (magnetPocketResult.cavityZStart > 0) {
                    layer.geometrySegments.push({
                        maskData: layer.printMask,
                        maskSpace: layer.printMaskSpace,
                        zStart: 0,
                        depth: magnetPocketResult.cavityZStart,
                        simplifyTolerance: baseSimplifyTolerance
                    });
                }
                layer.geometrySegments.push({
                    maskData: magnetPocketResult.carvedBaseMask,
                    maskSpace: layer.printMaskSpace,
                    zStart: magnetPocketResult.cavityZStart,
                    depth: magnetPocketResult.cavityHeight,
                    simplifyTolerance: null
                });
                const roofDepth = layer.thickness - magnetPocketResult.cavityZEnd;
                if (roofDepth > 0.001) {
                    layer.geometrySegments.push({
                        maskData: layer.printMask,
                        maskSpace: layer.printMaskSpace,
                        zStart: magnetPocketResult.cavityZEnd,
                        depth: roofDepth,
                        simplifyTolerance: baseSimplifyTolerance
                    });
                }
            } else {
                layer.geometrySegments = [{
                    maskData: layer.printMask,
                    maskSpace: layer.printMaskSpace,
                    zStart: 0,
                    depth: layer.thickness,
                    simplifyTolerance: baseSimplifyTolerance
                }];
            }

            if (bezelSpec.enabled && bezelMaskData && bezelShapeSet?.shapes?.length) {
                layer.geometrySegments.push({
                    maskData: bezelMaskData,
                    maskSpace,
                    zStart: layer.thickness,
                    depth: bezelSpec.extraHeightMm,
                    simplifyTolerance: null
                });
            }

            finalizedOutputLayers.push(layer);
            layerManifest.push({
                outputLayerId: layer.outputLayerId,
                displayLabel: layer.displayLabel || 'Base',
                sourceLayerIds: layer.sourceLayerIds?.slice() || [],
                isBase: true,
                shapeCount: layer.shapes?.length || 0,
                survivedPlan: true,
                dropoutPoint: null,
                repairActions: (layer.repairActions || []).map(a => a.type)
            });
            return;
        }

        const manifestEntry = {
            outputLayerId: layer.outputLayerId,
            displayLabel: layer.displayLabel || `Layer ${layer.outputLayerId}`,
            sourceLayerIds: layer.sourceLayerIds?.slice() || [],
            isBase: false,
            shapeCount: layer.rawShapeSet?.shapes?.length || layer.rawShapes?.length || 0,
            survivedPlan: false,
            dropoutPoint: null,
            repairActions: []
        };

        const rawLayerMask = rasterizeShapeSetToMask({
            shapes: layer.rawShapeSet?.shapes || [],
            offsetX: layer.rawShapeSet?.offsetX || 0,
            offsetY: layer.rawShapeSet?.offsetY || 0,
            maskSpace
        });
        if (!hasMaskPixels(rawLayerMask)) {
            manifestEntry.dropoutPoint = 'rasterize-to-mask-empty';
            manifestEntry.maskPixelCount = 0;
            layerManifest.push(manifestEntry);
            return;
        }

        const closedLayerMask = closeMaskData(maskSpace, rawLayerMask, thresholds.detailCloseRadiusPx);
        let printableLayerMask = hasMaskPixels(closedLayerMask) ? closedLayerMask : rawLayerMask.slice();

        if (resolvedBaseOutputLayer && innerMask) {
            const clippedMask = intersectMaskData(printableLayerMask, innerMask);
            if (getMaskDifferenceCount(printableLayerMask, clippedMask) > 0) {
                layer.repairActions.push({ type: 'clipped-for-bezel' });
                repairSummary.clippedForBezelLayers += 1;
            }
            printableLayerMask = clippedMask;
        }

        const split = splitMaskByPrintability(maskSpace, printableLayerMask, {
            minAreaPx: thresholds.minAreaPx,
            featureProbeRadiusPx: thresholds.featureProbeRadiusPx
        });
        const printableCount = split.components.filter((component) => component.printable).length;
        const absorbedCount = split.components.length - printableCount;

        layer.componentStats = {
            originalCount: analyzeMaskComponents(maskSpace, rawLayerMask).length,
            printableCount,
            absorbedCount
        };

        if (getMaskDifferenceCount(rawLayerMask, printableLayerMask) > 0) {
            layer.repairActions.push({ type: 'repaired-detail-mask' });
        }
        if (absorbedCount > 0) {
            layer.repairActions.push({
                type: resolvedBaseOutputLayer ? 'merged-into-base' : 'removed-subthreshold-components',
                count: absorbedCount
            });
            repairSummary.absorbedDetailComponents += absorbedCount;
        }

        if (!hasMaskPixels(split.keptMask)) {
            repairSummary.mergedDetailLayers += 1;
            manifestEntry.dropoutPoint = 'printability-split-empty';
            manifestEntry.componentStats = layer.componentStats;
            manifestEntry.repairActions = (layer.repairActions || []).map(a => a.type);
            layerManifest.push(manifestEntry);
            return;
        }

        const detailDecimatePercent = getDetailDecimatePercent(normalizedDecimatePercent);
        if (detailDecimatePercent < normalizedDecimatePercent) {
            layer.repairActions.push({
                type: 'capped-detail-decimation',
                requestedPercent: normalizedDecimatePercent,
                appliedPercent: detailDecimatePercent
            });
        }

        const repairedDetailShapeSet = buildShapeSetFromMask({
            maskData: split.keptMask,
            maskSpace,
            fallbackShapeSet: layer.rawShapeSet,
            tracer,
            options: state.lastOptions,
            SVGLoader,
            THREERef,
            decimatePercent: detailDecimatePercent
        });

        if (!repairedDetailShapeSet.shapes.length) {
            repairSummary.mergedDetailLayers += 1;
            manifestEntry.dropoutPoint = 'mask-retrace-empty';
            manifestEntry.repairActions = (layer.repairActions || []).map(a => a.type);
            layerManifest.push(manifestEntry);
            return;
        }

        layer.shapes = repairedDetailShapeSet.shapes;
        layer.shapeOffsetX = repairedDetailShapeSet.offsetX || 0;
        layer.shapeOffsetY = repairedDetailShapeSet.offsetY || 0;
        layer.footprintShapes = repairedDetailShapeSet.shapes.slice();
        layer.footprintOffsetX = repairedDetailShapeSet.offsetX || 0;
        layer.footprintOffsetY = repairedDetailShapeSet.offsetY || 0;
        layer.bounds = repairedDetailShapeSet.bounds;
        layer.printMask = split.keptMask;
        layer.printMaskSpace = maskSpace;
        const clippedForBezel = layer.repairActions.some((action) => action?.type === 'clipped-for-bezel');
        layer.geometrySegments = [{
            maskData: layer.printMask,
            maskSpace: layer.printMaskSpace,
            depth: layer.thickness,
            simplifyTolerance: clippedForBezel
                ? null
                : getMaskLoopSimplifyTolerance(detailDecimatePercent, maskSpace.pixelsPerUnit, {
                    baseTolerancePx: 0,
                    maxExtraTolerancePx: 2,
                    minimumTolerancePx: 1
                })
        }];
        finalizedOutputLayers.push(layer);
        repairSummary.preservedDetailLayers += 1;

        manifestEntry.survivedPlan = true;
        manifestEntry.shapeCount = repairedDetailShapeSet.shapes.length;
        manifestEntry.repairActions = (layer.repairActions || []).map(a => a.type);
        manifestEntry.componentStats = layer.componentStats;
        layerManifest.push(manifestEntry);
    });

    const printStyleWarnings = [];
    const faceDownBlockReason = requestedAmsPrintStyle === 'face-down'
        ? !resolvedBaseOutputLayer
            ? 'Face-down inlay needs a support base.'
            : bezelSpec.enabled
                ? 'Face-down inlay is not combined with a raised bezel.'
                : magnetPocketResult.enabled
                    ? 'Face-down inlay is not combined with magnet pockets.'
                    : ''
        : '';
    const appliedAmsPrintStyle = requestedAmsPrintStyle === 'face-down' && faceDownBlockReason
        ? 'raised-efficient'
        : requestedAmsPrintStyle;

    if (faceDownBlockReason) {
        printStyleWarnings.push({
            type: 'ams-print-style',
            message: `${faceDownBlockReason} Using thin raised color for this model.`
        });
    }

    if (resolvedBaseOutputLayer && appliedAmsPrintStyle === 'face-down') {
        const minimumBackingThickness = 0.2;
        const minimumColorDepth = 0.2;
        const requestedFaceDownBaseThickness = resolvedBaseOutputLayer.thickness;
        const baseThickness = Math.max(
            requestedFaceDownBaseThickness,
            minimumBackingThickness + minimumColorDepth
        );
        if (Math.abs(baseThickness - requestedFaceDownBaseThickness) > 1e-6) {
            printStyleWarnings.push({
                type: 'ams-base-depth',
                message: `Base thickness increased to ${baseThickness.toFixed(1)}mm so the face-down backing remains printable.`
            });
        }
        resolvedBaseOutputLayer.thickness = baseThickness;
        thicknessById[resolvedBaseOutputLayer.primarySourceLayerId] = baseThickness;
        const requestedColorDepth = clampThickness(defaultThickness, amsPrintStylePreset.colorThickness);
        const colorDepth = Math.max(
            minimumColorDepth,
            Math.min(requestedColorDepth, Math.max(minimumColorDepth, baseThickness - minimumBackingThickness))
        );
        if (Math.abs(colorDepth - requestedColorDepth) > 1e-6) {
            printStyleWarnings.push({
                type: 'ams-color-depth',
                message: `Color surface reduced to ${colorDepth.toFixed(1)}mm so the backing remains printable.`
            });
        }

        const detailLayers = finalizedOutputLayers.filter(
            (layer) => layer.outputLayerId !== resolvedBaseOutputLayer.outputLayerId
        );
        const detailMask = unionMaskData(maskSpace, detailLayers.map((layer) => layer.printMask));
        const frontBaseMask = subtractMaskData(supportBaseMask, detailMask);
        const baseSimplifyTolerance = getMaskLoopSimplifyTolerance(
            normalizedDecimatePercent,
            maskSpace.pixelsPerUnit,
            {
                baseTolerancePx: 0,
                maxExtraTolerancePx: 3,
                minimumTolerancePx: 1.5
            }
        );

        resolvedBaseOutputLayer.geometrySegments = [];
        if (hasMaskPixels(frontBaseMask)) {
            resolvedBaseOutputLayer.geometrySegments.push({
                maskData: frontBaseMask,
                maskSpace,
                zStart: 0,
                depth: colorDepth,
                simplifyTolerance: baseSimplifyTolerance
            });
        }
        if (baseThickness - colorDepth > 0.001) {
            resolvedBaseOutputLayer.geometrySegments.push({
                maskData: supportBaseMask,
                maskSpace,
                zStart: colorDepth,
                depth: baseThickness - colorDepth,
                simplifyTolerance: baseSimplifyTolerance
            });
        }

        finalizedOutputLayers.forEach((layer) => {
            if (layer.outputLayerId === resolvedBaseOutputLayer.outputLayerId) {
                layer.isBase = true;
                layer.zStart = 0;
                layer.zEnd = baseThickness;
                return;
            }
            layer.isBase = false;
            layer.thickness = colorDepth;
            layer.zStart = 0;
            layer.zEnd = colorDepth;
            layer.geometrySegments = [{
                maskData: layer.printMask,
                maskSpace: layer.printMaskSpace,
                zStart: 0,
                depth: colorDepth,
                simplifyTolerance: layer.geometrySegments?.[0]?.simplifyTolerance ?? null
            }];
            thicknessById[layer.primarySourceLayerId] = colorDepth;
        });
    } else if (resolvedBaseOutputLayer) {
        const baseExtraHeight = bezelSpec.enabled ? bezelSpec.extraHeightMm : 0;
        const baseThickness = resolvedBaseOutputLayer.thickness;
        finalizedOutputLayers.forEach((layer) => {
            if (layer.outputLayerId === resolvedBaseOutputLayer.outputLayerId) {
                layer.isBase = true;
                layer.zStart = 0;
                layer.zEnd = baseThickness + baseExtraHeight;
            } else {
                layer.isBase = false;
                layer.zStart = baseThickness;
                layer.zEnd = baseThickness + layer.thickness;
            }
        });
    } else {
        let cursor = 0;
        finalizedOutputLayers.forEach((layer) => {
            layer.isBase = false;
            layer.zStart = cursor;
            layer.zEnd = cursor + layer.thickness;
            cursor = layer.zEnd;
            layer.geometrySegments = layer.printMask && layer.printMaskSpace
                ? [{
                    maskData: layer.printMask,
                    maskSpace: layer.printMaskSpace,
                    zStart: layer.zStart,
                    depth: layer.thickness,
                    simplifyTolerance: getMaskLoopSimplifyTolerance(normalizedDecimatePercent, maskSpace.pixelsPerUnit, {
                        baseTolerancePx: 0,
                        maxExtraTolerancePx: 3,
                        minimumTolerancePx: 1.5
                    })
                }]
                : [{
                    shapes: layer.shapes,
                    offsetX: layer.shapeOffsetX || 0,
                    offsetY: layer.shapeOffsetY || 0,
                    zStart: layer.zStart,
                    depth: layer.thickness
                }];
        });
    }

    const totalHeight = finalizedOutputLayers.reduce((maxHeight, layer) => Math.max(maxHeight, layer.zEnd), 0);
    const aggregateComponentStats = finalizedOutputLayers.reduce((summary, layer) => ({
        originalCount: summary.originalCount + (layer.componentStats?.originalCount || 0),
        printableCount: summary.printableCount + (layer.componentStats?.printableCount || 0),
        absorbedCount: summary.absorbedCount + (layer.componentStats?.absorbedCount || 0)
    }), {
        originalCount: 0,
        printableCount: 0,
        absorbedCount: 0
    });

    const pauseEvents = magnetPocketResult.enabled
        && magnetPocketResult.valid
        && magnetPocketResult.config.mode === 'hidden'
        ? [{
            type: 'pause',
            z: magnetPocketResult.pauseZ,
            message: magnetPocketResult.message,
            gcode: 'M400 U1'
        }]
        : [];
    const magnetWarnings = magnetPocketResult.enabled
        ? magnetPocketResult.errors.map((message) => ({ type: 'magnet-pocket', message }))
        : [];

    return {
        outputLayers: finalizedOutputLayers,
        visibleSourceLayerIds: sourceLayerIds,
        thicknessById,
        requestedAmsPrintStyle,
        amsPrintStyle: appliedAmsPrintStyle,
        faceDownOnBed: appliedAmsPrintStyle === 'face-down',
        baseThickness: resolvedBaseOutputLayer?.thickness || null,
        colorLayerDepth: appliedAmsPrintStyle === 'face-down'
            ? finalizedOutputLayers.find((layer) => !layer.isBase)?.thickness || 0
            : null,
        useBaseLayer: !!(state.useBaseLayer || normalizedMagnetPocket.enabled),
        baseSourceLayerId: state.baseSourceLayerId,
        detectedBaseSourceLayerId: detectedBaseOutputLayer?.primarySourceLayerId ?? null,
        resolvedBaseOutputLayerId: resolvedBaseOutputLayer?.outputLayerId ?? null,
        rawBounds: normalizedBounds,
        totalHeight,
        maxHeight: totalHeight,
        curveSegments: getCurveSegmentsForDecimation(normalizedDecimatePercent),
        decimatePercent: normalizedDecimatePercent,
        normalization: {
            shiftX: -normalizedBounds.centerX,
            shiftY: -normalizedBounds.centerY,
            shiftZ: 0
        },
        scalePlan,
        printProfile,
        bezelPreset: clampBezelPreset(bezelPreset),
        bezelSpec,
        repairSummary,
        componentStats: aggregateComponentStats,
        layerManifest,
        magnetPocketResult,
        pauseEvents,
        warnings: [...magnetWarnings, ...printStyleWarnings]
    };
}

function createLayerGeometry({ layer, plan, THREERef }) {
    const geometries = [];

    const segments = Array.isArray(layer.geometrySegments) && layer.geometrySegments.length
        ? layer.geometrySegments
        : [{
            shapes: layer.shapes,
            offsetX: layer.shapeOffsetX || 0,
            offsetY: layer.shapeOffsetY || 0,
            zStart: layer.zStart,
            depth: layer.thickness
        }];

    segments.forEach((segment) => {
        if (segment.maskData instanceof Uint8Array && segment.maskSpace) {
            const maskGeometries = buildMaskExtrusionGeometries({
                maskSpace: segment.maskSpace,
                maskData: segment.maskData,
                zStart: Number.isFinite(segment.zStart) ? segment.zStart : layer.zStart,
                depth: segment.depth,
                plan,
                THREERef,
                simplifyTolerance: segment.simplifyTolerance
            });
            if (Array.isArray(maskGeometries) && maskGeometries.length) {
                geometries.push(...maskGeometries);
            }
            return;
        }

        const depth = Math.max(0.01, Number.isFinite(segment.depth) ? segment.depth : layer.thickness);
        const offsetX = segment.offsetX || 0;
        const offsetY = segment.offsetY || 0;
        const zStart = Number.isFinite(segment.zStart) ? segment.zStart : layer.zStart;

        separateShapePinchPoints(segment.shapes, plan.curveSegments, THREERef).forEach((shape) => {
            const geometry = new THREERef.ExtrudeGeometry(shape, {
                depth,
                curveSegments: plan.curveSegments,
                bevelEnabled: false
            });
            applyCanonicalRawExtrudeTransform(geometry, plan, {
                offsetX,
                offsetY,
                zStart,
                depth
            });
            geometry.computeVertexNormals();
            geometries.push(geometry);
        });
    });

    return geometries;
}

function getTriangleArea3D(vA, vB, vC, THREERef) {
    const edgeA = new THREERef.Vector3().subVectors(vB, vA);
    const edgeB = new THREERef.Vector3().subVectors(vC, vA);
    return new THREERef.Vector3().crossVectors(edgeA, edgeB).length() * 0.5;
}

function concatenateGeometries(geometries, THREERef) {
    if (!Array.isArray(geometries) || geometries.length === 0 || !THREERef) return null;
    if (geometries.length === 1) return geometries[0];

    const positions = [];
    geometries.forEach((geometry) => {
        if (!geometry) return;
        const working = geometry.index ? geometry.toNonIndexed() : geometry;
        const attribute = working.getAttribute('position');
        if (!attribute) {
            if (working !== geometry) working.dispose();
            return;
        }
        for (let index = 0; index < attribute.count; index++) {
            positions.push(
                attribute.getX(index),
                attribute.getY(index),
                attribute.getZ(index)
            );
        }
        if (working !== geometry) working.dispose();
    });

    if (!positions.length) return null;

    const merged = new THREERef.BufferGeometry();
    merged.setAttribute('position', new THREERef.Float32BufferAttribute(positions, 3));
    merged.computeVertexNormals();
    return merged;
}

const REPAIR_POSITION_EPSILON = 1e-5;

function getRepairVertexKey(vertex) {
    return [vertex.x, vertex.y, vertex.z]
        .map((value) => Math.round(value / REPAIR_POSITION_EPSILON))
        .join(',');
}

function getRepairEdgeKey(start, end) {
    const startKey = getRepairVertexKey(start);
    const endKey = getRepairVertexKey(end);
    return startKey < endKey
        ? `${startKey}|${endKey}`
        : `${endKey}|${startKey}`;
}

function repairCollinearBoundaryTJunctions(positions) {
    if (!Array.isArray(positions) || positions.length < 9) return positions;

    let workingPositions = positions.slice();

    for (let pass = 0; pass < 4; pass++) {
        const triangles = [];
        const vertexByKey = new Map();
        const edgeMap = new Map();

        for (let offset = 0; offset < workingPositions.length; offset += 9) {
            const triangle = [
                { x: workingPositions[offset], y: workingPositions[offset + 1], z: workingPositions[offset + 2] },
                { x: workingPositions[offset + 3], y: workingPositions[offset + 4], z: workingPositions[offset + 5] },
                { x: workingPositions[offset + 6], y: workingPositions[offset + 7], z: workingPositions[offset + 8] }
            ];
            const triangleIndex = triangles.length;
            triangles.push(triangle);

            for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
                const start = triangle[edgeIndex];
                const end = triangle[(edgeIndex + 1) % 3];
                const startKey = getRepairVertexKey(start);
                const endKey = getRepairVertexKey(end);
                const edgeKey = getRepairEdgeKey(start, end);
                vertexByKey.set(startKey, start);
                vertexByKey.set(endKey, end);

                const entry = edgeMap.get(edgeKey) || {
                    count: 0,
                    triangleIndex,
                    edgeIndex,
                    start,
                    end
                };
                entry.count += 1;
                edgeMap.set(edgeKey, entry);
            }
        }

        const boundaryEdges = [...edgeMap.values()].filter((edge) => edge.count % 2 === 1);
        if (!boundaryEdges.length) return workingPositions;

        const boundaryVertexKeys = new Set();
        boundaryEdges.forEach((edge) => {
            boundaryVertexKeys.add(getRepairVertexKey(edge.start));
            boundaryVertexKeys.add(getRepairVertexKey(edge.end));
        });

        const splitByTriangle = new Map();
        boundaryEdges.forEach((edge) => {
            if (splitByTriangle.has(edge.triangleIndex)) return;

            const dx = edge.end.x - edge.start.x;
            const dy = edge.end.y - edge.start.y;
            const dz = edge.end.z - edge.start.z;
            const lengthSquared = (dx * dx) + (dy * dy) + (dz * dz);
            if (lengthSquared <= 1e-12) return;

            const intermediate = [];
            boundaryVertexKeys.forEach((vertexKey) => {
                const vertex = vertexByKey.get(vertexKey);
                if (!vertex) return;

                const offsetX = vertex.x - edge.start.x;
                const offsetY = vertex.y - edge.start.y;
                const offsetZ = vertex.z - edge.start.z;
                const t = ((offsetX * dx) + (offsetY * dy) + (offsetZ * dz)) / lengthSquared;
                if (t <= 1e-6 || t >= 1 - 1e-6) return;

                const projected = {
                    x: edge.start.x + (dx * t),
                    y: edge.start.y + (dy * t),
                    z: edge.start.z + (dz * t)
                };
                const distance = Math.hypot(
                    vertex.x - projected.x,
                    vertex.y - projected.y,
                    vertex.z - projected.z
                );
                if (distance <= 1e-4) {
                    intermediate.push({ vertex, t });
                }
            });

            if (!intermediate.length) return;
            intermediate.sort((left, right) => left.t - right.t);
            const chain = [
                edge.start,
                ...intermediate.map((item) => item.vertex),
                edge.end
            ];
            const chainIsOpenBoundary = chain.slice(0, -1).every((point, index) => {
                return (edgeMap.get(getRepairEdgeKey(point, chain[index + 1]))?.count || 0) % 2 === 1;
            });
            if (!chainIsOpenBoundary) return;

            splitByTriangle.set(edge.triangleIndex, {
                edgeIndex: edge.edgeIndex,
                chain
            });
        });

        if (!splitByTriangle.size) return workingPositions;

        const repairedPositions = [];
        triangles.forEach((triangle, triangleIndex) => {
            const split = splitByTriangle.get(triangleIndex);
            if (!split) {
                appendTriangle(repairedPositions, triangle[0], triangle[1], triangle[2]);
                return;
            }

            const opposite = triangle[(split.edgeIndex + 2) % 3];
            split.chain.slice(0, -1).forEach((point, index) => {
                appendTriangle(repairedPositions, point, split.chain[index + 1], opposite);
            });
        });
        workingPositions = repairedPositions;
    }

    return workingPositions;
}

function getRepairLoopArea(loop) {
    let area = 0;
    for (let index = 0; index < loop.length; index++) {
        const current = loop[index];
        const next = loop[(index + 1) % loop.length];
        area += (current.x * next.y) - (next.x * current.y);
    }
    return area * 0.5;
}

function isPointInsideRepairLoop(point, loop) {
    let inside = false;
    for (let currentIndex = 0, previousIndex = loop.length - 1;
        currentIndex < loop.length;
        previousIndex = currentIndex++) {
        const current = loop[currentIndex];
        const previous = loop[previousIndex];
        const crossesRay = (current.y > point.y) !== (previous.y > point.y);
        if (!crossesRay) continue;
        const intersectionX = previous.x
            + ((point.y - previous.y) * (current.x - previous.x))
            / (current.y - previous.y);
        if (point.x < intersectionX) inside = !inside;
    }
    return inside;
}

function orderRepairBoundaryLoops(edges, vertexByKey) {
    const adjacency = new Map();
    edges.forEach((edge) => {
        const addNeighbor = (from, to) => {
            const neighbors = adjacency.get(from) || new Set();
            neighbors.add(to);
            adjacency.set(from, neighbors);
        };
        addNeighbor(edge.startKey, edge.endKey);
        addNeighbor(edge.endKey, edge.startKey);
    });

    const remaining = new Set(adjacency.keys());
    const loops = [];
    while (remaining.size) {
        const [seedKey] = remaining;
        const componentKeys = [];
        const queue = [seedKey];
        remaining.delete(seedKey);
        while (queue.length) {
            const currentKey = queue.shift();
            componentKeys.push(currentKey);
            (adjacency.get(currentKey) || []).forEach((neighborKey) => {
                if (!remaining.has(neighborKey)) return;
                remaining.delete(neighborKey);
                queue.push(neighborKey);
            });
        }

        if (componentKeys.length < 3 || componentKeys.some((key) => adjacency.get(key)?.size !== 2)) {
            continue;
        }

        const componentSet = new Set(componentKeys);
        const componentEdgeCount = edges.filter((edge) => (
            componentSet.has(edge.startKey) && componentSet.has(edge.endKey)
        )).length;
        if (componentEdgeCount !== componentKeys.length) continue;

        const loopKeys = [];
        let previousKey = null;
        let currentKey = seedKey;
        let valid = true;
        do {
            if (loopKeys.includes(currentKey)) {
                valid = false;
                break;
            }
            loopKeys.push(currentKey);
            const neighbors = [...(adjacency.get(currentKey) || [])];
            const nextKey = previousKey === null
                ? neighbors[0]
                : neighbors.find((neighborKey) => neighborKey !== previousKey);
            if (!nextKey) {
                valid = false;
                break;
            }
            previousKey = currentKey;
            currentKey = nextKey;
        } while (currentKey !== seedKey && loopKeys.length <= componentKeys.length);

        if (!valid || currentKey !== seedKey || loopKeys.length !== componentKeys.length) continue;
        const loop = loopKeys.map((key) => vertexByKey.get(key)).filter(Boolean);
        if (loop.length === loopKeys.length && Math.abs(getRepairLoopArea(loop)) > 1e-10) {
            loops.push(loop);
        }
    }
    return loops;
}

function appendCapRegionTriangles(positions, outerLoop, holeLoops, z, THREERef, orientation) {
    const orientLoop = (loop, clockwise) => {
        const oriented = loop.slice();
        const isClockwise = getRepairLoopArea(oriented) < 0;
        if (isClockwise !== clockwise) oriented.reverse();
        return oriented;
    };
    const contourPoints = orientLoop(outerLoop, true);
    const holePoints = holeLoops.map((loop) => orientLoop(loop, false));
    const contour = contourPoints.map((point) => new THREERef.Vector2(point.x, point.y));
    const holes = holePoints.map((loop) => (
        loop.map((point) => new THREERef.Vector2(point.x, point.y))
    ));
    const vertices = contourPoints.concat(...holePoints);
    const faces = THREERef.ShapeUtils.triangulateShape(contour, holes);

    faces.forEach(([a, b, c]) => {
        const vA = vertices[a];
        const vB = vertices[b];
        const vC = vertices[c];
        if (!vA || !vB || !vC) return;
        const crossZ = ((vB.x - vA.x) * (vC.y - vA.y))
            - ((vB.y - vA.y) * (vC.x - vA.x));
        if (crossZ * crossZ <= 1e-16) return;

        const shouldReverse = orientation === 'up' ? crossZ < 0 : crossZ > 0;
        appendTriangle(
            positions,
            { x: vA.x, y: vA.y, z },
            { x: shouldReverse ? vC.x : vB.x, y: shouldReverse ? vC.y : vB.y, z },
            { x: shouldReverse ? vB.x : vC.x, y: shouldReverse ? vB.y : vC.y, z }
        );
    });
}

function getRepairTopologyStats(positions) {
    const edgeCounts = new Map();
    const triangleCounts = new Map();
    for (let offset = 0; offset + 8 < positions.length; offset += 9) {
        const vertices = [
            { x: positions[offset], y: positions[offset + 1], z: positions[offset + 2] },
            { x: positions[offset + 3], y: positions[offset + 4], z: positions[offset + 5] },
            { x: positions[offset + 6], y: positions[offset + 7], z: positions[offset + 8] }
        ];
        const vertexKeys = vertices.map(getRepairVertexKey);
        const triangleKey = vertexKeys.slice().sort().join('|');
        triangleCounts.set(triangleKey, (triangleCounts.get(triangleKey) || 0) + 1);
        for (let edgeIndex = 0; edgeIndex < 3; edgeIndex++) {
            const edgeKey = getRepairEdgeKey(vertices[edgeIndex], vertices[(edgeIndex + 1) % 3]);
            edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) || 0) + 1);
        }
    }
    return {
        boundaryEdgeCount: [...edgeCounts.values()].filter((count) => count === 1).length,
        nonManifoldEdgeCount: [...edgeCounts.values()].filter((count) => count > 2).length,
        duplicateTriangleCount: [...triangleCounts.values()].reduce(
            (total, count) => total + Math.max(0, count - 1),
            0
        )
    };
}

function repairPlanarCapHoles(positions, THREERef) {
    if (!Array.isArray(positions) || positions.length < 9 || !THREERef?.ShapeUtils) return positions;

    const vertexByKey = new Map();
    const edgeMap = new Map();
    let minZ = Infinity;
    let maxZ = -Infinity;

    const makeVertex = (offset) => ({
        x: positions[offset],
        y: positions[offset + 1],
        z: positions[offset + 2]
    });

    const recordEdge = (start, end) => {
        const startKey = getRepairVertexKey(start);
        const endKey = getRepairVertexKey(end);
        vertexByKey.set(startKey, start);
        vertexByKey.set(endKey, end);

        const edgeKey = startKey < endKey ? `${startKey}|${endKey}` : `${endKey}|${startKey}`;
        const entry = edgeMap.get(edgeKey) || {
            count: 0,
            startKey,
            endKey,
            start,
            end
        };
        entry.count += 1;
        edgeMap.set(edgeKey, entry);
    };

    for (let index = 0; index < positions.length; index += 9) {
        const vA = makeVertex(index);
        const vB = makeVertex(index + 3);
        const vC = makeVertex(index + 6);
        minZ = Math.min(minZ, vA.z, vB.z, vC.z);
        maxZ = Math.max(maxZ, vA.z, vB.z, vC.z);
        recordEdge(vA, vB);
        recordEdge(vB, vC);
        recordEdge(vC, vA);
    }

    const planarOpenEdges = [...edgeMap.values()].filter((edge) => {
        if (edge.count !== 1 || Math.abs(edge.start.z - edge.end.z) > REPAIR_POSITION_EPSILON) {
            return false;
        }
        const z = (edge.start.z + edge.end.z) / 2;
        return Math.abs(z - minZ) <= REPAIR_POSITION_EPSILON
            || Math.abs(z - maxZ) <= REPAIR_POSITION_EPSILON;
    });
    if (!planarOpenEdges.length) return positions;

    const groups = new Map();
    planarOpenEdges.forEach((edge) => {
        const z = (edge.start.z + edge.end.z) / 2;
        const key = Math.round(z / REPAIR_POSITION_EPSILON);
        const bucket = groups.get(key) || [];
        bucket.push(edge);
        groups.set(key, bucket);
    });

    const repairedPositions = positions.slice();
    groups.forEach((edges, zKey) => {
        const loops = orderRepairBoundaryLoops(edges, vertexByKey);
        const records = loops.map((loop) => ({
            loop,
            area: Math.abs(getRepairLoopArea(loop)),
            parent: null,
            depth: 0
        }));

        records.forEach((record) => {
            const testPoint = record.loop[0];
            record.parent = records
                .filter((candidate) => (
                    candidate !== record
                    && candidate.area > record.area
                    && isPointInsideRepairLoop(testPoint, candidate.loop)
                ))
                .sort((left, right) => left.area - right.area)[0] || null;
        });
        records.forEach((record) => {
            let parent = record.parent;
            const visited = new Set();
            while (parent && !visited.has(parent)) {
                visited.add(parent);
                record.depth += 1;
                parent = parent.parent;
            }
        });

        const z = Number(zKey) * REPAIR_POSITION_EPSILON;
        const orientation = Math.abs(z - maxZ) <= REPAIR_POSITION_EPSILON ? 'up' : 'down';
        records.filter((record) => record.depth % 2 === 0).forEach((outer) => {
            const holes = records
                .filter((record) => record.parent === outer && record.depth % 2 === 1)
                .map((record) => record.loop);
            appendCapRegionTriangles(
                repairedPositions,
                outer.loop,
                holes,
                z,
                THREERef,
                orientation
            );
        });
    });

    const beforeStats = getRepairTopologyStats(positions);
    const afterStats = getRepairTopologyStats(repairedPositions);
    const improved = afterStats.boundaryEdgeCount < beforeStats.boundaryEdgeCount
        && afterStats.nonManifoldEdgeCount <= beforeStats.nonManifoldEdgeCount
        && afterStats.duplicateTriangleCount <= beforeStats.duplicateTriangleCount;
    return improved ? repairedPositions : positions;
}

function sanitizeGeometry(geometry, THREERef, bufferUtils, { mergeVerticesEnabled = true } = {}) {
    if (!geometry || !THREERef) return null;

    const working = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    const positions = working.getAttribute('position');
    if (!positions || positions.count < 3) {
        working.dispose();
        return null;
    }

    const filteredPositions = [];
    const vA = new THREERef.Vector3();
    const vB = new THREERef.Vector3();
    const vC = new THREERef.Vector3();

    for (let index = 0; index < positions.count; index += 3) {
        vA.fromBufferAttribute(positions, index);
        vB.fromBufferAttribute(positions, index + 1);
        vC.fromBufferAttribute(positions, index + 2);
        if (getTriangleArea3D(vA, vB, vC, THREERef) <= 1e-18) continue;

        filteredPositions.push(
            vA.x, vA.y, vA.z,
            vB.x, vB.y, vB.z,
            vC.x, vC.y, vC.z
        );
    }

    working.dispose();
    if (!filteredPositions.length) return null;

    const topologyRepairedPositions = repairCollinearBoundaryTJunctions(filteredPositions);
    const repairedPositions = repairPlanarCapHoles(topologyRepairedPositions, THREERef);

    let sanitized = new THREERef.BufferGeometry();
    sanitized.setAttribute('position', new THREERef.Float32BufferAttribute(repairedPositions, 3));
    if (mergeVerticesEnabled && bufferUtils?.mergeVertices) {
        const merged = bufferUtils.mergeVertices(sanitized, 1e-5);
        if (merged !== sanitized) sanitized.dispose();
        sanitized = merged;

        // Vertex welding can expose tiny planar gaps that were not visible while
        // the source geometries still used separate, nearly-identical vertices.
        // Re-run the cap repair against the welded coordinates so stacked bezel
        // segments remain watertight in the exported STL.
        const weldedTriangles = sanitized.index ? sanitized.toNonIndexed() : sanitized.clone();
        const weldedPositions = weldedTriangles.getAttribute('position');
        const weldedPositionValues = weldedPositions
            ? Array.from(weldedPositions.array)
            : [];
        weldedTriangles.dispose();

        const topologySealedPositionValues = repairCollinearBoundaryTJunctions(weldedPositionValues);
        const sealedPositionValues = repairPlanarCapHoles(topologySealedPositionValues, THREERef);
        if (sealedPositionValues.length > weldedPositionValues.length) {
            const sealedGeometry = new THREERef.BufferGeometry();
            sealedGeometry.setAttribute(
                'position',
                new THREERef.Float32BufferAttribute(sealedPositionValues, 3)
            );
            const mergedSealedGeometry = bufferUtils.mergeVertices(sealedGeometry, 1e-5);
            if (mergedSealedGeometry !== sealedGeometry) sealedGeometry.dispose();
            sanitized.dispose();
            sanitized = mergedSealedGeometry;
        }
    }
    // Cap triangulation and vertex welding may collapse a very short edge after
    // the first pass. Remove those zero-area faces at the final precision used
    // by print validation so text glyphs cannot poison an otherwise closed mesh.
    const finalTriangles = sanitized.index ? sanitized.toNonIndexed() : sanitized.clone();
    const finalPositions = finalTriangles.getAttribute('position');
    const cleanPositions = [];
    if (finalPositions) {
        for (let index = 0; index + 2 < finalPositions.count; index += 3) {
            vA.fromBufferAttribute(finalPositions, index);
            vB.fromBufferAttribute(finalPositions, index + 1);
            vC.fromBufferAttribute(finalPositions, index + 2);
            const abX = vB.x - vA.x;
            const abY = vB.y - vA.y;
            const abZ = vB.z - vA.z;
            const acX = vC.x - vA.x;
            const acY = vC.y - vA.y;
            const acZ = vC.z - vA.z;
            const crossX = abY * acZ - abZ * acY;
            const crossY = abZ * acX - abX * acZ;
            const crossZ = abX * acY - abY * acX;
            const areaSquared = crossX * crossX + crossY * crossY + crossZ * crossZ;
            if (areaSquared <= 1e-16) continue;
            cleanPositions.push(
                vA.x, vA.y, vA.z,
                vB.x, vB.y, vB.z,
                vC.x, vC.y, vC.z
            );
        }
    }
    finalTriangles.dispose();

    if (!cleanPositions.length) {
        sanitized.dispose();
        return null;
    }
    const resealedPositions = repairPlanarCapHoles(
        repairCollinearBoundaryTJunctions(cleanPositions),
        THREERef
    );
    const cleanedGeometry = new THREERef.BufferGeometry();
    cleanedGeometry.setAttribute('position', new THREERef.Float32BufferAttribute(resealedPositions, 3));
    const mergedCleanedGeometry = mergeVerticesEnabled && bufferUtils?.mergeVertices
        ? bufferUtils.mergeVertices(cleanedGeometry, 1e-5)
        : cleanedGeometry;
    if (mergedCleanedGeometry !== cleanedGeometry) cleanedGeometry.dispose();
    sanitized.dispose();
    sanitized = mergedCleanedGeometry;

    // The last vertex weld can collapse an extremely short edge and create a
    // degenerate indexed face. Filter once more without welding afterward;
    // otherwise the same final operation can recreate the triangles we just
    // removed. The 3MF serializer restores shared indices with the same 1e-5
    // seam tolerance used by print validation.
    const validationTriangles = sanitized.index ? sanitized.toNonIndexed() : sanitized.clone();
    const validationPositions = validationTriangles.getAttribute('position');
    const validationCleanPositions = [];
    let removedValidationTriangles = 0;
    if (validationPositions) {
        for (let index = 0; index + 2 < validationPositions.count; index += 3) {
            vA.fromBufferAttribute(validationPositions, index);
            vB.fromBufferAttribute(validationPositions, index + 1);
            vC.fromBufferAttribute(validationPositions, index + 2);
            const abX = vB.x - vA.x;
            const abY = vB.y - vA.y;
            const abZ = vB.z - vA.z;
            const acX = vC.x - vA.x;
            const acY = vC.y - vA.y;
            const acZ = vC.z - vA.z;
            const crossX = abY * acZ - abZ * acY;
            const crossY = abZ * acX - abX * acZ;
            const crossZ = abX * acY - abY * acX;
            const areaSquared = crossX * crossX + crossY * crossY + crossZ * crossZ;
            if (areaSquared <= 1e-16) {
                removedValidationTriangles += 1;
                continue;
            }
            validationCleanPositions.push(
                vA.x, vA.y, vA.z,
                vB.x, vB.y, vB.z,
                vC.x, vC.y, vC.z
            );
        }
    }
    validationTriangles.dispose();

    if (removedValidationTriangles > 0) {
        if (!validationCleanPositions.length) {
            sanitized.dispose();
            return null;
        }
        const validationRepairedPositions = repairPlanarCapHoles(
            repairCollinearBoundaryTJunctions(validationCleanPositions),
            THREERef
        );
        const finalValidationPositions = [];
        for (let index = 0; index + 2 < validationRepairedPositions.length / 3; index += 3) {
            vA.fromArray(validationRepairedPositions, index * 3);
            vB.fromArray(validationRepairedPositions, (index + 1) * 3);
            vC.fromArray(validationRepairedPositions, (index + 2) * 3);
            const abX = vB.x - vA.x;
            const abY = vB.y - vA.y;
            const abZ = vB.z - vA.z;
            const acX = vC.x - vA.x;
            const acY = vC.y - vA.y;
            const acZ = vC.z - vA.z;
            const crossX = abY * acZ - abZ * acY;
            const crossY = abZ * acX - abX * acZ;
            const crossZ = abX * acY - abY * acX;
            if (crossX * crossX + crossY * crossY + crossZ * crossZ <= 1e-16) continue;
            finalValidationPositions.push(
                vA.x, vA.y, vA.z,
                vB.x, vB.y, vB.z,
                vC.x, vC.y, vC.z
            );
        }
        if (!finalValidationPositions.length) {
            sanitized.dispose();
            return null;
        }
        const validationCleanGeometry = new THREERef.BufferGeometry();
        validationCleanGeometry.setAttribute(
            'position',
            new THREERef.Float32BufferAttribute(finalValidationPositions, 3)
        );
        sanitized.dispose();
        sanitized = validationCleanGeometry;
    }

    sanitized.computeVertexNormals();
    return sanitized;
}

export function sanitizeGeometryForPrint(geometry, THREERef, bufferUtils) {
    return sanitizeGeometry(geometry, THREERef, bufferUtils, {
        mergeVerticesEnabled: true
    });
}

export function buildObjGeometryBundle(plan, { THREERef, bufferUtils }) {
    if (!plan || !THREERef) return null;

    const layers = new Map();
    const orderedOutputLayers = [
        ...plan.outputLayers.filter((layer) => layer.isBase),
        ...plan.outputLayers.filter((layer) => !layer.isBase)
    ];

    orderedOutputLayers.forEach((layer) => {
        const geometries = createLayerGeometry({ layer, plan, THREERef });
        if (!geometries.length) {
            return;
        }
        const hasMultipleSegments = Array.isArray(layer.geometrySegments) && layer.geometrySegments.length > 1;
        const geometryParts = hasMultipleSegments
            ? geometries
                .map((sourceGeometry) => sanitizeGeometry(sourceGeometry.clone(), THREERef, bufferUtils, {
                    mergeVerticesEnabled: true
                }))
                .filter(Boolean)
            : [];

        let geometry = null;
        if (geometries.length === 1) {
            geometry = geometries[0];
        } else {
            geometry = concatenateGeometries(geometries, THREERef);
            geometries.forEach((sourceGeometry) => {
                if (sourceGeometry !== geometry) sourceGeometry.dispose();
            });
        }

        const preSanitizeVertexCount = geometry?.getAttribute?.('position')?.count || 0;
        const sanitizedGeometry = sanitizeGeometry(geometry, THREERef, bufferUtils, {
            mergeVerticesEnabled: true
        });
        if (!sanitizedGeometry) {
            geometry?.dispose?.();
            geometryParts.forEach((partGeometry) => partGeometry.dispose());
            return;
        }
        if (sanitizedGeometry !== geometry) geometry.dispose();
        sanitizedGeometry.computeVertexNormals();

        const color = layer.color || { r: 0, g: 0, b: 0 };
        const hex = ((Math.max(0, Math.min(255, color.r ?? 0)) << 16)
            | (Math.max(0, Math.min(255, color.g ?? 0)) << 8)
            | Math.max(0, Math.min(255, color.b ?? 0)))
            .toString(16)
            .padStart(6, '0');

        layers.set(layer.outputLayerId, {
            geometry: sanitizedGeometry,
            color,
            hex,
            thickness: layer.thickness,
            zStart: layer.zStart,
            zEnd: layer.zEnd,
            sourceLayerIds: layer.sourceLayerIds.slice(),
            primarySourceLayerId: layer.primarySourceLayerId,
            isBase: layer.isBase,
            displayLabel: layer.displayLabel,
            repairActions: Array.isArray(layer.repairActions) ? layer.repairActions.slice() : [],
            componentStats: { ...(layer.componentStats || {}) },
            geometryParts
        });
    });

    return {
        layers,
        plan
    };
}
