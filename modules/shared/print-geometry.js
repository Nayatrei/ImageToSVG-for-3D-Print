import { markTransparentPixels, stripTransparentPalette } from './image-utils.js';

const MASK_POINT_DIVISIONS = 48;
const MASK_ALPHA_THRESHOLD = 127;

export const DEFAULT_PRINT_PROFILE = Object.freeze({
    nozzleMm: 0.4,
    layerHeightMm: 0.2,
    minFeatureWidthMm: 0.45,
    minHoleWidthMm: 0.35,
    minIslandAreaMm2: 0.2,
    minSupportContactWidthMm: 0.45,
    maskResolutionPxPerMm: 24
});

export const BEZEL_PRESETS = Object.freeze({
    off: Object.freeze({ enabled: false, widthMm: 0, extraHeightMm: 0, label: 'Off' }),
    low: Object.freeze({ enabled: true, widthMm: 0.6, extraHeightMm: 0.4, label: 'Low' }),
    high: Object.freeze({ enabled: true, widthMm: 1.0, extraHeightMm: 0.8, label: 'High' })
});

function clampByte(value) {
    return value ? 1 : 0;
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

function updateBoundsFromPoints(bounds, points) {
    if (!Array.isArray(points)) return;
    points.forEach((point) => {
        if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        if (point.x < bounds.minX) bounds.minX = point.x;
        if (point.y < bounds.minY) bounds.minY = point.y;
        if (point.x > bounds.maxX) bounds.maxX = point.x;
        if (point.y > bounds.maxY) bounds.maxY = point.y;
    });
}

function appendRingToContext(context, points, offsetX, offsetY) {
    if (!Array.isArray(points) || points.length < 2) return;
    context.moveTo(points[0].x + offsetX, points[0].y + offsetY);
    for (let index = 1; index < points.length; index++) {
        context.lineTo(points[index].x + offsetX, points[index].y + offsetY);
    }
    context.closePath();
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

function buildShapesFromSvgString(svgString, SVGLoader) {
    if (!svgString || !SVGLoader) {
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
            const extracted = shape.extractPoints(MASK_POINT_DIVISIONS);
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

function buildEmptyShapeSet() {
    return {
        shapes: [],
        bounds: finalizeBounds(createEmptyBounds()),
        offsetX: 0,
        offsetY: 0,
        tracedata: null,
        traceOptions: null
    };
}

function buildBinaryMaskTraceData(maskImageData, tracer, options = {}) {
    if (!maskImageData || !tracer?.colorquantization) return null;

    const traceOptions = buildMaskTraceOptions(tracer, options);
    const quantized = tracer.colorquantization(maskImageData, traceOptions);
    if (!quantized?.palette || !Array.isArray(quantized.array)) return null;

    markTransparentPixels(quantized, maskImageData);
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

export function clampBezelPreset(value) {
    if (value === 'low' || value === 'high') return value;
    return 'off';
}

export function createMaskSpace({
    bounds,
    pixelsPerUnit,
    pixelsPerMm,
    paddingPx = 4
}) {
    const safePixelsPerUnit = Number.isFinite(pixelsPerUnit) && pixelsPerUnit > 0 ? pixelsPerUnit : 1;
    const safePixelsPerMm = Number.isFinite(pixelsPerMm) && pixelsPerMm > 0 ? pixelsPerMm : 24;
    const safePadding = Math.max(0, Math.ceil(paddingPx));
    const validBounds = bounds?.isValid ? bounds : finalizeBounds(createEmptyBounds());
    const sourceWidth = Number.isFinite(validBounds.width) ? validBounds.width : 0;
    const sourceHeight = Number.isFinite(validBounds.height)
        ? validBounds.height
        : (Number.isFinite(validBounds.depth) ? validBounds.depth : 0);

    return {
        width: Math.max(1, Math.ceil(sourceWidth * safePixelsPerUnit) + (safePadding * 2)),
        height: Math.max(1, Math.ceil(sourceHeight * safePixelsPerUnit) + (safePadding * 2)),
        originX: validBounds.minX - (safePadding / safePixelsPerUnit),
        originY: validBounds.minY - (safePadding / safePixelsPerUnit),
        pixelsPerUnit: safePixelsPerUnit,
        pixelsPerMm: safePixelsPerMm
    };
}

export function createEmptyMask(maskSpace) {
    return new Uint8Array(Math.max(1, (maskSpace?.width || 1) * (maskSpace?.height || 1)));
}

export function cloneMask(maskData) {
    return maskData instanceof Uint8Array ? maskData.slice() : new Uint8Array();
}

export function countMaskPixels(maskData) {
    if (!(maskData instanceof Uint8Array)) return 0;
    let count = 0;
    for (let index = 0; index < maskData.length; index++) {
        count += clampByte(maskData[index]);
    }
    return count;
}

export function hasMaskPixels(maskData) {
    if (!(maskData instanceof Uint8Array)) return false;
    for (let index = 0; index < maskData.length; index++) {
        if (maskData[index]) return true;
    }
    return false;
}

export function unionMaskData(left, right) {
    const size = Math.max(left?.length || 0, right?.length || 0);
    const result = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        result[index] = clampByte((left?.[index] || 0) || (right?.[index] || 0));
    }
    return result;
}

export function intersectMaskData(left, right) {
    const size = Math.max(left?.length || 0, right?.length || 0);
    const result = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        result[index] = clampByte((left?.[index] || 0) && (right?.[index] || 0));
    }
    return result;
}

export function subtractMaskData(left, right) {
    const size = Math.max(left?.length || 0, right?.length || 0);
    const result = new Uint8Array(size);
    for (let index = 0; index < size; index++) {
        result[index] = clampByte((left?.[index] || 0) && !(right?.[index] || 0));
    }
    return result;
}

function applyBinaryBoxPassHorizontal(data, width, height, radius, threshold) {
    if (radius <= 0) return data.slice();
    const output = new Uint8Array(data.length);

    for (let row = 0; row < height; row++) {
        const rowOffset = row * width;
        let sum = 0;

        for (let column = -radius; column <= radius; column++) {
            if (column >= 0 && column < width) {
                sum += data[rowOffset + column];
            }
        }

        for (let column = 0; column < width; column++) {
            output[rowOffset + column] = sum >= threshold ? 1 : 0;

            const removeColumn = column - radius;
            const addColumn = column + radius + 1;
            if (removeColumn >= 0 && removeColumn < width) {
                sum -= data[rowOffset + removeColumn];
            }
            if (addColumn >= 0 && addColumn < width) {
                sum += data[rowOffset + addColumn];
            }
        }
    }

    return output;
}

function applyBinaryBoxPassVertical(data, width, height, radius, threshold) {
    if (radius <= 0) return data.slice();
    const output = new Uint8Array(data.length);

    for (let column = 0; column < width; column++) {
        let sum = 0;

        for (let row = -radius; row <= radius; row++) {
            if (row >= 0 && row < height) {
                sum += data[(row * width) + column];
            }
        }

        for (let row = 0; row < height; row++) {
            output[(row * width) + column] = sum >= threshold ? 1 : 0;

            const removeRow = row - radius;
            const addRow = row + radius + 1;
            if (removeRow >= 0 && removeRow < height) {
                sum -= data[(removeRow * width) + column];
            }
            if (addRow >= 0 && addRow < height) {
                sum += data[(addRow * width) + column];
            }
        }
    }

    return output;
}

function applyBinaryBoxFilter(maskSpace, maskData, radiusPx, mode) {
    if (!(maskData instanceof Uint8Array)) return createEmptyMask(maskSpace);
    const radius = Math.max(0, Math.round(radiusPx));
    if (radius <= 0) return maskData.slice();
    const windowSize = (radius * 2) + 1;
    const threshold = mode === 'dilate' ? 1 : windowSize;
    const horizontal = applyBinaryBoxPassHorizontal(maskData, maskSpace.width, maskSpace.height, radius, threshold);
    return applyBinaryBoxPassVertical(horizontal, maskSpace.width, maskSpace.height, radius, threshold);
}

export function dilateMaskData(maskSpace, maskData, radiusPx) {
    return applyBinaryBoxFilter(maskSpace, maskData, radiusPx, 'dilate');
}

export function erodeMaskData(maskSpace, maskData, radiusPx) {
    return applyBinaryBoxFilter(maskSpace, maskData, radiusPx, 'erode');
}

export function closeMaskData(maskSpace, maskData, radiusPx) {
    if (Math.max(0, Math.round(radiusPx)) <= 0) return maskData.slice();
    return erodeMaskData(maskSpace, dilateMaskData(maskSpace, maskData, radiusPx), radiusPx);
}

function getFilledPixelBounds(maskSpace, maskData) {
    const width = maskSpace?.width || 0;
    const height = maskSpace?.height || 0;
    const bounds = {
        minX: Infinity,
        minY: Infinity,
        maxX: -Infinity,
        maxY: -Infinity
    };

    for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
            if (!maskData[(row * width) + column]) continue;
            if (column < bounds.minX) bounds.minX = column;
            if (row < bounds.minY) bounds.minY = row;
            if (column > bounds.maxX) bounds.maxX = column;
            if (row > bounds.maxY) bounds.maxY = row;
        }
    }

    const isValid = Number.isFinite(bounds.minX)
        && Number.isFinite(bounds.minY)
        && Number.isFinite(bounds.maxX)
        && Number.isFinite(bounds.maxY);

    if (!isValid) {
        return {
            isValid: false,
            minX: 0,
            minY: 0,
            maxX: 0,
            maxY: 0,
            widthPx: 0,
            heightPx: 0
        };
    }

    return {
        isValid: true,
        minX: bounds.minX,
        minY: bounds.minY,
        maxX: bounds.maxX,
        maxY: bounds.maxY,
        widthPx: (bounds.maxX - bounds.minX) + 1,
        heightPx: (bounds.maxY - bounds.minY) + 1
    };
}

export function getMaskBounds(maskSpace, maskData) {
    const pixelBounds = getFilledPixelBounds(maskSpace, maskData);
    if (!pixelBounds.isValid) return finalizeBounds(createEmptyBounds());

    const scale = maskSpace.pixelsPerUnit || 1;
    const minX = maskSpace.originX + (pixelBounds.minX / scale);
    const minY = maskSpace.originY + (pixelBounds.minY / scale);
    const maxX = maskSpace.originX + ((pixelBounds.maxX + 1) / scale);
    const maxY = maskSpace.originY + ((pixelBounds.maxY + 1) / scale);

    return finalizeBounds({ minX, minY, maxX, maxY });
}

export function rasterizeShapeSetToMask({
    shapes,
    offsetX = 0,
    offsetY = 0,
    maskSpace
}) {
    const output = createEmptyMask(maskSpace);
    if (!Array.isArray(shapes) || shapes.length === 0 || !maskSpace) return output;

    const canvas = document.createElement('canvas');
    canvas.width = maskSpace.width;
    canvas.height = maskSpace.height;

    const context = canvas.getContext('2d', { alpha: true });
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#000';
    context.setTransform(
        maskSpace.pixelsPerUnit,
        0,
        0,
        maskSpace.pixelsPerUnit,
        -maskSpace.originX * maskSpace.pixelsPerUnit,
        -maskSpace.originY * maskSpace.pixelsPerUnit
    );

    shapes.forEach((shape) => {
        if (!shape?.extractPoints) return;
        const extracted = shape.extractPoints(MASK_POINT_DIVISIONS);
        context.beginPath();
        appendRingToContext(context, extracted.shape, offsetX, offsetY);
        extracted.holes.forEach((hole) => appendRingToContext(context, hole, offsetX, offsetY));
        context.fill('evenodd');
    });

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    for (let index = 0; index < output.length; index++) {
        output[index] = imageData.data[(index * 4) + 3] > MASK_ALPHA_THRESHOLD ? 1 : 0;
    }
    return output;
}

function buildMaskImageData(maskSpace, maskData) {
    const imageData = new ImageData(maskSpace.width, maskSpace.height);
    for (let index = 0; index < maskData.length; index++) {
        const alpha = maskData[index] ? 255 : 0;
        const pixelIndex = index * 4;
        imageData.data[pixelIndex] = 0;
        imageData.data[pixelIndex + 1] = 0;
        imageData.data[pixelIndex + 2] = 0;
        imageData.data[pixelIndex + 3] = alpha;
    }
    return imageData;
}

export function traceMaskDataToShapeSet({
    maskSpace,
    maskData,
    tracer,
    options,
    SVGLoader
}) {
    if (!maskSpace || !hasMaskPixels(maskData) || !tracer || !SVGLoader) {
        return buildEmptyShapeSet();
    }

    const traced = buildBinaryMaskTraceData(buildMaskImageData(maskSpace, maskData), tracer, options);
    if (!traced?.tracedata) return buildEmptyShapeSet();

    const localSvgString = tracer.getsvgstring(traced.tracedata, traced.traceOptions);
    const innerSvg = extractInnerSvg(localSvgString);
    const wrappedSvg = `<svg viewBox="0 0 ${maskSpace.width / maskSpace.pixelsPerUnit} ${maskSpace.height / maskSpace.pixelsPerUnit}" xmlns="http://www.w3.org/2000/svg"><g transform="translate(${maskSpace.originX} ${maskSpace.originY}) scale(${1 / maskSpace.pixelsPerUnit})">${innerSvg}</g></svg>`;
    const shapeSet = buildShapesFromSvgString(wrappedSvg, SVGLoader);

    return {
        shapes: shapeSet.shapes,
        bounds: shapeSet.bounds,
        offsetX: 0,
        offsetY: 0,
        tracedata: traced.tracedata,
        traceOptions: traced.traceOptions
    };
}

export function analyzeMaskComponents(maskSpace, maskData) {
    const width = maskSpace?.width || 0;
    const height = maskSpace?.height || 0;
    const visited = new Uint8Array(maskData?.length || 0);
    const components = [];
    const neighborDeltas = [
        [-1, -1], [0, -1], [1, -1],
        [-1, 0], [1, 0],
        [-1, 1], [0, 1], [1, 1]
    ];

    for (let row = 0; row < height; row++) {
        for (let column = 0; column < width; column++) {
            const startIndex = (row * width) + column;
            if (!maskData[startIndex] || visited[startIndex]) continue;

            const queue = [startIndex];
            const indices = [];
            visited[startIndex] = 1;
            let queueIndex = 0;
            let minX = column;
            let maxX = column;
            let minY = row;
            let maxY = row;

            while (queueIndex < queue.length) {
                const current = queue[queueIndex++];
                indices.push(current);

                const currentX = current % width;
                const currentY = Math.floor(current / width);

                if (currentX < minX) minX = currentX;
                if (currentX > maxX) maxX = currentX;
                if (currentY < minY) minY = currentY;
                if (currentY > maxY) maxY = currentY;

                neighborDeltas.forEach(([deltaX, deltaY]) => {
                    const nextX = currentX + deltaX;
                    const nextY = currentY + deltaY;
                    if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) return;

                    const nextIndex = (nextY * width) + nextX;
                    if (!maskData[nextIndex] || visited[nextIndex]) return;
                    visited[nextIndex] = 1;
                    queue.push(nextIndex);
                });
            }

            components.push({
                indices,
                areaPx: indices.length,
                minX,
                minY,
                maxX,
                maxY,
                widthPx: (maxX - minX) + 1,
                heightPx: (maxY - minY) + 1
            });
        }
    }

    return components;
}

