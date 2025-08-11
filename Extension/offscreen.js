// offscreen.js
// This script runs in an offscreen document. It listens for messages
// from the background service worker instructing it to fetch an image,
// rasterize it onto an offscreen canvas, vectorize the pixels using
// ImageTracer, and return an SVG string back to the background script.

/* global ImageTracer */

// Listen for messages from the background service worker.
chrome.runtime.onMessage.addListener(async (msg) => {
  if (!msg || msg.type !== 'convert' || !msg.srcUrl) {
    return;
  }
  const { srcUrl, filename } = msg;
  try {
    // Try to fetch the image directly. Extensions with host_permissions
    // may fetch cross-origin resources. If the fetch fails, fall back
    // to a no-cors request which produces an opaque response; in that
    // case, drawing to canvas should still succeed for image decoding.
    let response;
    try {
      response = await fetch(srcUrl);
      if (!response.ok) throw new Error('Non‑OK response');
    } catch (e) {
      // Attempt a no-cors request. Opaque responses will still have a
      // body that we can convert to a blob. This may still fail for
      // some URLs, but it's a reasonable fallback.
      response = await fetch(srcUrl, { mode: 'no-cors' });
    }
    const blob = await response.blob();
    // Create an ImageBitmap for efficient pixel decoding.
    const bitmap = await createImageBitmap(blob);
    const width = bitmap.width;
    const height = bitmap.height;
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // Extract pixel data from the canvas.
    const imageData = ctx.getImageData(0, 0, width, height);
    // Create a new ImageTracer instance. The library attaches itself
    // to the window or self as ImageTracer; invoking the constructor
    // with new ensures independent options.
    const tracer = new ImageTracer();
    // Use simple options: enable viewBox so the SVG scales nicely. Other
    // parameters default to the library's built‑in values (16 colours,
    // slight smoothing, etc.). Feel free to tweak numberofcolors or
    // colorsampling values here if you desire a different result.
    const options = { viewbox: true };
    // Convert the pixel data to traced vector data.
    const traced = tracer.imagedataToTracedata(imageData, options);
    // Generate an SVG string from the traced data.
    const svgString = tracer.getsvgstring(traced, options);
    // Send the SVG back to the background script for downloading.
    chrome.runtime.sendMessage({ type: 'converted', svg: svgString, filename });
  } catch (error) {
    // In case of any error, return an SVG containing the error message.
    const errorMessage = String(error.message || error);
    const svgError = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="40"><text x="10" y="20" font-family="sans-serif" font-size="14">Error: ${errorMessage.replace(/</g, '&lt;')}</text></svg>`;
    chrome.runtime.sendMessage({ type: 'converted', svg: svgError, filename });
  }
});