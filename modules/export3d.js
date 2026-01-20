import { BED_PRESETS } from './config.js';
import { buildLayerIndexMap, getLayerIndexForColor } from './obj-layers.js';

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

// Helper to build layer geometries grouped by color
function buildLayerGeometries({
    dataToExport,
    state,
    elements,
    tracer,
    defaultThickness
}) {
    const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
    const THREERef = window.THREE;

    if (!SVGLoader || !THREERef) return null;

    const detailValue = elements.objDetailSlider ? parseInt(elements.objDetailSlider.value, 10) : 6;
    const curveSegments = Number.isFinite(detailValue) ? Math.max(1, detailValue) : 6;
    const bedKey = elements.objBedSelect?.value || 'x1';
    const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
    const marginValue = elements.objMarginInput ? parseFloat(elements.objMarginInput.value) : 5;
    const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;

    const svgString = tracer.getsvgstring(dataToExport, state.lastOptions);
    const loader = new SVGLoader();
    const svgData = loader.parse(svgString);
    const layerIndexMap = buildLayerIndexMap(dataToExport.palette);

    // Layer thicknesses
    const layerCount = dataToExport.palette.length;
    const layerThicknesses = state.layerThicknesses && state.layerThicknesses.length === layerCount
        ? state.layerThicknesses
        : new Array(layerCount).fill(defaultThickness);

    // Base layer positioning
    const useBaseLayer = state.useBaseLayer || false;
    const baseLayerIndex = state.baseLayerIndex || 0;
    const baseLayerThickness = useBaseLayer ? (layerThicknesses[baseLayerIndex] || defaultThickness) : 0;

    // Group geometries by layer index
    const layerGeometries = new Map(); // layerIndex -> { geometries: [], color: {r,g,b}, zPosition, depth }

    svgData.paths.forEach((path) => {
        const shapes = SVGLoader.createShapes(path);
        if (!shapes || !shapes.length) return;

        const sourceColor = path.color instanceof THREERef.Color
            ? path.color
            : new THREERef.Color(path.color || '#000');
        const hex = sourceColor.getHexString();
        const layerIndex = getLayerIndexForColor(layerIndexMap, hex);
        const layerDepth = layerThicknesses[layerIndex] || defaultThickness;

        // Calculate z position
        let zPosition = 0;
        if (useBaseLayer) {
            if (layerIndex === baseLayerIndex) {
                zPosition = 0;
            } else {
                zPosition = baseLayerThickness;
            }
        }

        if (!layerGeometries.has(layerIndex)) {
            const paletteColor = dataToExport.palette[layerIndex];
            layerGeometries.set(layerIndex, {
                geometries: [],
                color: { r: paletteColor.r, g: paletteColor.g, b: paletteColor.b },
                zPosition,
                depth: layerDepth,
                hex
            });
        }

        const layerData = layerGeometries.get(layerIndex);
        shapes.forEach((shape) => {
            const geometry = new THREERef.ExtrudeGeometry(shape, {
                depth: layerDepth,
                curveSegments,
                bevelEnabled: false
            });
            geometry.rotateX(Math.PI);
            // Apply z position to vertices
            const posAttr = geometry.getAttribute('position');
            for (let i = 0; i < posAttr.count; i++) {
                posAttr.setZ(i, posAttr.getZ(i) + zPosition);
            }
            posAttr.needsUpdate = true;
            // Recompute normals after all transformations for clean surfaces
            geometry.computeVertexNormals();
            layerData.geometries.push(geometry);
        });
    });

    // Merge geometries per layer
    const mergedLayers = new Map();
    layerGeometries.forEach((layerData, layerIndex) => {
        if (layerData.geometries.length === 0) return;

        const mergedGeometry = THREERef.BufferGeometryUtils.mergeGeometries(layerData.geometries, false);
        if (mergedGeometry) {
            // Recompute normals after merging for clean surfaces
            mergedGeometry.computeVertexNormals();
            mergedLayers.set(layerIndex, {
                geometry: mergedGeometry,
                color: layerData.color,
                zPosition: layerData.zPosition,
                depth: layerData.depth,
                hex: layerData.hex
            });
        }
        // Dispose original geometries
        layerData.geometries.forEach(g => g.dispose());
    });

    // Apply bed scaling
    const tempGroup = new THREERef.Group();
    mergedLayers.forEach((layerData) => {
        const mesh = new THREERef.Mesh(layerData.geometry);
        tempGroup.add(mesh);
    });

    const bbox = new THREERef.Box3().setFromObject(tempGroup);
    const size = new THREERef.Vector3();
    bbox.getSize(size);

    let scale = 1;
    if (size.x > 0 && size.y > 0) {
        const maxWidth = Math.max(1, bed.width - margin * 2);
        const maxDepth = Math.max(1, bed.depth - margin * 2);
        scale = Math.min(maxWidth / size.x, maxDepth / size.y, 1);
    }

    // Apply scale to geometries if needed
    if (scale < 1) {
        mergedLayers.forEach((layerData) => {
            layerData.geometry.scale(scale, scale, 1);
        });
    }

    // Clean up temp group
    tempGroup.children.forEach(child => tempGroup.remove(child));

    return {
        layers: mergedLayers,
        layerThicknesses,
        scale
    };
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
    const triangleCount = vertices.count / 3;

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
    const vA = new THREERef.Vector3();
    const vB = new THREERef.Vector3();
    const vC = new THREERef.Vector3();
    const nA = new THREERef.Vector3();
    const nB = new THREERef.Vector3();
    const nC = new THREERef.Vector3();
    const faceNormal = new THREERef.Vector3();

    for (let i = 0; i < triangleCount; i++) {
        const idx = i * 3;
        vA.fromBufferAttribute(vertices, idx);
        vB.fromBufferAttribute(vertices, idx + 1);
        vC.fromBufferAttribute(vertices, idx + 2);

        // Use stored normals if available, otherwise compute from vertices
        if (normals) {
            nA.fromBufferAttribute(normals, idx);
            nB.fromBufferAttribute(normals, idx + 1);
            nC.fromBufferAttribute(normals, idx + 2);
            // Average the vertex normals to get face normal
            faceNormal.addVectors(nA, nB).add(nC).normalize();
        } else {
            // Calculate face normal from vertices
            const edge1 = new THREERef.Vector3().subVectors(vB, vA);
            const edge2 = new THREERef.Vector3().subVectors(vC, vA);
            faceNormal.crossVectors(edge1, edge2).normalize();
        }

        // Normal
        dataView.setFloat32(offset, faceNormal.x, true); offset += 4;
        dataView.setFloat32(offset, faceNormal.y, true); offset += 4;
        dataView.setFloat32(offset, faceNormal.z, true); offset += 4;

        // Vertex 1
        dataView.setFloat32(offset, vA.x, true); offset += 4;
        dataView.setFloat32(offset, vA.y, true); offset += 4;
        dataView.setFloat32(offset, vA.z, true); offset += 4;

        // Vertex 2
        dataView.setFloat32(offset, vB.x, true); offset += 4;
        dataView.setFloat32(offset, vB.y, true); offset += 4;
        dataView.setFloat32(offset, vB.z, true); offset += 4;

        // Vertex 3
        dataView.setFloat32(offset, vC.x, true); offset += 4;
        dataView.setFloat32(offset, vC.y, true); offset += 4;
        dataView.setFloat32(offset, vC.z, true); offset += 4;

        // Attribute byte count (unused)
        dataView.setUint16(offset, 0, true); offset += 2;
    }

    if (geo !== geometry) {
        geo.dispose();
    }

    return buffer;
}

