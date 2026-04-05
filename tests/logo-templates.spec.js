const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const QA_DIR = path.join(process.cwd(), 'test-results', 'manual-logo');
const PRESETS = [
    { name: 'pill', resolution: '936×304 px' },
    { name: 'badge', resolution: '896×896 px' },
    { name: 'cta', resolution: '1032×312 px' }
];

function outputPath(name) {
    fs.mkdirSync(QA_DIR, { recursive: true });
    return path.join(QA_DIR, name);
}

async function setRangeValue(locator, value) {
    await locator.evaluate((input, nextValue) => {
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

async function openLogoTab(page) {
    await page.goto('/converter.html');
    await page.locator('.segmented-control-tab[data-tab="logo"]').click();
    await expect(page.locator('#tab-logo')).toBeVisible();
    await expect(page.locator('#logo-sidebar-controls')).toBeVisible();
    await expect(page.locator('#svg-sidebar-controls')).toBeHidden();
}

async function renderPreset(page, presetName, expectedResolution) {
    await page.locator(`#tab-logo .logo-html-preset[data-preset="${presetName}"]`).click();
    await expect(page.locator('#logo-original-resolution')).toHaveText(expectedResolution, { timeout: 30_000 });
    await expect(page.locator('#logo-html-status')).toHaveText('Ready', { timeout: 30_000 });
    await expectRenderedImage(page.locator('#logo-svg-source-mirror'));
    await expectRenderedImage(page.locator('#logo-svg-preview'));
    await expect(page.locator('#logo-export-obj-btn')).toBeEnabled();
    await expect(page.locator('#logo-export-3mf-btn')).toBeEnabled();
    await expect(page.locator('#logo-export-stl-btn')).toBeEnabled();
    await expect(page.locator('#logo-bambu-open-btn')).toBeDisabled();
    await expect(page.locator('#logo-obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('#tab-logo #logo-obj-scale')).toHaveCount(0);
    await expect(page.locator('#tab-logo #logo-obj-thickness')).toHaveCount(0);
    await expect(page.locator('#tab-logo #logo-obj-margin')).toHaveCount(0);
    await expect(page.locator('#tab-logo #logo-obj-bed')).toHaveCount(0);
}

test('logo sidebar controls stay isolated from SVG controls', async ({ page }) => {
    await openLogoTab(page);

    await expect(page.locator('#sidebar-adjust-section #obj-scale')).toBeVisible();
    await expect(page.locator('#sidebar-adjust-section #obj-thickness')).toBeVisible();
    await expect(page.locator('#sidebar-adjust-section #obj-bed')).toBeVisible();
    await expect(page.locator('#sidebar-adjust-section #obj-margin')).toBeVisible();
    await expect(page.locator('#logo-color-precision')).toBeVisible();
    await expect(page.locator('#color-precision')).toBeHidden();

    await setRangeValue(page.locator('#logo-color-precision'), 63);
    await expect(page.locator('#logo-color-precision-value')).toHaveText('63');

    await page.locator('.segmented-control-tab[data-tab="svg"]').click();
    await expect(page.locator('#tab-svg')).toBeVisible();
    await expect(page.locator('#svg-sidebar-controls')).toBeVisible();
    await expect(page.locator('#logo-sidebar-controls')).toBeHidden();
    await expect(page.locator('#sidebar-adjust-section #obj-scale')).toBeVisible();
    await expect(page.locator('#color-precision')).toBeVisible();

    await setRangeValue(page.locator('#color-precision'), 41);
    await expect(page.locator('#color-precision-value')).toHaveText('41');

    await page.locator('.segmented-control-tab[data-tab="logo"]').click();
    await expect(page.locator('#logo-sidebar-controls')).toBeVisible();
    await expect(page.locator('#logo-color-precision')).toHaveValue('63');
    await expect(page.locator('#sidebar-adjust-section #obj-scale')).toBeVisible();

    await page.locator('.segmented-control-tab[data-tab="svg"]').click();
    await expect(page.locator('#color-precision')).toHaveValue('41');
});

test('pill, badge, and CTA render cleanly in the logo workflow', async ({ page }) => {
    await openLogoTab(page);

    for (const preset of PRESETS) {
        await renderPreset(page, preset.name, preset.resolution);
        await expect(page.locator('#tab-logo .svg-compare-grid')).toBeVisible();
        await expect(page.locator('#tab-logo .svg-3d-grid')).toBeVisible();
        await expect(page.locator('#logo-use-base-layer')).toBeChecked();
        await expect(page.locator('#obj-structure-warning')).toBeHidden();

        await page.locator('#tab-logo .svg-compare-grid').screenshot({
            path: outputPath(`logo-${preset.name}-compare.png`)
        });
        await page.locator('#tab-logo .svg-3d-grid').screenshot({
            path: outputPath(`logo-${preset.name}-3d.png`)
        });
    }
});
