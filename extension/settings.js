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
  alertsEnabled: document.getElementById('alertsEnabled'),
  alertTags: document.getElementById('alertTags'),
  alertStrict: document.getElementById('alertStrict'),
  swatches: document.getElementById('swatches'),
  transcription: document.getElementById('transcription'),
  autoStartTranscription: document.getElementById('autoStartTranscription'),
  saveTranscripts: document.getElementById('saveTranscripts'),
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
  els.alertsEnabled.checked = settings.alertsEnabled;
  els.alertStrict.checked = settings.alertStrict;
  els.alertTags.value = slParseTags(settings.alertTags).join(', ');
  paintSwatches();
  els.transcription.checked = settings.transcription;
  els.autoStartTranscription.checked = settings.autoStartTranscription;
  els.saveTranscripts.checked = settings.saveTranscripts;
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

els.autoStartTranscription.addEventListener('change', () => {
  persist('autoStartTranscription', els.autoStartTranscription.checked);
});

els.saveTranscripts.addEventListener('change', () => {
  persist('saveTranscripts', els.saveTranscripts.checked);
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
