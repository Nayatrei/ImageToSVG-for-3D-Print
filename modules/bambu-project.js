import {
    BAMBU_PROJECT_APP_VERSION,
    BAMBU_PROJECT_3MF_VERSION,
    BAMBU_PROJECT_NOZZLE_DIAMETER
} from './config.js?v=r-78ade4c03db6e3a2';
import { getBambuPrinterTemplate, buildBambuProjectSettings } from './bambu/templates.js?v=r-78ade4c03db6e3a2';

const MESH_POSITION_EPSILON = 1e-5;

function hash32(seed) {
    const input = String(seed || '');
    let hash = 0x811c9dc5;
    for (let index = 0; index < input.length; index++) {
        hash ^= input.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash >>> 0;
}

function stableUuid(seed) {
    const bytes = new Uint8Array(16);
    const hashes = [
        hash32(`${seed}|0`),
        hash32(`${seed}|1`),
        hash32(`${seed}|2`),
        hash32(`${seed}|3`)
    ];

    hashes.forEach((value, hashIndex) => {
        const offset = hashIndex * 4;
        bytes[offset] = (value >>> 24) & 0xff;
        bytes[offset + 1] = (value >>> 16) & 0xff;
        bytes[offset + 2] = (value >>> 8) & 0xff;
        bytes[offset + 3] = value & 0xff;
    });

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;

    const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
    return [
        hex.slice(0, 8),
        hex.slice(8, 12),
        hex.slice(12, 16),
        hex.slice(16, 20),
        hex.slice(20)
    ].join('-');
}

function escapeXml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function formatNumber(value, digits = 6) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    if (!Number.isFinite(numeric)) return '0';
    return numeric.toFixed(digits).replace(/\.?0+$/, '') || '0';
}

function colorToHex(color) {
    const channel = (value) => Math.max(0, Math.min(255, Math.round(value ?? 0))).toString(16).padStart(2, '0');
    return `#${channel(color?.r)}${channel(color?.g)}${channel(color?.b)}`.toUpperCase();
}

