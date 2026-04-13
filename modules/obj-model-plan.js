import { resolveMergedLayerGroups } from './shared/trace-utils.js';
import { buildShapesFromTracedataLayers, buildWeldedShapeSet } from './shared/silhouette-builder.js';
import { computeObjScalePlan } from './obj-scale.js';
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
} from './shared/print-geometry.js';

const DEFAULT_CURVE_SEGMENTS = 6;
const BOUNDS_POINT_DIVISIONS = 16;
const TRIANGULATION_POINT_DIVISIONS = 12;
const MIN_SIMPLIFIED_POINT_DIVISIONS = 2;

function clampThickness(value, defaultThickness) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    const fallback = Number.isFinite(defaultThickness) ? defaultThickness : 4;
    return Math.max(0.1, Math.min(20, Number.isFinite(numeric) ? numeric : fallback));
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
    const next = (state.layerThicknessById && typeof state.layerThicknessById === 'object')
        ? { ...state.layerThicknessById }
        : {};
    const legacy = Array.isArray(state.layerThicknesses) ? state.layerThicknesses : null;

    sourceLayerIds.forEach((sourceLayerId) => {
        const legacyValue = legacy && legacy[sourceLayerId] !== undefined
            ? legacy[sourceLayerId]
            : undefined;
        next[sourceLayerId] = clampThickness(
            next[sourceLayerId] !== undefined ? next[sourceLayerId] : legacyValue,
            defaultThickness
        );
    });

    state.layerThicknessById = next;
    state.layerThicknesses = null;
    return next;
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

