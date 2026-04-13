const MENU_ID = 'convert_to_svg';
const BAMBU_NATIVE_HOST_NAME = 'com.genesisframeworks.bambu_bridge';
const BRIDGE_TYPES = {
    probe: 'genesis:probeBambuBridge',
    open: 'genesis:openBambuProject',
    downloadAndOpen: 'genesis:downloadAndOpenBambuProject'
};

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: MENU_ID,
        title: 'Convert image to SVG with Genesis Framework...',
        contexts: ['image']
    });
});

chrome.action.onClicked.addListener(() => {
    chrome.tabs.create({ url: chrome.runtime.getURL('converter.html') });
});

chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_ID && info.srcUrl) {
        chrome.storage.local.set({ imageUrlToConvert: info.srcUrl }, () => {
            chrome.tabs.create({ url: chrome.runtime.getURL('converter.html') });
        });
    }
});

chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'fetchImagePort') return;

    port.onMessage.addListener(async (request) => {
        if (request.type !== 'fetchImage' || !request.url) return;
        try {
            const response = await fetch(request.url);
            if (!response.ok) {
                throw new Error(`Network error: ${response.status} ${response.statusText}`);
            }
            const blob = await response.blob();
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => resolve(reader.result);
                reader.onerror = () => reject(new Error('Failed to read blob as Data URL.'));
                reader.readAsDataURL(blob);
            });
            port.postMessage({ dataUrl });
        } catch (error) {
            console.error('Background fetch failed:', error);
            port.postMessage({ error: error.message });
        }
    });
});

function sendNativeHostMessage(message) {
    return new Promise((resolve) => {
        if (!chrome.runtime.sendNativeMessage) {
            resolve({
                ok: false,
                code: 'native_messaging_unavailable',
                message: 'Chrome native messaging is unavailable.'
            });
            return;
        }

        try {
            chrome.runtime.sendNativeMessage(BAMBU_NATIVE_HOST_NAME, message, (response) => {
                if (chrome.runtime.lastError) {
                    resolve({
                        ok: false,
                        code: 'native_host_error',
                        message: chrome.runtime.lastError.message || 'Failed to contact the Bambu bridge.'
                    });
                    return;
                }
                resolve(response || {
                    ok: false,
                    code: 'native_host_empty_response',
                    message: 'The Bambu bridge returned no response.'
                });
            });
        } catch (error) {
            resolve({
                ok: false,
                code: 'native_host_exception',
                message: error.message || 'Failed to contact the Bambu bridge.'
            });
        }
    });
}

function waitForDownloadCompletion(downloadId) {
    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            chrome.downloads.onChanged.removeListener(handleChange);
            reject(new Error('Timed out waiting for the Bambu Studio project download.'));
        }, 30000);

        function cleanup() {
            clearTimeout(timeoutId);
            chrome.downloads.onChanged.removeListener(handleChange);
        }

        async function handleChange(delta) {
            if (delta.id !== downloadId || !delta.state?.current) return;

            if (delta.state.current === 'complete') {
                cleanup();
                chrome.downloads.search({ id: downloadId }, (items) => {
                    resolve(items?.[0] || null);
                });
                return;
            }

            if (delta.state.current === 'interrupted') {
                cleanup();
                reject(new Error(delta.error?.current || 'The Bambu Studio project download was interrupted.'));
            }
        }

        chrome.downloads.onChanged.addListener(handleChange);
    });
}

async function downloadProjectFile({ dataUrl, filename }) {
    const downloadId = await chrome.downloads.download({
        url: dataUrl,
        filename,
        conflictAction: 'uniquify',
        saveAs: false
    });
    const item = await waitForDownloadCompletion(downloadId);
    return {
        downloadId,
        path: item?.filename || '',
        item
    };
}

async function tryOpenWithBridge(path) {
    if (!path) {
        return {
            ok: false,
            opened: false,
            code: 'missing_path',
            message: 'No project path was available to open.'
        };
    }
    return sendNativeHostMessage({
        type: 'open-bambu-project',
        path
    });
}

async function handleBridgeMessage(message) {
    switch (message?.type) {
        case BRIDGE_TYPES.probe: {
            const probe = await sendNativeHostMessage({ type: 'probe-bambu-studio' });
            return {
                ok: Boolean(probe?.ok),
                available: Boolean(probe?.available),
                appPath: probe?.appPath || '',
                downloadsOpenAvailable: Boolean(chrome.downloads?.open),
                code: probe?.code || '',
                message: probe?.message || ''
            };
        }
        case BRIDGE_TYPES.open: {
            return tryOpenWithBridge(message.path);
        }
        case BRIDGE_TYPES.downloadAndOpen: {
            if (!message.dataUrl || !message.filename) {
                return {
                    ok: false,
                    opened: false,
                    code: 'invalid_request',
                    message: 'The Bambu Studio project payload was incomplete.'
                };
            }

            try {
                const download = await downloadProjectFile({
                    dataUrl: message.dataUrl,
                    filename: message.filename
                });

                const openResult = await tryOpenWithBridge(download.path);
                if (openResult?.ok && openResult?.opened) {
                    return {
                        ...openResult,
                        path: download.path,
                        downloadId: download.downloadId
                    };
                }

                if (chrome.downloads?.open && download.downloadId) {
                    try {
                        chrome.downloads.open(download.downloadId);
                        return {
                            ok: true,
                            opened: true,
                            path: download.path,
                            downloadId: download.downloadId,
                            message: 'The Bambu Studio project was downloaded and handed off to your system default 3MF app.'
                        };
                    } catch (error) {
                        return {
                            ok: false,
                            opened: false,
                            code: 'downloads_open_failed',
                            message: error.message || 'The project was downloaded, but the file could not be opened automatically.',
                            path: download.path,
                            downloadId: download.downloadId
                        };
                    }
                }

                return {
                    ok: false,
                    opened: false,
                    code: openResult?.code || 'native_host_unavailable',
                    message: openResult?.message || 'The project was downloaded, but Bambu Studio could not be opened automatically.',
                    path: download.path,
                    downloadId: download.downloadId
                };
            } catch (error) {
                return {
                    ok: false,
                    opened: false,
                    code: 'download_failed',
                    message: error.message || 'Failed to download the Bambu Studio project.'
                };
            }
        }
        default:
            return null;
    }
}

function addBridgeListener(register) {
    register.addListener((message, sender, sendResponse) => {
        if (!message?.type || !String(message.type).startsWith('genesis:')) return false;

        handleBridgeMessage(message)
            .then((response) => sendResponse(response || {
                ok: false,
                code: 'unsupported_message',
                message: 'Unsupported bridge message.'
            }))
            .catch((error) => {
                sendResponse({
                    ok: false,
                    code: 'bridge_handler_error',
                    message: error.message || 'The bridge request failed.'
                });
            });

        return true;
    });
}

addBridgeListener(chrome.runtime.onMessage);
addBridgeListener(chrome.runtime.onMessageExternal);
