// Settings popup — reads/writes chrome.storage.sync.
// The background worker reacts to floatingPanel and transcription changes; the
// content script reacts to pageOverlay and disposition changes live. Nothing
// here sends messages about a setting except the capture arming below.

'use strict';

const DEFAULTS = self.SL_DEFAULTS;

const els = {
  floatingPanel: document.getElementById('floatingPanel'),
  pageOverlay: document.getElementById('pageOverlay'),
  disposition: document.getElementById('disposition'),
  keybindNote: document.getElementById('keybind-note'),
  chromeShortcuts: document.getElementById('chrome-shortcuts'),
  alertsEnabled: document.getElementById('alertsEnabled'),
  alertTags: document.getElementById('alertTags'),
  alertStrict: document.getElementById('alertStrict'),
  swatches: document.getElementById('swatches'),
  transcription: document.getElementById('transcription'),
  outputDeviceId: document.getElementById('outputDeviceId'),
  transcriptionGroup: document.getElementById('transcription-group'),
  serverState: document.getElementById('server-state'),
  shortcuts: document.getElementById('shortcuts'),
  testServer: document.getElementById('test-server'),
  saved: document.getElementById('saved'),
};

chrome.storage.sync.get(DEFAULTS, (settings) => {
  els.floatingPanel.checked = settings.floatingPanel;
  els.pageOverlay.checked = settings.pageOverlay;
  els.disposition.value = settings.disposition;
  applyHotkeys(settings.hotkeys);
  els.alertsEnabled.checked = settings.alertsEnabled;
  els.alertStrict.checked = settings.alertStrict;
  els.alertTags.value = slParseTags(settings.alertTags).join(', ');
  paintSwatches();
  els.transcription.checked = settings.transcription;
  populateOutputDevices(settings.outputDeviceId);
  syncTranscriptionGroup();
});

let savedTimer;
function flashSaved() {
  els.saved.style.opacity = '1';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (els.saved.style.opacity = '0'), 1200);
}

function persist(key, value) {
  chrome.storage.sync.set({ [key]: value }, flashSaved);
}

// Preview of the colour each watched tag will get on the page.
function paintSwatches() {
  els.swatches.textContent = '';
  for (const tag of slParseTags(els.alertTags.value)) {
    const theme = SL_PALETTE[slColorFor(tag)] || SL_PALETTE.amber;
    const chip = document.createElement('span');
    chip.className = 'swatch';
    chip.textContent = tag;
    chip.style.background = theme.bg;
    chip.style.borderColor = theme.border;
    chip.style.color = theme.text;
    els.swatches.appendChild(chip);
  }
}

function syncTranscriptionGroup() {
  els.transcriptionGroup.classList.toggle('disabled-group', !els.transcription.checked);
}

// ------------------------------------------------------------- key bindings
// Chrome's shortcut page is the only way to fire an action from another tab,
// and its picker takes a Ctrl or Alt combination and nothing else — no number
// pad, which is the one place a rep working a cadence keeps a hand. So the
// extension records its own bindings here and listens for them itself, in the
// Salesloft page and the floating panel. Both are read back onto the buttons,
// so what a button says is what actually fires it.
let hotkeys = slNormalizeHotkeys(DEFAULTS.hotkeys);
let recording = null; // the action waiting for a key, or null

const ACTION_NAMES = { 'kill-and-log': 'End call & log', 'start-call': 'Start the next call' };

const keyButtons = [...document.querySelectorAll('button.key')];

function note(text) {
  els.keybindNote.textContent = text || '';
}

function applyHotkeys(stored) {
  hotkeys = slNormalizeHotkeys(stored);
  renderHotkeys();
}

function renderHotkeys() {
  for (const button of keyButtons) {
    const action = button.dataset.record;
    if (recording === action) {
      button.textContent = 'Press a key…';
      button.title = 'Press the key you want, or Esc to leave it alone';
      button.classList.add('recording');
      button.classList.remove('unset');
      continue;
    }
    const label = slHotkeyLabel(hotkeys[action], false);
    button.textContent = label || 'Not set';
    button.title = label ? `${label} — click to change` : 'Click, then press a key';
    button.classList.remove('recording');
    button.classList.toggle('unset', !label);
  }
}

// A bare letter or digit is a perfectly good binding — the page ignores every
// binding while the rep is typing in a field — but Salesloft has single-key
// shortcuts of its own, so it is worth saying once rather than refusing.
function bindingNote(binding) {
  const bare = binding.indexOf('+') === -1;
  if (bare && (/^(?:Key|Digit)./.test(binding) || binding === 'Space' || binding === 'Enter')) {
    return 'Saved. A bare letter or digit can collide with Salesloft’s own shortcuts.';
  }
  return 'Saved.';
}

function setHotkeys(next) {
  hotkeys = slNormalizeHotkeys(next);
  renderHotkeys();
  persist('hotkeys', hotkeys);
}

function onRecordKey(e) {
  // Nothing typed here reaches the popup: a recording field swallows the key
  // it is there to capture, Tab included.
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return; // a key held down from before, not a fresh press
  const pressed = slHotkeyFromEvent(e);
  if (!pressed) return; // a modifier on its own — keep waiting for the key
  const action = recording;
  stopRecording();
  if (e.code === 'Escape') { note('Left unchanged.'); return; }
  if (SL_RESERVED_KEYS.indexOf(e.code) !== -1) {
    note('Esc and Tab stay as they are — they cancel and move between fields.');
    return;
  }
  // One key, one action. Reassigning takes it from whatever had it, which is
  // what the rep meant, and the other row goes to "Not set" where they can see
  // it rather than silently losing the press.
  const taken = SL_HOTKEY_ACTIONS.find((a) => a !== action && hotkeys[a] === pressed);
  const next = Object.assign({}, hotkeys, { [action]: pressed });
  if (taken) next[taken] = '';
  setHotkeys(next);
  note(taken ? `Taken from “${ACTION_NAMES[taken]}”, which now has no key.` : bindingNote(pressed));
}

