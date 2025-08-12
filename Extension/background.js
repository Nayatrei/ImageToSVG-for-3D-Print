// background.js

const MENU_ID = 'convert_to_svg';

// Initialize context menu on extension install
chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: MENU_ID,
        title: 'Convert image to SVG...',
        contexts: ['image']
    });
});

// Handle context menu click to open converter page
chrome.contextMenus.onClicked.addListener(async (info) => {
    if (info.menuItemId !== MENU_ID || !info.srcUrl) {
        return;
    }
    await chrome.storage.local.set({ imageUrlToConvert: info.srcUrl });
    chrome.tabs.create({
        url: chrome.runtime.getURL('converter.html')
    });
});

// Handle image fetch requests to bypass CORS
chrome.runtime.onConnect.addListener((port) => {
    if (port.name === 'fetchImagePort') {
        port.onMessage.addListener(async (request) => {
            if (request.type === 'fetchImage' && request.url) {
                try {
                    // Provide custom headers to improve compatibility with some image hosts
                    const response = await fetch(request.url, {
                        // Some hosts require a referer or user-agent; these headers can help bypass 403s
                        headers: {
                            'User-Agent': 'Mozilla/5.0',
                            'Referer': 'https://seeklogo.com/'
                        }
                    });
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
            }
        });
    }
});