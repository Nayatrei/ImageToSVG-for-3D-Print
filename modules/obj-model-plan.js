import { resolveMergedLayerGroups } from './shared/trace-utils.js';
import { buildShapesFromTracedataLayers, buildWeldedShapeSet } from './shared/silhouette-builder.js';

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

export function buildObjModelPlan({
    state,
    tracer,
    SVGLoader,
    THREERef,
    defaultThickness,
    visibleSourceLayerIds,
    decimatePercent = 0
}) {
    if (!state?.tracedata || !tracer || !SVGLoader || !THREERef) return null;
    if (!Array.isArray(visibleSourceLayerIds) || visibleSourceLayerIds.length === 0) return null;

    const sourceLayerIds = visibleSourceLayerIds.slice();
    const thicknessById = ensureLayerThicknessById(state, sourceLayerIds, defaultThickness);
    const outputGroups = resolveMergedLayerGroups(sourceLayerIds, state.mergeRules || []);
    const shapeCache = new Map();
    const rawBounds = createEmptyBounds();

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
        const shapes = simplifyShapeSet(weldedShapeSet.shapes, THREERef, decimatePercent);
        const bounds = buildBoundsFromShapes(shapes, weldedShapeSet.offsetX, weldedShapeSet.offsetY);
        return {
            outputLayerId: group.outputLayerId,
            primarySourceLayerId: group.primarySourceLayerId,
            sourceLayerIds: group.sourceLayerIds.slice(),
            color: state.tracedata.palette[group.primarySourceLayerId],
            thickness: clampThickness(thicknessById[group.primarySourceLayerId], defaultThickness),
            rawShapes,
            shapes,
            shapeOffsetX: weldedShapeSet.offsetX || 0,
            shapeOffsetY: weldedShapeSet.offsetY || 0,
            footprintShapes: shapes.slice(),
            footprintOffsetX: weldedShapeSet.offsetX || 0,
            footprintOffsetY: weldedShapeSet.offsetY || 0,
            bounds,
            displayLabel: group.sourceLayerIds.length > 1
                ? `L${group.primarySourceLayerId} (${group.sourceLayerIds.join('+')})`
                : `L${group.primarySourceLayerId}`,
            zStart: 0,
            zEnd: 0,
            isBase: false,
            providesGeneratedSupportFootprint: false
        };
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

        const supportBaseShapeSet = buildWeldedShapeSet({
            shapes: outputLayers.flatMap((layer) => layer.rawShapes || []),
            tracer,
            options: state.lastOptions,
            SVGLoader,
            THREERef
        });
        if (supportBaseShapeSet.shapes.length) {
            const supportBaseShapes = simplifyShapeSet(supportBaseShapeSet.shapes, THREERef, decimatePercent);
            resolvedBaseOutputLayer.shapes = supportBaseShapes;
            resolvedBaseOutputLayer.shapeOffsetX = supportBaseShapeSet.offsetX || 0;
            resolvedBaseOutputLayer.shapeOffsetY = supportBaseShapeSet.offsetY || 0;
            resolvedBaseOutputLayer.footprintShapes = supportBaseShapes.slice();
            resolvedBaseOutputLayer.footprintOffsetX = supportBaseShapeSet.offsetX || 0;
            resolvedBaseOutputLayer.footprintOffsetY = supportBaseShapeSet.offsetY || 0;
            resolvedBaseOutputLayer.bounds = buildBoundsFromShapes(
                supportBaseShapes,
                supportBaseShapeSet.offsetX || 0,
                supportBaseShapeSet.offsetY || 0
            );
            resolvedBaseOutputLayer.providesGeneratedSupportFootprint = true;
        }
    }

    if (resolvedBaseOutputLayer) {
        const baseThickness = resolvedBaseOutputLayer.thickness;
        outputLayers.forEach((layer) => {
            layer.isBase = layer.outputLayerId === resolvedBaseOutputLayer.outputLayerId;
            layer.zStart = layer.isBase ? 0 : baseThickness;
            layer.zEnd = layer.zStart + layer.thickness;
        });
    } else {
        let cursor = 0;
        outputLayers.forEach((layer) => {
            layer.isBase = false;
            layer.zStart = cursor;
            layer.zEnd = cursor + layer.thickness;
            cursor = layer.zEnd;
        });
    }

    const normalizedBounds = finalizeBounds(rawBounds);
    const totalHeight = outputLayers.reduce((maxHeight, layer) => Math.max(maxHeight, layer.zEnd), 0);
    const warnings = resolvedBaseOutputLayer && !resolvedBaseOutputLayer.providesGeneratedSupportFootprint
        ? validateSupportFootprint(outputLayers, resolvedBaseOutputLayer, THREERef)
        : [];

    return {
        outputLayers,
        visibleSourceLayerIds: sourceLayerIds,
        thicknessById,
        useBaseLayer: !!state.useBaseLayer,
        baseSourceLayerId: state.baseSourceLayerId,
        detectedBaseSourceLayerId: detectedBaseOutputLayer?.primarySourceLayerId ?? null,
        resolvedBaseOutputLayerId: resolvedBaseOutputLayer?.outputLayerId ?? null,
        rawBounds: normalizedBounds,
        totalHeight,
        maxHeight: totalHeight,
        curveSegments: getCurveSegmentsForDecimation(decimatePercent),
        decimatePercent: clampDecimatePercent(decimatePercent),
        normalization: {
            shiftX: -normalizedBounds.centerX,
            shiftY: -normalizedBounds.centerY,
            shiftZ: 0
        },
        warnings
    };
}

