import {
    buildObjGeometryBundle,
    buildObjModelPlan,
    sanitizeGeometryForPrint
} from './obj-model-plan.js?v=r-afbde72383fa3b50';
import { fitObjScalePlanToGeometryBounds } from './obj-scale.js?v=r-afbde72383fa3b50';
import {
    buildBambuProjectFiles,
    buildBambuProjectFilesAsync
} from './bambu-project.js?v=r-afbde72383fa3b50';
import { BAMBU_PROJECT_NOZZLE_DIAMETER } from './config.js?v=r-afbde72383fa3b50';
import { canvasToBlobAsync, dataUrlToBlob } from './raster-utils.js?v=r-afbde72383fa3b50';
import { layerHasPaths } from './shared/trace-utils.js?v=r-afbde72383fa3b50';
import { svgToPng } from './shared/svg-renderer.js?v=r-afbde72383fa3b50';
import { getCanonicalBedCenter } from './shared/canonical-3d.js?v=r-afbde72383fa3b50';
import {
    getGeometryBundleBounds,
    validateGeometryBundleForPrint
} from './shared/print-validation.js?v=r-afbde72383fa3b50';
import {
    createObjGeometrySnapshot,
    objGeometrySnapshotsMatch
} from './shared/obj-geometry-snapshot.js?v=r-afbde72383fa3b50';
import { waitForBrowserPaint, yieldToBrowser } from './shared/bambu-send-progress.js?v=r-afbde72383fa3b50';
import { createBambuSendWorkflow } from './bambu-send-workflow.js?v=r-afbde72383fa3b50';

const THREE_MF_BLOB_TYPE = 'model/3mf';

function throwIfBambuSendAborted(signal) {
    if (!signal?.aborted) return;
    const error = new Error('Bambu send cancelled.');
    error.name = 'AbortError';
    error.code = 'BAMBU_SEND_CANCELLED';
    throw error;
}

async function yieldDuringBambuSend(signal) {
    throwIfBambuSendAborted(signal);
    await yieldToBrowser();
    throwIfBambuSendAborted(signal);
}

function cloneLayerGeometryData(layerData) {
    return {
        ...layerData,
        geometry: layerData.geometry.clone(),
        geometryParts: Array.isArray(layerData.geometryParts)
            ? layerData.geometryParts.map((geometry) => geometry.clone())
            : []
    };
}

function cloneGeometryBundleData(geometryBundle) {
    const cloned = {
        ...geometryBundle,
        plan: geometryBundle?.plan
            ? {
                ...geometryBundle.plan,
                scalePlan: geometryBundle.plan.scalePlan
                    ? { ...geometryBundle.plan.scalePlan }
                    : geometryBundle.plan.scalePlan
            }
            : geometryBundle?.plan,
        layers: new Map()
    };
    geometryBundle?.layers?.forEach((layerData, layerKey) => {
        cloned.layers.set(layerKey, cloneLayerGeometryData(layerData));
    });
    return cloned;
}

// Pinched (non-manifold) edges keep the shell closed, so they are reported rather
// than thrown. Bambu Studio / OrcaSlicer repair them silently on import.
function describePrintValidationWarnings(validation) {
    const warningCount = validation?.warnings?.length || 0;
    if (!warningCount) return '';
    return `${warningCount} minor mesh pinch${warningCount === 1 ? '' : 'es'} detected — Bambu Studio will auto-repair.`;
}

function appendPrintValidationWarnings(message, validation) {
    const warning = describePrintValidationWarnings(validation);
    return warning ? `${message} ${warning}` : message;
}

function disposeLayerGeometryData(layerData) {
    layerData?.geometry?.dispose?.();
    layerData?.geometryParts?.forEach((geometry) => geometry?.dispose?.());
}

function buildMtl(materials, name) {
    if (!materials || materials.size === 0) return '';
    let output = `# ${name}.mtl\n`;
    materials.forEach((material) => {
        const color = material.color || { r: 0, g: 0, b: 0 };
        output += `newmtl ${material.name}\n`;
        output += `Ka 0 0 0\n`;
        output += `Kd ${color.r.toFixed(4)} ${color.g.toFixed(4)} ${color.b.toFixed(4)}\n`;
        output += `Ks 0 0 0\n`;
        output += `d 1\n`;
        output += `illum 1\n\n`;
    });
    return output;
}

