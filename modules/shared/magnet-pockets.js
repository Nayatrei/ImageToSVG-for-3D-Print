import {
    createEmptyMask,
    subtractMaskData
} from './print-geometry.js?v=r-78ade4c03db6e3a2';

export const MAGNET_DISC_PRESETS = Object.freeze([
    { id: 'disc-6x2', label: '6 × 2 mm', diameter: 6, height: 2 },
    { id: 'disc-8x2', label: '8 × 2 mm', diameter: 8, height: 2 },
    { id: 'disc-8x3', label: '8 × 3 mm', diameter: 8, height: 3 },
    { id: 'disc-10x2', label: '10 × 2 mm', diameter: 10, height: 2 },
    { id: 'disc-10x3', label: '10 × 3 mm', diameter: 10, height: 3 },
    { id: 'disc-12x3', label: '12 × 3 mm', diameter: 12, height: 3 },
    { id: 'disc-15x3', label: '15 × 3 mm', diameter: 15, height: 3 },
    { id: 'disc-20x3', label: '20 × 3 mm', diameter: 20, height: 3 },
    { id: 'disc-20x5', label: '20 × 5 mm', diameter: 20, height: 5 }
]);

export const MAGNET_BLOCK_PRESETS = Object.freeze([
    { id: 'block-10x5x2', label: '10 × 5 × 2 mm', length: 10, width: 5, height: 2 },
    { id: 'block-15x5x2', label: '15 × 5 × 2 mm', length: 15, width: 5, height: 2 },
    { id: 'block-20x5x2', label: '20 × 5 × 2 mm', length: 20, width: 5, height: 2 },
    { id: 'block-20x10x2', label: '20 × 10 × 2 mm', length: 20, width: 10, height: 2 },
    { id: 'block-25x5x2', label: '25 × 5 × 2 mm', length: 25, width: 5, height: 2 },
    { id: 'block-25x10x3', label: '25 × 10 × 3 mm', length: 25, width: 10, height: 3 },
    { id: 'block-30x10x3', label: '30 × 10 × 3 mm', length: 30, width: 10, height: 3 },
    { id: 'block-40x10x3', label: '40 × 10 × 3 mm', length: 40, width: 10, height: 3 }
]);

const DISC_PRESET_BY_ID = new Map(MAGNET_DISC_PRESETS.map((preset) => [preset.id, preset]));
const BLOCK_PRESET_BY_ID = new Map(MAGNET_BLOCK_PRESETS.map((preset) => [preset.id, preset]));
const PLACEMENT_SEARCH_STEP_MM = 0.6;

function clampNumber(value, min, max, fallback) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    return Math.max(min, Math.min(max, Number.isFinite(numeric) ? numeric : fallback));
}

