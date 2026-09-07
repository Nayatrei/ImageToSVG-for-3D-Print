(function initializeGenesisId(global) {
    'use strict';

    const SESSION_KEY = 'genesis:id:session:v1';
    const PENDING_KEY = 'genesis:id:pending:v1';
    const PENDING_TTL_MS = 10 * 60 * 1000;
    const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
    const MICROCREDITS_PER_SPARK = 1_000_000;
    const sparkNumberFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 6 });
    const slots = new Set();

    function readMeta(name, fallback = '') {
        return document.querySelector(`meta[name="${name}"]`)?.content?.trim() || fallback;
    }

    function getConfig() {
        const identityOrigin = new URL(
            readMeta('genesis-id-origin', 'https://id.genesisframeworks.com')
        ).origin;
        const appId = readMeta('genesis-id-app-id', 'genesis-editor');
        const callbackPath = readMeta('genesis-id-callback-path', '/auth/callback/');
        if (!/^[a-z0-9-]{2,40}$/.test(appId)) throw new Error('Genesis ID app configuration is invalid.');
        const callbackUrl = new URL(callbackPath, global.location.origin);
        if (callbackUrl.origin !== global.location.origin) {
            throw new Error('Genesis ID callback must stay on this application origin.');
        }
        return {
            appId,
            callbackUri: callbackUrl.toString(),
            identityOrigin
        };
    }

    function base64Url(bytes) {
        let binary = '';
        bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
        return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
    }

    function randomValue(byteLength) {
        const bytes = new Uint8Array(byteLength);
        global.crypto.getRandomValues(bytes);
        return base64Url(bytes);
    }

    async function pkceChallenge(verifier) {
        const digest = await global.crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(verifier)
        );
        return base64Url(new Uint8Array(digest));
    }

    function safeReturnTo(candidate) {
        try {
            const target = new URL(candidate || '/', global.location.origin);
            if (target.origin !== global.location.origin || target.pathname.startsWith('/auth/callback')) return '/';
            return `${target.pathname}${target.search}${target.hash}`;
        } catch {
            return '/';
        }
    }

    function readJsonStorage(key) {
        try {
            const value = global.sessionStorage.getItem(key);
            return value ? JSON.parse(value) : null;
        } catch {
            return null;
        }
    }

    function writeJsonStorage(key, value) {
        global.sessionStorage.setItem(key, JSON.stringify(value));
    }

    function clearSession() {
        try {
            global.sessionStorage.removeItem(SESSION_KEY);
        } catch {
            // The converter remains available when browser storage is blocked.
        }
    }

    async function readResponseJson(response, fallbackMessage) {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(fallbackMessage);
        return body;
    }

    async function fetchPublicConfig() {
        const { identityOrigin } = getConfig();
        const response = await fetch(`${identityOrigin}/api/v1/account/config`, {
            cache: 'no-store',
            credentials: 'omit',
            headers: { Accept: 'application/json' }
        });
        const config = await readResponseJson(response, 'Genesis ID configuration is unavailable.');
        if (!config?.firebase?.apiKey) throw new Error('Genesis ID Firebase configuration is incomplete.');
        return config;
    }

    function tokenClaims(idToken) {
        try {
            const payload = idToken.split('.')[1];
            const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
            const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
            return JSON.parse(atob(padded));
        } catch {
            return null;
        }
    }

    function tokenExpiry(idToken, fallbackSeconds = 3600) {
        const expiresAt = Number(tokenClaims(idToken)?.exp) * 1000;
        if (Number.isFinite(expiresAt)) return expiresAt;
        return Date.now() + fallbackSeconds * 1000;
    }

    async function exchangeFirebaseCustomToken(firebaseCustomToken) {
        const publicConfig = await fetchPublicConfig();
        const response = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${encodeURIComponent(publicConfig.firebase.apiKey)}`,
            {
                method: 'POST',
                cache: 'no-store',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: firebaseCustomToken, returnSecureToken: true })
            }
        );
        const token = await readResponseJson(response, 'Genesis ID token exchange failed.');
        if (!token?.idToken) throw new Error('Genesis ID returned an incomplete token.');
        const claims = tokenClaims(token.idToken);
        const uid = claims?.sub;
        if (
            typeof uid !== 'string'
            || uid.length < 1
            || uid.length > 128
            || /[\u0000-\u001F\u007F]/u.test(uid)
            || (claims.user_id !== undefined && claims.user_id !== uid)
        ) {
            throw new Error('Genesis ID returned an incomplete token.');
        }
        return {
            schemaVersion: 1,
            uid,
            idToken: token.idToken,
            refreshToken: token.refreshToken || '',
            expiresAt: Date.now() + Math.max(60, Number(token.expiresIn) || 3600) * 1000
        };
    }

    async function refreshSession(session) {
        if (!session?.refreshToken) throw new Error('Genesis ID session expired.');
        const publicConfig = await fetchPublicConfig();
        const response = await fetch(
            `https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(publicConfig.firebase.apiKey)}`,
            {
                method: 'POST',
                cache: 'no-store',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    grant_type: 'refresh_token',
                    refresh_token: session.refreshToken
                })
            }
        );
        const token = await readResponseJson(response, 'Genesis ID session refresh failed.');
        if (!token?.id_token || !token?.user_id) throw new Error('Genesis ID returned an incomplete session.');
        const nextSession = {
            schemaVersion: 1,
            uid: token.user_id,
            idToken: token.id_token,
            refreshToken: token.refresh_token || session.refreshToken,
            expiresAt: Date.now() + Math.max(60, Number(token.expires_in) || 3600) * 1000
        };
        writeJsonStorage(SESSION_KEY, nextSession);
        return nextSession;
    }

    async function currentSession() {
        const session = readJsonStorage(SESSION_KEY);
        if (
            !session
            || session.schemaVersion !== 1
            || typeof session.idToken !== 'string'
            || typeof session.expiresAt !== 'number'
        ) return null;
        if (session.expiresAt > Date.now() + TOKEN_REFRESH_SKEW_MS) return session;
        try {
            return await refreshSession(session);
        } catch {
            clearSession();
            return null;
        }
    }

    async function accountRequest(path, idToken) {
        const { identityOrigin } = getConfig();
        const response = await fetch(`${identityOrigin}${path}`, {
            cache: 'no-store',
            credentials: 'omit',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${idToken}`
            }
        });
        return readResponseJson(response, 'Genesis ID account could not be loaded.');
    }

    async function loadAccount(idToken) {
        const account = await accountRequest('/api/v1/account/me', idToken);
        let credits = account?.credits;
        if (credits === undefined) {
            const creditResponse = await accountRequest('/api/v1/account/credits', idToken);
            credits = creditResponse?.credits;
        }
        return { ...account, credits: normalizeCredits(credits) };
    }

    function normalizeCredits(credits) {
        if (!credits || typeof credits !== 'object' || Array.isArray(credits)) {
            throw new Error('Genesis ID returned an invalid Spark balance.');
        }
        const divisor = credits.microcreditsPerSpark;
        const available = credits.available;
        if (
            credits.unit !== 'microcredit'
            || divisor !== MICROCREDITS_PER_SPARK
            || typeof available !== 'number'
            || !Number.isFinite(available)
            || available < 0
        ) throw new Error('Genesis ID returned an unsupported Spark balance.');
        return {
            amount: available / divisor,
            unlimited: credits.unlimited === true
        };
    }

    function creditLabel(balance) {
        if (balance.unlimited) return 'Unlimited Sparks';
        return `${sparkNumberFormat.format(balance.amount)} Sparks`;
    }

    function tierLabel(account) {
        const tier = String(account?.access?.tier || 'free');
        return tier.charAt(0).toUpperCase() + tier.slice(1);
    }

    function closeMenus(except) {
        slots.forEach((slot) => {
            if (slot === except) return;
            const menu = slot.querySelector('[data-genesis-id-menu]');
            const trigger = slot.querySelector('[data-genesis-id-trigger]');
            if (menu) menu.hidden = true;
            if (trigger) trigger.setAttribute('aria-expanded', 'false');
        });
    }

    function renderDisconnected(slot, message = '') {
        slot.replaceChildren();
        const shell = document.createElement('div');
        shell.className = 'genesis-id-widget is-disconnected';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'genesis-id-connect';
        button.textContent = 'Genesis ID 연결';
        button.addEventListener('click', () => {
            button.disabled = true;
            void beginConnection().catch((error) => {
                button.disabled = false;
                renderDisconnected(slot, error instanceof Error ? error.message : 'Genesis ID 연결을 시작할 수 없습니다.');
            });
        });
        shell.append(button);
        if (message) {
            const status = document.createElement('small');
            status.className = 'genesis-id-message';
            status.textContent = message;
            shell.append(status);
        }
        slot.append(shell);
    }

    function renderConnected(slot, account) {
        slot.replaceChildren();
        const shell = document.createElement('div');
        shell.className = 'genesis-id-widget is-connected';
        const trigger = document.createElement('button');
        trigger.type = 'button';
        trigger.className = 'genesis-id-account';
        trigger.dataset.genesisIdTrigger = '';
        trigger.setAttribute('aria-expanded', 'false');
        trigger.innerHTML = '<span class="genesis-id-dot" aria-hidden="true"></span><span>Genesis ID</span>';
        const summary = document.createElement('small');
        summary.textContent = `${tierLabel(account)} · ${creditLabel(account.credits)}`;
        trigger.append(summary);

        const menu = document.createElement('div');
        menu.className = 'genesis-id-menu';
        menu.dataset.genesisIdMenu = '';
        menu.hidden = true;
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', 'Genesis ID account');
        const heading = document.createElement('strong');
        heading.textContent = account?.profile?.displayName || 'Genesis ID connected';
        const detail = document.createElement('span');
        detail.textContent = `${tierLabel(account)} · ${creditLabel(account.credits)}`;
        const note = document.createElement('small');
        const editorIncluded = account?.access?.status === 'active'
            && ['plus', 'pro'].includes(account?.access?.tier);
        note.textContent = editorIncluded
            ? 'Plus / Pro 혜택 · Editor 포함. 추가 이용료나 Sparks 차감 없이 사용할 수 있습니다.'
            : '기존 무료 변환 도구는 로그인 없이도 계속 사용할 수 있습니다. Plus / Pro에도 Editor가 추가 비용 없이 포함됩니다.';
        const actions = document.createElement('div');
        actions.className = 'genesis-id-actions';
        const portal = document.createElement('a');
        portal.href = getConfig().identityOrigin;
        portal.target = '_blank';
        portal.rel = 'noopener noreferrer';
        portal.textContent = '계정 보기';
        const disconnect = document.createElement('button');
        disconnect.type = 'button';
        disconnect.textContent = '이 기기 연결 해제';
        disconnect.addEventListener('click', () => {
            clearSession();
            renderDisconnected(slot);
        });
        actions.append(portal, disconnect);
        menu.append(heading, detail, note, actions);
        trigger.addEventListener('click', () => {
            const opening = menu.hidden;
            closeMenus(opening ? slot : null);
            menu.hidden = !opening;
            trigger.setAttribute('aria-expanded', String(opening));
        });
        shell.append(trigger, menu);
        slot.append(shell);
    }

    async function updateSlot(slot) {
        slots.add(slot);
        const session = await currentSession();
        if (!session) {
            renderDisconnected(slot);
            return;
        }
        try {
            renderConnected(slot, await loadAccount(session.idToken));
        } catch {
            clearSession();
            renderDisconnected(slot, '계정 연결이 만료되었습니다. 다시 연결해 주세요.');
        }
    }

    async function mountAll() {
        const found = [...document.querySelectorAll('[data-genesis-id-slot]')];
        await Promise.all(found.map(updateSlot));
    }

    async function beginConnection(returnTo = `${global.location.pathname}${global.location.search}${global.location.hash}`) {
        const config = getConfig();
        const state = randomValue(32);
        const verifier = randomValue(32);
        const challenge = await pkceChallenge(verifier);
        writeJsonStorage(PENDING_KEY, {
            schemaVersion: 1,
            appId: config.appId,
            callbackUri: config.callbackUri,
            state,
            verifier,
            returnTo: safeReturnTo(returnTo),
            createdAt: Date.now()
        });
        const authorize = new URL('/', config.identityOrigin);
        authorize.searchParams.set('app_id', config.appId);
        authorize.searchParams.set('redirect_uri', config.callbackUri);
        authorize.searchParams.set('state', state);
        authorize.searchParams.set('code_challenge', challenge);
        authorize.searchParams.set('code_challenge_method', 'S256');
        global.location.assign(authorize.toString());
    }

    async function completeCallback() {
        const config = getConfig();
        const query = new URLSearchParams(global.location.search);
        const code = query.get('code') || '';
        const state = query.get('state') || '';
        const pending = readJsonStorage(PENDING_KEY);
        try {
            global.sessionStorage.removeItem(PENDING_KEY);
        } catch {
            // Validation below will fail safely if storage is unavailable.
        }
        if (
            !pending
            || pending.schemaVersion !== 1
            || pending.appId !== config.appId
            || pending.callbackUri !== config.callbackUri
            || pending.state !== state
            || typeof pending.verifier !== 'string'
            || pending.verifier.length < 43
            || !Number.isFinite(pending.createdAt)
            || pending.createdAt > Date.now() + 5000
            || Date.now() - pending.createdAt > PENDING_TTL_MS
            || !/^[A-Za-z0-9_-]{40,100}$/.test(code)
        ) throw new Error('Genesis ID callback is invalid or expired. Please start again.');

        const response = await fetch(`${config.identityOrigin}/api/v1/auth/sso/exchange`, {
            method: 'POST',
            cache: 'no-store',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appId: config.appId,
                redirectUri: config.callbackUri,
                code,
                codeVerifier: pending.verifier,
                state
            })
        });
        const grant = await readResponseJson(response, 'Genesis ID sign-in code is invalid or expired.');
        if (grant?.appId !== config.appId || !grant?.firebaseCustomToken) {
            throw new Error('Genesis ID returned an invalid application token.');
        }
        const session = await exchangeFirebaseCustomToken(grant.firebaseCustomToken);
        writeJsonStorage(SESSION_KEY, session);
        return safeReturnTo(pending.returnTo);
    }

    async function useManagedIdToken(idToken) {
        if (typeof idToken !== 'string' || idToken.length < 80 || idToken.split('.').length !== 3) {
            throw new Error('Managed Genesis ID token is invalid.');
        }
        const claims = tokenClaims(idToken);
        if (claims?.genesisApp !== getConfig().appId || claims?.genesisAgent !== true) {
            throw new Error('Managed Genesis ID token is not bound to this Agent application.');
        }
        const expiresAt = tokenExpiry(idToken, 0);
        if (expiresAt <= Date.now() + TOKEN_REFRESH_SKEW_MS) throw new Error('Managed Genesis ID token is expired.');
        const account = await loadAccount(idToken);
        writeJsonStorage(SESSION_KEY, {
            schemaVersion: 1,
            uid: account?.profile?.uid || '',
            idToken,
            refreshToken: '',
            expiresAt
        });
        await mountAll();
        return account;
    }

    document.addEventListener('click', (event) => {
        if (![...slots].some((slot) => slot.contains(event.target))) closeMenus();
    });
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') closeMenus();
    });

    global.GenesisId = Object.freeze({
        appId: 'genesis-editor',
        beginConnection,
        completeCallback,
        disconnect() {
            clearSession();
            return mountAll();
        },
        mountAll,
        useManagedIdToken
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { void mountAll(); }, { once: true });
    } else {
        void mountAll();
    }
})(window);