function getGeometryMeshData(geometry, translation = {}) {
    if (!geometry) return null;
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) return null;

    const index = geometry.index;
    const translateX = Number.isFinite(translation.x) ? translation.x : 0;
    const translateY = Number.isFinite(translation.y) ? translation.y : 0;
    const translateZ = Number.isFinite(translation.z) ? translation.z : 0;
    const vertices = [];
    const triangles = [];
    const vertexIndexByCoordinate = new Map();
    const bounds = {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity
    };

    const getOrCreateVertex = (sourceVertex) => {
        const sourceX = position.getX(sourceVertex);
        const sourceY = position.getY(sourceVertex);
        const sourceZ = position.getZ(sourceVertex);
        // Match print-validation's seam tolerance so a mesh that validates as
        // welded is serialized with the same shared vertex indices.
        const key = [sourceX, sourceY, sourceZ]
            .map((value) => Math.round(value / MESH_POSITION_EPSILON))
            .join(',');
        if (vertexIndexByCoordinate.has(key)) return vertexIndexByCoordinate.get(key);

        const x = sourceX + translateX;
        const y = sourceY + translateY;
        const z = sourceZ + translateZ;
        const vertexIndex = vertices.length;
        vertices.push({ x, y, z });
        vertexIndexByCoordinate.set(key, vertexIndex);
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.minZ = Math.min(bounds.minZ, z);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
        bounds.maxZ = Math.max(bounds.maxZ, z);
        return vertexIndex;
    };

    const elementCount = index ? index.count : position.count;
    const getSourceVertex = (elementIndex) => index ? index.getX(elementIndex) : elementIndex;
    for (let elementIndex = 0; elementIndex + 2 < elementCount; elementIndex += 3) {
        const sourceA = getSourceVertex(elementIndex);
        const sourceB = getSourceVertex(elementIndex + 1);
        const sourceC = getSourceVertex(elementIndex + 2);
        const ax = position.getX(sourceA);
        const ay = position.getY(sourceA);
        const az = position.getZ(sourceA);
        const bx = position.getX(sourceB);
        const by = position.getY(sourceB);
        const bz = position.getZ(sourceB);
        const cx = position.getX(sourceC);
        const cy = position.getY(sourceC);
        const cz = position.getZ(sourceC);
        const abX = bx - ax;
        const abY = by - ay;
        const abZ = bz - az;
        const acX = cx - ax;
        const acY = cy - ay;
        const acZ = cz - az;
        const crossX = abY * acZ - abZ * acY;
        const crossY = abZ * acX - abX * acZ;
        const crossZ = abX * acY - abY * acX;
        if (crossX * crossX + crossY * crossY + crossZ * crossZ <= 1e-16) continue;

        const v1 = getOrCreateVertex(sourceA);
        const v2 = getOrCreateVertex(sourceB);
        const v3 = getOrCreateVertex(sourceC);
        if (v1 === v2 || v2 === v3 || v3 === v1) continue;

        // Canonical seam welding can make three distinct source occurrences
        // share representative coordinates that are exactly collinear. Audit
        // the serialized coordinates, not only the raw triangle occurrences.
        const canonicalA = vertices[v1];
        const canonicalB = vertices[v2];
        const canonicalC = vertices[v3];
        const canonicalAbX = canonicalB.x - canonicalA.x;
        const canonicalAbY = canonicalB.y - canonicalA.y;
        const canonicalAbZ = canonicalB.z - canonicalA.z;
        const canonicalAcX = canonicalC.x - canonicalA.x;
        const canonicalAcY = canonicalC.y - canonicalA.y;
        const canonicalAcZ = canonicalC.z - canonicalA.z;
        const canonicalCrossX = canonicalAbY * canonicalAcZ - canonicalAbZ * canonicalAcY;
        const canonicalCrossY = canonicalAbZ * canonicalAcX - canonicalAbX * canonicalAcZ;
        const canonicalCrossZ = canonicalAbX * canonicalAcY - canonicalAbY * canonicalAcX;
        if (
            canonicalCrossX * canonicalCrossX
            + canonicalCrossY * canonicalCrossY
            + canonicalCrossZ * canonicalCrossZ
            <= 1e-16
        ) {
            continue;
        }
        triangles.push({ v1, v2, v3 });
    }

    if (!triangles.length || !vertices.length) return null;

    const edgeCounts = new Map();
    triangles.forEach(({ v1, v2, v3 }) => {
        [[v1, v2], [v2, v3], [v3, v1]].forEach(([start, end]) => {
            const edgeKey = start < end ? `${start}|${end}` : `${end}|${start}`;
            edgeCounts.set(edgeKey, (edgeCounts.get(edgeKey) || 0) + 1);
        });
    });
    const boundaryEdgeCount = [...edgeCounts.values()].filter((count) => count === 1).length;
    const nonManifoldEdgeCount = [...edgeCounts.values()].filter((count) => count > 2).length;

    return {
        vertices,
        triangles,
        boundaryEdgeCount,
        nonManifoldEdgeCount,
        bounds: {
            ...bounds,
            width: bounds.maxX - bounds.minX,
            depth: bounds.maxY - bounds.minY,
            height: bounds.maxZ - bounds.minZ
        }
    };
}

function buildObjectModelXml({ objectFileId, meshData, uuid }) {
    const verticesXml = meshData.vertices.map((vertex) => (
        `     <vertex x="${formatNumber(vertex.x, 9)}" y="${formatNumber(vertex.y, 9)}" z="${formatNumber(vertex.z, 9)}"/>`
    )).join('\n');
    const trianglesXml = meshData.triangles.map((triangle) => (
        `     <triangle v1="${triangle.v1}" v2="${triangle.v2}" v3="${triangle.v3}"/>`
    )).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">${escapeXml(BAMBU_PROJECT_3MF_VERSION)}</metadata>
 <resources>
  <object id="${objectFileId}" p:UUID="${escapeXml(uuid)}" type="model">
   <mesh>
    <vertices>
${verticesXml}
    </vertices>
    <triangles>
${trianglesXml}
    </triangles>
   </mesh>
  </object>
 </resources>
 <build>
  <item objectid="${objectFileId}"/>
 </build>
</model>`;
}

function buildRootModelXml({
    title,
    dateStamp,
    assemblyObjectId,
    assemblyUuid,
    buildUuid,
    parts
}) {
    const componentsXml = parts.map((part, index) => (
        `    <component p:path="/3D/Objects/object_${index + 1}.model" objectid="${index + 1}" p:UUID="${escapeXml(part.componentUuid)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`
    )).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="Application">BambuStudio-${escapeXml(BAMBU_PROJECT_APP_VERSION)}</metadata>
 <metadata name="BambuStudio:3mfVersion">${escapeXml(BAMBU_PROJECT_3MF_VERSION)}</metadata>
 <metadata name="CreationDate">${escapeXml(dateStamp)}</metadata>
 <metadata name="ModificationDate">${escapeXml(dateStamp)}</metadata>
 <metadata name="Description">Generated by Genesis Image Tools for Bambu Studio.</metadata>
 <metadata name="Thumbnail_Middle">/Metadata/plate_1.png</metadata>
 <metadata name="Thumbnail_Small">/Metadata/plate_1_small.png</metadata>
 <metadata name="Title">${escapeXml(title)}</metadata>
 <resources>
  <object id="${assemblyObjectId}" p:UUID="${escapeXml(assemblyUuid)}" type="model">
   <components>
