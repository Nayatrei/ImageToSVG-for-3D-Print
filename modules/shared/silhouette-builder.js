import { markTransparentPixels, stripTransparentPalette } from './image-utils.js';
import { buildTracedataSubset } from './trace-utils.js';

const MASK_POINT_DIVISIONS = 48;
const MASK_BOUNDS_POINT_DIVISIONS = 24;
const MASK_ALPHA_THRESHOLD = 127;

function createEmptyBounds() {
    return {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };
}

function finalizeBounds(bounds) {
    const isValid = Number.isFinite(bounds.minX)
        && Number.isFinite(bounds.minY)
        && Number.isFinite(bounds.maxX)
        && Number.isFinite(bounds.maxY)
        && bounds.maxX > bounds.minX
        && bounds.maxY > bounds.minY;

    if (!isValid) {
        return {
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
            width: 0,
            height: 0,
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
        height: bounds.maxY - bounds.minY,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2,
        isValid: true
    };
}

function updateBoundsFromPoints(bounds, points, offsetX = 0, offsetY = 0) {
    if (!Array.isArray(points)) return bounds;
    points.forEach((point) => {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        const x = point.x + offsetX;
        const y = point.y + offsetY;
        if (x < bounds.minX) bounds.minX = x;
        if (y < bounds.minY) bounds.minY = y;
        if (x > bounds.maxX) bounds.maxX = x;
        if (y > bounds.maxY) bounds.maxY = y;
    });
    return bounds;
}

function buildBoundsForShapes(shapes, divisions = MASK_BOUNDS_POINT_DIVISIONS) {
    const bounds = createEmptyBounds();
    (Array.isArray(shapes) ? shapes : []).forEach((shape) => {
        if (!shape?.extractPoints) return;
        const extracted = shape.extractPoints(divisions);
        updateBoundsFromPoints(bounds, extracted.shape);
        extracted.holes.forEach((hole) => updateBoundsFromPoints(bounds, hole));
    });
    return finalizeBounds(bounds);
}

function appendRingToContext(context, points, offsetX, offsetY) {
    if (!Array.isArray(points) || points.length < 2) return;
    context.moveTo(points[0].x - offsetX, points[0].y - offsetY);
    for (let index = 1; index < points.length; index++) {
        context.lineTo(points[index].x - offsetX, points[index].y - offsetY);
    }
    context.closePath();
}

function rasterizeShapesToMaskImageData({ shapes, bounds, THREERef }) {
    if (!bounds?.isValid) return null;

    const width = Math.max(1, Math.ceil(bounds.width));
    const height = Math.max(1, Math.ceil(bounds.height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d', { alpha: true });
    context.clearRect(0, 0, width, height);
    context.fillStyle = '#000';

    shapes.forEach((shape) => {
        if (!shape?.extractPoints) return;
        const extracted = shape.extractPoints(MASK_POINT_DIVISIONS);
        context.beginPath();
        appendRingToContext(context, extracted.shape, bounds.minX, bounds.minY);
        extracted.holes.forEach((hole) => appendRingToContext(context, hole, bounds.minX, bounds.minY));
        context.fill('evenodd');
    });

    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let index = 0; index < data.length; index += 4) {
        const alpha = data[index + 3] > MASK_ALPHA_THRESHOLD ? 255 : 0;
        data[index] = 0;
        data[index + 1] = 0;
        data[index + 2] = 0;
        data[index + 3] = alpha;
    }

    return imageData;
}

function buildMaskTraceOptions(tracer, options = {}) {
    const defaults = tracer?.checkoptions
        ? tracer.checkoptions(options)
        : { ...(tracer?.optionpresets?.default || {}), ...(options || {}) };

    return {
        ...defaults,
        viewbox: true,
        strokewidth: 0,
        numberofcolors: 2,
        colorsampling: 0,
        colorquantcycles: 1,
        pathomit: 0,
        ltres: 0.01,
        qtres: 0.01,
        blurradius: 0,
        roundcoords: 1,
        rightangleenhance: true,
        mincolorratio: 0
    };
}

function traceMaskImageData(imageData, tracer, options = {}) {
    if (!imageData || !tracer?.colorquantization) return null;

    const traceOptions = buildMaskTraceOptions(tracer, options);
    const quantized = tracer.colorquantization(imageData, traceOptions);
    if (!quantized?.palette || !Array.isArray(quantized.array)) return null;

    markTransparentPixels(quantized, imageData);
    stripTransparentPalette(quantized);

    if (!quantized.palette.length) return null;

    const tracedata = {
        layers: [],
        palette: quantized.palette.map((color) => ({ ...color, a: 255 })),
        width: quantized.array[0].length - 2,
        height: quantized.array.length - 2
    };

    for (let colorIndex = 0; colorIndex < quantized.palette.length; colorIndex++) {
        tracedata.layers.push(tracer.batchtracepaths(
            tracer.internodes(
                tracer.pathscan(tracer.layeringstep(quantized, colorIndex), traceOptions.pathomit),
                traceOptions
            ),
            traceOptions.ltres,
            traceOptions.qtres
        ));
    }

    return { tracedata, traceOptions };
}

function buildShapesFromSvgString(svgString, SVGLoader, THREERef) {
    if (!svgString || !SVGLoader || !THREERef) {
        return { shapes: [], bounds: finalizeBounds(createEmptyBounds()) };
    }

    const loader = new SVGLoader();
    const svgData = loader.parse(svgString);
    const shapes = [];
    const bounds = createEmptyBounds();

    svgData.paths.forEach((path) => {
        const pathShapes = SVGLoader.createShapes(path);
        if (!pathShapes?.length) return;

        pathShapes.forEach((shape) => {
            shapes.push(shape);
            const extracted = shape.extractPoints(MASK_BOUNDS_POINT_DIVISIONS);
            updateBoundsFromPoints(bounds, extracted.shape);
            extracted.holes.forEach((hole) => updateBoundsFromPoints(bounds, hole));
        });
    });

    return { shapes, bounds: finalizeBounds(bounds) };
}

function extractInnerSvg(svgString) {
    if (!svgString) return '';
    return svgString
        .replace(/^<svg[^>]*>/i, '')
        .replace(/<\/svg>\s*$/i, '');
}

function getSourceDimensions(tracedata, bounds) {
    const width = Number.isFinite(tracedata?.width) && tracedata.width > 0
        ? tracedata.width
        : Math.max(1, Math.ceil(bounds?.maxX || 1));
    const height = Number.isFinite(tracedata?.height) && tracedata.height > 0
        ? tracedata.height
        : Math.max(1, Math.ceil(bounds?.maxY || 1));
    return { width, height };
}

export function buildShapesFromTracedataLayers({
    tracedata,
    layerIndices,
    tracer,
    options,
    SVGLoader,
    THREERef
}) {
    if (!tracedata || !tracer || !SVGLoader || !THREERef) {
        return { shapes: [], bounds: finalizeBounds(createEmptyBounds()) };
    }

    const subset = Array.isArray(layerIndices)
        ? buildTracedataSubset(tracedata, layerIndices)
        : tracedata;
    if (!subset) return { shapes: [], bounds: finalizeBounds(createEmptyBounds()) };

    const svgString = tracer.getsvgstring(subset, options);
    return buildShapesFromSvgString(svgString, SVGLoader, THREERef);
}

export function buildWeldedShapeSet({
    shapes,
    tracer,
    options,
    SVGLoader,
    THREERef
}) {
    const fallbackBounds = buildBoundsForShapes(shapes);
    if (!Array.isArray(shapes) || shapes.length === 0 || !tracer || !SVGLoader || !THREERef) {
        return {
            shapes: Array.isArray(shapes) ? shapes.slice() : [],
            bounds: fallbackBounds,
            offsetX: 0,
            offsetY: 0,
            tracedata: null,
            traceOptions: buildMaskTraceOptions(tracer, options)
        };
    }

    if (!fallbackBounds.isValid) {
        return {
            shapes: shapes.slice(),
            bounds: fallbackBounds,
            offsetX: 0,
            offsetY: 0,
            tracedata: null,
            traceOptions: buildMaskTraceOptions(tracer, options)
        };
    }

    const imageData = rasterizeShapesToMaskImageData({ shapes, bounds: fallbackBounds, THREERef });
    const traced = traceMaskImageData(imageData, tracer, options);
    if (!traced?.tracedata) {
        return {
            shapes: shapes.slice(),
            bounds: fallbackBounds,
            offsetX: 0,
            offsetY: 0,
            tracedata: null,
            traceOptions: buildMaskTraceOptions(tracer, options)
        };
    }

    const localSvgString = tracer.getsvgstring(traced.tracedata, traced.traceOptions);
    const localShapeSet = buildShapesFromSvgString(localSvgString, SVGLoader, THREERef);
    const translatedBounds = localShapeSet.bounds.isValid
        ? {
            ...localShapeSet.bounds,
            minX: localShapeSet.bounds.minX + fallbackBounds.minX,
            minY: localShapeSet.bounds.minY + fallbackBounds.minY,
            maxX: localShapeSet.bounds.maxX + fallbackBounds.minX,
            maxY: localShapeSet.bounds.maxY + fallbackBounds.minY,
            centerX: localShapeSet.bounds.centerX + fallbackBounds.minX,
            centerY: localShapeSet.bounds.centerY + fallbackBounds.minY
        }
        : fallbackBounds;

    return {
        shapes: localShapeSet.shapes,
        bounds: translatedBounds,
        offsetX: fallbackBounds.minX,
        offsetY: fallbackBounds.minY,
        tracedata: traced.tracedata,
        traceOptions: traced.traceOptions
    };
}

export function buildWeldedSilhouetteSvgString({
    tracedata,
    layerIndices,
    tracer,
    options,
    SVGLoader,
    THREERef
}) {
    if (!tracedata || !Array.isArray(layerIndices) || layerIndices.length === 0 || !tracer || !SVGLoader || !THREERef) {
        return '';
    }

    const rawShapeSet = buildShapesFromTracedataLayers({
        tracedata,
        layerIndices,
        tracer,
        options,
        SVGLoader,
        THREERef
    });
    if (!rawShapeSet.shapes.length) return '';

    const welded = buildWeldedShapeSet({
        shapes: rawShapeSet.shapes,
        tracer,
        options,
        SVGLoader,
        THREERef
    });

    if (!welded.tracedata) {
        const subset = buildTracedataSubset(tracedata, layerIndices);
        return subset ? tracer.getsvgstring(subset, options) : '';
    }

    const localSvgString = tracer.getsvgstring(welded.tracedata, welded.traceOptions);
    const innerSvg = extractInnerSvg(localSvgString);
    const { width, height } = getSourceDimensions(tracedata, rawShapeSet.bounds);
    const version = tracer.versionnumber || '1.2.6';

    return `<svg viewBox="0 0 ${width} ${height}" version="1.1" xmlns="http://www.w3.org/2000/svg" desc="Created with imagetracer.js version ${version}" ><g transform="translate(${welded.offsetX} ${welded.offsetY})">${innerSvg}</g></svg>`;
}