function appendQuad(positions, a, b, c, d) {
    positions.push(
        a.x, a.y, a.z,
        b.x, b.y, b.z,
        c.x, c.y, c.z,
        a.x, a.y, a.z,
        c.x, c.y, c.z,
        d.x, d.y, d.z
    );
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
            const collinear = (
                (Math.abs(previous.x - current.x) < 1e-9 && Math.abs(current.x - next.x) < 1e-9)
                || (Math.abs(previous.y - current.y) < 1e-9 && Math.abs(current.y - next.y) < 1e-9)
            );
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
    return cleaned.length >= 4 ? cleaned : points.slice();
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
    const contourTolerance = Number.isFinite(simplifyTolerance) && simplifyTolerance > 0
        ? simplifyTolerance
        : (0.75 / pixelsPerUnit);
    const loops = extractMaskLoops(maskSpace, maskData).map((loop) => {
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

    if (!loops.length) return null;

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

        const faces = THREERef.ShapeUtils.triangulateShape(
            contour.map((point) => new THREERef.Vector2(point.x, point.y)),
            holes.map((ring) => ring.map((point) => new THREERef.Vector2(point.x, point.y)))
        );
        if (!faces.length) return;

        const vertices = contour.concat(...holes);
        const zBottom = zOffset;
        const zTop = zOffset + extrusionDepth;
        const positions = [];

        faces.forEach(([a, b, c]) => {
            const vA = vertices[a];
            const vB = vertices[b];
            const vC = vertices[c];
            if (!vA || !vB || !vC) return;

            appendTriangle(positions,
                { x: vA.x, y: vA.y, z: zTop },
                { x: vB.x, y: vB.y, z: zTop },
                { x: vC.x, y: vC.y, z: zTop }
            );
            appendTriangle(positions,
                { x: vC.x, y: vC.y, z: zBottom },
                { x: vB.x, y: vB.y, z: zBottom },
                { x: vA.x, y: vA.y, z: zBottom }
            );
        });

        [contour, ...holes].forEach((ring) => {
            for (let index = 0; index < ring.length; index++) {
                const current = ring[index];
                const next = ring[(index + 1) % ring.length];
                if (!current || !next) continue;
                if (Math.abs(current.x - next.x) < 1e-9 && Math.abs(current.y - next.y) < 1e-9) continue;

                appendQuad(positions,
                    { x: current.x, y: current.y, z: zBottom },
                    { x: next.x, y: next.y, z: zBottom },
                    { x: next.x, y: next.y, z: zTop },
                    { x: current.x, y: current.y, z: zTop }
                );
            }
        });

        if (!positions.length) return;

        const geometry = new THREERef.BufferGeometry();
        geometry.setAttribute('position', new THREERef.Float32BufferAttribute(positions, 3));
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
    bezelPreset = state?.objParams?.bezelPreset ?? 'off'
}) {
    if (!state?.tracedata || !tracer || !SVGLoader || !THREERef) return null;
    if (!Array.isArray(visibleSourceLayerIds) || visibleSourceLayerIds.length === 0) return null;

    const sourceLayerIds = visibleSourceLayerIds.slice();
    const thicknessById = ensureLayerThicknessById(state, sourceLayerIds, defaultThickness);
    const outputGroups = resolveMergedLayerGroups(sourceLayerIds, state.mergeRules || []);
    const shapeCache = new Map();
    const rawBounds = createEmptyBounds();
    const normalizedDecimatePercent = clampDecimatePercent(decimatePercent);

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

    if (state.autoBaseLayerSelectionPending && detectedBaseOutputLayer) {
        state.useBaseLayer = true;
        state.baseSourceLayerId = detectedBaseOutputLayer.primarySourceLayerId;
        state.autoBaseLayerSelectionPending = false;
    }

    migrateLegacyBaseSourceLayerId(state, outputLayers, detectedBaseOutputLayer);

    let resolvedBaseOutputLayer = null;
    if (state.useBaseLayer && outputLayers.length > 0) {
        resolvedBaseOutputLayer = outputLayers.find((layer) => layer.sourceLayerIds.includes(state.baseSourceLayerId));
        if (!resolvedBaseOutputLayer) {
            resolvedBaseOutputLayer = detectedBaseOutputLayer || outputLayers[0];
            state.baseSourceLayerId = resolvedBaseOutputLayer.primarySourceLayerId;
        }
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

    outputLayers.forEach((layer) => {
        if (resolvedBaseOutputLayer && layer.outputLayerId === resolvedBaseOutputLayer.outputLayerId) {
            layer.isBase = true;
            layer.geometrySegments = layer.shapes?.length
                ? [{
                    shapes: layer.shapes,
                    offsetX: layer.shapeOffsetX || 0,
                    offsetY: layer.shapeOffsetY || 0,
                    zStart: 0,
                    depth: layer.thickness
                }]
                : [{
                    maskData: layer.printMask,
                    maskSpace: layer.printMaskSpace,
                    zStart: 0,
                    depth: layer.thickness,
                    simplifyTolerance: getMaskLoopSimplifyTolerance(normalizedDecimatePercent, maskSpace.pixelsPerUnit, {
                        baseTolerancePx: 0,
                        maxExtraTolerancePx: 1.1
                    })
                }];

            if (bezelSpec.enabled && bezelMaskData && bezelShapeSet?.shapes?.length) {
                layer.geometrySegments.push(
                    bezelShapeSet.shapes.length
                        ? {
                            shapes: bezelShapeSet.shapes,
                            offsetX: bezelShapeSet.offsetX || 0,
                            offsetY: bezelShapeSet.offsetY || 0,
                            zStart: layer.thickness,
                            depth: bezelSpec.extraHeightMm
                        }
                        : {
                            maskData: bezelMaskData,
                            maskSpace,
                            zStart: layer.thickness,
                            depth: bezelSpec.extraHeightMm
                        }
                );
            }

            finalizedOutputLayers.push(layer);
            return;
        }

        const rawLayerMask = rasterizeShapeSetToMask({
            shapes: layer.rawShapeSet?.shapes || [],
            offsetX: layer.rawShapeSet?.offsetX || 0,
            offsetY: layer.rawShapeSet?.offsetY || 0,
            maskSpace
        });
        if (!hasMaskPixels(rawLayerMask)) return;

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
        layer.geometrySegments = layer.shapes?.length
            ? [{
                shapes: layer.shapes,
                offsetX: layer.shapeOffsetX || 0,
                offsetY: layer.shapeOffsetY || 0,
                depth: layer.thickness
            }]
            : [{
                maskData: layer.printMask,
                maskSpace: layer.printMaskSpace,
                depth: layer.thickness,
                simplifyTolerance: getMaskLoopSimplifyTolerance(detailDecimatePercent, maskSpace.pixelsPerUnit, {
                    baseTolerancePx: 0,
                    maxExtraTolerancePx: 0.7
                })
            }];
        finalizedOutputLayers.push(layer);
        repairSummary.preservedDetailLayers += 1;
    });

    if (resolvedBaseOutputLayer) {
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
            layer.geometrySegments = layer.shapes?.length
                ? [{
                    shapes: layer.shapes,
                    offsetX: layer.shapeOffsetX || 0,
                    offsetY: layer.shapeOffsetY || 0,
                    zStart: layer.zStart,
                    depth: layer.thickness
                }]
                : (layer.printMask && layer.printMaskSpace
                    ? [{
                    maskData: layer.printMask,
                    maskSpace: layer.printMaskSpace,
                    zStart: layer.zStart,
                    depth: layer.thickness,
                    simplifyTolerance: getMaskLoopSimplifyTolerance(normalizedDecimatePercent, maskSpace.pixelsPerUnit, {
                        baseTolerancePx: 0,
                        maxExtraTolerancePx: 1.1
                    })
                }]
                    : [{
                    shapes: layer.shapes,
                    offsetX: layer.shapeOffsetX || 0,
                    offsetY: layer.shapeOffsetY || 0,
                    zStart: layer.zStart,
                    depth: layer.thickness
                }]);
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

    return {
        outputLayers: finalizedOutputLayers,
        visibleSourceLayerIds: sourceLayerIds,
        thicknessById,
        useBaseLayer: !!state.useBaseLayer,
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
        warnings: []
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

        (segment.shapes || []).forEach((shape) => {
            const geometry = new THREERef.ExtrudeGeometry(shape, {
                depth,
                curveSegments: plan.curveSegments,
                bevelEnabled: false
            });
            geometry.rotateX(Math.PI);
            geometry.translate(
                plan.normalization.shiftX + offsetX,
                -plan.normalization.shiftY - offsetY,
                depth + zStart + plan.normalization.shiftZ
            );
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

function getRepairVertexKey(vertex) {
    return `${vertex.x.toFixed(5)},${vertex.y.toFixed(5)},${vertex.z.toFixed(5)}`;
}

function appendCapLoopTriangles(positions, loop, z, THREERef, orientation = 'up') {
    if (!Array.isArray(loop) || loop.length < 3) return;

    const contour = loop.map((point) => new THREERef.Vector2(point.x, point.y));
    let faces = [];

    if (contour.length === 3) {
        faces = [[0, 1, 2]];
    } else {
        faces = THREERef.ShapeUtils.triangulateShape(contour, []);
    }

    faces.forEach(([a, b, c]) => {
        const vA = loop[a];
        const vB = loop[b];
        const vC = loop[c];
        if (!vA || !vB || !vC) return;

        if (orientation === 'down') {
            appendTriangle(positions,
                { x: vC.x, y: vC.y, z },
                { x: vB.x, y: vB.y, z },
                { x: vA.x, y: vA.y, z }
            );
            return;
        }

        appendTriangle(positions,
            { x: vA.x, y: vA.y, z },
            { x: vB.x, y: vB.y, z },
            { x: vC.x, y: vC.y, z }
        );
    });
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
        return edge.count === 1 && Math.abs(edge.start.z - edge.end.z) <= 1e-5;
    });
    if (!planarOpenEdges.length) return positions;

    const groups = new Map();
    planarOpenEdges.forEach((edge) => {
        const z = (edge.start.z + edge.end.z) / 2;
        const key = z.toFixed(5);
        const bucket = groups.get(key) || [];
        bucket.push(edge);
        groups.set(key, bucket);
    });

    const repairedPositions = positions.slice();
    const midZ = (minZ + maxZ) / 2;

    groups.forEach((edges, zKey) => {
        const adjacency = new Map();
        edges.forEach((edge) => {
            const addNeighbor = (from, to) => {
                const bucket = adjacency.get(from) || new Set();
                bucket.add(to);
                adjacency.set(from, bucket);
            };
            addNeighbor(edge.startKey, edge.endKey);
            addNeighbor(edge.endKey, edge.startKey);
        });

        const remaining = new Set(adjacency.keys());
        while (remaining.size) {
            const [seedKey] = remaining;
            const queue = [seedKey];
            const componentKeys = [];
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

            const loop = componentKeys
                .map((vertexKey) => vertexByKey.get(vertexKey))
                .filter(Boolean);
            if (loop.length < 3) continue;

            const centroid = loop.reduce((sum, point) => ({
                x: sum.x + point.x,
                y: sum.y + point.y
            }), { x: 0, y: 0 });
            const centerX = centroid.x / loop.length;
            const centerY = centroid.y / loop.length;

            loop.sort((left, right) => (
                Math.atan2(left.y - centerY, left.x - centerX)
                - Math.atan2(right.y - centerY, right.x - centerX)
            ));

            appendCapLoopTriangles(
                repairedPositions,
                loop,
                Number.parseFloat(zKey),
                THREERef,
                Number.parseFloat(zKey) > midZ ? 'up' : 'down'
            );
        }
    });

    return repairedPositions;
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

    const repairedPositions = repairPlanarCapHoles(filteredPositions, THREERef);

    let sanitized = new THREERef.BufferGeometry();
    sanitized.setAttribute('position', new THREERef.Float32BufferAttribute(repairedPositions, 3));
    if (mergeVerticesEnabled && bufferUtils?.mergeVertices) {
        const merged = bufferUtils.mergeVertices(sanitized, 1e-5);
        if (merged !== sanitized) sanitized.dispose();
        sanitized = merged;
    }
    sanitized.computeVertexNormals();
    return sanitized;
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
        if (!geometries.length) return;
        const hasMultipleSegments = Array.isArray(layer.geometrySegments) && layer.geometrySegments.length > 1;

        let geometry = null;
        if (geometries.length === 1) {
            geometry = geometries[0];
        } else {
            geometry = concatenateGeometries(geometries, THREERef);
            geometries.forEach((sourceGeometry) => {
                if (sourceGeometry !== geometry) sourceGeometry.dispose();
            });
        }

        const sanitizedGeometry = sanitizeGeometry(geometry, THREERef, bufferUtils, {
            mergeVerticesEnabled: true
        });
        if (!sanitizedGeometry) {
            geometry.dispose();
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
            componentStats: { ...(layer.componentStats || {}) }
        });
    });

    return {
        layers,
        plan
    };
}
