import { BED_PRESETS } from '../config.js?v=r-78ade4c03db6e3a2';

const POSITION_EPSILON = 1e-5;
const TRIANGLE_AREA_EPSILON_SQUARED = 1e-16;
const BED_TOLERANCE_MM = 0.05;
// Two same-colour regions that touch at a single diagonal pixel corner weld into
// one shared vertical edge. The shell stays closed and slicers repair the pinch on
// import, so a handful of them is a warning. An abnormal share of pinched edges
// still means the mesh is genuinely broken, so keep an error ceiling.
const NON_MANIFOLD_EDGE_ERROR_RATIO = 0.001;
const NON_MANIFOLD_EDGE_ERROR_FLOOR = 8;

function createEmptyBounds() {
    return {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity
    };
}

function finalizeBounds(bounds) {
    const isValid = Object.values(bounds).every(Number.isFinite);
    if (!isValid) {
        return {
            isValid: false,
            minX: 0,
            minY: 0,
            minZ: 0,
            maxX: 0,
            maxY: 0,
            maxZ: 0,
            width: 0,
            depth: 0,
            height: 0,
            centerX: 0,
            centerY: 0,
            centerZ: 0
        };
    }

    return {
        ...bounds,
        isValid: true,
        width: bounds.maxX - bounds.minX,
        depth: bounds.maxY - bounds.minY,
        height: bounds.maxZ - bounds.minZ,
        centerX: (bounds.minX + bounds.maxX) / 2,
        centerY: (bounds.minY + bounds.maxY) / 2,
        centerZ: (bounds.minZ + bounds.maxZ) / 2
    };
}

function updateBounds(bounds, x, y, z, scaleX, scaleY, scaleZ) {
    const scaledX = x * scaleX;
    const scaledY = y * scaleY;
    const scaledZ = z * scaleZ;
    bounds.minX = Math.min(bounds.minX, scaledX);
    bounds.minY = Math.min(bounds.minY, scaledY);
    bounds.minZ = Math.min(bounds.minZ, scaledZ);
    bounds.maxX = Math.max(bounds.maxX, scaledX);
    bounds.maxY = Math.max(bounds.maxY, scaledY);
    bounds.maxZ = Math.max(bounds.maxZ, scaledZ);
}

export function getGeometryBundleBounds(geometryBundle, {
    scaleX = 1,
    scaleY = 1,
    scaleZ = 1
} = {}) {
    const bounds = createEmptyBounds();
    geometryBundle?.layers?.forEach((layerData) => {
        const position = layerData?.geometry?.getAttribute?.('position');
        if (!position) return;
        for (let index = 0; index < position.count; index++) {
            updateBounds(
                bounds,
                position.getX(index),
                position.getY(index),
                position.getZ(index),
                scaleX,
                scaleY,
                scaleZ
            );
        }
    });
    return finalizeBounds(bounds);
}

function getVertexKey(position, vertexIndex) {
    const x = Math.round(position.getX(vertexIndex) / POSITION_EPSILON);
    const y = Math.round(position.getY(vertexIndex) / POSITION_EPSILON);
    const z = Math.round(position.getZ(vertexIndex) / POSITION_EPSILON);
    return `${x},${y},${z}`;
}

