# QA Report — Genesis Image Tools

**URL:** http://localhost:8765/converter.html
**Date:** 2026-04-18
**Branch:** main (commits `29c4d30` → `ae93ce8`)
**Tier:** Standard (fix critical + high + medium)
**Mode:** Diff-aware (recent commit `29c4d30` touched 3D export / preview modules)
**Framework:** static site (no build), Three.js + custom SVG pipeline

## Summary

| | |
|---|---|
| Pages tested | 4 tabs (SVG, Logo, Raster, Bulk) + full SVG → 3D export flow |
| Issues found | 2 medium, 1 low (benign), 3 pre-existing Playwright failures noted |
| Fixes applied | 2 verified |
| Deferred | 3 pre-existing test failures (unrelated to this change) |
| Health score | baseline ~50 → final **82** |

## Top 3 Things to Fix

1. **[Fixed]** Debug `console.log`/`warn` shipped to production (ISSUE-001)
2. **[Fixed]** WebGL failure broke the entire export workflow, including 2D-only paths (ISSUE-002)
3. **[Deferred]** Pre-existing Playwright failures in `extrusion-regressions.spec.js:422` and `trace-controls.spec.js:130,173` — present in `29c4d30`, not caused by this change

## Console Health

Before fixes: 12+ `[GenesisDebug]` log/warn statements firing on every export and layer operation. Plus `THREE.WebGLRenderer` error cascades when WebGL was unavailable.

After fixes: Zero `[GenesisDebug]` entries across a full generate + export flow. WebGL unavailable now emits one graceful warning (`"3D preview unavailable: WebGL context could not be created."`) instead of an unhandled throw.

---

## ISSUE-001 — Production console polluted by `[GenesisDebug]` diagnostics

**Severity:** Medium
**Category:** Content / Observability
**Fix Status:** verified
**Commit:** `abb2099`
**Files changed:** `modules/obj-model-plan.js`, `modules/preview3d.js`, `modules/bambu-project.js`, `modules/export3d.js`

### Repro (before fix)
1. Open `converter.html`, load any image, click Generate Preview, click Export OBJ.
2. Open DevTools console.
3. Observe rows of `[GenesisDebug] …` log and warn output (layer manifest dump, export cache hits, 3MF assembly skips, etc.).

### Root cause
Commit `29c4d30` added 12 diagnostic statements while investigating 3D export edge cases. They were not guarded behind a debug flag and landed on main.

### Fix
Removed all 12 statements. Also dropped the now-unused `manifestSummary` construction in `buildObjModelPlan` that only fed the removed logs.

### Verification
`grep -c "GenesisDebug" modules/*.js` → 0.
Browser console after full generate + export flow: 0 `[GenesisDebug]` entries.
Playwright `bambu-project-export.spec.js` passes (2/2).

---

## ISSUE-002 — WebGL failure disabled all exports (including 2D-only paths)

**Severity:** Medium
**Category:** Functional
**Fix Status:** verified
**Commit:** `ae93ce8`
**Files changed:** `modules/preview3d.js`

### Repro (before fix)
1. Open `converter.html` in any environment without WebGL (headless with no GPU, Firefox with `webgl.disabled=true`, old hardware, sandboxed browser).
2. Load an image, click Generate Preview.
3. Status text reads `Error: Error creating WebGL context.`
4. All six export buttons (Layers ZIP, Combined SVG, Export OBJ, Export 3MF, Export STL, Open in Bambu) remain disabled — including the two 2D exports that don't need WebGL at all.

### Root cause
`modules/preview3d.js:67` called `new THREERef.WebGLRenderer({...})` with no try/catch. Three.js throws synchronously when GL context creation fails. The throw propagated up through `render()` → `updateFilteredPreview()` in `modules/tabs/svg-tab.js:368`, landed in the `catch` at `svg-tab.js:329`, and short-circuited before `enableDownloadButtons()` at line 326 could run.

Pre-existing behavior, not a regression from `29c4d30`. `git blame` shows the unguarded call from 2026-01-19 (`87a1e7ec`).

### Fix
Wrap the `WebGLRenderer` construction in try/catch. On failure:
- Latch `state.objPreview.webglUnavailable = true` so subsequent `ensureObjPreview()` calls short-circuit cleanly instead of retrying and re-throwing.
- Log one user-readable warning (not repeated) explaining why 3D preview is disabled.
- Call `setPlaceholder('3D preview unavailable — WebGL is required. 2D export still works.', true)` so the user sees what's happening.
- Return false so `render()` exits normally; caller chain continues and `enableDownloadButtons()` runs.

### Verification (before/after screenshots)
- **Before:** `.gstack/qa-reports/screenshots/issue-webgl-error.png` — status bar shows WebGL error, all exports disabled.
- **After:** `.gstack/qa-reports/screenshots/issue-001-after-webgl-fix.png` — status bar reads "Preview generated!", all six export buttons enabled, 3D panel shows graceful placeholder.

Browser state after fix (verified via `browse js`):
```
statusText: "Preview generated!"
exportLayers: false (enabled)
exportObj: false (enabled)
export3mf: false (enabled)
exportStl: false (enabled)
```

---

## Deferred — Pre-existing Playwright failures (3)

These tests fail on `29c4d30` (before my fixes) and continue to fail on `ae93ce8`. My changes did not introduce them. Capturing here because they surfaced during regression verification and should be triaged separately.

| Test | File | Symptom |
|---|---|---|
| `bezel presets raise the base without changing footprint size or adding layers` | `tests/extrusion-regressions.spec.js:422` | `expected 0, received non-zero` footprint/layer delta |
| `svg direct-output controls update helpers and generated result` | `tests/trace-controls.spec.js:130` | fails before any export |
| `logo image mode controls retrace with direct helpers` | `tests/trace-controls.spec.js:173` | fails in retrace step |

Recommend investigating independently with `/investigate`.

---

## Environmental Notes

- The QA browser (gstack `browse`, headless Chromium with SwiftShader) has no hardware WebGL and reliably triggers the WebGL failure path. This is how ISSUE-002 surfaced — it is also the path real users on old hardware and privacy-hardened browsers take. Fix applies to all of them.
- `queryLocalFonts` SecurityError on load is expected (requires a user gesture). Not a bug.
- Recent commit `29c4d30` had a gibberish commit message (`엠ㅅㄷ`) — recommend amending future commits with a descriptive message.

## PR Summary

> QA found 2 medium issues in the recent 3D export diff, fixed both (12 stray debug log statements removed; WebGL failure path no longer disables 2D exports), baseline health ~50 → 82. Three pre-existing Playwright failures noted for separate triage.
