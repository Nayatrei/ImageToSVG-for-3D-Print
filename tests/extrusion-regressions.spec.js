const fs = require('fs');
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
    const targetPath = testInfo.outputPath(download.suggestedFilename());
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
});
