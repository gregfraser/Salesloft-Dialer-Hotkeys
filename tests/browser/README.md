# Browser tests

The DOM automation in `extension/content.js` is the part of this repo most
likely to break, and it is the part `node --test` cannot reach: it needs a
document, a layout engine, and a Salesloft-shaped page to drive. These two
scripts give it all three.

They are **not** part of the standard suite and nothing in `extension/` depends
on them. Playwright is installed here on demand, so the extension stays what
`CLAUDE.md` says it is: plain JavaScript with no build step and no
`package.json` of its own. Anything npm writes in this directory is ignored by
git.

```bash
cd tests/browser
npm install playwright          # once; writes node_modules/ and package.json here
npx playwright install chromium # once, unless a browser is already present
node behaviour.mjs              # the Not in Service flow, the pane, the not-armed state
node regress.mjs                # the two older flows, and toggling the setting live
```

Both print one line per check and exit non-zero on a failure. Set
`CHROMIUM_PATH` if Playwright cannot find its own browser.

## What `mock.html` is

A stand-in for the parts of Salesloft these flows touch: the logger popout, the
Downshift disposition combobox, the "Log & Complete" split button and its
caret menu, and the cadence's remove control. It is built from **structure and
accessible names only** — never a generated `styled-components` class — which
is the same rule `content.js` follows, so a test passing here means the
selectors are anchored to something Salesloft is unlikely to move.

`window.__buildSalesloft(opts)` rebuilds it. **Every option on it exists
because it caught a real bug** that `node --test` and a screenshot both missed,
which is the only reason to add another: `inCall`, `confirm`, `confirmButtons`,
`noRemove`, `noMenuToggle`, `dispositions`, `dispositionSticks`,
`dispositionPreset`, `removeLabel`, `nameFrom`, `decoys`, `decoyTexts`,
`toast`, `confirmText`, `loggerIsDialog`, `listPage` and `downshiftMenu`.

The ones worth knowing about:

- The confirmation dialog is **`position: fixed`**, like every real modal.
  `offsetParent` is null for a fixed element, so a check written as
  `offsetParent !== null` reads a modal that is plainly on screen as hidden.
  The flow then reported a cadence removal that had not happened, with the
  dialog still open.
- `loggerIsDialog` gives the logger popout `role="dialog"`, which Salesloft's
  really has. A document-wide `[role="dialog"]` lookup matched the popout the
  flow had just been driving, so a removal that *had* succeeded was reported as
  "Stopped: … Finish manually."
- `decoys` fills the activity feed with list items whose **entire text is the
  disposition being looked for**, which is what a contact logged "Not in
  Service" a dozen times really looks like. A page-wide `ul li` search clicked
  one of those instead of the dropdown option, and the call logged with the
  field still empty. Against the code that shipped, this prints
  `DECOY CLICKED`.
- `nameFrom` moves the cadence control's accessible name between `aria-label`,
  `aria-labelledby`, the `title` attribute and the `<title>` inside its SVG.
  Salesloft uses the last of those, and reading only the attribute meant the
  flow logged the call and then timed out looking for a control that was there
  all along.
- `toast` throws an unrelated notification carrying a dialog role right when
  the confirmation would appear, because Salesloft does.
- `listPage` drops the contact marker, leaving only the logger popout — the
  state in which the plate used to appear beside a cadence's 170-row People
  list with nothing dialled.
- `downshiftMenu` renders the disposition combobox the way Downshift does: the
  menu is an empty listbox that stays in the DOM while closed, the toggle names
  nothing, the options sit under "Frequently Used" / "A-Z" headers, and opening
  it re-renders an unrelated list elsewhere. The flow counted every list that
  *existed* before its click as not the one it opened, this menu included, so
  it searched the unrelated list and stopped on `could not find "No Answer"`
  with the option on screen.
  The field is also an input with the toggle beside it, and picking a value
  swaps the chevron for a clear (×) button. The read-back looked only at the
  toggle it had clicked, which was detached by then, and sat on
  `Setting "No Answer"…` with the field reading "No Answer".

The mock should be as awkward as the real page, or it only tests the happy
path.

## What is still not covered

Everything upstream of the page. Tab capture, the offscreen document, the
service worker's state machine and `chrome.commands` are all stubbed. A green
run here means the flows drive a Salesloft-shaped DOM correctly; it is not a
substitute for the manual pass in `CLAUDE.md` against the live app.
