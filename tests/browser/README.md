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
node behaviour.mjs              # the transcript pane and the not-armed state
node regress.mjs                # the two dialer flows, where the plate shows, the compact bar
```

Both print one line per check and exit non-zero on a failure. Set
`CHROMIUM_PATH` if Playwright cannot find its own browser.

## What `mock.html` is

A stand-in for the parts of Salesloft these flows touch: the logger popout, the
Downshift disposition combobox and the "Log & Complete" button. It is built from **structure and
accessible names only** — never a generated `styled-components` class — which
is the same rule `content.js` follows, so a test passing here means the
selectors are anchored to something Salesloft is unlikely to move.

`window.__buildSalesloft(opts)` rebuilds it. **Every option on it exists
because it caught a real bug** that `node --test` and a screenshot both missed,
which is the only reason to add another: `inCall`, `dispositions`,
`dispositionSticks`, `dispositionPreset`, `decoys`, `decoyTexts`, `listPage`
and `downshiftMenu`.

The ones worth knowing about:

- `decoys` fills the activity feed with list items whose **entire text is the
  disposition being looked for**, which is what a contact logged "No Answer"
  a dozen times really looks like. A page-wide `ul li` search clicked
  one of those instead of the dropdown option, and the call logged with the
  field still empty. Against the code that shipped, this prints
  `DECOY CLICKED`.
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
