const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const QA_DIR = path.join(process.cwd(), 'test-results', 'manual-logo');
const PRESETS = [
    { name: 'pill', resolution: '936×304 px' },
    { name: 'badge', resolution: '896×896 px' },
    { name: 'cta', resolution: '1032×312 px' }
];

function buildStripedSvg() {
    const colors = ['#111827', '#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#7c3aed'];
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120" viewBox="0 0 360 120">
  ${colors.map((color, index) => `<rect x="${index * 60}" y="0" width="60" height="120" fill="${color}"/>`).join('\n  ')}
</svg>`.trim();
}

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
    await expect(page.locator('#logo-bambu-open-btn')).toBeEnabled();
    await expect(page.locator('#logo-export-stl-btn')).toBeEnabled();
    await expect(page.locator('#logo-obj-preview-placeholder')).toBeHidden({ timeout: 30_000 });
    await expect(page.locator('#tab-logo #logo-obj-scale')).toHaveCount(0);
    await expect(page.locator('#tab-logo #logo-obj-thickness')).toHaveCount(0);
    await expect(page.locator('#tab-logo #logo-obj-margin')).toHaveCount(0);
    await expect(page.locator('#tab-logo #logo-obj-bed')).toHaveCount(0);
}

test('logo sidebar controls stay isolated from SVG controls', async ({ page }) => {
    await openLogoTab(page);

    await expect(page.locator('#logo-bambu-open-btn')).toBeDisabled();
    await expect(page.locator('#logo-export-footer')).toContainText('Downloads the .3mf and attempts to launch Bambu Studio');

    await expect(page.locator('#sidebar-adjust-section #obj-scale')).toBeVisible();
    await expect(page.locator('#sidebar-adjust-section #obj-thickness')).toBeVisible();
    await expect(page.locator('#sidebar-adjust-section #obj-bed')).toBeVisible();
    await expect(page.locator('#sidebar-adjust-section #obj-margin')).toBeVisible();
    await expect(page.locator('#sidebar-adjust-section #obj-bezel')).toBeVisible();
    await expect(page.locator('#logo-html-color-summary')).toBeVisible();
    await expect(page.locator('#logo-image-color-controls')).toBeHidden();

    await page.locator('#file-input').setInputFiles({
        name: 'stripes.svg',
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(buildStripedSvg())
    });

    await expect(page.locator('#logo-image-color-controls')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#logo-output-colors')).toBeVisible();
    await expectRenderedImage(page.locator('#logo-svg-preview'));

    await setRangeValue(page.locator('#logo-output-colors'), 6);
    await expect(page.locator('#logo-output-colors-value')).toHaveText('6');

    await page.locator('.segmented-control-tab[data-tab="svg"]').click();
    await expect(page.locator('#tab-svg')).toBeVisible();
    await expect(page.locator('#svg-sidebar-controls')).toBeVisible();
    await expect(page.locator('#logo-sidebar-controls')).toBeHidden();
    await expect(page.locator('#sidebar-adjust-section #obj-scale')).toBeVisible();
    await expect(page.locator('#output-colors')).toBeVisible();

    await setRangeValue(page.locator('#output-colors'), 3);
    await expect(page.locator('#output-colors-value')).toHaveText('3');

    await page.locator('.segmented-control-tab[data-tab="logo"]').click();
    await expect(page.locator('#logo-sidebar-controls')).toBeVisible();
    await expect(page.locator('#logo-output-colors')).toHaveValue('6');
    await expect(page.locator('#sidebar-adjust-section #obj-scale')).toBeVisible();

    await page.locator('.segmented-control-tab[data-tab="svg"]').click();
    await expect(page.locator('#output-colors')).toHaveValue('3');
});

test('pill, badge, and CTA render cleanly in the logo workflow', async ({ page }) => {
    await openLogoTab(page);

    for (const preset of PRESETS) {
        await renderPreset(page, preset.name, preset.resolution);
        await expect(page.locator('#tab-logo .svg-compare-grid')).toBeVisible();
        await expect(page.locator('#tab-logo .svg-3d-grid')).toBeVisible();
        await expect(page.locator('#logo-use-base-layer')).toBeChecked();
        await expect(page.locator('#obj-structure-warning')).toBeHidden();
        await expect(page.locator('#logo-html-color-summary')).toBeVisible();
        await expect(page.locator('#logo-image-color-controls')).toBeHidden();

        await page.locator('#tab-logo .svg-compare-grid').screenshot({
            path: outputPath(`logo-${preset.name}-compare.png`)
        });
        await page.locator('#tab-logo .svg-3d-grid').screenshot({
            path: outputPath(`logo-${preset.name}-3d.png`)
        });
    }
});