function componentHasPrintableCore(component, featureProbeRadiusPx) {
    const radius = Math.max(0, Math.round(featureProbeRadiusPx));
    if (radius <= 0) return true;

    const padding = radius + 1;
    const width = component.widthPx + (padding * 2);
    const height = component.heightPx + (padding * 2);
    const subMask = new Uint8Array(width * height);

    component.indices.forEach((index) => {
        const x = index % component.sourceWidth;
        const y = Math.floor(index / component.sourceWidth);
        const subX = x - component.minX + padding;
        const subY = y - component.minY + padding;
        subMask[(subY * width) + subX] = 1;
    });

    const eroded = erodeMaskData({ width, height }, subMask, radius);
    return hasMaskPixels(eroded);
}

export function splitMaskByPrintability(maskSpace, maskData, {
    minAreaPx = 0,
    featureProbeRadiusPx = 0
} = {}) {
    const keptMask = createEmptyMask(maskSpace);
    const absorbedMask = createEmptyMask(maskSpace);
    const components = analyzeMaskComponents(maskSpace, maskData).map((component) => ({
        ...component,
        sourceWidth: maskSpace.width
    }));

    components.forEach((component) => {
        const printable = component.areaPx >= minAreaPx && componentHasPrintableCore(component, featureProbeRadiusPx);
        component.printable = printable;
        const target = printable ? keptMask : absorbedMask;
        component.indices.forEach((index) => {
            target[index] = 1;
        });
    });

    return {
        keptMask,
        absorbedMask,
        components
    };
}

