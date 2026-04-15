const BAMBU_STUDIO_PROTOCOL_URL = 'bambustudio://open';
const BAMBU_STUDIO_MAC_PROTOCOL_URL = 'bambustudioopen://open';

function getProtocolHook() {
    if (typeof window === 'undefined') return null;
    return typeof window.__GENESIS_BAMBU_PROTOCOL_HOOK__ === 'function'
        ? window.__GENESIS_BAMBU_PROTOCOL_HOOK__
        : null;
}

function getPreferredProtocolUrl() {
    if (typeof navigator === 'undefined') return BAMBU_STUDIO_PROTOCOL_URL;
    const platform = navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '';
    return /Mac/i.test(platform)
        ? BAMBU_STUDIO_MAC_PROTOCOL_URL
        : BAMBU_STUDIO_PROTOCOL_URL;
}

export function canAttemptBambuLaunch() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

    const userAgent = navigator.userAgent || '';
    return !/Android|iPhone|iPad|iPod/i.test(userAgent);
}

export async function launchBambuStudio() {
    const protocolUrl = getPreferredProtocolUrl();
    if (!canAttemptBambuLaunch()) {
        return {
            attempted: false,
            opened: false,
            protocolUrl
        };
    }

    const protocolHook = getProtocolHook();
    if (protocolHook) {
        const opened = await Promise.resolve(protocolHook(protocolUrl));
        return {
            attempted: true,
            opened: Boolean(opened),
            protocolUrl
        };
    }

    return new Promise((resolve) => {
        let settled = false;
        let iframe = null;

        const cleanup = () => {
            window.removeEventListener('blur', handleBlur, true);
            document.removeEventListener('visibilitychange', handleVisibilityChange, true);
            if (iframe?.parentNode) iframe.parentNode.removeChild(iframe);
            iframe = null;
        };

        const finish = (opened) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                attempted: true,
                opened,
                protocolUrl
            });
        };

        const handleBlur = () => finish(true);
        const handleVisibilityChange = () => {
            if (document.hidden) finish(true);
        };

        window.addEventListener('blur', handleBlur, true);
        document.addEventListener('visibilitychange', handleVisibilityChange, true);

        try {
            iframe = document.createElement('iframe');
            iframe.style.display = 'none';
            iframe.setAttribute('aria-hidden', 'true');
            document.body.appendChild(iframe);
            iframe.src = protocolUrl;
        } catch (error) {
            console.warn('Bambu Studio protocol iframe launch failed:', error);
        }

        window.setTimeout(() => {
            try {
                window.location.href = protocolUrl;
            } catch (error) {
                console.warn('Bambu Studio protocol navigation failed:', error);
            }
        }, 80);

        window.setTimeout(() => finish(false), 1800);
    });
}
