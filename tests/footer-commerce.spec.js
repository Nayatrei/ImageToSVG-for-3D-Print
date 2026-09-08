const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');

const root = path.resolve(__dirname, '..');
const footer = fs.readFileSync(path.join(root, 'modules/partials/footer-brand.html'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const accountUrl = 'https://id.genesisframeworks.com/account';

test('shared footer keeps account management central and has no donation or checkout action', () => {
    expect(footer).not.toMatch(/buymeacoffee\.com|Buy Me a Coffee|Support (?:the|this) [Pp]roject|donat(?:e|ion)|checkout|<form\b|<script\b|\bonclick\s*=/i);
    expect(footer.match(/https:\/\/id\.genesisframeworks\.com\/account/g)).toHaveLength(2);
});

for (const width of [320, 390, 1440]) {
    test(`central account footer stays accessible within a ${width}px viewport`, async ({ page }) => {
        // Local markup and existing styles only: no account, provider, or link navigation.
        await page.route('**/*', (route) => route.abort());
        await page.setViewportSize({ width, height: 1280 });
        await page.setContent(`<style>${styles}</style>${footer}`);

        const account = page.getByRole('link', { name: 'Genesis ID account', exact: true });
        const manage = page.getByRole('link', { name: 'Manage Genesis ID', exact: true });
        for (const link of [account, manage]) {
            await expect(link).toBeVisible();
            await expect(link).toHaveAttribute('href', accountUrl);
            await expect(link).toHaveAttribute('target', '_blank');
            await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
            const box = await link.boundingBox();
            expect(box.x).toBeGreaterThanOrEqual(0);
            expect(box.x + box.width).toBeLessThanOrEqual(width);
        }
        await account.focus();
        await expect(account).toBeFocused();
        await page.keyboard.press('Tab');
        await expect(page.getByRole('link', { name: 'jong@genesisframeworks.com', exact: true })).toBeFocused();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Tab');
        await expect(manage).toBeFocused();
        await expect(manage.locator('svg')).toHaveAttribute('aria-hidden', 'true');
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    });
}
