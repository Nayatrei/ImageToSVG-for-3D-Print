const { test, expect } = require('@playwright/test');

const identityOrigin = 'https://id.genesisframeworks.com';
const sessionKey = 'genesis:id:session:v1';
const included = 'Plus / Pro 혜택 · Editor 포함. 추가 이용료나 Sparks 차감 없이 사용할 수 있습니다.';

function syntheticToken(uid) {
    const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${encode({ alg: 'RS256' })}.${encode({ sub: uid, user_id: uid, exp: 4_000_000_000 })}.synthetic-local-fixture`;
}

function account(uid = 'local-editor-a', tier = 'plus', available = 0) {
    return {
        profile: { uid, displayName: uid },
        access: { uid, status: 'active', tier, recomputeAt: '2026-09-01T00:00:00.000Z' },
        credits: { unit: 'microcredit', microcreditsPerSpark: 1_000_000, available, unlimited: false }
    };
}

async function pauseClock(page) {
    // install() alone still advances with wall time between browser commands.
    // Freeze before creating any account timers so loaded CI cannot cross a deadline early.
    await page.clock.install({ time: new Date('2030-01-01T00:00:00.000Z') });
    await page.clock.pauseAt(new Date('2030-01-01T01:00:00.000Z'));
}

async function installSession(page, uid = 'local-editor-a', options = {}) {
    await page.evaluate(({ key, uid, token, options }) => {
        sessionStorage.setItem(key, JSON.stringify({
            schemaVersion: 1, uid, idToken: token, refreshToken: '',
            expiresAt: Date.now() + 3_600_000, ...options
        }));
        return window.GenesisId.mountAll();
    }, { key: sessionKey, uid, token: syntheticToken(uid), options });
}

async function stubAccount(page) {
    const state = { response: account(), requests: 0, status: 200, pending: null };
    // Every non-local request is intercepted. These tests never authenticate or contact a provider.
    await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await page.route(`${identityOrigin}/api/v1/account/me`, async (route) => {
        state.requests += 1;
        const response = state.response;
        const status = state.status;
        if (state.pending) await state.pending;
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(response) });
    });
    await page.goto('/3d-obj');
    return state;
}

test('card open refreshes Plus to Free and keeps zero-Spark local tools usable', async ({ page }) => {
    const state = await stubAccount(page);
    await installSession(page);
    await expect(page.getByRole('button', { name: /Genesis ID.*Plus.*0 Sparks/ })).toBeVisible();
    state.response = account('local-editor-a', 'free', 0);
    await page.getByRole('button', { name: /Genesis ID.*Plus/ }).click();
    await expect(page.getByRole('dialog')).toContainText('Free · 0 Sparks');
    await expect(page.getByText(included)).toHaveCount(0);
    await expect(page.locator('#import-btn')).toBeEnabled();
    expect(state.requests).toBe(2);
});

test('callback-only document does not start a competing widget account refresh', async ({ page }) => {
    const state = await stubAccount(page);
    await installSession(page);
    await page.goto('/auth/callback/');
    await expect(page.getByRole('heading', { name: 'Genesis ID를 연결하지 못했습니다' })).toBeVisible();
    await page.evaluate(async () => {
        await window.GenesisId.mountAll();
        window.dispatchEvent(new Event('focus'));
    });
    expect(state.requests).toBe(1);
    expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).uid, sessionKey)).toBe('local-editor-a');
});

test('focus and visibility resume coalesce into one request and update the balance', async ({ page }) => {
    const state = await stubAccount(page);
    await installSession(page);
    state.response = account('local-editor-a', 'pro', 42_000_000);
    await page.evaluate(() => {
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('focus'));
    });
    await expect(page.getByRole('button', { name: /Genesis ID.*Pro.*42 Sparks/ })).toBeVisible();
    expect(state.requests).toBe(2);
});

test('bounded visible polling updates an expired tier without treating past recomputeAt as a deadline', async ({ page }) => {
    const state = await stubAccount(page);
    await pauseClock(page);
    await installSession(page);
    state.response = account('local-editor-a', 'free');
    await page.clock.runFor(59_000);
    expect(state.requests).toBe(1);
    await page.clock.runFor(1_000);
    await expect(page.getByRole('button', { name: /Genesis ID.*Free.*0 Sparks/ })).toBeVisible();
    expect(state.requests).toBe(2);
});

for (const failure of ['suspended', 'forbidden', 'server-error', 'wrong-uid']) {
    test(`${failure} removes stale paid copy but preserves anonymous tools`, async ({ page }) => {
        const state = await stubAccount(page);
        await installSession(page);
        if (failure === 'suspended') state.response.access.status = 'suspended';
        if (failure === 'forbidden') state.status = 403;
        if (failure === 'server-error') state.status = 500;
        if (failure === 'wrong-uid') state.response = account('another-user');
        await page.getByRole('button', { name: /Genesis ID.*Plus/ }).click();
        await expect(page.getByRole('button', { name: 'Genesis ID 연결' })).toBeVisible();
        await expect(page.getByText(included)).toHaveCount(0);
        expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();
        await expect(page.locator('#import-btn')).toBeEnabled();
    });
}

test('single flight across card, focus and multiple slots cannot resurrect local signout', async ({ page }) => {
    const state = await stubAccount(page);
    await installSession(page);
    let release;
    state.pending = new Promise((resolve) => { release = resolve; });
    await page.getByRole('button', { name: /Genesis ID.*Plus/ }).click();
    await expect.poll(() => state.requests).toBe(2);
    await page.evaluate(() => {
        const extra = document.createElement('div');
        extra.dataset.genesisIdSlot = '';
        document.body.append(extra);
        window.refreshTestCompletion = window.GenesisId.mountAll();
        window.dispatchEvent(new Event('focus'));
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.getByRole('button', { name: '이 기기 연결 해제' }).click();
    release();
    await page.evaluate(() => window.refreshTestCompletion);
    await expect(page.getByRole('button', { name: 'Genesis ID 연결' })).toHaveCount(2);
    await expect(page.getByText(included)).toHaveCount(0);
    expect(state.requests).toBe(2);
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();
});

for (const lateStatus of [200, 403]) {
    test(`late ${lateStatus} account response cannot overwrite or clear a different UID session`, async ({ page }) => {
        const state = await stubAccount(page);
        await installSession(page);
        let release;
        state.status = lateStatus;
        state.pending = new Promise((resolve) => { release = resolve; });
        await page.getByRole('button', { name: /Genesis ID.*Plus/ }).click();
        await expect.poll(() => state.requests).toBe(2);
        await page.evaluate(() => { window.refreshTestCompletion = window.GenesisId.mountAll(); });
        state.pending = null;
        state.status = 200;
        state.response = account('local-editor-b', 'free', 7_000_000);
        await installSession(page, 'local-editor-b');
        release();
        await page.evaluate(() => window.refreshTestCompletion);
        await expect(page.getByRole('button', { name: /Genesis ID.*Free.*7 Sparks/ })).toBeVisible();
        await expect(page.getByRole('dialog')).toContainText('local-editor-b');
        expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).uid, sessionKey)).toBe('local-editor-b');
        await expect(page.getByText(included)).toHaveCount(0);
    });
}

test('official token refresh remains single flight and cannot persist after signout', async ({ page }) => {
    const state = await stubAccount(page);
    await installSession(page);
    let release;
    let refreshRequests = 0;
    const pending = new Promise((resolve) => { release = resolve; });
    await page.route(`${identityOrigin}/api/v1/account/config`, (route) => route.fulfill({
        contentType: 'application/json', body: JSON.stringify({ firebase: { apiKey: 'public-local-fixture' } })
    }));
    await page.route('https://securetoken.googleapis.com/**', async (route) => {
        refreshRequests += 1;
        await pending;
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify({
            id_token: syntheticToken('local-editor-a'), user_id: 'local-editor-a',
            refresh_token: 'synthetic-local-refresh', expires_in: '3600'
        }) });
    });
    await page.evaluate((key) => {
        const session = JSON.parse(sessionStorage.getItem(key));
        session.expiresAt = Date.now() + 30_000;
        session.refreshToken = 'synthetic-local-refresh';
        sessionStorage.setItem(key, JSON.stringify(session));
    }, sessionKey);
    await page.getByRole('button', { name: /Genesis ID.*Plus/ }).click();
    await expect.poll(() => refreshRequests).toBe(1);
    await page.evaluate(() => { window.refreshTestCompletion = window.GenesisId.mountAll(); });
    await page.getByRole('button', { name: '이 기기 연결 해제' }).click();
    release();
    await page.evaluate(() => window.refreshTestCompletion);
    await expect(page.getByRole('button', { name: 'Genesis ID 연결' })).toBeVisible();
    expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();
    expect(refreshRequests).toBe(1);
    expect(state.requests).toBe(1);
});

test('hidden tabs defer polling I/O until visibility resume', async ({ page }) => {
    const state = await stubAccount(page);
    await pauseClock(page);
    await installSession(page);
    await page.evaluate(() => Object.defineProperty(document, 'hidden', { configurable: true, value: true }));
    state.response = account('local-editor-a', 'free');
    await page.clock.runFor(180_000);
    expect(state.requests).toBe(1);
    await expect(page.getByText(included)).toHaveCount(0);
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(100);
    await expect(page.getByRole('button', { name: /Genesis ID.*Free.*0 Sparks/ })).toBeVisible();
    expect(state.requests).toBe(2);
});

test('hiding during the resume debounce cancels or refuses the delayed refresh', async ({ page }) => {
    const state = await stubAccount(page);
    await pauseClock(page);
    await installSession(page);
    for (const emitVisibility of [true, false]) {
        await page.evaluate(() => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: false });
            window.dispatchEvent(new Event('focus'));
        });
        await page.clock.runFor(50);
        await page.evaluate((emitVisibility) => {
            Object.defineProperty(document, 'hidden', { configurable: true, value: true });
            if (emitVisibility) document.dispatchEvent(new Event('visibilitychange'));
        }, emitVisibility);
        await page.clock.runFor(150);
        expect(state.requests).toBe(1);
    }
    state.response = account('local-editor-a', 'free');
    await page.evaluate(() => {
        Object.defineProperty(document, 'hidden', { configurable: true, value: false });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.clock.runFor(100);
    await expect(page.getByRole('button', { name: /Genesis ID.*Free/ })).toBeVisible();
    expect(state.requests).toBe(2);
});

test('fresh DOM preserves keyboard focus on trigger, portal and disconnect during refresh', async ({ page }) => {
    const state = await stubAccount(page);
    await pauseClock(page);
    await installSession(page);
    const trigger = page.locator('[data-genesis-id-trigger]');
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => state.requests).toBe(2);
    await expect(page.getByText(included)).toBeVisible();
    await expect(trigger).toBeFocused();
    for (const selector of ['[data-genesis-id-portal]', '[data-genesis-id-disconnect]']) {
        await page.locator(selector).focus();
        const count = state.requests;
        await page.clock.runFor(60_000);
        await expect.poll(() => state.requests).toBe(count + 1);
        await expect(page.getByText(included)).toBeVisible();
        await expect(page.locator(selector)).toBeFocused();
    }
});

test('late refresh does not steal focus back from a converter control', async ({ page }) => {
    const state = await stubAccount(page);
    await installSession(page);
    let release;
    state.pending = new Promise((resolve) => { release = resolve; });
    await page.locator('[data-genesis-id-trigger]').click();
    await expect.poll(() => state.requests).toBe(2);
    await page.evaluate(() => { window.refreshTestCompletion = window.GenesisId.mountAll(); });
    await page.locator('#import-btn').focus();
    release();
    await page.evaluate(() => window.refreshTestCompletion);
    await expect(page.locator('#import-btn')).toBeFocused();
});

for (const uid of ['local-editor-a', 'unexpected-user']) {
    test(`official token refresh verifies the same UID: ${uid}`, async ({ page }) => {
        const state = await stubAccount(page);
        await installSession(page);
        let refreshRequests = 0;
        await page.route(`${identityOrigin}/api/v1/account/config`, (route) => route.fulfill({
            contentType: 'application/json', body: JSON.stringify({ firebase: { apiKey: 'public-local-fixture' } })
        }));
        await page.route('https://securetoken.googleapis.com/**', (route) => {
            refreshRequests += 1;
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({
                id_token: syntheticToken(uid), user_id: uid,
                refresh_token: 'synthetic-local-refresh-rotated', expires_in: '3600'
            }) });
        });
        await page.evaluate((key) => {
            const session = JSON.parse(sessionStorage.getItem(key));
            session.expiresAt = Date.now() + 30_000;
            session.refreshToken = 'synthetic-local-refresh';
            sessionStorage.setItem(key, JSON.stringify(session));
        }, sessionKey);
        await page.locator('[data-genesis-id-trigger]').click();
        if (uid === 'local-editor-a') {
            await expect(page.getByText(included)).toBeVisible();
            expect(await page.evaluate((key) => JSON.parse(sessionStorage.getItem(key)).refreshToken, sessionKey)).toBe('synthetic-local-refresh-rotated');
            expect(state.requests).toBe(2);
        } else {
            await expect(page.getByRole('button', { name: 'Genesis ID 연결' })).toBeVisible();
            expect(await page.evaluate((key) => sessionStorage.getItem(key), sessionKey)).toBeNull();
            expect(state.requests).toBe(1);
        }
        expect(refreshRequests).toBe(1);
    });
}
