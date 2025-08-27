# Image → SVG (3D Print Ready) — Chrome Extension

## Install (Developer Mode)
1. Open **chrome://extensions**.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder.

## Use
- Right‑click any image on the web → **Convert image to SVG for 3D printing...**
- Or click the toolbar icon to open the app and **Import Image** or **Load URL**.
- Choose **📐 3D Print (Tinkercad Ready)**, tweak sliders, **Generate 3D-Ready Preview**.
- Toggle layers, then **Download Layers for Tinkercad**: you’ll get a solid background silhouette and one SVG per visible layer.

## Notes
- URL loading first attempts a background-port fetch (CORS-safe), then falls back to a proxy.
- Sliders directly map to ImageTracer options for predictable, printable results.
- “Remove Background” detects the dominant edge color and makes it transparent before tracing.

## Files
- `manifest.json` — MV3 configuration
- `background.js` — context menu and background image fetch
- `converter.html` — UI
- `converter.js` — logic and ImageTracer integration
- `style.css` — layout & styles
- `imagetracer_v1.2.6.js` — vectorization library
- `icon48.png` — extension icon