function validateLayerMesh(layerData, layerIndex) {
    const errors = [];
    const warnings = [];
    const geometry = layerData?.geometry;
    const position = geometry?.getAttribute?.('position');
    const index = geometry?.index;
    const label = layerData?.displayLabel || `Layer ${layerIndex + 1}`;

    if (!position || position.count < 3) {
        return {
            errors: [`${label} has no printable mesh.`],
            warnings: [],
            triangleCount: 0,
            boundaryEdgeCount: 0,
            nonManifoldEdgeCount: 0,
            degenerateTriangleCount: 0,
            signedVolume: 0
        };
    }

    for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex++) {
        if (
            !Number.isFinite(position.getX(vertexIndex))
            || !Number.isFinite(position.getY(vertexIndex))
            || !Number.isFinite(position.getZ(vertexIndex))
        ) {
            errors.push(`${label} contains an invalid vertex.`);
            break;
        }
    }

    const elementCount = index ? index.count : position.count;
    if (elementCount % 3 !== 0) {
        errors.push(`${label} has an incomplete triangle.`);
    }

    const edgeCounts = new Map();
    let degenerateTriangleCount = 0;
    let signedVolume = 0;

    const getVertexIndex = (elementIndex) => index ? index.getX(elementIndex) : elementIndex;
    const recordEdge = (startIndex, endIndex) => {
        const startKey = getVertexKey(position, startIndex);
        const endKey = getVertexKey(position, endIndex);
        const edgeKey = startKey < endKey
            ? `${startKey}|${endKey}`
            : `${endKey}|${startKey}`;
        edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) || 0) + 1);
    };

    for (let elementIndex = 0; elementIndex + 2 < elementCount; elementIndex += 3) {
        const aIndex = getVertexIndex(elementIndex);
        const bIndex = getVertexIndex(elementIndex + 1);
        const cIndex = getVertexIndex(elementIndex + 2);
        if (
            aIndex < 0 || aIndex >= position.count
            || bIndex < 0 || bIndex >= position.count
            || cIndex < 0 || cIndex >= position.count
        ) {
            errors.push(`${label} contains an invalid triangle index.`);
            continue;
        }

        const ax = position.getX(aIndex);
        const ay = position.getY(aIndex);
        const az = position.getZ(aIndex);
        const bx = position.getX(bIndex);
        const by = position.getY(bIndex);
        const bz = position.getZ(bIndex);
        const cx = position.getX(cIndex);
        const cy = position.getY(cIndex);
        const cz = position.getZ(cIndex);

        const abx = bx - ax;
        const aby = by - ay;
        const abz = bz - az;
        const acx = cx - ax;
        const acy = cy - ay;
        const acz = cz - az;
        const crossX = aby * acz - abz * acy;
        const crossY = abz * acx - abx * acz;
        const crossZ = abx * acy - aby * acx;
        const areaSquared = crossX * crossX + crossY * crossY + crossZ * crossZ;
        if (areaSquared <= TRIANGLE_AREA_EPSILON_SQUARED) {
            degenerateTriangleCount += 1;
        }

        signedVolume += (
            ax * (by * cz - bz * cy)
            - ay * (bx * cz - bz * cx)
            + az * (bx * cy - by * cx)
        ) / 6;

        recordEdge(aIndex, bIndex);
        recordEdge(bIndex, cIndex);
        recordEdge(cIndex, aIndex);
    }

    let boundaryEdgeCount = 0;
    let nonManifoldEdgeCount = 0;
    edgeCounts.forEach((count) => {
        if (count === 1) boundaryEdgeCount += 1;
        // Only an edge shared by three or more faces is non-manifold. Counting
        // boundary edges here too used to double-report every open edge.
        if (count > 2) nonManifoldEdgeCount += 1;
    });

    if (degenerateTriangleCount > 0) {
        errors.push(`${label} contains ${degenerateTriangleCount} zero-area triangle${degenerateTriangleCount === 1 ? '' : 's'}.`);
    }
    if (boundaryEdgeCount > 0) {
        errors.push(`${label} has ${boundaryEdgeCount} open mesh edge${boundaryEdgeCount === 1 ? '' : 's'}.`);
    }
    if (nonManifoldEdgeCount > 0) {
        const message = `${label} has ${nonManifoldEdgeCount} non-manifold edge${nonManifoldEdgeCount === 1 ? '' : 's'}.`;
        const errorThreshold = Math.max(
            NON_MANIFOLD_EDGE_ERROR_FLOOR,
            Math.ceil(edgeCounts.size * NON_MANIFOLD_EDGE_ERROR_RATIO)
        );
        if (nonManifoldEdgeCount > errorThreshold) {
            errors.push(message);
        } else {
            warnings.push(message);
        }
    }
    if (Math.abs(signedVolume) <= POSITION_EPSILON) {
        errors.push(`${label} has no enclosed printable volume.`);
    }

    return {
        errors,
        warnings,
        triangleCount: Math.floor(elementCount / 3),
        boundaryEdgeCount,
        nonManifoldEdgeCount,
        degenerateTriangleCount,
        signedVolume
    };
}

