import {
    BAMBU_BRIDGE_ALLOWED_MATCHES,
    BAMBU_BRIDGE_EXTENSION_ID,
    BAMBU_BRIDGE_EXTENSION_STORAGE_KEY
} from './config.js';

const MESSAGE_TYPES = {
    probe: 'genesis:probeBambuBridge',
    open: 'genesis:openBambuProject',
    downloadAndOpen: 'genesis:downloadAndOpenBambuProject'
};

function getRuntime() {
    return typeof chrome !== 'undefined' ? chrome.runtime : null;
}

function getStorage() {
    try {
        return window.localStorage;
    } catch (error) {
        return null;
    }
}

function getOverrideExtensionId(storage) {
    try {
        const value = storage?.getItem?.(BAMBU_BRIDGE_EXTENSION_STORAGE_KEY);
        return value ? String(value).trim() : '';
    } catch (error) {
        return '';
    }
}

export function getConfiguredBambuExtensionId() {
    const runtime = getRuntime();
    if (runtime?.id) return runtime.id;
    const overrideId = getOverrideExtensionId(getStorage());
    return overrideId || BAMBU_BRIDGE_EXTENSION_ID;
}

export function canUseChromeDownloadsOpen() {
    return typeof chrome !== 'undefined'
        && Boolean(chrome.downloads?.download && chrome.downloads?.open);
}

function matchesAllowedPage() {
    if (typeof window === 'undefined' || !window.location) return false;
    const href = window.location.href;
    return BAMBU_BRIDGE_ALLOWED_MATCHES.some((pattern) => {
        const normalized = pattern
            .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '.*');
        return new RegExp(`^${normalized}$`).test(href);
    });
}

function sendRuntimeMessage({ message, extensionId = '', runtime = getRuntime() }) {
    if (!runtime?.sendMessage) {
        return Promise.resolve({ ok: false, code: 'bridge_unavailable', message: 'Chrome runtime messaging is unavailable.' });
    }

    return new Promise((resolve) => {
        const callback = (response) => {
            const lastError = chrome?.runtime?.lastError;
            if (lastError) {
                resolve({
                    ok: false,
                    code: 'bridge_error',
                    message: lastError.message || 'Bridge request failed.'
                });
                return;
            }
            resolve(response || { ok: false, code: 'bridge_no_response', message: 'No response from bridge.' });
        };

        try {
            if (extensionId) {
                runtime.sendMessage(extensionId, message, callback);
            } else {
                runtime.sendMessage(message, callback);
            }
        } catch (error) {
            resolve({
                ok: false,
                code: 'bridge_exception',
                message: error.message || 'Bridge request failed.'
            });
        }
    });
}

let probePromise = null;

export function createBambuBridgeClient() {
    const runtime = getRuntime();
    const extensionId = runtime?.id ? '' : (matchesAllowedPage() ? getConfiguredBambuExtensionId() : '');

    function canSendMessages() {
        return Boolean(runtime?.sendMessage) && (Boolean(runtime?.id) || Boolean(extensionId));
    }

    async function probe({ force = false } = {}) {
        if (!force && probePromise) return probePromise;
        if (!canSendMessages()) {
            return {
                ok: false,
                available: false,
                code: 'bridge_unavailable',
                message: 'Install the Genesis extension bridge to open projects from the hosted app.'
            };
        }

        probePromise = sendRuntimeMessage({
            runtime,
            extensionId,
            message: { type: MESSAGE_TYPES.probe }
        }).then((response) => ({
            ok: Boolean(response?.ok),
            available: Boolean(response?.available),
            appPath: response?.appPath || '',
            message: response?.message || '',
            code: response?.code || ''
        }));

        return probePromise;
    }

    async function openProject(path) {
        if (!canSendMessages()) {
            return {
                ok: false,
                opened: false,
                code: 'bridge_unavailable',
                message: 'Install the Genesis extension bridge to open projects from the hosted app.'
            };
        }

        return sendRuntimeMessage({
            runtime,
            extensionId,
            message: {
                type: MESSAGE_TYPES.open,
                path
            }
        });
    }

    async function downloadAndOpenProject({ dataUrl, filename }) {
        if (!canSendMessages()) {
            return {
                ok: false,
                opened: false,
                code: 'bridge_unavailable',
                message: 'Install the Genesis extension bridge to open projects from the hosted app.'
            };
        }

        return sendRuntimeMessage({
            runtime,
            extensionId,
            message: {
                type: MESSAGE_TYPES.downloadAndOpen,
                dataUrl,
                filename
            }
        });
    }

    return {
        canSendMessages,
        probe,
        openProject,
        downloadAndOpenProject
    };
}
