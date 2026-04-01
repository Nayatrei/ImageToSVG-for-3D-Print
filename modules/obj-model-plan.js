import { buildTracedataSubset, resolveMergedLayerGroups } from './shared/trace-utils.js';

const DEFAULT_CURVE_SEGMENTS = 6;
const BOUNDS_POINT_DIVISIONS = 16;
const TRIANGULATION_POINT_DIVISIONS = 12;

function clampThickness(value, defaultThickness) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    const fallback = Number.isFinite(defaultThickness) ? defaultThickness : 4;
    return Math.max(0.1, Math.min(20, Number.isFinite(numeric) ? numeric : fallback));
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

function buildShapesForSourceLayer({ tracedata, sourceLayerId, tracer, options, SVGLoader }) {
    const subset = buildTracedataSubset(tracedata, [sourceLayerId]);
    if (!subset) return { shapes: [], bounds: finalizeBounds(createEmptyBounds()) };

    const svgString = tracer.getsvgstring(subset, options);
    const loader = new SVGLoader();
    const svgData = loader.parse(svgString);
    const shapes = [];
    const bounds = createEmptyBounds();

    svgData.paths.forEach((path) => {
        const pathShapes = SVGLoader.createShapes(path);
        if (!pathShapes || !pathShapes.length) return;

        pathShapes.forEach((shape) => {
            shapes.push(shape);
            const extracted = shape.extractPoints(BOUNDS_POINT_DIVISIONS);
            updateBoundsFromPoints(bounds, extracted.shape);
            extracted.holes.forEach((hole) => updateBoundsFromPoints(bounds, hole));
        });
    });

    return { shapes, bounds: finalizeBounds(bounds) };
}

function buildLayerTriangles(shapes, THREERef) {
    const triangles = [];
    if (!Array.isArray(shapes) || !THREERef?.ShapeUtils) return triangles;

    shapes.forEach((shape) => {
        const extracted = shape.extractPoints(TRIANGULATION_POINT_DIVISIONS);
        const contour = extracted.shape.map((point) => new THREERef.Vector2(point.x, point.y));
        const holes = extracted.holes.map((hole) => hole.map((point) => new THREERef.Vector2(point.x, point.y)));
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

function validateSupportFootprint(outputLayers, resolvedBaseOutputLayer, THREERef) {
    if (!resolvedBaseOutputLayer || !THREERef) return [];

    const baseTriangles = buildLayerTriangles(resolvedBaseOutputLayer.footprintShapes, THREERef);
    if (!baseTriangles.length) return [];

    return outputLayers
        .filter((layer) => !layer.isBase)
        .flatMap((layer) => {
            const layerTriangles = buildLayerTriangles(layer.footprintShapes, THREERef);
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

function migrateLegacyBaseSourceLayerId(state, outputLayers) {
    if (Number.isInteger(state.baseSourceLayerId)) return;
    const legacyIndex = Number.parseInt(state.baseLayerIndex, 10);
    if (Number.isInteger(legacyIndex) && legacyIndex >= 0 && legacyIndex < outputLayers.length) {
        state.baseSourceLayerId = outputLayers[legacyIndex].primarySourceLayerId;
        return;
    }
    state.baseSourceLayerId = outputLayers[0]?.primarySourceLayerId ?? null;
}

export function buildObjModelPlan({
    state,
    tracer,
    SVGLoader,
    THREERef,
    defaultThickness,
    visibleSourceLayerIds
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
            SVGLoader
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
        const shapes = [];
        group.sourceLayerIds.forEach((sourceLayerId) => {
            const sourceShapes = shapeCache.get(sourceLayerId)?.shapes || [];
            shapes.push(...sourceShapes);
        });
        return {
            outputLayerId: group.outputLayerId,
            primarySourceLayerId: group.primarySourceLayerId,
            sourceLayerIds: group.sourceLayerIds.slice(),
            color: state.tracedata.palette[group.primarySourceLayerId],
            thickness: clampThickness(thicknessById[group.primarySourceLayerId], defaultThickness),
            shapes,
            footprintShapes: shapes.slice(),
            displayLabel: group.sourceLayerIds.length > 1
                ? `L${group.primarySourceLayerId} (${group.sourceLayerIds.join('+')})`
                : `L${group.primarySourceLayerId}`,
            zStart: 0,
            zEnd: 0,
            isBase: false
        };
    });

    migrateLegacyBaseSourceLayerId(state, outputLayers);

    let resolvedBaseOutputLayer = null;
    if (state.useBaseLayer && outputLayers.length > 0) {
        resolvedBaseOutputLayer = outputLayers.find((layer) => layer.sourceLayerIds.includes(state.baseSourceLayerId));
        if (!resolvedBaseOutputLayer) {
            resolvedBaseOutputLayer = outputLayers[0];
            state.baseSourceLayerId = resolvedBaseOutputLayer.primarySourceLayerId;
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
    const warnings = resolvedBaseOutputLayer
        ? validateSupportFootprint(outputLayers, resolvedBaseOutputLayer, THREERef)
        : [];

    return {
        outputLayers,
        visibleSourceLayerIds: sourceLayerIds,
        thicknessById,
        useBaseLayer: !!state.useBaseLayer,
        baseSourceLayerId: state.baseSourceLayerId,
        resolvedBaseOutputLayerId: resolvedBaseOutputLayer?.outputLayerId ?? null,
        rawBounds: normalizedBounds,
        totalHeight,
        maxHeight: totalHeight,
        curveSegments: DEFAULT_CURVE_SEGMENTS,
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

    layer.shapes.forEach((shape) => {
        const geometry = new THREERef.ExtrudeGeometry(shape, {
            depth: layer.thickness,
            curveSegments: plan.curveSegments,
            bevelEnabled: false
        });
        geometry.rotateX(Math.PI);
        geometry.translate(
            plan.normalization.shiftX,
            plan.normalization.shiftY,
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
