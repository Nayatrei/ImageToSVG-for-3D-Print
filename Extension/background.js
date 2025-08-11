// background.js
// This service worker registers a context menu on images and sends the
// selected image URL to an offscreen document for conversion. When the
// offscreen script responds with an SVG string, the background script
// downloads the file using the Chrome downloads API.

const MENU_ID = 'convert_to_svg';

// Create the context menu item when the extension is installed or updated.
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: MENU_ID,
    title: 'Convert image to SVG',
    contexts: ['image']
  });
});

/**
 * Ensures that an offscreen document exists. The offscreen document
 * executes in its own context and performs expensive work like image
 * decoding and vectorization without blocking the background service
 * worker. The offscreen API is only available in Manifest V3.
 */
async function ensureOffscreen() {
  const exists = await chrome.offscreen.hasDocument();
  if (exists) {
    return;
  }
  await chrome.offscreen.createDocument({
    url: chrome.runtime.getURL('offscreen.html'),
    reasons: ['BLOBS', 'DOM_PARSER', 'CANVAS'],
    justification: 'Process image data and vectorize it without blocking the UI'
  });
}

// When the context menu item is clicked on an image, pass the image URL to the offscreen document.
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Only handle our menu and ensure there is a srcUrl present.
  if (info.menuItemId !== MENU_ID || !info.srcUrl) {
    return;
  }
  // Ensure the offscreen document has been created.
  await ensureOffscreen();
  // Derive a suggested filename from the image URL. Remove query strings and extensions.
  let suggestedName = 'image.svg';
  try {
    const parsed = new URL(info.srcUrl);
    let name = parsed.pathname.split('/').pop() || 'image';
    name = name.split('?')[0];
    const base = name.replace(/\.[^/.]+$/, '');
    suggestedName = `${base}.svg`;
  } catch (e) {
    // Fallback to default name
    suggestedName = 'image.svg';
  }
  // Send a message to the offscreen document to start the conversion.
  chrome.runtime.sendMessage({
    type: 'convert',
    srcUrl: info.srcUrl,
    filename: suggestedName
  });
});

// Listen for messages from the offscreen document containing the SVG string.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'converted' && msg.svg) {
    // Create a Blob from the SVG string and trigger a download.
    const blob = new Blob([msg.svg], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: msg.filename || 'image.svg',
      saveAs: true
    }, downloadId => {
      // Revoke the object URL after a short delay to free memory.
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    });
  }
});