export function validateGeometryBundleForPrint(geometryBundle, {
    bedKey = 'x1',
    margin = 5
} = {}) {
    const errors = [];
    const warnings = [];
    const layers = [];
    const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
    const safeMargin = Number.isFinite(margin) ? Math.max(0, margin) : 5;
    const bounds = getGeometryBundleBounds(geometryBundle);

    geometryBundle?.layers?.forEach((layerData, layerIndex) => {
        const sourceGeometries = Array.isArray(layerData?.geometryParts) && layerData.geometryParts.length
            ? layerData.geometryParts
            : [layerData?.geometry];
        sourceGeometries.forEach((geometry, partIndex) => {
            const label = sourceGeometries.length > 1
                ? `${layerData?.displayLabel || `Layer ${layerIndex + 1}`} part ${partIndex + 1}`
                : layerData?.displayLabel || `Layer ${layerIndex + 1}`;
            const result = validateLayerMesh({
                ...layerData,
                displayLabel: label,
                geometry
            }, layerIndex);
            layers.push({
                label,
                ...result
            });
            errors.push(...result.errors);
            warnings.push(...(result.warnings || []));
        });
    });

    if (!layers.length || !bounds.isValid) {
        errors.push('No printable geometry was generated.');
    } else {
        const usableWidth = Math.max(1, bed.width - safeMargin * 2);
        const usableDepth = Math.max(1, bed.depth - safeMargin * 2);
        const placedMinX = bed.width / 2 + bounds.minX;
        const placedMaxX = bed.width / 2 + bounds.maxX;
        const placedMinY = bed.depth / 2 + bounds.minY;
        const placedMaxY = bed.depth / 2 + bounds.maxY;
        if (bounds.width > usableWidth + BED_TOLERANCE_MM) {
            errors.push(`Model width ${bounds.width.toFixed(1)} mm exceeds the usable ${bed.label} width.`);
        }
        if (bounds.depth > usableDepth + BED_TOLERANCE_MM) {
            errors.push(`Model depth ${bounds.depth.toFixed(1)} mm exceeds the usable ${bed.label} depth.`);
        }
        if (
            placedMinX < safeMargin - BED_TOLERANCE_MM
            || placedMaxX > bed.width - safeMargin + BED_TOLERANCE_MM
            || placedMinY < safeMargin - BED_TOLERANCE_MM
            || placedMaxY > bed.depth - safeMargin + BED_TOLERANCE_MM
        ) {
            errors.push(`Model placement crosses the ${safeMargin.toFixed(1)} mm ${bed.label} safety margin.`);
        }
        if (bounds.minZ < -BED_TOLERANCE_MM) {
            errors.push(`Model extends ${Math.abs(bounds.minZ).toFixed(2)} mm below the print bed.`);
        }
        if (bounds.minZ > BED_TOLERANCE_MM) {
            errors.push(`Model starts ${bounds.minZ.toFixed(2)} mm above the print bed.`);
        }
        if (bounds.maxZ > bed.height + BED_TOLERANCE_MM) {
            errors.push(`Model height ${bounds.maxZ.toFixed(1)} mm exceeds the ${bed.label} height.`);
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        bounds,
        bed,
        margin: safeMargin,
        layers,
        triangleCount: layers.reduce((sum, layer) => sum + layer.triangleCount, 0)
    };
}
