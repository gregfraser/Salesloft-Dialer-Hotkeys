// Shared settings defaults.
//
// Loaded as a plain script by every context (content script via the manifest,
// service worker via importScripts, panel and settings via a <script> tag), so
// there is exactly one definition of what a fresh install looks like.

(function (root) {
  'use strict';

  const DEFAULTS = {
    // -- dialer (existing behaviour) --
    floatingPanel: false,
    pageOverlay: true,
    disposition: 'No Answer',

    // -- transcription --
    // The master switch is the only choice: with it on, transcription always
    // starts when a call is detected. Saving is never automatic — a cadence is
    // dozens of dials and a file per dial is noise — so the transcript (text
    // only, never audio) is written only when the rep asks for it.
    transcription: false,          // master switch, off until opted into
    // Empty means the system default output device. See docs/troubleshooting.md:
    // if the rep's headset is not the Windows default, passthrough plays the
    // call somewhere they cannot hear it.
    outputDeviceId: '',
    serverUrl: 'ws://127.0.0.1:8765/transcribe',
    healthUrl: 'http://127.0.0.1:8765/health',

    // -- contact alerts --
    alertsEnabled: true,
    alertTags: ['No Interest', 'Meeting Scheduled', 'Interested'],
    alertStrict: true,

    // -- key bindings --
    // The keys the rep picked for the two dialer actions. See the section
    // below for why the extension keeps its own bindings at all, and why an
    // empty string (no key) is a normal value.
    hotkeys: { 'kill-and-log': 'F8', 'start-call': 'F9' },
  };

  root.SL_DEFAULTS = DEFAULTS;

  // ---------------- Contact alert colours ----------------
  // What colour each tag gets. Anything unrecognised falls back to amber.
  const TAG_COLORS = {
    'meeting scheduled': 'blue',
    'interested': 'green',
    'no interest': 'red',
    'not interested': 'red',
    'do not contact': 'red',
  };

  root.slColorFor = function (tag) {
    return TAG_COLORS[String(tag || '').replace(/\s+/g, ' ').trim().toLowerCase()] || 'amber';
  };

  // When several tags are on the page at once, this decides the alert's own
  // colour: a booked meeting outranks everything, then a hard no, then interest.
  // Each tag still keeps its own colour on its chip.
  const PRIORITY = ['blue', 'red', 'green', 'amber'];

  root.slTopColor = function (tags) {
    const present = new Set((tags || []).map(root.slColorFor));
    return PRIORITY.find((c) => present.has(c)) || 'amber';
  };

  // Palette for the overlay's alert line and the floating panel. Tuned for the
  // dark surfaces both already use.
  root.SL_PALETTE = {
    red:   { bg: '#3a1d1a', border: '#c0392b', text: '#ffb4a8' },
    blue:  { bg: '#17263a', border: '#2f6fd0', text: '#a8ccff' },
    green: { bg: '#1b3326', border: '#1e7e46', text: '#a8e6b8' },
    amber: { bg: '#3a3320', border: '#b8860b', text: '#ffd88a' },
  };

  // There is deliberately no headline to go with these. The alert shows the
  // tag Salesloft already put on the contact — "No Interest" — and the colour
  // carries the rest. Anything added in front of it either repeats the tag
  // ("Meeting already scheduled — Meeting Scheduled") or tells the rep what to
  // do, which is their call and not this extension's.

  // ---------------- Transcript formatting ----------------
  // Shared by the floating panel and the on-page transcript pane so a line
  // reads the same in both, and a saved file does not depend on which one
  // happened to write it.
  root.slFormatClock = function (seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = String(Math.floor(total / 60)).padStart(2, '0');
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  };

  // A running transcript can span several calls. `newCall` on an entry marks
  // where the next one began, so the text keeps the boundary the on-screen
  // divider shows. Entries without it (the floating panel's) format unchanged.
  root.slTranscriptText = function (entries) {
    const lines = [];
    for (const entry of entries || []) {
      if (entry.newCall && lines.length) lines.push('', '--- next call ---', '');
      lines.push(`[${root.slFormatClock(entry.start)}] ${entry.text}`);
    }
    return lines.join('\n');
  };

  // transcript_2026-08-27T14-32-05.txt — a timestamp and nothing else. The
  // filename never carries the prospect's name.
  root.slTranscriptFilename = function (now) {
    const stamp = (now || new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `transcript_${stamp}.txt`;
  };

  // "No Interest, Meeting Scheduled" -> ['No Interest', 'Meeting Scheduled'].
  // Accepts an array too, so it can also sanitise whatever is in storage.
  root.slParseTags = function (value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(',');
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const tag = String(raw).replace(/\s+/g, ' ').trim();
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
    return out;
  };

  // ---------------- Key bindings ----------------
  // Two layers, because Chrome only offers one of them.
  //
  // chrome://extensions/shortcuts is the only way to fire an action from
  // another tab, and its picker takes a Ctrl or Alt combination and nothing
  // else — no number pad, and it silently leaves a command unassigned when the
  // suggested key is already taken. A rep working a cadence has one hand on the
  // pad, so the extension also keeps its own bindings for the two dialer
  // actions and listens for them itself, in the Salesloft page and the floating
  // panel. Those two are the only places a key event reaches this extension, so
  // the layers sit side by side: the rep's own key where the work happens,
  // Chrome's where it has to cross a tab.
  //
  // A binding is `e.code` — the physical key — not `e.key`. The pad's 1 and the
  // 1 above the letters are different keys to a hand on the pad but both are
  // '1' to `key`, and with Num Lock off `key` reads 'End'. Storing the code is
  // what makes a number pad binding survive Num Lock either way.
  //
  // Empty is a normal value: a rep who only wants the number pad clears the
  // other key, and every surface that prints a keycap prints nothing for it.
  const HOTKEY_ACTIONS = ['kill-and-log', 'start-call'];

  root.SL_HOTKEY_ACTIONS = HOTKEY_ACTIONS;

  // Held down while another key is pressed, so they can never be a binding on
  // their own. A recorder keeps listening rather than treating one as an answer.
  const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

  // Never bound: Escape cancels a recording, and Tab is how the settings popup
  // is navigated without a mouse.
  root.SL_RESERVED_KEYS = ['Escape', 'Tab'];

  root.slHotkeyFromEvent = function (e) {
    if (!e || !e.code || MODIFIER_CODE.test(e.code)) return null;
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    parts.push(e.code);
    return parts.join('+');
  };

  // Both sides canonical, so matching is a string compare and a binding cannot
  // half-match (Shift+F8 never fires a plain F8).
  root.slHotkeyMatches = function (binding, e) {
    return !!binding && root.slHotkeyFromEvent(e) === binding;
  };

  // ---------------- Key binding labels ----------------
  // Two forms of the same name. `compact` is for the keycaps on the buttons,
  // where two of them share a 210px column and "Ctrl+Shift+9" does not fit;
  // the full form is for the settings popup, where "Num 1" reads better than
  // "Num1". Both take either an own binding ('Ctrl+Shift+Numpad1') or the
  // string chrome.commands hands back ('Ctrl+Shift+9'), since they are the same
  // shape: modifiers first, key last.
  const MODIFIER_NAMES = {
    ctrl: 'Ctrl', control: 'Ctrl', macctrl: 'Ctrl',
    alt: 'Alt', option: 'Alt',
    shift: 'Shift',
    meta: 'Meta', command: 'Meta', cmd: 'Meta', search: 'Meta',
  };
  const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  const MODIFIER_LABELS = {
    Ctrl:  ['Ctrl', 'Ctrl'],
    Alt:   ['Alt', 'Alt'],
    Shift: ['Shift', '⇧'],
    Meta:  ['Cmd', '⌘'],
  };

  // What is printed on the key itself, where the code does not already say it.
  const KEY_LABELS = {
    ArrowUp: ['↑', '↑'], ArrowDown: ['↓', '↓'], ArrowLeft: ['←', '←'], ArrowRight: ['→', '→'],
    PageUp: ['Page Up', 'PgUp'], PageDown: ['Page Down', 'PgDn'],
    Insert: ['Insert', 'Ins'], Delete: ['Delete', 'Del'],
    Backspace: ['Backspace', 'Bksp'], Space: ['Space', 'Space'],
    CapsLock: ['Caps Lock', 'Caps'], NumLock: ['Num Lock', 'NumLk'],
    ScrollLock: ['Scroll Lock', 'ScrLk'], PrintScreen: ['Print Screen', 'PrtSc'],
    ContextMenu: ['Menu', 'Menu'],
  };

  // The glyph on the key, not the word for it: a rep looking down at the pad
  // sees + and *, not "Add" and "Multiply".
  const NUMPAD_KEYS = {
    NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/',
    NumpadDecimal: '.', NumpadComma: ',', NumpadEqual: '=', NumpadEnter: 'Enter',
  };

  const PUNCTUATION = {
    Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
    IntlBackslash: '\\', Semicolon: ';', Quote: "'", Backquote: '`',
    Comma: ',', Period: '.', Slash: '/',
  };

  function keyLabel(code, compact) {
    const i = compact ? 1 : 0;
    if (KEY_LABELS[code]) return KEY_LABELS[code][i];
    if (NUMPAD_KEYS[code]) return (compact ? 'Num' : 'Num ') + NUMPAD_KEYS[code];
    if (PUNCTUATION[code]) return PUNCTUATION[code];
    let match = /^Numpad(\d)$/.exec(code);
    if (match) return (compact ? 'Num' : 'Num ') + match[1];
    match = /^(?:Key|Digit)(.)$/.exec(code);
    if (match) return match[1];
    // F-keys, and whatever else a keyboard reports — including the bare '9' or
    // 'Y' Chrome gives back for its own shortcuts. Runs of words read better
    // spaced out, where there is room for it.
    return compact ? code : code.replace(/([a-z])([A-Z])/g, '$1 $2');
  }

  root.slHotkeyLabel = function (binding, compact) {
    const parts = String(binding == null ? '' : binding).split('+').filter(Boolean);
    if (!parts.length) return '';
    const key = parts.pop();
    const modifiers = [];
    for (const part of parts) {
      const name = MODIFIER_NAMES[part.toLowerCase()];
      if (name && modifiers.indexOf(name) === -1) modifiers.push(name);
    }
    modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
    const shown = modifiers.map((m) => MODIFIER_LABELS[m][compact ? 1 : 0]);
    // Compact runs them together (Ctrl⇧9); the full form spells the joins out.
    return compact ? shown.join('') + keyLabel(key, true)
                   : shown.concat(keyLabel(key, false)).join('+');
  };

  // Whatever is in storage, reduced to one binding per action. Anything the
  // settings popup never wrote — a hand-edited value, a half-object synced from
  // an older install — resolves to no key rather than to a wrong one.
  root.slNormalizeHotkeys = function (value) {
    const out = {};
    const taken = new Set();
    for (const action of HOTKEY_ACTIONS) {
      const binding = value && typeof value[action] === 'string' ? value[action].trim() : '';
      // One key, one action. Sharing would run both flows off a single press;
      // the busy flag swallows the second, so the rep would see a key that
      // sometimes does the other thing.
      out[action] = binding && !taken.has(binding) ? binding : '';
      if (out[action]) taken.add(out[action]);
    }
    return out;
  };

  // ---------------- Which pages the on-page controls belong on ----------------
  // The buttons dial one person, so they only make sense where one person is on
  // screen: a contact's own page, not the dashboard, a cadence, the People list
  // or analytics. Salesloft is a single-page app, so the content script is
  // injected once and this is re-checked on every navigation instead.
  //
  // Matched on the route rather than the DOM. A contact's page is
  // /app/people/{id} — older builds nest it as /app/people/details/{id} — while
  // the list itself is /app/people with nothing after it. So: a section that
  // names people, followed by something that looks like one record.
  const CONTACT_SECTIONS = ['people', 'person', 'contact', 'contacts', 'prospect', 'prospects'];

  // Segments that follow the section but are still a listing rather than a
  // record. Without these, /app/people/search would read as a contact.
  const NOT_A_RECORD = [
    'list', 'lists', 'search', 'filter', 'filters', 'import', 'imports',
    'all', 'new', 'bulk', 'tags', 'segments',
  ];

  root.slIsContactUrl = function (url) {
    let parsed;
    try {
      parsed = new URL(String(url == null ? '' : url), 'https://app.salesloft.com');
    } catch (e) {
      return false;
    }
    // Some Salesloft routes live in the fragment (#/people/123); treat that as
    // part of the path so both styles resolve the same way.
    const hash = parsed.hash.startsWith('#/') ? parsed.hash.slice(1) : '';
    const parts = (parsed.pathname + hash).split('/').filter(Boolean).map((p) => p.toLowerCase());

    const section = parts.findIndex((p) => CONTACT_SECTIONS.indexOf(p) !== -1);
    if (section < 0) return false;
    return parts.slice(section + 1).some((p) => NOT_A_RECORD.indexOf(p) === -1);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULTS,
      slFormatClock: root.slFormatClock,
      slTranscriptText: root.slTranscriptText,
      slTranscriptFilename: root.slTranscriptFilename,
      slParseTags: root.slParseTags,
      slIsContactUrl: root.slIsContactUrl,
      slHotkeyFromEvent: root.slHotkeyFromEvent,
      slHotkeyMatches: root.slHotkeyMatches,
      slHotkeyLabel: root.slHotkeyLabel,
      slNormalizeHotkeys: root.slNormalizeHotkeys,
      SL_HOTKEY_ACTIONS: root.SL_HOTKEY_ACTIONS,
      SL_RESERVED_KEYS: root.SL_RESERVED_KEYS,
      slColorFor: root.slColorFor,
      slTopColor: root.slTopColor,
      SL_PALETTE: root.SL_PALETTE,
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