${componentsXml}
   </components>
  </object>
 </resources>
 <build p:UUID="${escapeXml(buildUuid)}">
  <item objectid="${assemblyObjectId}" p:UUID="${escapeXml(stableUuid(`${title}|build-item`))}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
 </build>
</model>`;
}

function buildModelRelsXml(parts) {
    const rels = parts.map((part, index) => (
        ` <Relationship Target="/3D/Objects/object_${index + 1}.model" Id="rel-${index + 1}" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>`
    )).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${rels}
</Relationships>`;
}

function buildRootRelsXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
 <Relationship Target="/Auxiliaries/.thumbnails/thumbnail_3mf.png" Id="rel-2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/thumbnail"/>
 <Relationship Target="/Metadata/plate_1.png" Id="rel-4" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-middle"/>
 <Relationship Target="/Metadata/plate_1_small.png" Id="rel-5" Type="http://schemas.bambulab.com/package/2021/cover-thumbnail-small"/>
</Relationships>`;
}

function buildContentTypesXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
 <Default Extension="png" ContentType="image/png"/>
</Types>`;
}

function buildModelSettingsXml({
    title,
    parts,
    filamentCount,
    assemblyObjectId
}) {
    const totalFaceCount = parts.reduce((sum, part) => sum + part.meshData.triangles.length, 0);
    const partsXml = parts.map((part, index) => (
        `    <part id="${index + 1}" subtype="normal_part">
      <metadata key="name" value="${escapeXml(part.name)}"/>
      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
      <metadata key="source_file" value="${escapeXml(`${title}.3mf`)}"/>
      <metadata key="source_object_id" value="${index + 1}"/>
      <metadata key="source_volume_id" value="0"/>
      <metadata key="source_offset_x" value="${formatNumber(part.meshData.bounds.minX)}"/>
      <metadata key="source_offset_y" value="${formatNumber(part.meshData.bounds.minY)}"/>
      <metadata key="source_offset_z" value="${formatNumber(part.meshData.bounds.minZ)}"/>
      <metadata key="extruder" value="${part.materialIndex + 1}"/>
      <mesh_stat face_count="${part.meshData.triangles.length}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`
    )).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="${assemblyObjectId}">
    <metadata key="name" value="${escapeXml(title)}"/>
    <metadata key="extruder" value="1"/>
    <metadata face_count="${totalFaceCount}"/>
${partsXml}
  </object>
  <plate>
    <metadata key="plater_id" value="1"/>
    <metadata key="plater_name" value="genesis"/>
    <metadata key="locked" value="false"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="filament_maps" value="${filamentCount}"/>
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_1.png"/>
    <metadata key="top_file" value="Metadata/top_1.png"/>
    <metadata key="pick_file" value="Metadata/pick_1.png"/>
    <model_instance>
      <metadata key="object_id" value="${assemblyObjectId}"/>
      <metadata key="instance_id" value="0"/>
      <metadata key="identify_id" value="1"/>
    </model_instance>
  </plate>
</config>`;
}

function buildSliceInfoXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <header>
    <header_item key="X-BBL-Client-Type" value="slicer"/>
    <header_item key="X-BBL-Client-Version" value="${escapeXml(BAMBU_PROJECT_APP_VERSION)}"/>
  </header>
</config>`;
}

function buildCutInformationXml(assemblyObjectId) {
    return `<?xml version="1.0" encoding="utf-8"?>
<objects>
 <object id="${assemblyObjectId}">
  <cut_id id="0" check_sum="1" connectors_cnt="0"/>
 </object>
</objects>`;
}

function getAssemblyBounds(parts) {
    return parts.reduce((bounds, part) => ({
        minX: Math.min(bounds.minX, part.meshData.bounds.minX),
        minY: Math.min(bounds.minY, part.meshData.bounds.minY),
        minZ: Math.min(bounds.minZ, part.meshData.bounds.minZ),
        maxX: Math.max(bounds.maxX, part.meshData.bounds.maxX),
        maxY: Math.max(bounds.maxY, part.meshData.bounds.maxY),
        maxZ: Math.max(bounds.maxZ, part.meshData.bounds.maxZ)
    }), {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity
    });
}

