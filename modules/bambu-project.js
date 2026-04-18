import {
    BAMBU_PROJECT_APP_VERSION,
    BAMBU_PROJECT_3MF_VERSION,
    BAMBU_PROJECT_NOZZLE_DIAMETER
} from './config.js';
import { getBambuPrinterTemplate, buildBambuProjectSettings } from './bambu/templates.js';

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

function getGeometryMeshData(geometry) {
    if (!geometry) return null;
    const position = geometry.getAttribute('position');
    if (!position || position.count < 3) return null;

    const index = geometry.index;
    const vertices = [];
    const triangles = [];
    const bounds = {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity
    };

    for (let vertexIndex = 0; vertexIndex < position.count; vertexIndex++) {
        const x = position.getX(vertexIndex);
        const y = position.getY(vertexIndex);
        const z = position.getZ(vertexIndex);
        vertices.push({ x, y, z });
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.minZ = Math.min(bounds.minZ, z);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
        bounds.maxZ = Math.max(bounds.maxZ, z);
    }

    if (index) {
        for (let triangleIndex = 0; triangleIndex < index.count; triangleIndex += 3) {
            triangles.push({
                v1: index.getX(triangleIndex),
                v2: index.getX(triangleIndex + 1),
                v3: index.getX(triangleIndex + 2)
            });
        }
    } else {
        for (let triangleIndex = 0; triangleIndex < position.count; triangleIndex += 3) {
            triangles.push({
                v1: triangleIndex,
                v2: triangleIndex + 1,
                v3: triangleIndex + 2
            });
        }
    }

    return {
        vertices,
        triangles,
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
        `     <vertex x="${formatNumber(vertex.x)}" y="${formatNumber(vertex.y)}" z="${formatNumber(vertex.z)}"/>`
    )).join('\n');
    const trianglesXml = meshData.triangles.map((triangle) => (
        `     <triangle v1="${triangle.v1}" v2="${triangle.v2}" v3="${triangle.v3}"/>`
    )).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06" requiredextensions="p">
 <metadata name="BambuStudio:3mfVersion">${escapeXml(BAMBU_PROJECT_3MF_VERSION)}</metadata>
 <resources>
  <object id="1" p:UUID="${escapeXml(uuid)}" type="model">
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
  <item objectid="1"/>
 </build>
</model>`;
}

function buildRootModelXml({ title, dateStamp, assemblyUuid, buildUuid, parts }) {
    const componentsXml = parts.map((part, index) => (
        `    <component p:path="/3D/Objects/object_${index + 1}.model" objectid="1" p:UUID="${escapeXml(part.componentUuid)}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>`
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
  <object id="1" p:UUID="${escapeXml(assemblyUuid)}" type="model">
   <components>
${componentsXml}
   </components>
  </object>
 </resources>
 <build p:UUID="${escapeXml(buildUuid)}">
  <item objectid="1" p:UUID="${escapeXml(stableUuid(`${title}|build-item`))}" transform="1 0 0 0 1 0 0 0 1 0 0 0" printable="1"/>
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

function buildModelSettingsXml({ title, parts }) {
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
      <metadata key="extruder" value="${index + 1}"/>
      <mesh_stat face_count="${part.meshData.triangles.length}" edges_fixed="0" degenerate_facets="0" facets_removed="0" facets_reversed="0" backwards_edges="0"/>
    </part>`
    )).join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<config>
  <object id="1">
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
    <metadata key="filament_maps" value="${parts.length}"/>
    <metadata key="thumbnail_file" value="Metadata/plate_1.png"/>
    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_1.png"/>
    <metadata key="top_file" value="Metadata/top_1.png"/>
    <metadata key="pick_file" value="Metadata/pick_1.png"/>
    <model_instance>
      <metadata key="object_id" value="1"/>
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

function buildCutInformationXml() {
    return `<?xml version="1.0" encoding="utf-8"?>
<objects>
 <object id="1">
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

function buildPlateJson({ template, parts }) {
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
            id: 1,
            layer_height: 0.2,
            name: 'Genesis Assembly'
        }],
        bed_type: template.bedType,
        filament_colors: parts.map((part) => part.hexColor),
        filament_ids: parts.map((_, index) => index),
        first_extruder: 0,
        is_seq_print: false,
        nozzle_diameter: BAMBU_PROJECT_NOZZLE_DIAMETER,
        version: 2
    }, null, 2);
}