function createLayerGeometry({ layer, plan, THREERef }) {
    const geometries = [];
    const offsetX = layer.shapeOffsetX || 0;
    const offsetY = layer.shapeOffsetY || 0;

    layer.shapes.forEach((shape) => {
        const geometry = new THREERef.ExtrudeGeometry(shape, {
            depth: layer.thickness,
            curveSegments: plan.curveSegments,
            bevelEnabled: false
        });
        geometry.rotateX(Math.PI);
        geometry.translate(
            plan.normalization.shiftX + offsetX,
            -plan.normalization.shiftY - offsetY,
            layer.thickness + layer.zStart + plan.normalization.shiftZ
        );
        geometry.computeVertexNormals();
        geometries.push(geometry);
    });

    return geometries;
}

export function buildObjGeometryBundle(plan, { THREERef, bufferUtils }) {
    if (!plan || !THREERef) return null;

    const layers = new Map();
    plan.outputLayers.forEach((layer) => {
        const geometries = createLayerGeometry({ layer, plan, THREERef });
        if (!geometries.length) return;

        let geometry = null;
        if (geometries.length === 1) {
            geometry = geometries[0];
        } else if (bufferUtils?.mergeGeometries) {
            geometry = bufferUtils.mergeGeometries(geometries, false);
            geometries.forEach((sourceGeometry) => {
                if (sourceGeometry !== geometry) sourceGeometry.dispose();
            });
        } else {
            geometry = geometries[0];
        }

        geometry.computeVertexNormals();

        const color = layer.color || { r: 0, g: 0, b: 0 };
        const hex = ((Math.max(0, Math.min(255, color.r ?? 0)) << 16)
            | (Math.max(0, Math.min(255, color.g ?? 0)) << 8)
            | Math.max(0, Math.min(255, color.b ?? 0)))
            .toString(16)
            .padStart(6, '0');

        layers.set(layer.outputLayerId, {
            geometry,
            color,
            hex,
            thickness: layer.thickness,
            zStart: layer.zStart,
            zEnd: layer.zEnd,
            sourceLayerIds: layer.sourceLayerIds.slice(),
            primarySourceLayerId: layer.primarySourceLayerId,
            isBase: layer.isBase,
            displayLabel: layer.displayLabel
        });
    });

    return {
        layers,
        plan
    };
}
