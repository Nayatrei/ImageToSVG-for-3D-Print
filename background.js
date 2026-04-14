const MENU_ID = 'convert_to_svg';

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
