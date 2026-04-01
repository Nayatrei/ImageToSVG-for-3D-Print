---
name: GenesisImageConverter project overview
description: Multi-tab image converter — SVG, Logo 3D print, Raster, Bulk tabs
type: project
---

Web app at /Users/jongmac/Documents/WebTools/GenesisImageConverter that converts images into SVG layers for multi-colour 3D printing (Bambu Lab). Main entry: converter.html + converter.js. Tabs are loaded as HTML partials. Three.js for 3D preview. ImageTracer for raster→SVG. Export to OBJ/3MF/STL.

**Why:** Tool for creating multi-colour 3D-printable logos and badges from PNG images or HTML snippets.

**How to apply:** When working on export, preview, or tracing code, understand the full pipeline: image → color quantisation → path tracing → SVG → Three.js extrude → export.
