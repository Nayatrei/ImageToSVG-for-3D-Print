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
            elements.statusText.textContent = 'Analyze colors before exporting OBJ.';
            return;
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const OBJExporter = window.OBJExporter || window.THREE?.OBJExporter;
        const THREERef = window.THREE;

        if (!SVGLoader || !OBJExporter || !THREERef) {
            elements.statusText.textContent = 'OBJ export libraries are still loading.';
            return;
        }

        const dataToExport = getDataToExport();
        if (!dataToExport) {
            elements.statusText.textContent = 'No layers available for OBJ export.';
            return;
        }

        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const thickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;
        const detailValue = elements.objDetailSlider ? parseInt(elements.objDetailSlider.value, 10) : 6;
        const curveSegments = Number.isFinite(detailValue) ? Math.max(1, detailValue) : 6;
        const bedKey = elements.objBedSelect?.value || 'x1';
        const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
        const marginValue = elements.objMarginInput ? parseFloat(elements.objMarginInput.value) : 5;
        const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;

        try {
            showLoader(true);
            elements.statusText.textContent = 'Exporting OBJ...';

            const svgString = tracer.getsvgstring(dataToExport, state.lastOptions);
            const loader = new SVGLoader();
            const svgData = loader.parse(svgString);
            const group = new THREERef.Group();
            const materials = new Map();
            const layerIndexMap = buildLayerIndexMap(dataToExport.palette);

            svgData.paths.forEach((path) => {
                const shapes = SVGLoader.createShapes(path);
                if (!shapes || !shapes.length) return;

                const sourceColor = path.color instanceof THREERef.Color
                    ? path.color
                    : new THREERef.Color(path.color || '#000');
                const hex = sourceColor.getHexString();
                const layerIndex = getLayerIndexForColor(layerIndexMap, hex);
                const layerZ = layerIndex * thickness;

                let material = materials.get(hex);
                if (!material) {
                    material = new THREERef.MeshStandardMaterial({ color: sourceColor });
                    material.name = `mat_${hex}`;
                    materials.set(hex, material);
                }

                shapes.forEach((shape) => {
                    const geometry = new THREERef.ExtrudeGeometry(shape, {
                        depth: thickness,
                        curveSegments,
                        bevelEnabled: false
                    });
                    geometry.rotateX(Math.PI);
                    const mesh = new THREERef.Mesh(geometry, material);
                    mesh.position.z = layerZ;
                    group.add(mesh);
                });
            });

            const bbox = new THREERef.Box3().setFromObject(group);
            const size = new THREERef.Vector3();
            bbox.getSize(size);
            if (size.x > 0 && size.y > 0) {
                const maxWidth = Math.max(1, bed.width - margin * 2);
                const maxDepth = Math.max(1, bed.depth - margin * 2);
                const scale = Math.min(maxWidth / size.x, maxDepth / size.y, 1);
                if (scale < 1) {
                    group.scale.set(scale, scale, 1);
                }
            }

            const exporter = new OBJExporter();
            group.updateMatrixWorld(true);
            let obj = exporter.parse(group);
            const baseName = `${getImageBaseName()}_extruded_${Math.round(thickness)}mm`;
            const mtl = buildMtl(materials, baseName);

            if (mtl) {
                obj = `mtllib ${baseName}.mtl\n` + obj;
                downloadBlob(new Blob([mtl], { type: 'text/plain' }), `${baseName}.mtl`);
            }

            downloadBlob(new Blob([obj], { type: 'text/plain' }), `${baseName}.obj`);
            elements.statusText.textContent = 'OBJ export complete.';
        } catch (error) {
            console.error('OBJ export failed:', error);
            elements.statusText.textContent = 'Failed to export OBJ.';
        } finally {
            showLoader(false);
        }
    }

    async function exportAsGLB() {
        if (!state.tracedata) {
            elements.statusText.textContent = 'Analyze colors before exporting GLB.';
            return;
        }

        const SVGLoader = window.SVGLoader || window.THREE?.SVGLoader;
        const GLTFExporter = window.GLTFExporter || window.THREE?.GLTFExporter;
        const THREERef = window.THREE;

        if (!SVGLoader || !GLTFExporter || !THREERef) {
            elements.statusText.textContent = 'GLB export libraries are still loading.';
            return;
        }

        const dataToExport = getDataToExport();
        if (!dataToExport) {
            elements.statusText.textContent = 'No layers available for GLB export.';
            return;
        }

        const thicknessValue = elements.objThicknessSlider ? parseFloat(elements.objThicknessSlider.value) : 4;
        const thickness = Number.isFinite(thicknessValue) ? thicknessValue : 4;
        const detailValue = elements.objDetailSlider ? parseInt(elements.objDetailSlider.value, 10) : 6;
        const curveSegments = Number.isFinite(detailValue) ? Math.max(1, detailValue) : 6;
        const bedKey = elements.objBedSelect?.value || 'x1';
        const bed = BED_PRESETS[bedKey] || BED_PRESETS.x1;
        const marginValue = elements.objMarginInput ? parseFloat(elements.objMarginInput.value) : 5;
        const margin = Number.isFinite(marginValue) ? Math.max(0, marginValue) : 5;

        try {
            showLoader(true);
            elements.statusText.textContent = 'Exporting GLB...';

            const svgString = tracer.getsvgstring(dataToExport, state.lastOptions);
            const loader = new SVGLoader();
            const svgData = loader.parse(svgString);
            const group = new THREERef.Group();
            const materials = new Map();
            const layerIndexMap = buildLayerIndexMap(dataToExport.palette);

            svgData.paths.forEach((path) => {
                const shapes = SVGLoader.createShapes(path);
                if (!shapes || !shapes.length) return;

                const sourceColor = path.color instanceof THREERef.Color
                    ? path.color
                    : new THREERef.Color(path.color || '#000');
                const hex = sourceColor.getHexString();
                const layerIndex = getLayerIndexForColor(layerIndexMap, hex);
                const layerZ = layerIndex * thickness;

                let material = materials.get(hex);
                if (!material) {
                    material = new THREERef.MeshStandardMaterial({ color: sourceColor });
                    material.name = `mat_${hex}`;
                    materials.set(hex, material);
                }

                shapes.forEach((shape) => {
                    const geometry = new THREERef.ExtrudeGeometry(shape, {
                        depth: thickness,
                        curveSegments,
                        bevelEnabled: false
                    });
                    geometry.rotateX(Math.PI);
                    const mesh = new THREERef.Mesh(geometry, material);
                    mesh.position.z = layerZ;
                    group.add(mesh);
                });
            });

            const bbox = new THREERef.Box3().setFromObject(group);
            const size = new THREERef.Vector3();
            bbox.getSize(size);
            if (size.x > 0 && size.y > 0) {
                const maxWidth = Math.max(1, bed.width - margin * 2);
                const maxDepth = Math.max(1, bed.depth - margin * 2);
                const scale = Math.min(maxWidth / size.x, maxDepth / size.y, 1);
                if (scale < 1) {
                    group.scale.set(scale, scale, 1);
                }
            }

            const exporter = new GLTFExporter();
            group.updateMatrixWorld(true);
            exporter.parse(
                group,
                (result) => {
                    const baseName = `${getImageBaseName()}_extruded_${Math.round(thickness)}mm`;
                    const blob = new Blob([result], { type: 'model/gltf-binary' });
                    downloadBlob(blob, `${baseName}.glb`);
                    elements.statusText.textContent = 'GLB export complete.';
                },
                { binary: true }
            );
        } catch (error) {
            console.error('GLB export failed:', error);
            elements.statusText.textContent = 'Failed to export GLB.';
        } finally {
            showLoader(false);
        }
    }

    return { exportAsOBJ, exportAsGLB };
}
