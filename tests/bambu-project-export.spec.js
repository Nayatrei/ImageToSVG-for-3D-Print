const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { test, expect } = require('@playwright/test');

function buildAsymmetricBubbleSvg() {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="140" viewBox="0 0 240 140">
  <path fill="#f2d500" d="M36 18h150c27.6 0 50 22.4 50 50s-22.4 50-50 50H88l-22 18 4-18H36C16.1 118 0 101.9 0 82V68C0 40.4 18.4 18 36 18z"/>
  <rect x="38" y="38" width="20" height="20" rx="4" fill="#111827"/>
</svg>`.trim();
}

async function collectDownloads(page, action, expectedCount = 1) {
    const downloads = [];
    const handler = (download) => downloads.push(download);
    page.on('download', handler);

    try {
        await action();
        await expect.poll(() => downloads.length, {
            timeout: 30_000,
            message: `Expected ${expectedCount} download(s)`
        }).toBe(expectedCount);
        return downloads;
    } finally {
        page.off('download', handler);
    }
}

async function saveDownload(download, testInfo) {
    const targetPath = testInfo.outputPath(download.suggestedFilename());
    await download.saveAs(targetPath);
    return targetPath;
}

function inspectBambuProject(filePath) {
    const script = `
import json
import sys
import zipfile
import xml.etree.ElementTree as ET

archive = zipfile.ZipFile(sys.argv[1])
names = archive.namelist()
root_model = archive.read('3D/3dmodel.model').decode('utf-8', 'replace')
rels_xml = archive.read('3D/_rels/3dmodel.model.rels').decode('utf-8', 'replace')
plate = json.loads(archive.read('Metadata/plate_1.json').decode('utf-8', 'replace'))
model_settings = archive.read('Metadata/model_settings.config').decode('utf-8', 'replace')

ns = {
    'm': 'http://schemas.microsoft.com/3dmanufacturing/core/2015/02',
    'r': 'http://schemas.openxmlformats.org/package/2006/relationships'
}

rels_root = ET.fromstring(rels_xml)
relation_targets = [node.attrib.get('Target') for node in rels_root]

detail_centroid_x = None
if '3D/Objects/object_2.model' in names:
    detail_root = ET.fromstring(archive.read('3D/Objects/object_2.model').decode('utf-8', 'replace'))
    xs = [float(node.attrib['x']) for node in detail_root.findall('.//m:vertex', ns)]
    if xs:
        detail_centroid_x = sum(xs) / len(xs)

print(json.dumps({
    'names': names,
    'relationTargets': relation_targets,
    'rootHasBambuNamespace': 'xmlns:BambuStudio="http://schemas.bambulab.com/package/2021"' in root_model,
    'rootHas3mfVersion': '<metadata name="BambuStudio:3mfVersion">1</metadata>' in root_model,
    'plate': plate,
    'modelSettings': model_settings,
    'detailCentroidX': detail_centroid_x
}))
`;

    return JSON.parse(execFileSync('python3', ['-c', script, filePath], { encoding: 'utf8' }));
}

test('Bambu project export includes native package metadata and preserves handedness', async ({ page }, testInfo) => {
    await page.goto('/converter.html');

    await expect(page.locator('#svg-bambu-open-btn')).toBeDisabled();

    await page.locator('#file-input').setInputFiles({
        name: 'asymmetric-bubble.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(buildAsymmetricBubbleSvg())
    });

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expect(page.locator('#obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });

    const rotationY = await page.evaluate(async () => (await import('/modules/config.js')).OBJ_DEFAULT_ROTATION.y);
    expect(rotationY).toBeLessThan(0);

    const downloads = await collectDownloads(page, async () => {
        await page.locator('#export-3mf-btn').click();
        await expect(page.locator('#status-text')).toHaveText('Bambu Studio project downloaded. Open the .3mf in Bambu Studio.', { timeout: 30_000 });
    });

    const filePath = await saveDownload(downloads[0], testInfo);
    const project = inspectBambuProject(filePath);

    expect(project.names).toEqual(expect.arrayContaining([
        '[Content_Types].xml',
        '_rels/.rels',
        '3D/3dmodel.model',
        '3D/_rels/3dmodel.model.rels',
        '3D/Objects/object_1.model',
        '3D/Objects/object_2.model',
        'Metadata/project_settings.config',
        'Metadata/model_settings.config',
        'Metadata/slice_info.config',
        'Metadata/plate_1.json',
        'Metadata/filament_sequence.json',
        'Metadata/cut_information.xml',
        'Metadata/plate_1.png',
        'Metadata/plate_1_small.png',
        'Metadata/top_1.png',
        'Metadata/pick_1.png',
        'Metadata/plate_no_light_1.png',
        'Auxiliaries/.thumbnails/thumbnail_3mf.png',
        'Auxiliaries/.thumbnails/thumbnail_middle.png',
        'Auxiliaries/.thumbnails/thumbnail_small.png'
    ]));
    expect(project.rootHasBambuNamespace).toBe(true);
    expect(project.rootHas3mfVersion).toBe(true);
    expect(project.relationTargets).toEqual(expect.arrayContaining([
        '/3D/Objects/object_1.model',
        '/3D/Objects/object_2.model'
    ]));
    expect(project.plate.bed_type).toBe('textured_plate');
    expect(project.plate.nozzle_diameter).toBeCloseTo(0.4, 5);
    expect(project.plate.filament_colors).toHaveLength(2);
    expect(project.modelSettings).toContain('metadata key="extruder" value="1"');
    expect(project.modelSettings).toContain('metadata key="extruder" value="2"');
    expect(project.detailCentroidX).not.toBeNull();
    expect(project.detailCentroidX).toBeLessThan(128);
});

test('Bambu Studio button downloads 3MF and triggers the protocol hook', async ({ page }) => {
    await page.addInitScript(() => {
        window.__GENESIS_BAMBU_PROTOCOL_CALLS__ = [];
        window.__GENESIS_BAMBU_PROTOCOL_HOOK__ = async (url) => {
            window.__GENESIS_BAMBU_PROTOCOL_CALLS__.push(url);
            return true;
        };
    });

    await page.goto('/converter.html');
    await page.locator('#file-input').setInputFiles({
        name: 'asymmetric-bubble.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(buildAsymmetricBubbleSvg())
    });

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expect(page.locator('#svg-bambu-open-btn')).toBeEnabled();

    const downloads = await collectDownloads(page, async () => {
        await page.locator('#svg-bambu-open-btn').click();
        await expect(page.locator('#status-text')).toContainText(/Bambu Studio/, { timeout: 30_000 });
    });

    expect(downloads[0].suggestedFilename()).toMatch(/\.3mf$/i);
});
