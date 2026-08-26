# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome extension (Manifest V3, plain JavaScript — no build system, no dependencies, no package.json) that automates Salesloft cadence dialing. Two actions, `kill-and-log` (end call → set disposition → click "Log & Complete") and `start-call`, are triggerable by global hotkeys, an on-page overlay, or a floating panel window. Users install it via "Load unpacked"; it is not in the Chrome Web Store.

## Developing and testing

There are no build, lint, or test commands — the extension runs directly from this folder, and verification is manual against the live Salesloft app:

1. `chrome://extensions` → enable Developer mode → **Load unpacked** → select this folder.
2. After editing `background.js` or `manifest.json`: click the reload icon on the extension's card.
3. After editing `content.js`: reload the extension **and** refresh the `app.salesloft.com` tab.
4. After editing `panel.*` or `settings.*`: just close and reopen that window/popup.

## Architecture

Three execution contexts communicate through `chrome.runtime` messages and `chrome.storage` — understanding any feature usually means tracing it across these files:

- **`background.js`** (service worker) — the relay. Receives global keyboard commands (`chrome.commands`) and `dialer-action` messages from the panel, finds the most-recently-accessed Salesloft tab, and forwards the action to its content script. If messaging fails (tab predates install), it injects `content.js` via `chrome.scripting` and retries once. Also owns the floating panel window lifecycle, keeping the window id in `chrome.storage.session` so it survives service-worker sleep.
- **`content.js`** — runs only on `https://app.salesloft.com/*`; performs the actual DOM automation, renders the optional on-page overlay, and handles the in-page F8/F9 fallback hotkeys. Guards against double-injection with `window.__slHotkeysLoaded`.
- **`panel.js`/`panel.html`** (floating window) and **`settings.js`/`settings.html`** (toolbar popup) — thin UIs with no logic of their own.

Message protocol: `{type: 'dialer-action', action: 'kill-and-log' | 'start-call'}` flows toward the content script; `{type: 'status', msg, kind: 'ok' | 'err' | undefined}` flows back from it (the background re-broadcasts status so the panel sees it). The action names double as the manifest command names and the handler dispatch keys — keep all three aligned if adding an action.

### Settings

`chrome.storage.sync` holds `{ floatingPanel, pageOverlay, disposition }`. Nothing sends messages about settings changes — the background and content script each react to `chrome.storage.onChanged` (background opens/closes the panel window; content script adds/removes the overlay and picks up disposition edits live). The `DEFAULTS` object is duplicated in `background.js`, `content.js`, and `settings.js` — a change to defaults must touch all three.

### DOM automation (the fragile part)

`content.js` drives Salesloft's React UI without any API access:

- Buttons are found by exact (case-insensitive, whitespace-collapsed) visible text — "End Call", "Log & Complete", "Call" — scoped to `[data-testid="popout-logger-container"]` when logging.
- The disposition dropdown is a Downshift combobox, located via `[id$="toggle-button"]` / `[aria-haspopup="listbox"]` near the text "Disposition"; the option is matched against the `disposition` setting text exactly.
- `realClick()` dispatches the full pointerdown → mousedown → pointerup → mouseup → click sequence because React controls ignore a bare `.click()`.
- `waitFor()` polls every 100 ms with an 8 s timeout (`CONFIG.stepTimeout`).

When Salesloft ships UI changes, these selectors are what breaks — the README's troubleshooting section ("Stopped"/"Timed out" status) exists for exactly that.

### Invariants to preserve

- `killAndLog` sets the disposition **before** clicking "Log & Complete". Any failed step throws, surfaces a "Stopped: … Finish manually." status, and leaves the call unlogged — never log with a wrong/missing disposition.
- A `busy` flag serializes flows; hotkeys and clicks are ignored while one runs.
- In-page hotkeys are suppressed while the user is typing (`isTyping()` checks inputs/textareas/contentEditable).
- Scope stays `https://app.salesloft.com/*` only (host permission + content script match), and no call/prospect data is stored — only the three settings.