function countPixelsAndBounds(maskData, width, height) {
    let count = 0;
    let minX = width;
    let maxX = -1;
    let minY = -1;
    let maxY = -1;

    for (let row = 0; row < height; row++) {
        const rowOffset = row * width;
        let rowHasPixel = false;
        for (let column = 0; column < width; column++) {
            if (!maskData[rowOffset + column]) continue;
            count++;
            rowHasPixel = true;
            if (column < minX) minX = column;
            if (column > maxX) maxX = column;
        }
        if (rowHasPixel) {
            if (minY < 0) minY = row;
            maxY = row;
        }
    }

    const isValid = count > 0;
    return {
        count,
        isValid,
        widthPx: isValid ? (maxX - minX) + 1 : 0,
        heightPx: isValid ? (maxY - minY) + 1 : 0
    };
}

function buildSkippedBezelResult(baseMask, maskSpace, preset) {
    return {
        innerMask: cloneMask(baseMask),
        bezelMask: createEmptyMask(maskSpace),
        bezelSpec: {
            enabled: false,
            widthMm: preset.widthMm,
            extraHeightMm: preset.extraHeightMm,
            effectiveWidthMm: 0,
            skippedReason: 'Model is too small for a printable inner bezel.'
        }
    };
}

export function resolveBezelMaskSet({
    maskSpace,
    baseMask,
    bezelPreset,
    printProfile = DEFAULT_PRINT_PROFILE
}) {
    const presetKey = clampBezelPreset(bezelPreset);
    const preset = BEZEL_PRESETS[presetKey];

    if (!preset?.enabled || !hasMaskPixels(baseMask)) {
        return {
            innerMask: cloneMask(baseMask),
            bezelMask: createEmptyMask(maskSpace),
            bezelSpec: {
                enabled: false,
                widthMm: preset?.widthMm || 0,
                extraHeightMm: preset?.extraHeightMm || 0,
                effectiveWidthMm: 0,
                skippedReason: presetKey === 'off' ? 'Bezel disabled.' : 'No support footprint available.'
            }
        };
    }

    const desiredRadiusPx = Math.max(1, Math.round(preset.widthMm * maskSpace.pixelsPerMm));
    const minimumRadiusPx = Math.max(1, Math.ceil(printProfile.minFeatureWidthMm * maskSpace.pixelsPerMm));
    const minInteriorSpanPx = Math.max(1, Math.ceil((printProfile.minFeatureWidthMm * 2) * maskSpace.pixelsPerMm));
    const minInteriorAreaPx = Math.max(1, Math.ceil(printProfile.minIslandAreaMm2 * maskSpace.pixelsPerMm * maskSpace.pixelsPerMm));

    if (minimumRadiusPx > desiredRadiusPx) {
        return buildSkippedBezelResult(baseMask, maskSpace, preset);
    }

    const width = maskSpace.width || 0;
    const height = maskSpace.height || 0;
    let lo = minimumRadiusPx;
    let hi = desiredRadiusPx;
    let bestRadius = -1;
    let bestInnerMask = null;

    while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const innerMask = erodeMaskData(maskSpace, baseMask, mid);
        const stats = countPixelsAndBounds(innerMask, width, height);

        if (stats.count >= minInteriorAreaPx
            && stats.isValid
            && Math.min(stats.widthPx, stats.heightPx) >= minInteriorSpanPx) {
            bestRadius = mid;
            bestInnerMask = innerMask;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }

    if (bestRadius < 0) {
        return buildSkippedBezelResult(baseMask, maskSpace, preset);
    }

    const bezelMask = subtractMaskData(baseMask, bestInnerMask);

    return {
        innerMask: bestInnerMask,
        bezelMask,
        bezelSpec: {
            enabled: true,
            widthMm: preset.widthMm,
            extraHeightMm: preset.extraHeightMm,
            effectiveWidthMm: Number.parseFloat((bestRadius / maskSpace.pixelsPerMm).toFixed(2)),
            skippedReason: ''
        }
    };
}