// Generate binary STL from geometry
function geometryToSTL(geometry) {
    const THREERef = window.THREE;
    if (!THREERef) return null;

    // Ensure we have a non-indexed geometry
    let geo = geometry;
    if (geometry.index) {
        geo = geometry.toNonIndexed();
    }

    const vertices = geo.getAttribute('position');
    const normals = geo.getAttribute('normal');
    const triangles = [];
    const vA = new THREERef.Vector3();
    const vB = new THREERef.Vector3();
    const vC = new THREERef.Vector3();
    const nA = new THREERef.Vector3();
    const nB = new THREERef.Vector3();
    const nC = new THREERef.Vector3();
    const faceNormal = new THREERef.Vector3();
    const edge1 = new THREERef.Vector3();
    const edge2 = new THREERef.Vector3();

    for (let idx = 0; idx < vertices.count; idx += 3) {
        vA.fromBufferAttribute(vertices, idx);
        vB.fromBufferAttribute(vertices, idx + 1);
        vC.fromBufferAttribute(vertices, idx + 2);

        edge1.subVectors(vB, vA);
        edge2.subVectors(vC, vA);
        faceNormal.crossVectors(edge1, edge2);
        if (faceNormal.lengthSq() <= 1e-24) continue;

        if (normals) {
            nA.fromBufferAttribute(normals, idx);
            nB.fromBufferAttribute(normals, idx + 1);
            nC.fromBufferAttribute(normals, idx + 2);
            faceNormal.addVectors(nA, nB).add(nC);
            if (faceNormal.lengthSq() <= 1e-24) {
                faceNormal.crossVectors(edge1, edge2);
            }
        }

        triangles.push({
            normal: faceNormal.clone().normalize(),
            vertices: [
                vA.clone(),
                vB.clone(),
                vC.clone()
            ]
        });
    }

    const triangleCount = triangles.length;
    if (!triangleCount) {
        if (geo !== geometry) geo.dispose();
        return null;
    }

    // Binary STL: 80 byte header + 4 byte triangle count + (50 bytes per triangle)
    const bufferSize = 84 + triangleCount * 50;
    const buffer = new ArrayBuffer(bufferSize);
    const dataView = new DataView(buffer);

    // Header (80 bytes) - can be anything
    const header = 'Binary STL exported from ImageToSVG-for-3D-Print';
    for (let i = 0; i < 80; i++) {
        dataView.setUint8(i, i < header.length ? header.charCodeAt(i) : 0);
    }

    // Triangle count
    dataView.setUint32(80, triangleCount, true);

    let offset = 84;
    triangles.forEach((triangle) => {
        const [a, b, c] = triangle.vertices;

        // Normal
        dataView.setFloat32(offset, triangle.normal.x, true); offset += 4;
        dataView.setFloat32(offset, triangle.normal.y, true); offset += 4;
        dataView.setFloat32(offset, triangle.normal.z, true); offset += 4;

        // Vertex 1
        dataView.setFloat32(offset, a.x, true); offset += 4;
        dataView.setFloat32(offset, a.y, true); offset += 4;
        dataView.setFloat32(offset, a.z, true); offset += 4;

        // Vertex 2
        dataView.setFloat32(offset, b.x, true); offset += 4;
        dataView.setFloat32(offset, b.y, true); offset += 4;
        dataView.setFloat32(offset, b.z, true); offset += 4;

        // Vertex 3
        dataView.setFloat32(offset, c.x, true); offset += 4;
        dataView.setFloat32(offset, c.y, true); offset += 4;
        dataView.setFloat32(offset, c.z, true); offset += 4;

        // Attribute byte count (unused)
        dataView.setUint16(offset, 0, true); offset += 2;
    });

    if (geo !== geometry) {
        geo.dispose();
    }

    return buffer;
}

function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('Failed to load project preview image.'));
        image.src = dataUrl;
    });
}

async function blobToUint8Array(blob) {
    return new Uint8Array(await blob.arrayBuffer());
}

async function renderCanvasToPngBytes(width, height, drawFn) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { alpha: true });
    drawFn(ctx, canvas);
    const blob = await canvasToBlobAsync(canvas, 'image/png');
    return blobToUint8Array(blob);
}

function drawContainedImage(ctx, image, width, height, { padding = 0, background = null } = {}) {
    if (background) {
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, width, height);
    } else {
        ctx.clearRect(0, 0, width, height);
    }

    const contentWidth = Math.max(1, width - padding * 2);
    const contentHeight = Math.max(1, height - padding * 2);
    const scale = Math.min(contentWidth / image.width, contentHeight / image.height);
    const drawWidth = image.width * scale;
    const drawHeight = image.height * scale;
    const drawX = (width - drawWidth) / 2;
    const drawY = (height - drawHeight) / 2;
    ctx.drawImage(image, drawX, drawY, drawWidth, drawHeight);
}

async function buildBambuPreviewAssets({ tracer, state, getDataToExport, bedKey, scalePlan }) {
    if (!tracer || !state?.lastOptions || !getDataToExport) return {};

    const exportData = getDataToExport();
    if (!exportData) return {};

    const svgString = tracer.getsvgstring(exportData, state.lastOptions);
    const previewDataUrl = await svgToPng(svgString, 1024, null, true, null);
    const previewImage = await loadImageFromDataUrl(previewDataUrl);
    const { bed } = getCanonicalBedCenter(bedKey);

    const renderThumbnail = (size, padding) => renderCanvasToPngBytes(size, size, (ctx, canvas) => {
        drawContainedImage(ctx, previewImage, canvas.width, canvas.height, {
            padding,
            background: '#ffffff'
        });
    });

    const renderPlate = (size) => renderCanvasToPngBytes(size, size, (ctx, canvas) => {
        const plateInset = Math.round(size * 0.08);
        const plateX = plateInset;
        const plateY = plateInset;
        const plateWidth = canvas.width - plateInset * 2;
        const plateHeight = canvas.height - plateInset * 2;

        ctx.fillStyle = '#111827';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#20242d';
        ctx.fillRect(plateX, plateY, plateWidth, plateHeight);

        ctx.strokeStyle = 'rgba(209, 213, 219, 0.18)';
        const gridStepX = plateWidth / 10;
        const gridStepY = plateHeight / 10;
        for (let x = plateX; x <= plateX + plateWidth + 0.5; x += gridStepX) {
            ctx.beginPath();
            ctx.moveTo(x, plateY);
            ctx.lineTo(x, plateY + plateHeight);
            ctx.stroke();
        }
        for (let y = plateY; y <= plateY + plateHeight + 0.5; y += gridStepY) {
            ctx.beginPath();
            ctx.moveTo(plateX, y);
            ctx.lineTo(plateX + plateWidth, y);
            ctx.stroke();
        }

        const bedScaleX = plateWidth / bed.width;
        const bedScaleY = plateHeight / bed.depth;
        const drawWidth = Math.max(1, (scalePlan?.footprintWidth || previewImage.width) * bedScaleX);
        const drawHeight = Math.max(1, (scalePlan?.footprintDepth || previewImage.height) * bedScaleY);
        const drawX = plateX + (plateWidth - drawWidth) / 2;
        const drawY = plateY + (plateHeight - drawHeight) / 2;
        ctx.drawImage(previewImage, drawX, drawY, drawWidth, drawHeight);
    });

    const [thumbnailLarge, thumbnailSmall, plateLarge, plateSmall] = await Promise.all([
        renderThumbnail(512, 24),
        renderThumbnail(256, 18),
        renderPlate(1024),
        renderPlate(512)
    ]);

    return { thumbnailLarge, thumbnailSmall, plateLarge, plateSmall };
}

