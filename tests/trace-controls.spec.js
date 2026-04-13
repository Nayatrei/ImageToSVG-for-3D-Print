const { test, expect } = require('@playwright/test');

function buildNoisyShapeSvg() {
    return `
<svg xmlns="http://www.w3.org/2000/svg" width="360" height="220" viewBox="0 0 360 220">
  <rect x="16" y="20" width="328" height="124" rx="28" fill="#111827"/>
  <path d="M36 120 Q 180 18 324 120" stroke="#60a5fa" stroke-width="20" fill="none" stroke-linecap="round"/>
  <path d="M44 182 L44 150 L120 150 L120 194 L182 194 L182 150 L258 150 L258 182" stroke="#f59e0b" stroke-width="14" fill="none" stroke-linejoin="round" stroke-linecap="round"/>
  <rect x="286" y="156" width="34" height="34" fill="#16a34a"/>
  <rect x="326" y="156" width="18" height="18" fill="#dc2626"/>
  <rect x="28" y="34" width="5" height="5" fill="#ef4444"/>
  <rect x="44" y="30" width="5" height="5" fill="#22c55e"/>
  <rect x="60" y="34" width="5" height="5" fill="#facc15"/>
  <rect x="76" y="30" width="5" height="5" fill="#38bdf8"/>
  <rect x="92" y="34" width="5" height="5" fill="#a855f7"/>
</svg>`.trim();
}

function buildHtmlDotsSnippet() {
    return `
<div style="display:flex;flex-direction:column;gap:12px;width:320px;padding:20px;background:#0f172a;border-radius:24px;">
  <div style="height:72px;border-radius:18px;background:#111827;"></div>
  <div style="display:flex;gap:8px;align-items:center;">
    <div style="width:6px;height:6px;background:#ef4444;"></div>
    <div style="width:6px;height:6px;background:#22c55e;"></div>
    <div style="width:6px;height:6px;background:#38bdf8;"></div>
    <div style="width:6px;height:6px;background:#facc15;"></div>
  </div>
  <div style="height:18px;width:180px;background:#f59e0b;"></div>
</div>`.trim();
}

