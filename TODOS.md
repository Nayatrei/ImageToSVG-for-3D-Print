# TODOS

Items deferred from active development. Each entry has context so a future engineer understands the "why."

---

## P2: Native messaging companion for exact folder control

**What:** A tiny native host (Python or Node.js script, installed once) that receives 3MF data from the extension via `chrome.nativeMessaging`, writes it to `~/Documents/GenesisConverter/`, and triggers the Bambu Studio protocol via an OS-level command.

**Why:** `chrome.downloads` can only write to subdirectories of the user's default Downloads folder. If a user wants their Genesis files in `~/Documents/` (or anywhere other than Downloads), native messaging is the only path that avoids requiring a server.

**Pros:** Exact folder control, most reliable protocol trigger (OS-level `open`/`start` command), cross-platform.

**Cons:** Requires users to run an install script once. Extension needs `nativeMessaging` permission + host manifest (`com.genesis.bambu_host.json`). Maintenance surface: native host must work on macOS and Windows.

**Effort:** M (human: ~1 day / CC: ~30min)

**Context:** Designed in /office-hours session on 2026-04-15. Design doc at `~/.gstack/projects/Nayatrei-GenesisConverter/jongmac-main-design-20260415-211132.md` (Approach B).

**Depends on:** Bambu Studio local launch (Approach A) shipping first as v3.1.2.

---

## P3: Linux support for Bambu Studio launch

**What:** Detect Linux in `canAttemptBambuLaunch()` and return `false` (or `true` if a Linux protocol approach is verified). The Bambu Studio Linux AppImage does not register a protocol handler by default.

**Why:** The current code passes on Linux (mobile UA filter doesn't block it), so the button appears enabled but the protocol trigger silently does nothing.

**Pros:** Honest UX — don't show a button that won't work.

**Cons:** Low user impact (Linux + Bambu Studio is a small segment).

**Effort:** S (human: ~30min / CC: ~5min)

**Context:** Surfaced during /plan-ceo-review on 2026-04-15.

---

## P3: Bambu Connect print queue integration

**What:** After the model opens in Bambu Studio, optionally queue the print via Bambu Connect (`bambu-connect://import-file?path=<localpath>&name=<name>&version=1.0.0`).

**Why:** The 12-month ideal is full zero-touch: Image → Bambu Studio → AMS assigned → print queued.

**Pros:** Closes the loop on the printing workflow entirely.

**Cons:** Requires Bambu Connect (separate app) to be installed. Local-file-only protocol (no remote URL). Scope expansion beyond current plan.

**Effort:** M (human: ~4h / CC: ~20min)

**Context:** Identified as 12-month ideal state during /plan-ceo-review on 2026-04-15.