function buildBambuProjectGeometryLayers(geometryBundle, bedKey = 'x1') {
    const placement = getCanonicalBedCenter(bedKey);
    const layers = [];
    let materialIndex = 0;

    geometryBundle.layers.forEach((layerData) => {
        const sourceParts = Array.isArray(layerData.geometryParts) && layerData.geometryParts.length
            ? layerData.geometryParts
            : [layerData.geometry];
        sourceParts.forEach((sourceGeometry, partIndex) => {
            const geometry = sourceGeometry.clone();
            geometry.computeVertexNormals();
            layers.push({
                ...layerData,
                displayLabel: sourceParts.length > 1
                    ? `${layerData.displayLabel || `Layer ${materialIndex + 1}`} · Part ${partIndex + 1}`
                    : layerData.displayLabel,
                geometry,
                geometryParts: [],
                materialIndex,
                translation: placement
            });
        });
        materialIndex += 1;
    });

    return layers;
}

async function generateBambuProject3MF({
    geometryBundle,
    baseName,
    bedKey,
    tracer,
    state,
    getDataToExport,
    cooperative = false,
    onProgress,
    yieldControl = yieldToBrowser
}) {
    const placedLayers = buildBambuProjectGeometryLayers(geometryBundle, bedKey);
    try {
        onProgress?.({ phase: 'preview', ratio: 0 });
        const previewAssets = await buildBambuPreviewAssets({
            tracer,
            state,
            getDataToExport,
            bedKey,
            scalePlan: geometryBundle?.plan?.scalePlan
        });
        onProgress?.({ phase: 'preview', ratio: 1 });
        if (cooperative) await yieldControl();

        const projectOptions = {
            layers: placedLayers,
            baseName,
            bedKey,
            nozzleDiameter: BAMBU_PROJECT_NOZZLE_DIAMETER,
            previewAssets,
            pauseEvents: geometryBundle?.plan?.pauseEvents || []
        };
        const project = cooperative
            ? await buildBambuProjectFilesAsync({
                ...projectOptions,
                yieldControl,
                onProgress: (event) => onProgress?.({
                    ...event,
                    phase: event.phase === 'mesh' ? 'serialize-mesh' : 'serialize-xml'
                })
            })
            : buildBambuProjectFiles(projectOptions);
        if (!project) return null;
        const blob = await createZipFile(project.files, {
            mimeType: THREE_MF_BLOB_TYPE,
            yieldControl: cooperative ? yieldControl : undefined,
            onProgress: cooperative
                ? (ratio) => onProgress?.({ phase: 'zip', ratio })
                : undefined
        });
        return { blob, project };
    } finally {
        placedLayers.forEach(disposeLayerGeometryData);
    }
}