function roundMillimetres(value, decimals = 3) {
    const factor = 10 ** decimals;
    return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function createDefaultMagnetPocketConfig() {
    return {
        enabled: false,
        shape: 'disc',
        presetId: 'disc-10x3',
        count: 4,
        mode: 'hidden',
        diameter: 10,
        length: 20,
        width: 5,
        height: 3,
        clearanceXY: 0.25,
        clearanceZ: 0.2,
        minWall: 1.2,
        floor: 0.8,
        roof: 0.8
    };
}

export function getMagnetPresets(shape) {
    return shape === 'block' ? MAGNET_BLOCK_PRESETS : MAGNET_DISC_PRESETS;
}

export function normalizeMagnetPocketConfig(value = {}) {
    const defaults = createDefaultMagnetPocketConfig();
    const shape = value.shape === 'block' ? 'block' : 'disc';
    const presetMap = shape === 'block' ? BLOCK_PRESET_BY_ID : DISC_PRESET_BY_ID;
    const defaultPresetId = shape === 'block' ? 'block-20x5x2' : 'disc-10x3';
    const presetId = value.presetId === 'custom' || presetMap.has(value.presetId)
        ? value.presetId
        : defaultPresetId;
    const preset = presetId === 'custom' ? null : presetMap.get(presetId);

    return {
        enabled: value.enabled === true,
        shape,
        presetId,
        count: Math.round(clampNumber(value.count, 1, 4, defaults.count)),
        mode: value.mode === 'bottom' ? 'bottom' : 'hidden',
        diameter: clampNumber(preset?.diameter ?? value.diameter, 1, 100, defaults.diameter),
        length: clampNumber(preset?.length ?? value.length, 1, 100, defaults.length),
        width: clampNumber(preset?.width ?? value.width, 1, 100, defaults.width),
        height: clampNumber(preset?.height ?? value.height, 0.5, 20, defaults.height),
        clearanceXY: clampNumber(value.clearanceXY, 0, 1, defaults.clearanceXY),
        clearanceZ: clampNumber(value.clearanceZ, 0, 1, defaults.clearanceZ),
        minWall: clampNumber(value.minWall, 0.4, 10, defaults.minWall),
        floor: clampNumber(value.floor, 0.4, 10, defaults.floor),
        roof: clampNumber(value.roof, 0.4, 10, defaults.roof)
    };
}

export function serializeMagnetPocketConfig(value = {}) {
    const normalized = normalizeMagnetPocketConfig(value);
    return [
        normalized.enabled ? 1 : 0,
        normalized.shape,
        normalized.presetId,
        normalized.count,
        normalized.mode,
        normalized.diameter,
        normalized.length,
        normalized.width,
        normalized.height,
        normalized.clearanceXY,
        normalized.clearanceZ,
        normalized.minWall,
        normalized.floor,
        normalized.roof
    ].join(':');
}

export function formatMagnetPocketLabel(config) {
    const normalized = normalizeMagnetPocketConfig(config);
    return normalized.shape === 'block'
        ? `${roundMillimetres(normalized.length)} × ${roundMillimetres(normalized.width)} × ${roundMillimetres(normalized.height)} mm`
        : `Ø${roundMillimetres(normalized.diameter)} × ${roundMillimetres(normalized.height)} mm`;
}

function getFilledPixelBounds(maskSpace, maskData) {
    const width = maskSpace?.width || 0;
    const height = maskSpace?.height || 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    for (let y = 0; y < height; y++) {
        const rowOffset = y * width;
        for (let x = 0; x < width; x++) {
            if (!maskData[rowOffset + x]) continue;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
        }
    }

    return {
        minX,
        minY,
        maxX,
        maxY,
        width: Math.max(0, maxX - minX + 1),
        height: Math.max(0, maxY - minY + 1),
        isValid: maxX >= minX && maxY >= minY
    };
}

function getEnvelopeDimensions(config, orientation) {
    const isRotated = orientation === 90;
    if (config.shape === 'disc') {
        const diameter = config.diameter + (config.clearanceXY * 2);
        return {
            cavityWidthMm: diameter,
            cavityDepthMm: diameter,
            envelopeWidthMm: diameter + (config.minWall * 2),
            envelopeDepthMm: diameter + (config.minWall * 2)
        };
    }

    const length = config.length + (config.clearanceXY * 2);
    const width = config.width + (config.clearanceXY * 2);
    const cavityWidthMm = isRotated ? width : length;
    const cavityDepthMm = isRotated ? length : width;
    return {
        cavityWidthMm,
        cavityDepthMm,
        envelopeWidthMm: cavityWidthMm + (config.minWall * 2),
        envelopeDepthMm: cavityDepthMm + (config.minWall * 2)
    };
}

function maskContainsEnvelope({
    maskSpace,
    supportMask,
    centerX,
    centerY,
    config,
    orientation
}) {
    const pixelsPerMm = maskSpace.pixelsPerMm || 24;
    const dimensions = getEnvelopeDimensions(config, orientation);
    const halfWidth = (dimensions.envelopeWidthMm * pixelsPerMm) / 2;
    const halfDepth = (dimensions.envelopeDepthMm * pixelsPerMm) / 2;
    const minY = Math.ceil(centerY - halfDepth);
    const maxY = Math.floor(centerY + halfDepth);
    const width = maskSpace.width;
    const height = maskSpace.height;

    if (
        centerX - halfWidth < 0
        || centerX + halfWidth >= width
        || minY < 0
        || maxY >= height
    ) {
        return false;
    }

    for (let y = minY; y <= maxY; y++) {
        let rowHalfWidth = halfWidth;
        if (config.shape === 'disc') {
            const dy = y - centerY;
            const remaining = (halfDepth * halfDepth) - (dy * dy);
            if (remaining < 0) continue;
            rowHalfWidth = Math.sqrt(remaining);
        }
        const minX = Math.ceil(centerX - rowHalfWidth);
        const maxX = Math.floor(centerX + rowHalfWidth);
        const rowOffset = y * width;
        for (let x = minX; x <= maxX; x++) {
            if (!supportMask[rowOffset + x]) return false;
        }
    }

    return true;
}

function placementsOverlap(placements, dimensions, pixelsPerMm) {
    const halfWidth = (dimensions.envelopeWidthMm * pixelsPerMm) / 2;
    const halfDepth = (dimensions.envelopeDepthMm * pixelsPerMm) / 2;
    for (let leftIndex = 0; leftIndex < placements.length; leftIndex++) {
        for (let rightIndex = leftIndex + 1; rightIndex < placements.length; rightIndex++) {
            const left = placements[leftIndex];
            const right = placements[rightIndex];
            if (
                Math.abs(left.pixelX - right.pixelX) < halfWidth * 2
                && Math.abs(left.pixelY - right.pixelY) < halfDepth * 2
            ) {
                return true;
            }
        }
    }
    return false;
}

function getBalancedAnchors(count, bounds) {
    const isWide = bounds.width >= bounds.height;
    if (count === 1) return [{ x: 0, y: 0 }];
    if (count === 2) {
        return isWide
            ? [{ x: -1, y: 0 }, { x: 1, y: 0 }]
            : [{ x: 0, y: -1 }, { x: 0, y: 1 }];
    }
    if (count === 3) {
        return isWide
            ? [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 0, y: 1 }]
            : [{ x: -1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 0 }];
    }
    return [
        { x: -1, y: -1 },
        { x: 1, y: -1 },
        { x: -1, y: 1 },
        { x: 1, y: 1 }
    ];
}