function buildFilamentSequenceJson(parts) {
    return JSON.stringify({
        plate_1: {
            sequence: parts.map((_, index) => index)
        }
    }, null, 2);
}

export function buildBambuProjectFiles({
    layers,
    baseName,
    bedKey = 'x1',
    nozzleDiameter = BAMBU_PROJECT_NOZZLE_DIAMETER,
    previewAssets = {}
}) {
    const template = getBambuPrinterTemplate(bedKey);
    const title = String(baseName || 'genesis_project');
    const dateStamp = new Date().toISOString().slice(0, 10);

    const parts = [];
    layers.forEach((layerData, index) => {
        const meshData = getGeometryMeshData(layerData.geometry);
        if (!meshData) {
            const posAttr = layerData.geometry?.getAttribute?.('position');
            console.warn(`[GenesisDebug] 3MF assembly: layer ${index} "${layerData.displayLabel || ''}" SKIPPED by getGeometryMeshData (geometry: ${!!layerData.geometry}, positionAttr: ${!!posAttr}, vertexCount: ${posAttr?.count || 0}, isBase: ${layerData.isBase})`);
            return;
        }

        parts.push({
            index,
            name: layerData.displayLabel || `Layer ${index + 1}`,
            meshData,
            hexColor: colorToHex(layerData.color),
            componentUuid: stableUuid(`${title}|component|${index}`),
            objectUuid: stableUuid(`${title}|object-model|${index}`)
        });
    });

    if (!parts.length) return null;

    const projectSettings = buildBambuProjectSettings({
        template,
        title,
        layerCount: parts.length,
        filamentColors: parts.map((part) => part.hexColor),
        nozzleDiameter
    });

    const files = {
        '[Content_Types].xml': buildContentTypesXml(),
        '_rels/.rels': buildRootRelsXml(),
        '3D/3dmodel.model': buildRootModelXml({
            title,
            dateStamp,
            assemblyUuid: stableUuid(`${title}|assembly`),
            buildUuid: stableUuid(`${title}|build`),
            parts
        }),
        '3D/_rels/3dmodel.model.rels': buildModelRelsXml(parts),
        'Metadata/project_settings.config': JSON.stringify(projectSettings, null, 2),
        'Metadata/model_settings.config': buildModelSettingsXml({ title, parts }),
        'Metadata/slice_info.config': buildSliceInfoXml(),
        'Metadata/plate_1.json': buildPlateJson({ template, parts }),
        'Metadata/filament_sequence.json': buildFilamentSequenceJson(parts),
        'Metadata/cut_information.xml': buildCutInformationXml()
    };

    parts.forEach((part, index) => {
        files[`3D/Objects/object_${index + 1}.model`] = buildObjectModelXml({
            objectFileId: index + 1,
            meshData: part.meshData,
            uuid: part.objectUuid
        });
    });

    if (previewAssets.plateLarge) {
        files['Metadata/plate_1.png'] = previewAssets.plateLarge;
        files['Metadata/plate_no_light_1.png'] = previewAssets.plateLarge;
        files['Metadata/top_1.png'] = previewAssets.plateLarge;
        files['Metadata/pick_1.png'] = previewAssets.plateLarge;
    }
    if (previewAssets.plateSmall) {
        files['Metadata/plate_1_small.png'] = previewAssets.plateSmall;
    }
    if (previewAssets.thumbnailLarge) {
        files['Auxiliaries/.thumbnails/thumbnail_3mf.png'] = previewAssets.thumbnailLarge;
        files['Auxiliaries/.thumbnails/thumbnail_middle.png'] = previewAssets.thumbnailLarge;
    }
    if (previewAssets.thumbnailSmall) {
        files['Auxiliaries/.thumbnails/thumbnail_small.png'] = previewAssets.thumbnailSmall;
    }

    return {
        files,
        parts,
        title,
        template
    };
}