function rgbToHex(r, g, b) {
    return [r, g, b].map(x => {
        const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('').toUpperCase();
}

async function normalizeZipContent(content, encoder) {
    if (content instanceof Blob) {
        return new Uint8Array(await content.arrayBuffer());
    }

    if (content instanceof Uint8Array) {
        return content;
    }

    if (content instanceof ArrayBuffer) {
        return new Uint8Array(content);
    }

    if (ArrayBuffer.isView(content)) {
        return new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
    }

    if (typeof content === 'string') {
        return encoder.encode(content);
    }

    return encoder.encode(String(content ?? ''));
}

// Simple ZIP file creator using JSZip if available, otherwise manual implementation
export async function createZipFile(files, {
    mimeType = 'application/zip',
    onProgress,
    yieldControl
} = {}) {
    const blobType = typeof mimeType === 'string' && mimeType.trim()
        ? mimeType.trim()
        : 'application/zip';
    // Try to use JSZip if available
    if (window.JSZip) {
        const zip = new window.JSZip();
        for (const [path, content] of Object.entries(files)) {
            zip.file(path, content);
        }
        const zipData = await zip.generateAsync(
            { type: 'uint8array', compression: 'DEFLATE' },
            ({ percent }) => onProgress?.(Math.max(0, Math.min(1, percent / 100)))
        );
        onProgress?.(1);
        return new Blob([zipData], { type: blobType });
    }

    // Fallback: create uncompressed ZIP manually
    const encoder = new TextEncoder();
    const fileEntries = [];
    let offset = 0;

    // Prepare file entries
    const sourceEntries = Object.entries(files);
    for (let entryIndex = 0; entryIndex < sourceEntries.length; entryIndex += 1) {
        const [path, content] = sourceEntries[entryIndex];
        const data = await normalizeZipContent(content, encoder);
        const pathBytes = encoder.encode(path);

        fileEntries.push({
            path,
            pathBytes,
            data,
            offset,
            crc32: crc32(data)
        });

        // Local file header (30 bytes) + path + data
        offset += 30 + pathBytes.length + data.length;
        onProgress?.(((entryIndex + 1) / Math.max(1, sourceEntries.length)) * 0.45);
        if (yieldControl) await yieldControl();
    }

    const centralDirOffset = offset;
    let centralDirSize = 0;

    // Calculate central directory size
    fileEntries.forEach(entry => {
        centralDirSize += 46 + entry.pathBytes.length;
    });

    // Total size
    const totalSize = offset + centralDirSize + 22;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    let pos = 0;

    // Write local file headers and data
    for (let entryIndex = 0; entryIndex < fileEntries.length; entryIndex += 1) {
        const entry = fileEntries[entryIndex];
        // Local file header signature
        view.setUint32(pos, 0x04034b50, true); pos += 4;
        // Version needed
        view.setUint16(pos, 20, true); pos += 2;
        // General purpose bit flag
        view.setUint16(pos, 0, true); pos += 2;
        // Compression method (0 = stored)
        view.setUint16(pos, 0, true); pos += 2;
        // File mod time
        view.setUint16(pos, 0, true); pos += 2;
        // File mod date
        view.setUint16(pos, 0, true); pos += 2;
        // CRC-32
        view.setUint32(pos, entry.crc32, true); pos += 4;
        // Compressed size
        view.setUint32(pos, entry.data.length, true); pos += 4;
        // Uncompressed size
        view.setUint32(pos, entry.data.length, true); pos += 4;
        // Filename length
        view.setUint16(pos, entry.pathBytes.length, true); pos += 2;
        // Extra field length
        view.setUint16(pos, 0, true); pos += 2;
        // Filename
        uint8.set(entry.pathBytes, pos); pos += entry.pathBytes.length;
        // File data
        uint8.set(entry.data, pos); pos += entry.data.length;
        onProgress?.(0.45 + (((entryIndex + 1) / Math.max(1, fileEntries.length)) * 0.35));
        if (yieldControl) await yieldControl();
    }

    // Write central directory
    for (let entryIndex = 0; entryIndex < fileEntries.length; entryIndex += 1) {
        const entry = fileEntries[entryIndex];
        // Central file header signature
        view.setUint32(pos, 0x02014b50, true); pos += 4;
        // Version made by
        view.setUint16(pos, 20, true); pos += 2;
        // Version needed
        view.setUint16(pos, 20, true); pos += 2;
        // General purpose bit flag
        view.setUint16(pos, 0, true); pos += 2;
        // Compression method
        view.setUint16(pos, 0, true); pos += 2;
        // File mod time
        view.setUint16(pos, 0, true); pos += 2;
        // File mod date
        view.setUint16(pos, 0, true); pos += 2;
        // CRC-32
        view.setUint32(pos, entry.crc32, true); pos += 4;
        // Compressed size
        view.setUint32(pos, entry.data.length, true); pos += 4;
        // Uncompressed size
        view.setUint32(pos, entry.data.length, true); pos += 4;
        // Filename length
        view.setUint16(pos, entry.pathBytes.length, true); pos += 2;
        // Extra field length
        view.setUint16(pos, 0, true); pos += 2;
        // Comment length
        view.setUint16(pos, 0, true); pos += 2;
        // Disk number start
        view.setUint16(pos, 0, true); pos += 2;
        // Internal file attributes
        view.setUint16(pos, 0, true); pos += 2;
        // External file attributes
        view.setUint32(pos, 0, true); pos += 4;
        // Relative offset of local header
        view.setUint32(pos, entry.offset, true); pos += 4;
        // Filename
        uint8.set(entry.pathBytes, pos); pos += entry.pathBytes.length;
        onProgress?.(0.8 + (((entryIndex + 1) / Math.max(1, fileEntries.length)) * 0.18));
        if (yieldControl) await yieldControl();
    }

    // End of central directory
    view.setUint32(pos, 0x06054b50, true); pos += 4;
    // Disk number
    view.setUint16(pos, 0, true); pos += 2;
    // Disk number with central dir
    view.setUint16(pos, 0, true); pos += 2;
    // Number of entries on this disk
    view.setUint16(pos, fileEntries.length, true); pos += 2;
    // Total number of entries
    view.setUint16(pos, fileEntries.length, true); pos += 2;
    // Central directory size
    view.setUint32(pos, centralDirSize, true); pos += 4;
    // Central directory offset
    view.setUint32(pos, centralDirOffset, true); pos += 4;
    // Comment length
    view.setUint16(pos, 0, true);

    onProgress?.(1);
    return new Blob([buffer], { type: blobType });
}

// CRC32 calculation
function crc32(data) {
    let crc = 0xFFFFFFFF;
    const table = getCRC32Table();
    for (let i = 0; i < data.length; i++) {
        crc = (crc >>> 8) ^ table[(crc ^ data[i]) & 0xFF];
    }
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

let crc32Table = null;
function getCRC32Table() {
    if (crc32Table) return crc32Table;
    crc32Table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) {
            c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        }
        crc32Table[i] = c;
    }
    return crc32Table;
}

export function createObjExporter({
    state,
    modelControls,
    exportControls,
    statusText,
    getDataToExport,
    ImageTracer,
    showLoader,
    downloadBlob,
    getImageBaseName
}) {
    const tracer = ImageTracer || window.ImageTracer;
    const model = modelControls || {};

    // ── Geometry cache ────────────────────────────────────────────────────────
    let cachedGeometry = null;
    let cachedGeometryKey = '';
    let cachedTracedata = null;
    let cachedTraceOptions = null;
    let threeMfDownloadInFlight = false;

    function report3mfDownloadPackageProgress(event) {
        const ratio = Math.max(0, Math.min(1, Number(event?.ratio) || 0));
        const phase = event?.phase;
        const progress = phase === 'preview'
            ? 0.54 + (ratio * 0.08)
            : phase === 'serialize-mesh'
                ? 0.62 + (ratio * 0.12)
                : phase === 'serialize-xml'
                    ? 0.74 + (ratio * 0.09)
                    : 0.83 + (ratio * 0.14);
        const subtitle = phase === 'preview'
            ? 'Creating Bambu Studio project previews.'
            : phase === 'serialize-mesh'
                ? `Writing mesh ${event.completed || 0} of ${event.total || 0}.`
                : phase === 'serialize-xml'
                    ? `Writing object ${event.completed || 0} of ${event.total || 0}.`
                    : 'Compressing the final Bambu Studio project.';
        showLoader(true, {
            title: 'Building AMS-ready 3MF…',
            subtitle,
            progress
        });
    }

    function getVisibleLayerIndices() {
        if (!state.tracedata) return [];
        const hidden = state.hiddenSourceLayerIds || new Set();
        const indices = [];
        for (let i = 0; i < state.tracedata.layers.length; i++) {
            if (layerHasPaths(state.tracedata.layers[i]) && !hidden.has(i)) indices.push(i);
        }
        return indices;
    }

    function buildExportGeometry(defaultThickness) {
        const visibleSourceLayerIds = getVisibleLayerIndices();
        const snapshot = createObjGeometrySnapshot({
            state,
            modelControls: model,
            visibleSourceLayerIds,
            defaultThickness
        });
        const key = snapshot.key;
        if (
            cachedGeometry
            && cachedGeometryKey === key
            && cachedTracedata === state.tracedata
            && cachedTraceOptions === state.lastOptions
        ) {
            // Clone cached geometries so callers can dispose without breaking the cache
            return cloneGeometryBundleData(cachedGeometry);
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const THREERef = window.THREE;
        const bufferUtils = window.BufferGeometryUtils || THREERef?.BufferGeometryUtils;
        if (!SVGLoader || !THREERef || !bufferUtils) return null;

        if (!visibleSourceLayerIds.length) return null;

        const marginValue = model.objMarginInput ? Number.parseFloat(model.objMarginInput.value) : 5;
        const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;
        const bedKey = model.objBedSelect?.value || 'x1';

        const plan = buildObjModelPlan({
            state,
            tracer,
            SVGLoader,
            THREERef,
            defaultThickness,
            visibleSourceLayerIds,
            decimatePercent: model.objDecimateSlider ? Number.parseFloat(model.objDecimateSlider.value) : 0,
            bedKey,
            margin,
            scalePercent: model.objScaleSlider ? Number.parseFloat(model.objScaleSlider.value) : 100,
            sourceScale: state.sourceRenderScale || 1,
            bezelPreset: model.objBezelSelect?.value || state.objParams?.bezelPreset || 'off'
        });
        if (!plan || plan.outputLayers.length === 0) return null;
        if (plan.magnetPocketResult?.enabled && !plan.magnetPocketResult.valid) {
            throw new Error(plan.magnetPocketResult.errors?.[0] || 'Magnet pocket placement is invalid.');
        }

        const geometryBundle = buildObjGeometryBundle(plan, { THREERef, bufferUtils });
        if (!geometryBundle || geometryBundle.layers.size === 0) return null;

        const scalePlan = plan.scalePlan;
        fitObjScalePlanToGeometryBounds(scalePlan, getGeometryBundleBounds(geometryBundle, {
            scaleX: scalePlan.scale,
            scaleY: scalePlan.scale
        }));

        geometryBundle.layers.forEach((layerData) => {
            layerData.geometry.scale(scalePlan.scale, scalePlan.scale, 1);
            (layerData.geometryParts || []).forEach((partGeometry) => {
                partGeometry.scale(scalePlan.scale, scalePlan.scale, 1);
            });
        });

        const uncenteredBounds = getGeometryBundleBounds(geometryBundle);
        if (uncenteredBounds.isValid) {
            geometryBundle.layers.forEach((layerData) => {
                layerData.geometry.translate(
                    -uncenteredBounds.centerX,
                    -uncenteredBounds.centerY,
                    -uncenteredBounds.minZ
                );
                layerData.geometryParts?.forEach((partGeometry) => {
                    partGeometry.translate(
                        -uncenteredBounds.centerX,
                        -uncenteredBounds.centerY,
                        -uncenteredBounds.minZ
                    );
                });
            });
        }

        // Centering writes the final Float32 coordinates and can collapse a
        // microscopic edge that survived the source-coordinate cleanup. Run
        // print sanitization in that final coordinate frame so validation and
        // the serialized mesh inspect the exact same triangles.
        geometryBundle.layers.forEach((layerData) => {
            layerData.geometry.computeVertexNormals();
            const sourceGeometry = layerData.geometry;
            layerData.geometry = sanitizeGeometryForPrint(
                sourceGeometry,
                THREERef,
                bufferUtils
            );
            sourceGeometry.dispose();

            layerData.geometryParts = (layerData.geometryParts || []).map((partGeometry) => {
                partGeometry.computeVertexNormals();
                const cleanedPart = sanitizeGeometryForPrint(
                    partGeometry,
                    THREERef,
                    bufferUtils
                );
                partGeometry.dispose();
                return cleanedPart;
            }).filter(Boolean);
        });

        const validation = validateGeometryBundleForPrint(geometryBundle, {
            bedKey,
            margin
        });
        if (!validation.ok) {
            geometryBundle.layers.forEach(disposeLayerGeometryData);
            throw new Error(`3D print validation failed: ${validation.errors[0]}`);
        }
        if (validation.warnings?.length) {
            console.warn(`3D print validation warnings: ${validation.warnings.join(' ')}`);
        }
        geometryBundle.validation = validation;
        geometryBundle.plan.printValidation = validation;
        geometryBundle.plan.scalePlan.actualFootprintWidth = validation.bounds.width;
        geometryBundle.plan.scalePlan.actualFootprintDepth = validation.bounds.depth;
        geometryBundle.plan.scalePlan.modelHeight = validation.bounds.height;

        // Dispose previous cache
        if (cachedGeometry) {
            cachedGeometry.layers.forEach(disposeLayerGeometryData);
        }
        cachedGeometry = geometryBundle;
        cachedGeometryKey = key;
        cachedTracedata = state.tracedata;
        cachedTraceOptions = state.lastOptions;

        // Return cloned geometries so callers can dispose freely
        return cloneGeometryBundleData(geometryBundle);
    }

    async function buildPreparedPreviewGeometryForSend(defaultThickness, onProgress, signal) {
        throwIfBambuSendAborted(signal);
        const visibleSourceLayerIds = getVisibleLayerIndices();
        const currentSnapshot = createObjGeometrySnapshot({
            state,
            modelControls: model,
            visibleSourceLayerIds,
            defaultThickness
        });
        const preview = state.objPreview;
        const previewCanvas = exportControls?.objPreviewCanvas;
        if (
            !objGeometrySnapshotsMatch(preview?.exportGeometrySnapshot, currentSnapshot)
            && previewCanvas?.dataset?.renderState === 'building'
        ) {
            onProgress?.({
                stage: 'Waiting for 3D preview',
                value: 5,
                detail: 'The updated print orientation is still being built…'
            });
            const waitDeadline = performance.now() + 60_000;
            while (
                performance.now() < waitDeadline
                && previewCanvas.dataset.renderState === 'building'
                && !objGeometrySnapshotsMatch(preview?.exportGeometrySnapshot, currentSnapshot)
            ) {
                await new Promise((resolve) => setTimeout(resolve, 50));
                throwIfBambuSendAborted(signal);
            }
        }
        if (
            !objGeometrySnapshotsMatch(preview?.exportGeometrySnapshot, currentSnapshot)
            || !preview?.lastGeometryBundle?.layers?.size
        ) {
            // This path reuses the preview mesh, so a browser that cannot create a
            // WebGL context never produces one. Say that plainly instead of asking
            // the user to wait for a preview that will never finish.
            if (preview?.webglUnavailable) {
                const webglError = new Error('3D transfer requires WebGL, which this browser does not provide. Enable hardware acceleration or use a different browser, then try again.');
                webglError.code = 'WEBGL_UNAVAILABLE';
                throw webglError;
            }
            const error = new Error('The 3D preview is not ready for this model. Wait for it to finish, then send again.');
            error.code = 'PREVIEW_NOT_READY';
            throw error;
        }

        const THREERef = window.THREE;
        const bufferUtils = window.BufferGeometryUtils || THREERef?.BufferGeometryUtils;
        const geometryBundle = cloneGeometryBundleData(preview.lastGeometryBundle);
        const plan = geometryBundle.plan;
        const scalePlan = plan?.scalePlan;
        const bedKey = model.objBedSelect?.value || 'x1';
        const marginValue = model.objMarginInput ? Number.parseFloat(model.objMarginInput.value) : 5;
        const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;

        try {
            onProgress?.({ stage: 'Preparing print geometry', value: 10, detail: 'Reusing the finished 3D preview…' });
            await yieldDuringBambuSend(signal);

            geometryBundle.layers.forEach((layerData, outputLayerId) => {
                const transform = preview.exportGeometryTransforms?.get(outputLayerId);
                const scaleZ = Number.isFinite(transform?.scaleZ) ? transform.scaleZ : 1;
                const translateZ = Number.isFinite(transform?.translateZ) ? transform.translateZ : 0;
                if (scaleZ === 1 && translateZ === 0) return;
                layerData.geometry.scale(1, 1, scaleZ);
                layerData.geometry.translate(0, 0, translateZ);
                (layerData.geometryParts || []).forEach((partGeometry) => {
                    partGeometry.scale(1, 1, scaleZ);
                    partGeometry.translate(0, 0, translateZ);
                });
            });

            fitObjScalePlanToGeometryBounds(scalePlan, getGeometryBundleBounds(geometryBundle, {
                scaleX: scalePlan.scale,
                scaleY: scalePlan.scale
            }));

            const layerEntries = [...geometryBundle.layers.values()];
            const layerTotal = Math.max(1, layerEntries.length);
            for (let layerIndex = 0; layerIndex < layerEntries.length; layerIndex += 1) {
                const layerData = layerEntries[layerIndex];
                layerData.geometry.scale(scalePlan.scale, scalePlan.scale, 1);
                (layerData.geometryParts || []).forEach((partGeometry) => {
                    partGeometry.scale(scalePlan.scale, scalePlan.scale, 1);
                });
                onProgress?.({
                    stage: 'Preparing print geometry',
                    value: 10 + (((layerIndex + 1) / layerTotal) * 8),
                    detail: `Scaling layer ${layerIndex + 1} of ${layerEntries.length}…`
                });
                await yieldDuringBambuSend(signal);
            }

            const uncenteredBounds = getGeometryBundleBounds(geometryBundle);
            if (uncenteredBounds.isValid) {
                geometryBundle.layers.forEach((layerData) => {
                    layerData.geometry.translate(
                        -uncenteredBounds.centerX,
                        -uncenteredBounds.centerY,
                        -uncenteredBounds.minZ
                    );
                    layerData.geometryParts?.forEach((partGeometry) => {
                        partGeometry.translate(
                            -uncenteredBounds.centerX,
                            -uncenteredBounds.centerY,
                            -uncenteredBounds.minZ
                        );
                    });
                });
            }
            onProgress?.({ stage: 'Checking print geometry', value: 20, detail: 'Repairing and checking printable surfaces…' });
            await yieldDuringBambuSend(signal);

            let completedParts = 0;
            const totalParts = Math.max(1, layerEntries.reduce(
                (total, layerData) => total + 1 + (layerData.geometryParts?.length || 0),
                0
            ));
            for (const layerData of layerEntries) {
                layerData.geometry.computeVertexNormals();
                const sourceGeometry = layerData.geometry;
                layerData.geometry = sanitizeGeometryForPrint(sourceGeometry, THREERef, bufferUtils);
                sourceGeometry.dispose();
                completedParts += 1;
                onProgress?.({
                    stage: 'Checking print geometry',
                    value: 20 + ((completedParts / totalParts) * 28),
                    detail: `Checking mesh ${completedParts} of ${totalParts}…`
                });
                await yieldDuringBambuSend(signal);

                const cleanedParts = [];
                for (const partGeometry of layerData.geometryParts || []) {
                    partGeometry.computeVertexNormals();
                    const cleanedPart = sanitizeGeometryForPrint(partGeometry, THREERef, bufferUtils);
                    partGeometry.dispose();
                    if (cleanedPart) cleanedParts.push(cleanedPart);
                    completedParts += 1;
                    onProgress?.({
                        stage: 'Checking print geometry',
                        value: 20 + ((completedParts / totalParts) * 28),
                        detail: `Checking mesh ${completedParts} of ${totalParts}…`
                    });
                    await yieldDuringBambuSend(signal);
                }
                layerData.geometryParts = cleanedParts;
            }

            const validation = validateGeometryBundleForPrint(geometryBundle, { bedKey, margin });
            if (!validation.ok) {
                throw new Error(`3D print validation failed: ${validation.errors[0]}`);
            }
            if (validation.warnings?.length) {
                console.warn(`3D print validation warnings: ${validation.warnings.join(' ')}`);
            }
            geometryBundle.validation = validation;
            plan.printValidation = validation;
            scalePlan.actualFootprintWidth = validation.bounds.width;
            scalePlan.actualFootprintDepth = validation.bounds.depth;
            scalePlan.modelHeight = validation.bounds.height;
            onProgress?.({
                stage: 'Print geometry ready',
                value: 52,
                detail: appendPrintValidationWarnings('Model passed the print checks.', validation)
            });
            await yieldDuringBambuSend(signal);
            return geometryBundle;
        } catch (error) {
            geometryBundle.layers.forEach(disposeLayerGeometryData);
            throw error;
        }
    }

    const bambuSendWorkflow = createBambuSendWorkflow({
        controls: exportControls,
        statusText,
        prepareGeometry: buildPreparedPreviewGeometryForSend,
        packageProject: ({ geometryBundle, baseName, bedKey, onProgress, signal }) => (
            generateBambuProject3MF({
                geometryBundle,
                baseName,
                bedKey,
                tracer,
                state,
                getDataToExport,
                cooperative: true,
                onProgress,
                yieldControl: () => yieldDuringBambuSend(signal)
            })
        ),
        downloadBlob,
        getSourceBaseName: getImageBaseName,
        getBaseName: (geometryBundle, defaultThickness, sourceBaseName) => (
            `${sourceBaseName || getImageBaseName()}_${Math.round(geometryBundle.plan.maxHeight || defaultThickness)}mm`
        ),
        getBedKey: () => model.objBedSelect?.value || 'x1',
        disposeGeometry: (geometryBundle) => geometryBundle.layers.forEach(disposeLayerGeometryData)
    });

    async function exportAsOBJ() {
        if (!state.tracedata) {
            if (statusText) statusText.textContent = 'Generate preview before exporting OBJ.';
            return;
        }

        const OBJExporter = window.OBJExporter || window.THREE?.OBJExporter;
        const THREERef = window.THREE;

        if (!OBJExporter || !THREERef || !window.SVGLoader || !window.BufferGeometryUtils) {
            if (statusText) statusText.textContent = 'OBJ export libraries are still loading.';
            return;
        }

        const thicknessValue = model.objThicknessSlider ? parseFloat(model.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;

        try {
            showLoader(true);
            if (statusText) statusText.textContent = 'Exporting OBJ...';

            const result = buildExportGeometry(defaultThickness);
            if (!result || result.layers.size === 0) {
                throw new Error('No geometry generated');
            }

            // Build merged group for OBJ export
            const group = new THREERef.Group();
            const materials = new Map();

            result.layers.forEach((layerData) => {
                const color = new THREERef.Color(
                    layerData.color.r / 255,
                    layerData.color.g / 255,
                    layerData.color.b / 255
                );
                const material = new THREERef.MeshStandardMaterial({ color });
                material.name = `mat_${layerData.hex}`;
                materials.set(layerData.hex, { name: material.name, color: { r: color.r, g: color.g, b: color.b } });

                const mesh = new THREERef.Mesh(layerData.geometry, material);
                group.add(mesh);
            });

            const exporter = new OBJExporter();
            group.updateMatrixWorld(true);
            let obj = exporter.parse(group);

            const baseName = `${getImageBaseName()}_${Math.round(result.plan.maxHeight || defaultThickness)}mm`;
            const mtl = buildMtl(materials, baseName);

            if (mtl) {
                obj = `mtllib ${baseName}.mtl\n` + obj;
                downloadBlob(new Blob([mtl], { type: 'text/plain' }), `${baseName}.mtl`);
            }

            downloadBlob(new Blob([obj], { type: 'text/plain' }), `${baseName}.obj`);
            if (statusText) {
                statusText.textContent = appendPrintValidationWarnings('OBJ export complete.', result.validation);
            }

            // Cleanup
            result.layers.forEach(disposeLayerGeometryData);
        } catch (error) {
            console.error('OBJ export failed:', error);
            if (statusText) statusText.textContent = error.message || 'Failed to export OBJ.';
        } finally {
            showLoader(false);
        }
    }

    async function exportAs3MF() {
        if (threeMfDownloadInFlight) return;
        if (!state.tracedata) {
            if (statusText) statusText.textContent = 'Generate preview before exporting 3MF.';
            return;
        }

        const THREERef = window.THREE;
        if (!THREERef || !window.SVGLoader || !window.BufferGeometryUtils) {
            if (statusText) statusText.textContent = '3MF export libraries are still loading.';
            return;
        }

        const thicknessValue = model.objThicknessSlider ? parseFloat(model.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;
        const exportButton = exportControls?.export3mfBtn || null;
        let result = null;

        try {
            threeMfDownloadInFlight = true;
            if (exportButton) {
                exportButton.disabled = true;
                exportButton.setAttribute('aria-busy', 'true');
            }
            showLoader(true, {
                title: 'Preparing AMS-ready 3MF…',
                subtitle: 'Checking the finished 3D preview.',
                progress: 0.02
            });
            if (statusText) statusText.textContent = 'Exporting Bambu Studio project...';
            await waitForBrowserPaint();

            result = await buildPreparedPreviewGeometryForSend(defaultThickness, (event) => {
                showLoader(true, {
                    title: 'Preparing AMS-ready 3MF…',
                    subtitle: event?.detail || event?.stage || 'Checking print geometry.',
                    progress: Math.max(0.03, Math.min(0.52, (Number(event?.value) || 0) / 100))
                });
            });
            if (!result || result.layers.size === 0) {
                throw new Error('No geometry generated');
            }

            const baseName = `${getImageBaseName()}_${Math.round(result.plan.maxHeight || defaultThickness)}mm`;
            const exportResult = await generateBambuProject3MF({
                geometryBundle: result,
                baseName,
                bedKey: model.objBedSelect?.value || 'x1',
                tracer,
                state,
                getDataToExport,
                cooperative: true,
                onProgress: report3mfDownloadPackageProgress,
                yieldControl: () => yieldDuringBambuSend()
            });
            if (!exportResult?.blob) {
                throw new Error('Failed to assemble the Bambu Studio project.');
            }
            const filename = `${baseName}.3mf`;
            downloadBlob(new Blob([exportResult.blob], { type: THREE_MF_BLOB_TYPE }), filename);
            if (statusText) {
                statusText.textContent = appendPrintValidationWarnings(
                    'Bambu Studio project downloaded. Open the .3mf in Bambu Studio.',
                    result.validation
                );
            }
            showLoader(true, {
                title: 'AMS-ready 3MF downloaded',
                subtitle: filename,
                progress: 1
            });
        } catch (error) {
            console.error('3MF export failed:', error);
            if (statusText) statusText.textContent = error.message || 'Failed to export 3MF.';
        } finally {
            result?.layers?.forEach(disposeLayerGeometryData);
            threeMfDownloadInFlight = false;
            if (exportButton) {
                exportButton.disabled = false;
                exportButton.setAttribute('aria-busy', 'false');
            }
            showLoader(false);
        }
    }

    async function exportAsSTL() {
        if (!state.tracedata) {
            if (statusText) statusText.textContent = 'Generate preview before exporting STL.';
            return;
        }

        const THREERef = window.THREE;
        if (!THREERef || !window.SVGLoader || !window.BufferGeometryUtils) {
            if (statusText) statusText.textContent = 'STL export libraries are still loading.';
            return;
        }

        const thicknessValue = model.objThicknessSlider ? parseFloat(model.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;

        try {
            showLoader(true);
            if (statusText) statusText.textContent = 'Exporting STL files...';

            const result = buildExportGeometry(defaultThickness);
            if (!result || result.layers.size === 0) {
                throw new Error('No geometry generated');
            }

            const baseName = `${getImageBaseName()}_${Math.round(result.plan.maxHeight || defaultThickness)}mm`;

            // Export each layer as separate STL
            let exportedCount = 0;
            Array.from(result.layers.values()).forEach((layerData, layerIndex) => {
                const stlBuffer = geometryToSTL(layerData.geometry);
                if (stlBuffer) {
                    const colorName = rgbToHex(layerData.color.r, layerData.color.g, layerData.color.b);
                    const fileName = `${baseName}_L${layerIndex}_${colorName}.stl`;
                    downloadBlob(new Blob([stlBuffer], { type: 'application/sla' }), fileName);
                    exportedCount++;
                }
            });

            if (statusText) {
                statusText.textContent = appendPrintValidationWarnings(
                    `Exported ${exportedCount} STL files.`,
                    result.validation
                );
            }

            // Cleanup
            result.layers.forEach(disposeLayerGeometryData);
        } catch (error) {
            console.error('STL export failed:', error);
            if (statusText) statusText.textContent = error.message || 'Failed to export STL.';
        } finally {
            showLoader(false);
        }
    }

    function exportAndOpenInBambu() {
        if (!state.tracedata) {
            if (statusText) statusText.textContent = 'Generate preview before exporting.';
            return;
        }

        const THREERef = window.THREE;
        if (!THREERef || !window.SVGLoader || !window.BufferGeometryUtils) {
            if (statusText) statusText.textContent = '3MF export libraries are still loading.';
            return;
        }

        const thicknessValue = model.objThicknessSlider ? parseFloat(model.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;

        return bambuSendWorkflow.send(defaultThickness);
    }

    return {
        exportAsOBJ,
        exportAs3MF,
        exportAsSTL,
        exportAndOpenInBambu,
        resetBambuSendProgress: bambuSendWorkflow.reset
    };
}