function buildPlacementAt({
    pixelX,
    pixelY,
    maskSpace,
    dimensions,
    orientation
}) {
    const pixelsPerUnit = maskSpace.pixelsPerUnit || 1;
    return {
        pixelX,
        pixelY,
        sourceX: maskSpace.originX + ((pixelX + 0.5) / pixelsPerUnit),
        sourceY: maskSpace.originY + ((pixelY + 0.5) / pixelsPerUnit),
        orientation,
        cavityWidthMm: dimensions.cavityWidthMm,
        cavityDepthMm: dimensions.cavityDepthMm
    };
}

function findSinglePlacement({ maskSpace, supportMask, config, orientation, bounds, dimensions }) {
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const candidates = [{ x: centerX, y: centerY }];
    const pixelsPerMm = maskSpace.pixelsPerMm || 24;
    const maxRadius = Math.max(bounds.width, bounds.height) / 2;
    const stepPixels = Math.max(1, PLACEMENT_SEARCH_STEP_MM * pixelsPerMm);

    for (let radius = stepPixels; radius <= maxRadius; radius += stepPixels) {
        for (let segment = 0; segment < 16; segment++) {
            const angle = (segment / 16) * Math.PI * 2;
            candidates.push({
                x: centerX + (Math.cos(angle) * radius),
                y: centerY + (Math.sin(angle) * radius)
            });
        }
    }

    for (const candidate of candidates) {
        const pixelX = Math.round(candidate.x);
        const pixelY = Math.round(candidate.y);
        if (maskContainsEnvelope({
            maskSpace,
            supportMask,
            centerX: pixelX,
            centerY: pixelY,
            config,
            orientation
        })) {
            return [buildPlacementAt({
                pixelX,
                pixelY,
                maskSpace,
                dimensions,
                orientation
            })];
        }
    }
    return [];
}