function startRecording(action) {
  recording = action;
  note('');
  renderHotkeys();
  // Capture phase on the window: the popup's own buttons must not act on the
  // key being recorded.
  window.addEventListener('keydown', onRecordKey, true);
}

function stopRecording() {
  if (!recording) return;
  recording = null;
  window.removeEventListener('keydown', onRecordKey, true);
  renderHotkeys();
}

for (const button of keyButtons) {
  button.addEventListener('click', () => startRecording(button.dataset.record));
  // Clicking away is a cancel, not a binding left half-recorded.
  button.addEventListener('blur', stopRecording);
}

for (const button of document.querySelectorAll('button.key-clear')) {
  button.addEventListener('click', () => {
    const action = button.dataset.clear;
    if (!hotkeys[action]) { note(`“${ACTION_NAMES[action]}” already has no key.`); return; }
    setHotkeys(Object.assign({}, hotkeys, { [action]: '' }));
    note(`Cleared. “${ACTION_NAMES[action]}” now only answers its button and Chrome’s shortcut.`);
  });
}

// What Chrome actually has, not what the manifest suggested: a suggested key
// that collided with something already installed is simply not assigned, and
// the rep can reassign any of them. Reading it back is the difference between
// this list and the one that sent them here.
chrome.commands.getAll().then((commands) => {
  els.chromeShortcuts.textContent = '';
  for (const command of commands) {
    // _execute_action is the toolbar button, not one of ours.
    if (command.name.startsWith('_')) continue;
    const item = document.createElement('li');
    item.textContent = `${command.description || command.name} — `;
    const key = document.createElement('span');
    if (command.shortcut) {
      key.textContent = slHotkeyLabel(command.shortcut, false);
    } else {
      key.textContent = 'not set';
      key.className = 'unset';
    }
    item.appendChild(key);
    els.chromeShortcuts.appendChild(item);
  }
}).catch(() => { /* the notice above still explains the two layers */ });

// ------------------------------------------------------------------ toggles
els.floatingPanel.addEventListener('change', () => {
  persist('floatingPanel', els.floatingPanel.checked);
});

els.pageOverlay.addEventListener('change', () => {
  persist('pageOverlay', els.pageOverlay.checked);
});

els.disposition.addEventListener('change', () => {
  const value = els.disposition.value.trim() || DEFAULTS.disposition;
  els.disposition.value = value;
  persist('disposition', value);
});

els.alertsEnabled.addEventListener('change', () => {
  persist('alertsEnabled', els.alertsEnabled.checked);
});

els.alertStrict.addEventListener('change', () => {
  persist('alertStrict', els.alertStrict.checked);
});

els.alertTags.addEventListener('input', paintSwatches);

els.alertTags.addEventListener('change', () => {
  const tags = slParseTags(els.alertTags.value);
  const value = tags.length ? tags : DEFAULTS.alertTags;
  els.alertTags.value = value.join(', ');
  paintSwatches();
  persist('alertTags', value);
});

els.transcription.addEventListener('change', () => {
  persist('transcription', els.transcription.checked);
  syncTranscriptionGroup();
  if (els.transcription.checked) {
    // Opening this popup is an extension invocation for the active tab, so if
    // that tab is Salesloft this is a chance to arm capture without the rep
    // needing to know the rule. Ctrl+Shift+8 remains the reliable path.
    chrome.runtime.sendMessage({ type: 'arm-transcription' }).catch(() => {});
    checkServer();
  }
});

els.outputDeviceId.addEventListener('change', () => {
  persist('outputDeviceId', els.outputDeviceId.value);
});

// ----------------------------------------------------------- output devices
async function populateOutputDevices(selected) {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter((device) => device.kind === 'audiooutput');
    for (const device of outputs) {
      if (!device.deviceId || device.deviceId === 'default') continue;
      const option = document.createElement('option');
      option.value = device.deviceId;
      // Labels are blank until the browser has been granted device access at
      // least once; the id still works, it is just not readable.
      option.textContent = device.label || `Output device ${els.outputDeviceId.length}`;
      els.outputDeviceId.appendChild(option);
    }
  } catch (err) {
    // Enumeration is a convenience. Falling back to the system default is
    // always valid, and troubleshooting.md covers the manual route.
  }
  els.outputDeviceId.value = selected || '';
}

// ------------------------------------------------------------ server health
async function checkServer() {
  els.serverState.textContent = 'Checking server…';
  els.serverState.className = '';
  try {
    const settings = await chrome.storage.sync.get(DEFAULTS);
    const response = await fetch(settings.healthUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    els.serverState.textContent = `Server ready — ${body.model} (${body.compute_type})`;
    els.serverState.className = 'ok';
  } catch (err) {
    els.serverState.textContent = 'Server not reachable — start it with start-server.ps1';
    els.serverState.className = 'err';
  }
}

els.testServer.addEventListener('click', checkServer);

els.shortcuts.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
