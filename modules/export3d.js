import { buildObjGeometryBundle, buildObjModelPlan } from './obj-model-plan.js?v=20260412b';
import { buildBambuProjectFiles } from './bambu-project.js';
import { BAMBU_PROJECT_NOZZLE_DIAMETER } from './config.js';
import { canvasToBlobAsync, dataUrlToBlob } from './raster-utils.js';
import { layerHasPaths } from './shared/trace-utils.js';
import { svgToPng } from './shared/svg-renderer.js';
import { getCanonicalBedCenter } from './shared/canonical-3d.js';
import { launchBambuStudio, downloadAndOpenInBambu } from './bambu-bridge.js';

const THREE_MF_BLOB_TYPE = 'model/3mf';

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

    geometryBundle.layers.forEach((layerData) => {
        const geometry = layerData.geometry.clone();
        geometry.translate(placement.x, placement.y, placement.z);
        geometry.computeVertexNormals();
        layers.push({
            ...layerData,
            geometry
        });
    });

    return layers;
}

async function generateBambuProject3MF({
    geometryBundle,
    baseName,
    bedKey,
    tracer,
    state,
    getDataToExport
}) {
    const placedLayers = buildBambuProjectGeometryLayers(geometryBundle, bedKey);
    try {
        const previewAssets = await buildBambuPreviewAssets({
            tracer,
            state,
            getDataToExport,
            bedKey,
            scalePlan: geometryBundle?.plan?.scalePlan
        });
        const project = buildBambuProjectFiles({
            layers: placedLayers,
            baseName,
            bedKey,
            nozzleDiameter: BAMBU_PROJECT_NOZZLE_DIAMETER,
            previewAssets
        });
        if (!project) return null;
        const blob = await createZipFile(project.files);
        return { blob, project };
    } finally {
        placedLayers.forEach((layerData) => layerData.geometry?.dispose?.());
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
export async function createZipFile(files) {
    // Try to use JSZip if available
    if (window.JSZip) {
        const zip = new window.JSZip();
        for (const [path, content] of Object.entries(files)) {
            zip.file(path, content);
        }
        const zipData = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
        return new Blob([zipData], { type: THREE_MF_BLOB_TYPE });
    }

    // Fallback: create uncompressed ZIP manually
    const encoder = new TextEncoder();
    const fileEntries = [];
    let offset = 0;

    // Prepare file entries
    for (const [path, content] of Object.entries(files)) {
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
    fileEntries.forEach(entry => {
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
    });

    // Write central directory
    fileEntries.forEach(entry => {
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
    });

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

    return new Blob([buffer], { type: THREE_MF_BLOB_TYPE });
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

    function getGeometryCacheKey(defaultThickness) {
        return [
            defaultThickness,
            model.objDecimateSlider?.value ?? 0,
            model.objBedSelect?.value ?? 'x1',
            model.objMarginInput?.value ?? 5,
            model.objScaleSlider?.value ?? 100,
            model.objBezelSelect?.value ?? state.objParams?.bezelPreset ?? 'off',
            state.tracedata?.layers?.length ?? 0,
            state.tracedata?.palette?.map(c => `${c.r},${c.g},${c.b}`).join(';') ?? ''
        ].join('|');
    }

    function getVisibleLayerIndices() {
        if (!state.tracedata) return [];
        const indices = [];
        for (let i = 0; i < state.tracedata.layers.length; i++) {
            if (layerHasPaths(state.tracedata.layers[i])) indices.push(i);
        }
        return indices;
    }

    function buildExportGeometry(defaultThickness) {
        const key = getGeometryCacheKey(defaultThickness);
        if (cachedGeometry && cachedGeometryKey === key) {
            // Clone cached geometries so callers can dispose without breaking the cache
            const cloned = {
                ...cachedGeometry,
                layers: new Map()
            };
            cachedGeometry.layers.forEach((layerData, layerKey) => {
                cloned.layers.set(layerKey, {
                    ...layerData,
                    geometry: layerData.geometry.clone()
                });
            });
            return cloned;
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const THREERef = window.THREE;
        const bufferUtils = window.BufferGeometryUtils || THREERef?.BufferGeometryUtils;
        if (!SVGLoader || !THREERef || !bufferUtils) return null;

        const visibleSourceLayerIds = getVisibleLayerIndices();
        if (!visibleSourceLayerIds.length) return null;

        const plan = buildObjModelPlan({
            state,
            tracer,
            SVGLoader,
            THREERef,
            defaultThickness,
            visibleSourceLayerIds,
            decimatePercent: model.objDecimateSlider ? Number.parseFloat(model.objDecimateSlider.value) : 0,
            bedKey: model.objBedSelect?.value || 'x1',
            margin: model.objMarginInput ? Number.parseFloat(model.objMarginInput.value) : 5,
            scalePercent: model.objScaleSlider ? Number.parseFloat(model.objScaleSlider.value) : 100,
            sourceScale: state.sourceRenderScale || 1,
            bezelPreset: model.objBezelSelect?.value || state.objParams?.bezelPreset || 'off'
        });
        if (!plan || plan.outputLayers.length === 0) return null;

        const geometryBundle = buildObjGeometryBundle(plan, { THREERef, bufferUtils });
        if (!geometryBundle || geometryBundle.layers.size === 0) return null;

        const scalePlan = plan.scalePlan;

        geometryBundle.layers.forEach((layerData) => {
            layerData.geometry.scale(scalePlan.scale, scalePlan.scale, 1);
            layerData.geometry.computeVertexNormals();
        });

        // Dispose previous cache
        if (cachedGeometry) {
            cachedGeometry.layers.forEach((ld) => ld.geometry?.dispose?.());
        }
        cachedGeometry = geometryBundle;
        cachedGeometryKey = key;

        // Return cloned geometries so callers can dispose freely
        const result = { ...geometryBundle, layers: new Map() };
        geometryBundle.layers.forEach((layerData, layerKey) => {
            result.layers.set(layerKey, {
                ...layerData,
                geometry: layerData.geometry.clone()
            });
        });
        return result;
    }

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
            if (statusText) statusText.textContent = 'OBJ export complete.';

            // Cleanup
            result.layers.forEach((layerData) => layerData.geometry.dispose());
        } catch (error) {
            console.error('OBJ export failed:', error);
            if (statusText) statusText.textContent = 'Failed to export OBJ.';
        } finally {
            showLoader(false);
        }
    }

    async function exportAs3MF() {
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

        try {
            showLoader(true);
            if (statusText) statusText.textContent = 'Exporting Bambu Studio project...';

            const result = buildExportGeometry(defaultThickness);
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
                getDataToExport
            });
            if (!exportResult?.blob) {
                throw new Error('Failed to assemble the Bambu Studio project.');
            }
            const filename = `${baseName}.3mf`;
            downloadBlob(new Blob([exportResult.blob], { type: THREE_MF_BLOB_TYPE }), filename);
            if (statusText) statusText.textContent = 'Bambu Studio project downloaded. Open the .3mf in Bambu Studio.';

            // Cleanup
            result.layers.forEach((layerData) => layerData.geometry.dispose());
        } catch (error) {
            console.error('3MF export failed:', error);
            if (statusText) statusText.textContent = error.message || 'Failed to export 3MF.';
        } finally {
            showLoader(false);
        }
    }

    async function exportAndOpenInBambu() {
        if (!state.tracedata) {
            if (statusText) statusText.textContent = 'Generate preview before exporting to Bambu Studio.';
            return;
        }

        const THREERef = window.THREE;
        if (!THREERef || !window.SVGLoader || !window.BufferGeometryUtils) {
            if (statusText) statusText.textContent = 'Bambu export libraries are still loading.';
            return;
        }

        const thicknessValue = model.objThicknessSlider ? parseFloat(model.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;

        try {
            showLoader(true);
            if (statusText) statusText.textContent = 'Preparing Bambu Studio project...';

            const result = buildExportGeometry(defaultThickness);
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
                getDataToExport
            });
            if (!exportResult?.blob) {
                throw new Error('Failed to assemble the Bambu Studio project.');
            }

            const filename = `${baseName}.3mf`;
            const blob = new Blob([exportResult.blob], { type: THREE_MF_BLOB_TYPE });

            // Try Chrome downloads API to download and auto-open in Bambu Studio
            const openResult = await downloadAndOpenInBambu(blob, filename);

            if (openResult.opened) {
                if (statusText) statusText.textContent = 'Project exported and opening in Bambu Studio.';
            } else {
                // Fallback: regular download + protocol launch
                downloadBlob(blob, filename);
                const launchResult = await launchBambuStudio();
                if (statusText) {
                    statusText.textContent = launchResult.opened
                        ? 'Downloaded .3mf and opened Bambu Studio. Import the downloaded file via File > Import.'
                        : 'Downloaded .3mf. Open the file in Bambu Studio to import your project.';
                }
            }

            result.layers.forEach((layerData) => layerData.geometry.dispose());
        } catch (error) {
            console.error('Bambu Studio launch export failed:', error);
            if (statusText) statusText.textContent = error.message || 'Failed to prepare the Bambu Studio project.';
        } finally {
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

            if (statusText) statusText.textContent = `Exported ${exportedCount} STL files.`;

            // Cleanup
            result.layers.forEach((layerData) => layerData.geometry.dispose());
        } catch (error) {
            console.error('STL export failed:', error);
            if (statusText) statusText.textContent = 'Failed to export STL.';
        } finally {
            showLoader(false);
        }
    }

    return { exportAsOBJ, exportAs3MF, exportAsSTL, exportAndOpenInBambu };
}