function findBalancedPlacements({
    maskSpace,
    supportMask,
    config,
    orientation,
    bounds,
    count
}) {
    const dimensions = getEnvelopeDimensions(config, orientation);
    if (count === 1) {
        return findSinglePlacement({
            maskSpace,
            supportMask,
            config,
            orientation,
            bounds,
            dimensions
        });
    }

    const pixelsPerMm = maskSpace.pixelsPerMm || 24;
    const halfEnvelopeWidth = (dimensions.envelopeWidthMm * pixelsPerMm) / 2;
    const halfEnvelopeDepth = (dimensions.envelopeDepthMm * pixelsPerMm) / 2;
    const centerX = (bounds.minX + bounds.maxX) / 2;
    const centerY = (bounds.minY + bounds.maxY) / 2;
    const availableX = Math.max(0, ((bounds.width - 1) / 2) - halfEnvelopeWidth);
    const availableY = Math.max(0, ((bounds.height - 1) / 2) - halfEnvelopeDepth);
    const anchors = getBalancedAnchors(count, bounds);
    const maxTravel = Math.max(availableX, availableY, 1);
    const searchSteps = Math.max(
        24,
        Math.min(220, Math.ceil(maxTravel / Math.max(1, PLACEMENT_SEARCH_STEP_MM * pixelsPerMm)))
    );
    const spreadPairs = [];
    const seenSpreadPairs = new Set();
    const addSpreadPair = (spreadX, spreadY) => {
        const normalizedX = Math.max(0, Math.min(1, spreadX));
        const normalizedY = Math.max(0, Math.min(1, spreadY));
        const key = `${normalizedX.toFixed(4)}:${normalizedY.toFixed(4)}`;
        if (seenSpreadPairs.has(key)) return;
        seenSpreadPairs.add(key);
        spreadPairs.push({ x: normalizedX, y: normalizedY });
    };

    // Rounded and irregular silhouettes often need one axis pulled inward while
    // the other remains near its balanced target. Search those symmetric paths
    // before falling back to a small two-dimensional spread grid.
    for (let step = 0; step <= searchSteps; step++) {
        const spread = 1 - (step / searchSteps);
        addSpreadPair(spread, 1);
        addSpreadPair(1, spread);
        addSpreadPair(spread, spread);
    }
    for (let xStep = 0; xStep <= 8; xStep++) {
        for (let yStep = 0; yStep <= 8; yStep++) {
            addSpreadPair(1 - (xStep / 8), 1 - (yStep / 8));
        }
    }

    for (const spread of spreadPairs) {
        const placements = anchors.map((anchor) => buildPlacementAt({
            pixelX: Math.round(centerX + (anchor.x * availableX * spread.x)),
            pixelY: Math.round(centerY + (anchor.y * availableY * spread.y)),
            maskSpace,
            dimensions,
            orientation
        }));

        if (placementsOverlap(placements, dimensions, pixelsPerMm)) continue;
        const allValid = placements.every((placement) => maskContainsEnvelope({
            maskSpace,
            supportMask,
            centerX: placement.pixelX,
            centerY: placement.pixelY,
            config,
            orientation
        }));
        if (allValid) return placements;
    }

    return [];
}

function getPlacementSpreadScore(placements) {
    if (!placements.length) return -Infinity;
    const centerX = placements.reduce((sum, placement) => sum + placement.pixelX, 0) / placements.length;
    const centerY = placements.reduce((sum, placement) => sum + placement.pixelY, 0) / placements.length;
    return placements.reduce((sum, placement) => (
        sum + Math.hypot(placement.pixelX - centerX, placement.pixelY - centerY)
    ), 0);
}

function fillCavityMask(maskSpace, cavityMask, placements, config) {
    const pixelsPerMm = maskSpace.pixelsPerMm || 24;
    const width = maskSpace.width;
    const height = maskSpace.height;

    placements.forEach((placement) => {
        const halfWidth = (placement.cavityWidthMm * pixelsPerMm) / 2;
        const halfDepth = (placement.cavityDepthMm * pixelsPerMm) / 2;
        const minY = Math.max(0, Math.ceil(placement.pixelY - halfDepth));
        const maxY = Math.min(height - 1, Math.floor(placement.pixelY + halfDepth));

        for (let y = minY; y <= maxY; y++) {
            let rowHalfWidth = halfWidth;
            if (config.shape === 'disc') {
                const dy = y - placement.pixelY;
                const remaining = (halfDepth * halfDepth) - (dy * dy);
                if (remaining < 0) continue;
                rowHalfWidth = Math.sqrt(remaining);
            }
            const minX = Math.max(0, Math.ceil(placement.pixelX - rowHalfWidth));
            const maxX = Math.min(width - 1, Math.floor(placement.pixelX + rowHalfWidth));
            const rowOffset = y * width;
            for (let x = minX; x <= maxX; x++) {
                cavityMask[rowOffset + x] = 1;
            }
        }
    });
}

function createDisabledResult(config, requestedBaseThickness) {
    return {
        enabled: false,
        valid: true,
        config,
        requestedCount: config.count,
        fittedCount: 0,
        placements: [],
        cavityMask: null,
        carvedBaseMask: null,
        orientation: 0,
        cavityHeight: 0,
        cavityZStart: 0,
        cavityZEnd: 0,
        pauseZ: null,
        requiredBaseThickness: requestedBaseThickness,
        effectiveBaseThickness: requestedBaseThickness,
        autoThickenedBy: 0,
        errors: [],
        warnings: [],
        message: ''
    };
}