function buildPlateJson({
    template,
    parts,
    filamentColors,
    assemblyObjectId
}) {
    const bounds = getAssemblyBounds(parts);
    return JSON.stringify({
        bbox_all: [
            Number(formatNumber(bounds.minX)),
            Number(formatNumber(bounds.minY)),
            Number(formatNumber(bounds.maxX)),
            Number(formatNumber(bounds.maxY))
        ],
        bbox_objects: [{
            area: Number(formatNumber((bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY))),
            bbox: [
                Number(formatNumber(bounds.minX)),
                Number(formatNumber(bounds.minY)),
                Number(formatNumber(bounds.maxX)),
                Number(formatNumber(bounds.maxY))
            ],
            id: assemblyObjectId,
            layer_height: 0.2,
            name: 'Genesis Assembly'
        }],
        bed_type: template.bedType,
        filament_colors: filamentColors,
        filament_ids: filamentColors.map((_, index) => index),
        first_extruder: 0,
        is_seq_print: false,
        nozzle_diameter: BAMBU_PROJECT_NOZZLE_DIAMETER,
        version: 2
    }, null, 2);
}

function buildFilamentSequenceJson(filamentCount) {
    return JSON.stringify({
        plate_1: {
            sequence: Array.from({ length: filamentCount }, (_, index) => index)
        }
    }, null, 2);
}

function buildCustomGcodePerLayerXml(pauseEvents) {
    const events = (Array.isArray(pauseEvents) ? pauseEvents : [])
        .filter((event) => event?.type === 'pause' && Number.isFinite(event.z))
        .sort((left, right) => left.z - right.z);
    if (!events.length) return '';

    const layers = events.map((event) => (
        `  <layer top_z="${formatNumber(event.z)}" type="1" extruder="0" color="#FFFFFF" extra="${escapeXml(event.message || 'Insert magnets, then resume.')}" gcode="${escapeXml(event.gcode || 'M400 U1')}"/>`
    )).join('\n');

    return `<?xml version="1.0" encoding="utf-8"?>
<custom_gcodes_per_layer>
 <plate>
  <plate_info id="1"/>
${layers}
  <mode value="SingleExtruder"/>
 </plate>
</custom_gcodes_per_layer>`;
}

function buildBambuProjectPart({ layerData, index, title }) {
    const meshData = getGeometryMeshData(layerData.geometry, layerData.translation);
    if (!meshData) return null;

    // Only an open shell is fatal here. A pinched (non-manifold) edge — two same
    // colour regions meeting at a single diagonal corner — still serializes to a
    // closed 3MF mesh, and Bambu Studio repairs it on import.
    if (meshData.boundaryEdgeCount) {
        const name = layerData.displayLabel || `Layer ${index + 1}`;
        throw new Error(
            `3MF serialization failed: ${name} has ${meshData.boundaryEdgeCount} open edge(s) `
            + `and ${meshData.nonManifoldEdgeCount} non-manifold edge(s).`
        );
    }

    return {
        index,
        name: layerData.displayLabel || `Layer ${index + 1}`,
        meshData,
        hexColor: colorToHex(layerData.color),
        materialIndex: Number.isInteger(layerData.materialIndex)
            ? Math.max(0, layerData.materialIndex)
            : index,
        componentUuid: stableUuid(`${title}|component|${index}`),
        objectUuid: stableUuid(`${title}|object-model|${index}`)
    };
}

function createBambuProjectScaffold({ parts, title, bedKey, nozzleDiameter, pauseEvents }) {
    const template = getBambuPrinterTemplate(bedKey);
    const dateStamp = new Date().toISOString().slice(0, 10);
    const filamentColorsByIndex = new Map();
    parts.forEach((part) => {
        if (!filamentColorsByIndex.has(part.materialIndex)) {
            filamentColorsByIndex.set(part.materialIndex, part.hexColor);
        }
    });
    const filamentColors = [...filamentColorsByIndex.entries()]
        .sort(([leftIndex], [rightIndex]) => leftIndex - rightIndex)
        .map(([, color]) => color);
    const assemblyObjectId = parts.length + 1;
    const projectSettings = buildBambuProjectSettings({
        template,
        title,
        layerCount: filamentColors.length,
        filamentColors,
        nozzleDiameter
    });
    const files = {
        '[Content_Types].xml': buildContentTypesXml(),
        '_rels/.rels': buildRootRelsXml(),
        '3D/3dmodel.model': buildRootModelXml({
            title,
            dateStamp,
            assemblyObjectId,
            assemblyUuid: stableUuid(`${title}|assembly`),
            buildUuid: stableUuid(`${title}|build`),
            parts
        }),
        '3D/_rels/3dmodel.model.rels': buildModelRelsXml(parts),
        'Metadata/project_settings.config': JSON.stringify(projectSettings, null, 2),
        'Metadata/model_settings.config': buildModelSettingsXml({
            title,
            parts,
            filamentCount: filamentColors.length,
            assemblyObjectId
        }),
        'Metadata/slice_info.config': buildSliceInfoXml(),
        'Metadata/plate_1.json': buildPlateJson({
            template,
            parts,
            filamentColors,
            assemblyObjectId
        }),
        'Metadata/filament_sequence.json': buildFilamentSequenceJson(filamentColors.length),
        'Metadata/cut_information.xml': buildCutInformationXml(assemblyObjectId)
    };
    const customGcodeXml = buildCustomGcodePerLayerXml(pauseEvents);
    if (customGcodeXml) files['Metadata/custom_gcode_per_layer.xml'] = customGcodeXml;
    return { files, parts, title, template };
}