// Generate 3MF file (ZIP archive with XML)
async function generate3MF(layers, baseName) {
    // 3MF is a ZIP file containing XML
    // We'll create it manually using the Compression Streams API or JSZip if available

    const objects = [];
    const colorGroups = [];
    let vertexOffset = 0;

    layers.forEach((layerData, layerIndex) => {
        const geo = layerData.geometry;
        const color = layerData.color;

        // Get vertices and triangles
        let vertices = [];
        let triangles = [];

        const posAttr = geo.getAttribute('position');
        const indexAttr = geo.index;

        // Extract vertices
        for (let i = 0; i < posAttr.count; i++) {
            vertices.push({
                x: posAttr.getX(i),
                y: posAttr.getY(i),
                z: posAttr.getZ(i)
            });
        }

        // Extract triangles
        if (indexAttr) {
            for (let i = 0; i < indexAttr.count; i += 3) {
                triangles.push({
                    v1: indexAttr.getX(i),
                    v2: indexAttr.getX(i + 1),
                    v3: indexAttr.getX(i + 2)
                });
            }
        } else {
            for (let i = 0; i < posAttr.count; i += 3) {
                triangles.push({
                    v1: i,
                    v2: i + 1,
                    v3: i + 2
                });
            }
        }

        objects.push({
            id: layerIndex + 1,
            vertices,
            triangles,
            color: {
                r: Math.round(color.r),
                g: Math.round(color.g),
                b: Math.round(color.b)
            }
        });
    });

    // Build 3MF XML content
    const modelXml = build3MFModel(objects);
    const contentTypesXml = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

    const relsXml = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

    // Create ZIP file
    const zipBlob = await createZipFile({
        '[Content_Types].xml': contentTypesXml,
        '_rels/.rels': relsXml,
        '3D/3dmodel.model': modelXml
    });

    return zipBlob;
}