export function resolveMagnetPocketPlan({
    config: rawConfig,
    supportMask,
    maskSpace,
    requestedBaseThickness
}) {
    const config = normalizeMagnetPocketConfig(rawConfig);
    const baseThickness = clampNumber(requestedBaseThickness, 0.1, 1000, 4);
    if (!config.enabled) return createDisabledResult(config, baseThickness);

    const errors = [];
    const warnings = [];
    if (!(supportMask instanceof Uint8Array) || !maskSpace) {
        errors.push('A printable support base is required for magnet pockets.');
    }

    const bounds = errors.length ? null : getFilledPixelBounds(maskSpace, supportMask);
    if (!bounds?.isValid) {
        errors.push('The support base has no area available for magnet pockets.');
    }

    const orientationOptions = config.shape === 'block' ? [0, 90] : [0];
    let placements = [];
    let orientation = 0;

    if (!errors.length) {
        const solutions = [];
        for (const candidateOrientation of orientationOptions) {
            const candidatePlacements = findBalancedPlacements({
                maskSpace,
                supportMask,
                config,
                orientation: candidateOrientation,
                bounds,
                count: config.count
            });
            if (candidatePlacements.length === config.count) {
                solutions.push({
                    orientation: candidateOrientation,
                    placements: candidatePlacements,
                    score: getPlacementSpreadScore(candidatePlacements)
                });
            }
        }
        solutions.sort((left, right) => right.score - left.score);
        if (solutions.length) {
            placements = solutions[0].placements;
            orientation = solutions[0].orientation;
        }
    }

    let fittedCount = placements.length;
    if (!errors.length && fittedCount !== config.count) {
        for (let fallbackCount = config.count - 1; fallbackCount >= 1; fallbackCount--) {
            let fallbackPlacements = [];
            let fallbackOrientation = 0;
            for (const candidateOrientation of orientationOptions) {
                fallbackPlacements = findBalancedPlacements({
                    maskSpace,
                    supportMask,
                    config,
                    orientation: candidateOrientation,
                    bounds,
                    count: fallbackCount
                });
                if (fallbackPlacements.length === fallbackCount) {
                    fallbackOrientation = candidateOrientation;
                    break;
                }
            }
            if (fallbackPlacements.length === fallbackCount) {
                fittedCount = fallbackCount;
                orientation = fallbackOrientation;
                break;
            }
        }
        errors.push(
            fittedCount > 0
                ? `Only ${fittedCount} of ${config.count} magnet pockets fit with the current size and wall clearance.`
                : 'No magnet pockets fit with the current size and wall clearance.'
        );
        placements = [];
    }

    const cavityHeight = roundMillimetres(config.height + config.clearanceZ);
    const cavityZStart = config.mode === 'hidden' ? roundMillimetres(config.floor) : 0;
    const cavityZEnd = roundMillimetres(cavityZStart + cavityHeight);
    const requiredBaseThickness = roundMillimetres(cavityZEnd + config.roof);
    const effectiveBaseThickness = Math.max(baseThickness, requiredBaseThickness);
    const autoThickenedBy = roundMillimetres(effectiveBaseThickness - baseThickness);
    if (autoThickenedBy > 0) {
        warnings.push(
            `Base thickness increases from ${roundMillimetres(baseThickness)} to ${roundMillimetres(effectiveBaseThickness)} mm for the magnet pocket.`
        );
    }

    const cavityMask = errors.length ? null : createEmptyMask(maskSpace);
    if (cavityMask) fillCavityMask(maskSpace, cavityMask, placements, config);
    const carvedBaseMask = cavityMask ? subtractMaskData(supportMask, cavityMask) : null;
    const label = formatMagnetPocketLabel(config);
    const message = errors.length
        ? errors[0]
        : config.mode === 'hidden'
            ? `Insert ${config.count} × ${label} magnets at Z ${roundMillimetres(cavityZEnd)} mm, keep them below the cavity edge, then resume.`
            : `${config.count} × ${label} bottom recess${config.count === 1 ? '' : 'es'} ready through Z ${roundMillimetres(cavityZEnd)} mm.`;

    return {
        enabled: true,
        valid: errors.length === 0,
        config,
        requestedCount: config.count,
        fittedCount,
        placements,
        cavityMask,
        carvedBaseMask,
        orientation,
        cavityHeight,
        cavityZStart,
        cavityZEnd,
        pauseZ: config.mode === 'hidden' ? cavityZEnd : null,
        requiredBaseThickness,
        effectiveBaseThickness,
        autoThickenedBy,
        errors,
        warnings,
        message
    };
}
