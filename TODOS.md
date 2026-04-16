# TODOS

Items deferred from active development. Each entry has context so a future engineer understands the "why."

---

## P2: Native companion app for exact folder control

**What:** A tiny native host (Python or Node.js script, installed once) that receives 3MF data from the static site via a localhost bridge, writes it to a user-chosen folder, and triggers the Bambu Studio protocol via an OS-level command.

**Why:** Browser downloads go to the user's default Downloads folder. If a user wants their Genesis files elsewhere, a native companion is the only reliable path.

**Pros:** Exact folder control, most reliable protocol trigger (OS-level `open`/`start` command), cross-platform.

**Cons:** Requires users to run an install script once. Maintenance surface: companion must work on macOS and Windows.

**Effort:** M (human: ~1 day / CC: ~30min)

**Context:** Originally designed in /office-hours session on 2026-04-15 as a Chrome extension native messaging approach. Reframed for static site deployment.

---

## P3: Linux support for Bambu Studio launch

**What:** Detect Linux in `canAttemptBambuLaunch()` and return `false` (or `true` if a Linux protocol approach is verified). The Bambu Studio Linux AppImage does not register a protocol handler by default.

**Why:** The current code correctly blocks Linux (`bambu-bridge.js:29`), so the button shows disabled with a "Desktop browsers only" explanation. If a Linux protocol approach is verified, this can be enabled.

**Pros:** Honest UX, don't show a button that won't work.

**Cons:** Low user impact (Linux + Bambu Studio is a small segment).

**Effort:** S (human: ~30min / CC: ~5min)

**Context:** Surfaced during /plan-ceo-review on 2026-04-15.

---

## P3: Bambu Connect print queue integration

**What:** After the model opens in Bambu Studio, optionally queue the print via Bambu Connect (`bambu-connect://import-file?path=<localpath>&name=<name>&version=1.0.0`).

**Why:** The 12-month ideal is full zero-touch: Image -> Bambu Studio -> AMS assigned -> print queued.

**Pros:** Closes the loop on the printing workflow entirely.

**Cons:** Requires Bambu Connect (separate app) to be installed. Local-file-only protocol (no remote URL). Scope expansion beyond current plan.

**Effort:** M (human: ~4h / CC: ~20min)

**Context:** Identified as 12-month ideal state during /plan-ceo-review on 2026-04-15.

---

## P3: Mobile-responsive export footer collapse

**What:** On mobile (<768px), collapse the 3D export buttons (OBJ, 3MF, STL, Open in Bambu) into an expandable "3D Export..." group. Show 2D exports (Layers ZIP, Combined SVG) directly.

**Why:** The SVG tab footer has 6 buttons. When stacked on mobile, the footer exceeds the viewport height (~480px). 3D printing from a phone is rare, so those actions can be one tap deeper.

**Pros:** Footer fits on screen. 2D exports (the mobile-likely actions) are immediately visible.

**Cons:** Adds a collapsible JS component + CSS media query. Users who DO want 3D export on mobile need one extra tap.

**Effort:** S (human: ~2h / CC: ~15min)

**Context:** Surfaced during /plan-design-review on 2026-04-15. The Logo tab (4 buttons) is less urgent but could benefit from the same pattern.

---

## P3: Create DESIGN.md

**What:** Document existing design patterns: button hierarchy (primary/secondary), color tokens (#1f2937 bg, #374151 borders, blue primary accent), footer grid system, icon style (24x24 stroke icons), spacing (py-3 px-4), grouped footer layout.

**Why:** No formal design system exists. Every design decision is implicit in Tailwind utility classes. A DESIGN.md ensures consistency as the app grows and prevents design drift.

**Pros:** Future contributors know the visual language. Design reviews have a baseline to calibrate against.

**Cons:** Maintenance burden to keep it in sync with CSS changes.

**Effort:** S (human: ~1h / CC: ~10min)

**Context:** Surfaced during /plan-design-review on 2026-04-15. Recommended running /design-consultation for a full system if this grows beyond a utility tool.