function build3MFModel(objects) {
    let verticesXml = '';
    let trianglesXml = '';
    let objectsXml = '';
    let buildItemsXml = '';
    let materialsXml = '';
    let baseMaterialsXml = '';

    // Build base materials (colors)
    objects.forEach((obj, idx) => {
        const hexColor = rgbToHex(obj.color.r, obj.color.g, obj.color.b);
        baseMaterialsXml += `      <base name="Color_${idx}" displaycolor="#${hexColor}"/>\n`;
    });

    objects.forEach((obj, idx) => {
        let vXml = '';
        obj.vertices.forEach(v => {
            vXml += `          <vertex x="${v.x.toFixed(6)}" y="${v.y.toFixed(6)}" z="${v.z.toFixed(6)}"/>\n`;
        });

        let tXml = '';
        obj.triangles.forEach(t => {
            tXml += `          <triangle v1="${t.v1}" v2="${t.v2}" v3="${t.v3}" pid="1" p1="${idx}"/>\n`;
        });

        objectsXml += `    <object id="${obj.id}" type="model">
      <mesh>
        <vertices>
${vXml}        </vertices>
        <triangles>
${tXml}        </triangles>
      </mesh>
    </object>\n`;

        buildItemsXml += `    <item objectid="${obj.id}"/>\n`;
    });

    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">
  <resources>
    <m:basematerials id="1">
${baseMaterialsXml}    </m:basematerials>
${objectsXml}  </resources>
  <build>
${buildItemsXml}  </build>
</model>`;
}

function rgbToHex(r, g, b) {
    return [r, g, b].map(x => {
        const hex = Math.max(0, Math.min(255, Math.round(x))).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('').toUpperCase();
}

// Simple ZIP file creator using JSZip if available, otherwise manual implementation
async function createZipFile(files) {
    // Try to use JSZip if available
    if (window.JSZip) {
        const zip = new window.JSZip();
        for (const [path, content] of Object.entries(files)) {
            zip.file(path, content);
        }
        return await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    }

    // Fallback: create uncompressed ZIP manually
    const encoder = new TextEncoder();
    const fileEntries = [];
    let offset = 0;

    // Prepare file entries
    for (const [path, content] of Object.entries(files)) {
        const data = encoder.encode(content);
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

    return new Blob([buffer], { type: 'application/vnd.ms-package.3dmanufacturing-3dmodel+xml' });
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
    elements,
    getDataToExport,
    ImageTracer,
    showLoader,
    downloadBlob,
    getImageBaseName
}) {
    const tracer = ImageTracer || window.ImageTracer;

    async function exportAsOBJ() {
        if (!state.tracedata) {
            elements.statusText.textContent = 'Generate preview before exporting OBJ.';
            return;
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const OBJExporter = window.OBJExporter || window.THREE?.OBJExporter;
        const THREERef = window.THREE;

        if (!SVGLoader || !OBJExporter || !THREERef || !THREERef.BufferGeometryUtils) {
            elements.statusText.textContent = 'OBJ export libraries are still loading.';
            return;
        }

        const dataToExport = getDataToExport();
        if (!dataToExport) {
            elements.statusText.textContent = 'No layers available for OBJ export.';
            return;
        }

        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;

        try {
            showLoader(true);
            elements.statusText.textContent = 'Exporting OBJ...';

            const result = buildLayerGeometries({
                dataToExport,
                state,
                elements,
                tracer,
                defaultThickness
            });

            if (!result || result.layers.size === 0) {
                throw new Error('No geometry generated');
            }

            // Build merged group for OBJ export
            const group = new THREERef.Group();
            const materials = new Map();

            result.layers.forEach((layerData, layerIndex) => {
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

            const maxThickness = Math.max(...(state.layerThicknesses || [defaultThickness]));
            const baseName = `${getImageBaseName()}_${Math.round(maxThickness)}mm`;
            const mtl = buildMtl(materials, baseName);

            if (mtl) {
                obj = `mtllib ${baseName}.mtl\n` + obj;
                downloadBlob(new Blob([mtl], { type: 'text/plain' }), `${baseName}.mtl`);
            }

            downloadBlob(new Blob([obj], { type: 'text/plain' }), `${baseName}.obj`);
            elements.statusText.textContent = 'OBJ export complete.';

            // Cleanup
            result.layers.forEach(layerData => layerData.geometry.dispose());
        } catch (error) {
            console.error('OBJ export failed:', error);
            elements.statusText.textContent = 'Failed to export OBJ.';
        } finally {
            showLoader(false);
        }
    }

    async function exportAs3MF() {
        if (!state.tracedata) {
            elements.statusText.textContent = 'Generate preview before exporting 3MF.';
            return;
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const THREERef = window.THREE;

        if (!SVGLoader || !THREERef || !THREERef.BufferGeometryUtils) {
            elements.statusText.textContent = '3MF export libraries are still loading.';
            return;
        }

        const dataToExport = getDataToExport();
        if (!dataToExport) {
            elements.statusText.textContent = 'No layers available for 3MF export.';
            return;
        }

        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;

        try {
            showLoader(true);
            elements.statusText.textContent = 'Exporting 3MF...';

            const result = buildLayerGeometries({
                dataToExport,
                state,
                elements,
                tracer,
                defaultThickness
            });

            if (!result || result.layers.size === 0) {
                throw new Error('No geometry generated');
            }

            const maxThickness = Math.max(...(state.layerThicknesses || [defaultThickness]));
            const baseName = `${getImageBaseName()}_${Math.round(maxThickness)}mm`;

            const blob = await generate3MF(result.layers, baseName);
            downloadBlob(blob, `${baseName}.3mf`);
            elements.statusText.textContent = '3MF export complete.';

            // Cleanup
            result.layers.forEach(layerData => layerData.geometry.dispose());
        } catch (error) {
            console.error('3MF export failed:', error);
            elements.statusText.textContent = 'Failed to export 3MF.';
        } finally {
            showLoader(false);
        }
    }

    async function exportAsSTL() {
        if (!state.tracedata) {
            elements.statusText.textContent = 'Generate preview before exporting STL.';
            return;
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const THREERef = window.THREE;

        if (!SVGLoader || !THREERef || !THREERef.BufferGeometryUtils) {
            elements.statusText.textContent = 'STL export libraries are still loading.';
            return;
        }

        const dataToExport = getDataToExport();
        if (!dataToExport) {
            elements.statusText.textContent = 'No layers available for STL export.';
            return;
        }

        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const defaultThickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;

        try {
            showLoader(true);
            elements.statusText.textContent = 'Exporting STL files...';

            const result = buildLayerGeometries({
                dataToExport,
                state,
                elements,
                tracer,
                defaultThickness
            });

            if (!result || result.layers.size === 0) {
                throw new Error('No geometry generated');
            }

            const maxThickness = Math.max(...(state.layerThicknesses || [defaultThickness]));
            const baseName = `${getImageBaseName()}_${Math.round(maxThickness)}mm`;

            // Export each layer as separate STL
            let exportedCount = 0;
            result.layers.forEach((layerData, layerIndex) => {
                const stlBuffer = geometryToSTL(layerData.geometry);
                if (stlBuffer) {
                    const colorName = rgbToHex(layerData.color.r, layerData.color.g, layerData.color.b);
                    const fileName = `${baseName}_L${layerIndex}_${colorName}.stl`;
                    downloadBlob(new Blob([stlBuffer], { type: 'application/sla' }), fileName);
                    exportedCount++;
                }
            });

            elements.statusText.textContent = `Exported ${exportedCount} STL files.`;

            // Cleanup
            result.layers.forEach(layerData => layerData.geometry.dispose());
        } catch (error) {
            console.error('STL export failed:', error);
            elements.statusText.textContent = 'Failed to export STL.';
        } finally {
            showLoader(false);
        }
    }

    return { exportAsOBJ, exportAs3MF, exportAsSTL };
}
