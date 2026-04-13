const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

function setRangeValue(locator, value) {
    return locator.evaluate((input, nextValue) => {
        input.value = String(nextValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
}

async function expectRenderedImage(locator) {
    await expect.poll(async () => locator.evaluate((img) => {
        if (!(img instanceof HTMLImageElement)) return false;
        const styles = window.getComputedStyle(img);
        return Boolean(img.src && img.naturalWidth > 0 && img.naturalHeight > 0 && styles.display !== 'none');
    }), {
        timeout: 30_000
    }).toBe(true);
}

function buildConnectedBlocksHtml() {
    return `
<div style="display:flex;align-items:center;width:240px;height:72px;background:transparent;">
  <div style="width:96px;height:56px;border-radius:28px;background:#111827;"></div>
  <div style="width:48px;height:56px;border-radius:24px;background:#ef4444;"></div>
  <div style="width:96px;height:56px;border-radius:28px;background:#111827;"></div>
</div>`.trim();
}

function buildConnectedBlocksSvg() {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="72" viewBox="0 0 240 72">
  <rect x="0" y="8" width="96" height="56" rx="28" ry="28" fill="#111827"/>
  <rect x="96" y="8" width="48" height="56" rx="24" ry="24" fill="#ef4444"/>
  <rect x="144" y="8" width="96" height="56" rx="28" ry="28" fill="#111827"/>
</svg>`.trim();
}

function buildEdgeStripeSvg() {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="72" viewBox="0 0 240 72">
  <rect x="0" y="0" width="240" height="72" rx="24" ry="24" fill="#111827"/>
  <rect x="0" y="0" width="48" height="72" rx="24" ry="24" fill="#ef4444"/>
</svg>`.trim();
}

function buildTinyBadgeSvg() {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="6" height="6" viewBox="0 0 6 6">
  <rect x="0" y="0" width="6" height="6" rx="1.5" ry="1.5" fill="#111827"/>
</svg>`.trim();
}

function parseBinaryStl(buffer) {
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    const view = new DataView(arrayBuffer);
    const triangleCount = view.getUint32(80, true);
    const triangles = [];
    let offset = 84;

    for (let index = 0; index < triangleCount; index++) {
        offset += 12;
        const triangle = [];
        for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
            triangle.push([
                view.getFloat32(offset, true),
                view.getFloat32(offset + 4, true),
                view.getFloat32(offset + 8, true)
            ]);
            offset += 12;
        }
        triangles.push(triangle);
        offset += 2;
    }

    return { triangleCount, triangles };
}

function countTriangleComponents(triangles) {
    if (!triangles.length) return 0;

    const parent = triangles.map((_, index) => index);
    const rank = triangles.map(() => 0);
    const vertexToFaces = new Map();

    const find = (index) => {
        if (parent[index] !== index) parent[index] = find(parent[index]);
        return parent[index];
    };

    const union = (left, right) => {
        const rootLeft = find(left);
        const rootRight = find(right);
        if (rootLeft === rootRight) return;
        if (rank[rootLeft] < rank[rootRight]) {
            parent[rootLeft] = rootRight;
            return;
        }
        if (rank[rootLeft] > rank[rootRight]) {
            parent[rootRight] = rootLeft;
            return;
        }
        parent[rootRight] = rootLeft;
        rank[rootLeft] += 1;
    };

    triangles.forEach((triangle, faceIndex) => {
        triangle.forEach((vertex) => {
            const key = vertex.map((value) => value.toFixed(4)).join(',');
            const faces = vertexToFaces.get(key) || [];
            faces.forEach((otherFaceIndex) => union(faceIndex, otherFaceIndex));
            faces.push(faceIndex);
            vertexToFaces.set(key, faces);
        });
    });

    return new Set(parent.map((_, index) => find(index))).size;
}

function getTriangleArea3d(triangle) {
    const [a, b, c] = triangle;
    const edgeA = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const edgeB = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const cross = [
        (edgeA[1] * edgeB[2]) - (edgeA[2] * edgeB[1]),
        (edgeA[2] * edgeB[0]) - (edgeA[0] * edgeB[2]),
        (edgeA[0] * edgeB[1]) - (edgeA[1] * edgeB[0])
    ];
    return Math.hypot(cross[0], cross[1], cross[2]) * 0.5;
}

function countZeroAreaTriangles(triangles) {
    return triangles.filter((triangle) => getTriangleArea3d(triangle) <= 1e-10).length;
}

function countOpenBoundaryEdges(triangles) {
    const edgeCounts = new Map();

    const recordEdge = (start, end) => {
        const a = start.map((value) => value.toFixed(4)).join(',');
        const b = end.map((value) => value.toFixed(4)).join(',');
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
    };

    triangles.forEach((triangle) => {
        recordEdge(triangle[0], triangle[1]);
        recordEdge(triangle[1], triangle[2]);
        recordEdge(triangle[2], triangle[0]);
    });

    let openEdges = 0;
    edgeCounts.forEach((count) => {
        if (count === 1) openEdges += 1;
    });
    return openEdges;
}

function getMeshBounds(triangles) {
    const bounds = {
        minX: Infinity,
        minY: Infinity,
        minZ: Infinity,
        maxX: -Infinity,
        maxY: -Infinity,
        maxZ: -Infinity
    };

    triangles.flat().forEach(([x, y, z]) => {
        bounds.minX = Math.min(bounds.minX, x);
        bounds.minY = Math.min(bounds.minY, y);
        bounds.minZ = Math.min(bounds.minZ, z);
        bounds.maxX = Math.max(bounds.maxX, x);
        bounds.maxY = Math.max(bounds.maxY, y);
        bounds.maxZ = Math.max(bounds.maxZ, z);
    });

    return {
        ...bounds,
        width: bounds.maxX - bounds.minX,
        depth: bounds.maxY - bounds.minY,
        height: bounds.maxZ - bounds.minZ
    };
}

async function collectDownloads(page, action, expectedCount) {
    const downloads = [];
    const handler = (download) => downloads.push(download);
    page.on('download', handler);

    try {
        await action();
        await expect.poll(() => downloads.length, {
            timeout: 30_000,
            message: `Expected ${expectedCount} downloads`
        }).toBe(expectedCount);
        return downloads;
    } finally {
        page.off('download', handler);
    }
}

async function saveDownloadBuffer(download, testInfo) {
    const suggestedFilename = download.suggestedFilename();
    const extension = path.extname(suggestedFilename) || '.bin';
    const safeFilename = suggestedFilename.length > 120
        ? `download-${Date.now()}-${Buffer.from(suggestedFilename).toString('hex').slice(0, 24)}${extension}`
        : suggestedFilename;
    const targetPath = testInfo.outputPath(safeFilename);
    await download.saveAs(targetPath);
    return fs.readFileSync(targetPath);
}

async function exportLayerStls(page, buttonSelector, expectedCount) {
    const statusLocator = page.locator('#status-text');
    return collectDownloads(page, async () => {
        await page.locator(buttonSelector).click();
        await expect(statusLocator).toContainText(`Exported ${expectedCount} STL files.`, { timeout: 30_000 });
    }, expectedCount);
}

function findDownloadByLayer(downloads, layerToken) {
    return downloads.find((download) => download.suggestedFilename().includes(layerToken)) || null;
}

test('welded overlap removes duplicated cap faces before extrusion', async ({ page }) => {
    await page.goto('/converter.html');
    await page.waitForFunction(() => Boolean(window.THREE && window.SVGLoader && window.ImageTracer));

    const result = await page.evaluate(async () => {
        const { buildWeldedShapeSet } = await import('/modules/shared/silhouette-builder.js');
        const THREERef = window.THREE;

        const makeRect = (minX, minY, maxX, maxY) => {
            const shape = new THREERef.Shape();
            shape.moveTo(minX, minY);
            shape.lineTo(maxX, minY);
            shape.lineTo(maxX, maxY);
            shape.lineTo(minX, maxY);
            shape.closePath();
            return shape;
        };

        const triangleArea2d = (a, b, c) => Math.abs(
            ((b[0] - a[0]) * (c[1] - a[1])) - ((c[0] - a[0]) * (b[1] - a[1]))
        ) / 2;

        const countCapStats = (shapes) => {
            let topArea = 0;
            let bottomArea = 0;

            shapes.forEach((shape) => {
                const geometry = new THREERef.ExtrudeGeometry(shape, {
                    depth: 2,
                    curveSegments: 6,
                    bevelEnabled: false
                });
                const positions = geometry.toNonIndexed().getAttribute('position');
                for (let index = 0; index < positions.count; index += 3) {
                    const vertices = [
                        [positions.getX(index), positions.getY(index), positions.getZ(index)],
                        [positions.getX(index + 1), positions.getY(index + 1), positions.getZ(index + 1)],
                        [positions.getX(index + 2), positions.getY(index + 2), positions.getZ(index + 2)]
                    ];
                    const capArea = triangleArea2d(vertices[0], vertices[1], vertices[2]);
                    if (vertices.every((value) => Math.abs(value[2]) < 1e-6)) {
                        bottomArea += capArea;
                    }
                    if (vertices.every((value) => Math.abs(value[2] - 2) < 1e-6)) {
                        topArea += capArea;
                    }
                }
                geometry.dispose();
            });

            return { topArea, bottomArea };
        };

        const rawShapes = [
            makeRect(0, 0, 10, 10),
            makeRect(5, 0, 15, 10)
        ];

        const welded = buildWeldedShapeSet({
            shapes: rawShapes,
            tracer: window.ImageTracer,
            options: { viewbox: true, strokewidth: 0 },
            SVGLoader: window.SVGLoader,
            THREERef
        });

        return {
            raw: countCapStats(rawShapes),
            welded: countCapStats(welded.shapes),
            weldedShapeCount: welded.shapes.length
        };
    });

    expect(result.weldedShapeCount).toBe(1);
    expect(result.raw.topArea).toBeGreaterThan(result.welded.topArea);
    expect(result.raw.bottomArea).toBeGreaterThan(result.welded.bottomArea);
    expect(result.welded.topArea).toBeGreaterThan(140);
    expect(result.welded.bottomArea).toBeGreaterThan(140);
});

test('logo support base stays continuous while detail reduction lowers triangle count', async ({ page }, testInfo) => {
    await page.goto('/converter.html');
    await page.locator('.segmented-control-tab[data-tab="logo"]').click();
    await expect(page.locator('#tab-logo')).toBeVisible();

    await page.locator('#logo-html-input').fill(buildConnectedBlocksHtml());
    await page.locator('#logo-html-render-btn').click();

    await expect(page.locator('#logo-html-status')).toHaveText('Ready', { timeout: 30_000 });
    await expectRenderedImage(page.locator('#logo-svg-preview'));
    await expect(page.locator('#logo-export-stl-btn')).toBeEnabled();
    await expect(page.locator('#logo-obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('#logo-use-base-layer')).toBeChecked();
    await expect(page.locator('#obj-structure-warning')).toBeHidden();

    const baselineDownloads = await exportLayerStls(page, '#logo-export-stl-btn', 2);
    const baselineBaseBuffer = await saveDownloadBuffer(
        baselineDownloads.find((download) => download.suggestedFilename().includes('_L0_')) || baselineDownloads[0],
        testInfo
    );
    const baselineBaseMesh = parseBinaryStl(baselineBaseBuffer);

    await setRangeValue(page.locator('#obj-decimate'), 80);
    await expect(page.locator('#logo-triangle-controls-hint')).toContainText('80%', { timeout: 30_000 });

    const reducedDownloads = await exportLayerStls(page, '#logo-export-stl-btn', 2);
    const reducedBaseBuffer = await saveDownloadBuffer(
        reducedDownloads.find((download) => download.suggestedFilename().includes('_L0_')) || reducedDownloads[0],
        testInfo
    );
    const reducedBaseMesh = parseBinaryStl(reducedBaseBuffer);

    expect(countTriangleComponents(baselineBaseMesh.triangles)).toBe(1);
    expect(countTriangleComponents(reducedBaseMesh.triangles)).toBe(1);
    expect(countZeroAreaTriangles(baselineBaseMesh.triangles)).toBe(0);
    expect(countZeroAreaTriangles(reducedBaseMesh.triangles)).toBe(0);
    expect(countOpenBoundaryEdges(baselineBaseMesh.triangles)).toBe(0);
    expect(countOpenBoundaryEdges(reducedBaseMesh.triangles)).toBe(0);
    expect(reducedBaseMesh.triangleCount).toBeLessThan(baselineBaseMesh.triangleCount);
});

test('svg tab uses the welded silhouette for support-base exports', async ({ page }, testInfo) => {
    await page.goto('/converter.html');

    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildConnectedBlocksSvg())}`;
    await page.locator('#url-input').fill(svgDataUrl);
    await page.locator('#load-url-btn').click();

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expectRenderedImage(page.locator('#svg-preview'));
    await expect(page.locator('#export-stl-btn')).toBeEnabled();
    await expect(page.locator('#obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('#use-base-layer')).toBeChecked();
    await expect(page.locator('#obj-structure-warning')).toBeHidden();

    const downloads = await exportLayerStls(page, '#export-stl-btn', 2);
    const baseBuffer = await saveDownloadBuffer(
        downloads.find((download) => download.suggestedFilename().includes('_L0_')) || downloads[0],
        testInfo
    );
    const baseMesh = parseBinaryStl(baseBuffer);

    expect(countTriangleComponents(baseMesh.triangles)).toBe(1);
    expect(countZeroAreaTriangles(baseMesh.triangles)).toBe(0);
    expect(countOpenBoundaryEdges(baseMesh.triangles)).toBe(0);
});

test('bezel presets raise the base without changing footprint size or adding layers', async ({ page }, testInfo) => {
    await page.goto('/converter.html');

    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildConnectedBlocksSvg())}`;
    await page.locator('#url-input').fill(svgDataUrl);
    await page.locator('#load-url-btn').click();

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expect(page.locator('#obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });

    const offDownloads = await exportLayerStls(page, '#export-stl-btn', 2);
    const offBaseMesh = parseBinaryStl(await saveDownloadBuffer(
        findDownloadByLayer(offDownloads, '_L0_') || offDownloads[0],
        testInfo
    ));

    await page.locator('#obj-bezel').selectOption('low');
    const lowDownloads = await exportLayerStls(page, '#export-stl-btn', 2);
    const lowBaseMesh = parseBinaryStl(await saveDownloadBuffer(
        findDownloadByLayer(lowDownloads, '_L0_') || lowDownloads[0],
        testInfo
    ));

    await page.locator('#obj-bezel').selectOption('high');
    const highDownloads = await exportLayerStls(page, '#export-stl-btn', 2);
    const highBaseMesh = parseBinaryStl(await saveDownloadBuffer(
        findDownloadByLayer(highDownloads, '_L0_') || highDownloads[0],
        testInfo
    ));

    const offBounds = getMeshBounds(offBaseMesh.triangles);
    const lowBounds = getMeshBounds(lowBaseMesh.triangles);
    const highBounds = getMeshBounds(highBaseMesh.triangles);

    expect(countTriangleComponents(lowBaseMesh.triangles)).toBe(1);
    expect(countTriangleComponents(highBaseMesh.triangles)).toBe(1);
    expect(countZeroAreaTriangles(lowBaseMesh.triangles)).toBe(0);
    expect(countZeroAreaTriangles(highBaseMesh.triangles)).toBe(0);
    expect(countOpenBoundaryEdges(lowBaseMesh.triangles)).toBe(0);
    expect(countOpenBoundaryEdges(highBaseMesh.triangles)).toBe(0);
    expect(Math.abs(lowBounds.width - offBounds.width)).toBeLessThan(0.15);
    expect(Math.abs(lowBounds.depth - offBounds.depth)).toBeLessThan(0.15);
    expect(Math.abs(highBounds.width - offBounds.width)).toBeLessThan(0.15);
    expect(Math.abs(highBounds.depth - offBounds.depth)).toBeLessThan(0.15);
    expect(lowBounds.height).toBeGreaterThan(offBounds.height + 0.2);
    expect(highBounds.height).toBeGreaterThan(lowBounds.height + 0.2);
});

test('bezel clips edge detail inward without breaking the exported meshes', async ({ page }, testInfo) => {
    await page.goto('/converter.html');

    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildEdgeStripeSvg())}`;
    await page.locator('#url-input').fill(svgDataUrl);
    await page.locator('#load-url-btn').click();

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expect(page.locator('#obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });

    const offDownloads = await exportLayerStls(page, '#export-stl-btn', 2);
    const offBaseMesh = parseBinaryStl(await saveDownloadBuffer(
        findDownloadByLayer(offDownloads, '_L0_') || offDownloads[0],
        testInfo
    ));
    const offDetailMesh = parseBinaryStl(await saveDownloadBuffer(
        findDownloadByLayer(offDownloads, '_L1_') || offDownloads[1],
        testInfo
    ));

    await page.locator('#obj-bezel').selectOption('low');
    const bezelDownloads = await exportLayerStls(page, '#export-stl-btn', 2);
    const bezelBaseMesh = parseBinaryStl(await saveDownloadBuffer(
        findDownloadByLayer(bezelDownloads, '_L0_') || bezelDownloads[0],
        testInfo
    ));
    const bezelDetailMesh = parseBinaryStl(await saveDownloadBuffer(
        findDownloadByLayer(bezelDownloads, '_L1_') || bezelDownloads[1],
        testInfo
    ));

    const offBaseBounds = getMeshBounds(offBaseMesh.triangles);
    const offDetailBounds = getMeshBounds(offDetailMesh.triangles);
    const bezelBaseBounds = getMeshBounds(bezelBaseMesh.triangles);
    const bezelDetailBounds = getMeshBounds(bezelDetailMesh.triangles);

    expect(countOpenBoundaryEdges(bezelBaseMesh.triangles)).toBe(0);
    expect(countOpenBoundaryEdges(bezelDetailMesh.triangles)).toBe(0);
    expect(countZeroAreaTriangles(bezelBaseMesh.triangles)).toBe(0);
    expect(countZeroAreaTriangles(bezelDetailMesh.triangles)).toBe(0);
    expect(Math.abs(bezelBaseBounds.minX - offBaseBounds.minX)).toBeLessThan(0.15);
    expect(bezelDetailBounds.minX).toBeGreaterThan(offDetailBounds.minX + 0.3);
});

test('tiny models skip bezel cleanly when no printable interior remains', async ({ page }, testInfo) => {
    await page.goto('/converter.html');

    const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(buildTinyBadgeSvg())}`;
    await page.locator('#url-input').fill(svgDataUrl);
    await page.locator('#load-url-btn').click();

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expect(page.locator('#obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });

    const offDownloads = await exportLayerStls(page, '#export-stl-btn', 1);
    const offMesh = parseBinaryStl(await saveDownloadBuffer(offDownloads[0], testInfo));

    await page.locator('#obj-bezel').selectOption('high');
    const highDownloads = await exportLayerStls(page, '#export-stl-btn', 1);
    const highMesh = parseBinaryStl(await saveDownloadBuffer(highDownloads[0], testInfo));

    const offBounds = getMeshBounds(offMesh.triangles);
    const highBounds = getMeshBounds(highMesh.triangles);

    expect(countOpenBoundaryEdges(highMesh.triangles)).toBe(0);
    expect(countZeroAreaTriangles(highMesh.triangles)).toBe(0);
    expect(Math.abs(highBounds.width - offBounds.width)).toBeLessThan(0.05);
    expect(Math.abs(highBounds.depth - offBounds.depth)).toBeLessThan(0.05);
    expect(Math.abs(highBounds.height - offBounds.height)).toBeLessThan(0.05);
});
