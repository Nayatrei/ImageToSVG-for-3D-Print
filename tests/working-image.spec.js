const path = require('path');
const { test, expect } = require('@playwright/test');

function setRangeValue(locator, value) {
    return locator.evaluate((input, nextValue) => {
        input.value = String(nextValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
}

function buildOversizedRectSvg() {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="1100" height="900" viewBox="0 0 1100 900">
  <rect x="0" y="0" width="1100" height="900" fill="#111827"/>
</svg>`.trim();
}

function parseFootprint(text) {
    const match = /Footprint:\s*([0-9.]+)\s*×\s*([0-9.]+)\s*mm/.exec(text || '');
    if (!match) return null;
    return {
        width: Number.parseFloat(match[1]),
        depth: Number.parseFloat(match[2])
    };
}

test('auto working image helper chooses expected dimensions', async ({ page }) => {
    await page.goto('/converter.html');

    const result = await page.evaluate(async () => {
        const mod = await import('/modules/raster-utils.js');
        return {
            small: mod.getAutoWorkingImageSpec({ width: 500, height: 400 }),
            longEdge: mod.getAutoWorkingImageSpec({ width: 1600, height: 400, maxPixels: 5_000_000 }),
            pixelBudget: mod.getAutoWorkingImageSpec({ width: 1000, height: 1000, maxEdge: 5_000, maxPixels: 640_000 }),
            both: mod.getAutoWorkingImageSpec({ width: 1600, height: 900, maxEdge: 1400, maxPixels: 810_000 })
        };
    });

    expect(result.small).toMatchObject({
        workingWidth: 500,
        workingHeight: 400,
        workingScale: 1,
        wasReduced: false
    });
    expect(result.longEdge).toMatchObject({
        workingWidth: 1024,
        workingHeight: 256,
        workingScale: 0.64,
        wasReduced: true
    });
    expect(result.pixelBudget).toMatchObject({
        workingWidth: 800,
        workingHeight: 800,
        workingScale: 0.8,
        wasReduced: true
    });
    expect(result.both).toMatchObject({
        workingWidth: 1200,
        workingHeight: 675,
        workingScale: 0.75,
        wasReduced: true
    });
});

test('color and path settings start collapsed in svg and logo sidebars', async ({ page }) => {
    await page.goto('/converter.html');

    const accordionState = await page.evaluate(() => {
        const readState = (bodyId) => {
            const button = document.querySelector(`[onclick*="${bodyId}"]`);
            const body = document.getElementById(bodyId);
            return {
                expanded: button?.classList.contains('expanded') || false,
                ariaExpanded: button?.getAttribute('aria-expanded'),
                maxHeight: body ? getComputedStyle(body).maxHeight : null
            };
        };

        return {
            svgColor: readState('color-controls-body'),
            svgPath: readState('path-controls-body'),
            logoColor: readState('logo-color-controls-body'),
            logoPath: readState('logo-path-controls-body')
        };
    });

    expect(accordionState.svgColor).toMatchObject({
        expanded: false,
        ariaExpanded: 'false',
        maxHeight: '0px'
    });
    expect(accordionState.svgPath).toMatchObject({
        expanded: false,
        ariaExpanded: 'false',
        maxHeight: '0px'
    });
    expect(accordionState.logoColor).toMatchObject({
        expanded: false,
        ariaExpanded: 'false',
        maxHeight: '0px'
    });
    expect(accordionState.logoPath).toMatchObject({
        expanded: false,
        ariaExpanded: 'false',
        maxHeight: '0px'
    });
});

test('small source keeps full size and avoids oversized notice', async ({ page }) => {
    await page.goto('/converter.html');
    await page.locator('#file-input').setInputFiles(path.join(process.cwd(), 'genesis-logo.png'));

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expect(page.locator('#original-resolution')).toHaveText('500×500 px');
    await expect(page.locator('#resolution-notice')).not.toContainText('Large source detected.');
});

test('oversized source uses reduced working image while preserving 3D footprint scale', async ({ page }) => {
    await page.goto('/converter.html');
    await page.locator('#file-input').setInputFiles({
        name: 'oversized-rect.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(buildOversizedRectSvg())
    });

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 30_000 });
    await expect(page.locator('#original-resolution')).toHaveText('1100×900 px');
    await expect(page.locator('#resolution-notice')).toContainText('Using 1024×838 internally');
    await expect(page.locator('#obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });

    await setRangeValue(page.locator('#obj-scale'), 50);
    await expect(page.locator('#obj-size-readout')).toContainText('Footprint:', { timeout: 30_000 });

    const footprint = parseFootprint(await page.locator('#obj-size-readout').textContent());
    expect(footprint.width).toBeCloseTo(137.5, 0);
    expect(footprint.depth).toBeCloseTo(112.5, 0);
});

test('test image is internally reduced and still completes preview generation', async ({ page }) => {
    await page.goto('/converter.html');
    await page.locator('#file-input').setInputFiles(path.join(process.cwd(), 'testImage.png'));

    await expect(page.locator('#status-text')).toHaveText('Preview generated!', { timeout: 60_000 });
    await expect(page.locator('#original-resolution')).toHaveText('1536×1024 px');
    await expect(page.locator('#resolution-notice')).toContainText('Using 1024×683 internally');
    await expect(page.locator('#obj-preview-placeholder')).toBeHidden({ timeout: 60_000 });
});

test('logo html mode does not use oversized working-image notice', async ({ page }) => {
    await page.goto('/converter.html');
    await page.locator('.segmented-control-tab[data-tab="logo"]').click();
    await expect(page.locator('#tab-logo')).toBeVisible();

    await page.locator('#logo-html-input').fill('<div style="width:640px;height:320px;background:#111827;border-radius:40px;"></div>');
    await page.locator('#logo-html-render-btn').click();

    await expect(page.locator('#logo-html-status')).toHaveText('Ready', { timeout: 30_000 });
    await expect(page.locator('#resolution-notice')).not.toContainText('Large source detected.');
});