async function setRangeValue(locator, value) {
    await locator.evaluate((input, nextValue) => {
        input.value = String(nextValue);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
}

async function toggleCheckbox(locator) {
    await locator.evaluate((input) => {
        input.checked = !input.checked;
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
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

async function waitForPreviewChange(locator, previousSrc) {
    await expect.poll(async () => locator.getAttribute('src'), {
        timeout: 30_000
    }).not.toBe(previousSrc);
}

async function waitForGenerateCycle(buttonLocator) {
    await expect(buttonLocator).toBeDisabled({ timeout: 10_000 });
    await expect(buttonLocator).toBeEnabled({ timeout: 30_000 });
}

async function uploadSingleSource(page, markup, filename = 'fixture.svg') {
    await page.locator('#file-input').setInputFiles({
        name: filename,
        mimeType: 'image/svg+xml',
        buffer: Buffer.from(markup)
    });
}

test('trace option builder stays monotonic and direct', async ({ page }) => {
    await page.goto('/converter.html');

    const result = await page.evaluate(async () => {
        const mod = await import('/modules/shared/trace-controls.js');

        const samples = [0, 25, 50, 75, 100];
        const pathomit = samples.map((value) => mod.buildTraceOptions({
            ...mod.createDefaultTraceControls('logo'),
            pathCleanup: value
        }).pathomit);
        const qtres = samples.map((value) => mod.buildTraceOptions({
            ...mod.createDefaultTraceControls('logo'),
            cornerSharpness: value
        }).qtres);
        const ltres = samples.map((value) => mod.buildTraceOptions({
            ...mod.createDefaultTraceControls('logo'),
            curveStraightness: value
        }).ltres);
        const numberofcolors = [2, 4, 6, 8].map((value) => mod.buildTraceOptions({
            ...mod.createDefaultTraceControls('logo'),
            outputColors: value
        }).numberofcolors);
        const rightAngles = {
            off: mod.buildTraceOptions({
                ...mod.createDefaultTraceControls('logo'),
                preserveRightAngles: false
            }),
            on: mod.buildTraceOptions({
                ...mod.createDefaultTraceControls('logo'),
                preserveRightAngles: true
            })
        };
        const htmlMode = mod.buildTraceOptions({
            ...mod.createDefaultTraceControls('detailed'),
            outputColors: 8
        }, {
            htmlDeclaredColorCount: 3
        });

        return { pathomit, qtres, ltres, numberofcolors, rightAngles, htmlMode };
    });

    expect(result.pathomit).toEqual([0, 3, 5, 8, 10]);
    expect(result.qtres).toEqual([0.8, 0.61, 0.43, 0.24, 0.05]);
    expect(result.ltres).toEqual([0.05, 0.29, 0.53, 0.76, 1]);
    expect(result.numberofcolors).toEqual([2, 4, 6, 8]);
    expect(result.rightAngles.off.qtres).toBe(result.rightAngles.on.qtres);
    expect(result.rightAngles.off.rightangleenhance).toBe(false);
    expect(result.rightAngles.on.rightangleenhance).toBe(true);
    expect(result.htmlMode.numberofcolors).toBe(3);
    expect(result.htmlMode.mincolorratio).toBe(0);
});

test('svg direct-output controls update helpers and generated result', async ({ page }) => {
    await page.goto('/converter.html');
    await uploadSingleSource(page, buildNoisyShapeSvg());

    const preview = page.locator('#svg-preview');
    await expectRenderedImage(preview);
    await expect(page.locator('#generate-preview-btn')).toBeEnabled();

    let previousSrc = await preview.getAttribute('src');

    await setRangeValue(page.locator('#color-cleanup'), 100);
    await expect(page.locator('#color-cleanup-helper')).toContainText('2.5%');
    await waitForGenerateCycle(page.locator('#generate-preview-btn'));
    previousSrc = await preview.getAttribute('src');

    await setRangeValue(page.locator('#path-cleanup'), 100);
    await expect(page.locator('#path-cleanup-helper')).toContainText('10 traced points');
    await waitForGenerateCycle(page.locator('#generate-preview-btn'));
    previousSrc = await preview.getAttribute('src');

    await setRangeValue(page.locator('#corner-sharpness'), 100);
    await expect(page.locator('#corner-sharpness-helper')).toContainText('0.05');
    await waitForGenerateCycle(page.locator('#generate-preview-btn'));
    previousSrc = await preview.getAttribute('src');

    await setRangeValue(page.locator('#curve-straightness'), 100);
    await expect(page.locator('#curve-straightness-helper')).toContainText('1');
    await waitForGenerateCycle(page.locator('#generate-preview-btn'));
    previousSrc = await preview.getAttribute('src');

    await toggleCheckbox(page.locator('#preserve-right-angles'));
    await expect(page.locator('#preserve-right-angles-helper')).toContainText('snapping is off');
    await waitForGenerateCycle(page.locator('#generate-preview-btn'));
    previousSrc = await preview.getAttribute('src');

    await setRangeValue(page.locator('#output-colors'), 2);
    await expect(page.locator('#output-colors-helper')).toContainText('2 color layers');
    await waitForPreviewChange(preview, previousSrc);

    await expect(page.locator('#output-colors')).toHaveValue('2');
    await expect(page.locator('#color-count-notice')).toContainText('set to keep 2');
});

test('logo image mode controls retrace with direct helpers', async ({ page }) => {
    await page.goto('/converter.html');
    await page.locator('.segmented-control-tab[data-tab="logo"]').click();
    await expect(page.locator('#tab-logo')).toBeVisible();

    await uploadSingleSource(page, buildNoisyShapeSvg(), 'logo-source.svg');

    await expect(page.locator('#logo-image-color-controls')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#logo-html-color-summary')).toBeHidden();

    const preview = page.locator('#logo-svg-preview');
    await expectRenderedImage(preview);
    await expect(page.locator('#logo-generate-preview-btn')).toBeEnabled();

    await setRangeValue(page.locator('#logo-path-cleanup'), 100);
    await expect(page.locator('#logo-path-cleanup-helper')).toContainText('10 traced points');
    await waitForGenerateCycle(page.locator('#logo-generate-preview-btn'));
    await expectRenderedImage(preview);

    await toggleCheckbox(page.locator('#logo-preserve-right-angles'));
    await expect(page.locator('#logo-preserve-right-angles-helper')).toContainText('snapping is off');
    await waitForGenerateCycle(page.locator('#logo-generate-preview-btn'));
    await expectRenderedImage(preview);

    await setRangeValue(page.locator('#logo-output-colors'), 2);
    await expect(page.locator('#logo-output-colors-helper')).toContainText('2 color layers');
    await waitForGenerateCycle(page.locator('#logo-generate-preview-btn'));
    await expectRenderedImage(preview);

    await expect(page.locator('#logo-output-colors')).toHaveValue('2');
    await expect(page.locator('#logo-color-count-notice')).toContainText('set to keep 2');
});

test('logo html mode shows declared-color summary and retraces path cleanup', async ({ page }) => {
    await page.goto('/converter.html');
    await page.locator('.segmented-control-tab[data-tab="logo"]').click();
    await expect(page.locator('#tab-logo')).toBeVisible();

    await page.locator('#logo-html-input').fill(buildHtmlDotsSnippet());
    await page.locator('#logo-html-render-btn').click();

    await expect(page.locator('#logo-html-status')).toHaveText('Ready', { timeout: 30_000 });
    await expect(page.locator('#logo-html-color-summary')).toContainText('declared HTML/CSS colors');
    await expect(page.locator('#logo-image-color-controls')).toBeHidden();

    const preview = page.locator('#logo-svg-preview');
    await expectRenderedImage(preview);

    await setRangeValue(page.locator('#logo-path-cleanup'), 100);
    await expect(page.locator('#logo-path-cleanup-helper')).toContainText('10 traced points');
    await waitForGenerateCycle(page.locator('#logo-generate-preview-btn'));
    await expectRenderedImage(preview);
});
