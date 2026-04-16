function getProtocolHook() {
    if (typeof window === 'undefined') return null;
    return typeof window.__GENESIS_BAMBU_PROTOCOL_HOOK__ === 'function'
        ? window.__GENESIS_BAMBU_PROTOCOL_HOOK__
        : null;
}

function getPlatformKey() {
    if (typeof navigator === 'undefined') return 'windows';
    const platform = navigator.userAgentData?.platform || navigator.platform || '';
    if (/Mac/i.test(platform)) return 'mac';
    if (/Linux/i.test(platform)) return 'linux';
    return 'windows';
}

export function buildProtocolUrl(filePath) {
    const platform = getPlatformKey();
    if (platform === 'mac' || platform === 'linux') {
        return `bambustudioopen://${filePath}`;
    }
    return `bambustudio://open?file=${encodeURIComponent(filePath)}`;
}

export function canAttemptBambuLaunch() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

    const userAgent = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return false;
    if (getPlatformKey() === 'linux') return false;

    return true;
}

/**
 * Triggers the Bambu Studio protocol handler to launch the app.
 * Uses blur/visibility heuristic to detect whether it opened.
 */
export async function launchBambuStudio() {
    if (!canAttemptBambuLaunch()) {
        return { attempted: false, opened: false };
    }

    const platform = getPlatformKey();
    const protocolUrl = platform === 'mac'
        ? 'bambustudioopen://'
        : 'bambustudio://open';

    const protocolHook = getProtocolHook();
    if (protocolHook) {
        const opened = await Promise.resolve(protocolHook(protocolUrl));
        return { attempted: true, opened: Boolean(opened), protocolUrl };
    }

    return new Promise((resolve) => {
        let settled = false;

        const cleanup = () => {
            window.removeEventListener('blur', handleBlur, true);
            document.removeEventListener('visibilitychange', handleVisibilityChange, true);
        };

        const finish = (opened) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ attempted: true, opened, protocolUrl });
        };

        const handleBlur = () => finish(true);
        const handleVisibilityChange = () => {
            if (document.hidden) finish(true);
        };

        window.addEventListener('blur', handleBlur, true);
        document.addEventListener('visibilitychange', handleVisibilityChange, true);

        // Anchor-click to trigger protocol handler
        const anchor = document.createElement('a');
        anchor.href = protocolUrl;
        anchor.style.display = 'none';
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);

        window.setTimeout(() => finish(false), 1800);
    });
}