function appendBambuObjectFile(project, part, index) {
    project.files[`3D/Objects/object_${index + 1}.model`] = buildObjectModelXml({
        objectFileId: index + 1,
        meshData: part.meshData,
        uuid: part.objectUuid
    });
}

function appendBambuPreviewAssets(files, previewAssets = {}) {
    if (previewAssets.plateLarge) {
        files['Metadata/plate_1.png'] = previewAssets.plateLarge;
        files['Metadata/plate_no_light_1.png'] = previewAssets.plateLarge;
        files['Metadata/top_1.png'] = previewAssets.plateLarge;
        files['Metadata/pick_1.png'] = previewAssets.plateLarge;
    }
    if (previewAssets.plateSmall) files['Metadata/plate_1_small.png'] = previewAssets.plateSmall;
    if (previewAssets.thumbnailLarge) {
        files['Auxiliaries/.thumbnails/thumbnail_3mf.png'] = previewAssets.thumbnailLarge;
        files['Auxiliaries/.thumbnails/thumbnail_middle.png'] = previewAssets.thumbnailLarge;
    }
    if (previewAssets.thumbnailSmall) {
        files['Auxiliaries/.thumbnails/thumbnail_small.png'] = previewAssets.thumbnailSmall;
    }
}

export function buildBambuProjectFiles({
    layers,
    baseName,
    bedKey = 'x1',
    nozzleDiameter = BAMBU_PROJECT_NOZZLE_DIAMETER,
    previewAssets = {},
    pauseEvents = []
}) {
    const title = String(baseName || 'genesis_project');
    const parts = [];
    layers.forEach((layerData, index) => {
        const part = buildBambuProjectPart({ layerData, index, title });
        if (part) parts.push(part);
    });
    if (!parts.length) return null;

    const project = createBambuProjectScaffold({
        parts,
        title,
        bedKey,
        nozzleDiameter,
        pauseEvents
    });
    parts.forEach((part, index) => appendBambuObjectFile(project, part, index));
    appendBambuPreviewAssets(project.files, previewAssets);
    return project;
}

/** Cooperative serializer used by the interactive Bambu handoff. */
export async function buildBambuProjectFilesAsync({
    layers,
    baseName,
    bedKey = 'x1',
    nozzleDiameter = BAMBU_PROJECT_NOZZLE_DIAMETER,
    previewAssets = {},
    pauseEvents = [],
    onProgress,
    yieldControl = async () => {}
}) {
    const title = String(baseName || 'genesis_project');
    const parts = [];
    const layerTotal = Math.max(1, layers.length);

    for (let index = 0; index < layers.length; index += 1) {
        const part = buildBambuProjectPart({ layerData: layers[index], index, title });
        if (part) parts.push(part);
        onProgress?.({
            phase: 'mesh',
            completed: index + 1,
            total: layers.length,
            ratio: ((index + 1) / layerTotal) * 0.58
        });
        await yieldControl();
    }
    if (!parts.length) return null;

    const project = createBambuProjectScaffold({
        parts,
        title,
        bedKey,
        nozzleDiameter,
        pauseEvents
    });
    await yieldControl();

    const partTotal = Math.max(1, parts.length);
    for (let index = 0; index < parts.length; index += 1) {
        appendBambuObjectFile(project, parts[index], index);
        onProgress?.({
            phase: 'xml',
            completed: index + 1,
            total: parts.length,
            ratio: 0.58 + (((index + 1) / partTotal) * 0.42)
        });
        await yieldControl();
    }

    appendBambuPreviewAssets(project.files, previewAssets);
    onProgress?.({ phase: 'complete', completed: parts.length, total: parts.length, ratio: 1 });
    return project;
}
