---
name: Logo tab architecture and design decisions
description: Key files, state paths, framing logic, background-layer handling for Logo tab
type: project
---

## Key files
- `modules/tabs/logo-tab.js` — main controller (tracing, events, preview coordination)
- `modules/preview3d.js` — Three.js 3D preview (render, fitView, camera, bed plate)
- `modules/export3d.js` — OBJ/3MF/STL export (uses same `getDataToExport()` as preview)
- `modules/tabs/html/tab-logo.html` — UI markup
- `modules/tabs/logo/html-editor.js` — HTML-mode editor, font loading
- `modules/app-state.js` — initialises `state.logo` (passed as `ls` to logo controller)
- `modules/layer-layout.js` — layer stacking/Z-position calculation

## State path
Logo state lives at `state.logo` (aliased `ls`). 3D preview state at `ls.objPreview`.

## Background-layer hole cleaning (logo-tab.js `traceVectorPaths`)
Applied to BOTH HTML and PNG image modes. Detects background = layer with largest
outer-path bounding-box area. Strips hole paths from background only; preserves holes
(letter counters) on all other layers. Layer reordering (bg→L0) is HTML mode only.

## 3D preview stable framing (preview3d.js `render`)
- XY anchor: SVG footprint centre × scalePlan.scale (not 3D mesh centroid — avoids
  jump when backing-plate rect is added/removed).
- Z anchor: always `BED_CONTACT_EPSILON - centeredBox.min.z` regardless of
  showBuildPlate (toggling plate must not shift model in Z).
- frameMaxDim: XY footprint only (no finalSize.z) — keeps panScale stable across
  layer-height changes.
- lookAtTarget: fixed `(0,0,5)` — never height-dependent.
- camera target (`preview.target`) set once on first render; explicit Fit button
  (`logo-obj-fit-view`) is the only way to reframe intentionally.

## Backing plate (was "Base layer")
- Default `useBaseLayer: false` in app-state.js (was true — caused DOM/state mismatch).
- UI label renamed from "Base layer" to "Backing plate" in tab-logo.html.
- When enabled: generates a solid rect covering SVG bounds for that layer.
- Decoupled from background-hole filling (hole filling works without backing).

## Font loading (html-editor.js)
- Font Access API (`window.queryLocalFonts()`) gets ALL installed fonts when available.
- Fallback list expanded to ~200 fonts covering macOS, Windows, Linux, Adobe, Google.

**Why:** Prior code had: duplicate footer in HTML, backing default mismatch, background
hole-clean only in HTML mode, build-plate toggle causing Z jump, height-dependent
framing causing preview jumps on layer-height edits, missing Fit button and font select.
