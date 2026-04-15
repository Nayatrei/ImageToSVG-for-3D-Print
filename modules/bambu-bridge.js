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

function hasChromeDownloadsApi() {
    return typeof chrome !== 'undefined' && !!chrome.downloads?.download;
}

export function canAttemptBambuLaunch() {
    if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;

    const userAgent = navigator.userAgent || '';
    return !/Android|iPhone|iPad|iPod/i.test(userAgent);
}

/**
 * Downloads the blob via Chrome downloads API, resolves the saved file path,
 * then opens it directly in Bambu Studio using the protocol handler with
 * the file= parameter (same mechanism MakerWorld uses).
 */
export async function downloadAndOpenInBambu(blob, filename) {
    if (!hasChromeDownloadsApi()) {
        return { opened: false, downloaded: false };
    }

    const url = URL.createObjectURL(blob);
    try {
        return await new Promise((resolve) => {
            chrome.downloads.download({ url, filename, saveAs: false }, (downloadId) => {
                if (chrome.runtime.lastError || !downloadId) {
                    resolve({ opened: false, downloaded: false });
                    return;
                }

                function onChanged(delta) {
                    if (delta.id !== downloadId) return;
                    if (delta.state?.current === 'complete') {
                        chrome.downloads.onChanged.removeListener(onChanged);

                        // Get the full file path and pass it to Bambu Studio's protocol handler
                        chrome.downloads.search({ id: downloadId }, (results) => {
                            const filePath = results?.[0]?.filename;
                            if (filePath) {
                                const protocolBase = getPreferredProtocolUrl();
                                const protocolUrl = `${protocolBase}?file=${encodeURIComponent(filePath)}`;
                                try { window.location.href = protocolUrl; } catch (_) { /* best-effort */ }
                                resolve({ opened: true, downloaded: true });
                            } else {
                                resolve({ opened: false, downloaded: true });
                            }
                        });
                    } else if (delta.state?.current === 'interrupted') {
                        chrome.downloads.onChanged.removeListener(onChanged);
                        resolve({ opened: false, downloaded: false });
                    }
                }

                chrome.downloads.onChanged.addListener(onChanged);
            });
        });
    } finally {
        URL.revokeObjectURL(url);
    }
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
