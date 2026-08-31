// Floating panel — dialer buttons relay through the background worker to the
// Salesloft tab; transcript lines and status stream in from the offscreen
// document and content script.
//
// Nothing here ever steals focus: no alert(), no modal, no .focus() call. New
// text appearing must never pull attention away from a live conversation.

'use strict';

const els = {
  status: document.getElementById('status'),
  transcription: document.getElementById('transcription'),
  indicator: document.getElementById('indicator'),
  connection: document.getElementById('connection'),
  timer: document.getElementById('timer'),
  pause: document.getElementById('pause'),
  copy: document.getElementById('copy'),
  save: document.getElementById('save'),
  clear: document.getElementById('clear'),
  transcript: document.getElementById('transcript'),
  scrollHint: document.getElementById('scroll-hint'),
};

const view = {
  entries: [],
  autoScroll: true,
  paused: false,
  callStart: null,
  timerHandle: null,
  unsaved: false, // lines added since the last save — drives the call-end offer
};

// ------------------------------------------------------------ dialer actions
function send(action) {
  chrome.runtime.sendMessage({ type: 'dialer-action', action }).catch(() => {
    setStatus('Background not reachable — reload extension', 'err');
  });
}

const actionButtons = [...document.querySelectorAll('.row button[data-action]')];
for (const button of actionButtons) {
  button.addEventListener('click', () => send(button.dataset.action));
}

// Anything the panel has to say replaces the opening line, so the opening line
// is only rewritten while it is still the opening line.
let statusPristine = true;

function setStatus(msg, kind) {
  statusPristine = false;
  els.status.textContent = msg;
  els.status.className = kind || '';
}

// ------------------------------------------------------------- key bindings
// The panel is a window of its own, so a key pressed here never reaches the
// Salesloft page — which is why it answers the rep's bindings itself. Left
// focused on a second monitor, it dials from the number pad like the page does.
let hotkeys = self.slNormalizeHotkeys(self.SL_DEFAULTS.hotkeys);
// Chrome's own shortcut per command, read back rather than assumed: a
// suggested key that collided with another extension is simply not assigned.
let commandKeys = {};

function renderKeys() {
  for (const button of actionButtons) {
    const action = button.dataset.action;
    // The rep's own binding reaches this window and the Salesloft page;
    // Chrome's reaches any tab. Either can be missing, and binding the key
    // Chrome already has makes them the same key said twice.
    const own = self.slHotkeyLabel(hotkeys[action], false);
    const anywhere = self.slHotkeyLabel(commandKeys[action], false);
    const keys = [own, anywhere].filter((key, i, all) => key && all.indexOf(key) === i);
    button.querySelector('.sub').textContent = keys.join('  ·  ') || 'Not bound';

    const said = [];
    if (own) said.push(`${own} here and on the Salesloft page`);
    if (anywhere && anywhere !== own) said.push(`${anywhere} from any tab`);
    button.title = said.join(', ') || 'No key bound — set one in the extension settings';
  }
  // True only while Chrome has a shortcut of its own: the rep's bindings need
  // this window or the Salesloft page to have focus.
  if (statusPristine) {
    const fromAnywhere = actionButtons.some((b) => commandKeys[b.dataset.action]);
    els.status.textContent = fromAnywhere ? 'Ready — shortcuts work from anywhere' : 'Ready';
  }
}

document.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  const pressed = self.slHotkeyFromEvent(e);
  if (!pressed) return;
  for (const action of self.SL_HOTKEY_ACTIONS) {
    if (pressed === hotkeys[action]) {
      e.preventDefault();
      send(action);
      return;
    }
  }
});

// -------------------------------------------------------------- transcription
function setConnection(state, detail) {
  const labels = {
    ready: 'LIVE',
    busy: 'LIVE',
    degraded: 'BEHIND',
    error: 'ERROR',
    offline: 'OFFLINE',
  };
  const dotClass = {
    ready: 'live',
    busy: 'live',
    degraded: 'degraded',
    error: 'offline',
    offline: 'offline',
  };
  els.connection.textContent = labels[state] || 'OFFLINE';
  els.indicator.className = 'dot ' + (dotClass[state] || 'offline');
  if (detail) setStatus(detail, state === 'error' ? 'err' : undefined);
}

// Shared with the on-page transcript so a line reads the same in both.
const formatClock = self.slFormatClock;

function startTimer() {
  if (view.timerHandle) return;
  view.callStart = Date.now();
  view.timerHandle = setInterval(() => {
    els.timer.textContent = formatClock((Date.now() - view.callStart) / 1000);
  }, 1000);
  els.timer.textContent = '00:00';
}

function stopTimer() {
  clearInterval(view.timerHandle);
  view.timerHandle = null;
}

function addEntry(payload) {
  const empty = document.getElementById('empty');
  if (empty) empty.remove();

  const entry = document.createElement('div');
  entry.className = 'entry' + (payload.merged > 1 ? ' merged' : '');

  const time = document.createElement('div');
  time.className = 'entry-time';
  time.textContent = formatClock(payload.start || 0);
  if (payload.merged > 1) {
    time.title = 'Coalesced under load — timestamps approximate';
  }

  const text = document.createElement('div');
  text.className = 'entry-text';
  text.textContent = payload.text;

  entry.appendChild(time);
  entry.appendChild(text);
  els.transcript.appendChild(entry);
  view.entries.push({ start: payload.start || 0, text: payload.text });
  view.unsaved = true;

  if (view.autoScroll) {
    els.transcript.scrollTop = els.transcript.scrollHeight;
    els.scrollHint.classList.remove('on');
  } else {
    // Scroll-lock: the rep is reading back something earlier, so do not yank
    // the view away from them.
    els.scrollHint.classList.add('on');
  }
}

els.transcript.addEventListener('scroll', () => {
  const distanceFromBottom =
    els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight;
  view.autoScroll = distanceFromBottom < 24;
  if (view.autoScroll) els.scrollHint.classList.remove('on');
});

els.scrollHint.addEventListener('click', () => {
  view.autoScroll = true;
  els.transcript.scrollTop = els.transcript.scrollHeight;
  els.scrollHint.classList.remove('on');
});

// ------------------------------------------------------------------- controls
els.pause.addEventListener('click', () => {
  view.paused = !view.paused;
  els.pause.setAttribute('aria-pressed', String(view.paused));
  els.pause.textContent = view.paused ? '▶' : '⏸';
  els.pause.title = view.paused ? 'Resume transcription' : 'Pause transcription';
  chrome.runtime
    .sendMessage({ type: 'transcription-command', action: 'pause', paused: view.paused })
    .catch(() => {});
  setStatus(view.paused ? 'Transcription paused' : 'Transcription resumed');
});

function transcriptAsText() {
  return self.slTranscriptText(view.entries);
}

els.copy.addEventListener('click', async () => {
  if (!view.entries.length) { setStatus('Nothing to copy'); return; }
  const text = transcriptAsText();
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`Copied ${view.entries.length} lines`, 'ok');
  } catch (err) {
    // Clipboard API needs focus and can refuse; fall back rather than fail.
    const scratch = document.createElement('textarea');
    scratch.value = text;
    document.body.appendChild(scratch);
    scratch.select();
    document.execCommand('copy');
    scratch.remove();
    setStatus(`Copied ${view.entries.length} lines`, 'ok');
  }
});

function saveTranscript() {
  // Text only, never audio, and the filename carries no prospect details.
  const blob = new Blob([transcriptAsText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = self.slTranscriptFilename();
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  view.unsaved = false;
  clearSaveOffer();
  setStatus('Transcript saved', 'ok');
}

els.save.addEventListener('click', () => {
  if (!view.entries.length) { setStatus('Nothing to save'); return; }
  saveTranscript();
});

// Quiet, and quiet is the point: a line in the status the rep already reads,
// plus a highlight on the button that acts on it. No modal, no focus steal.
function offerSave() {
  if (!view.unsaved || !view.entries.length) return;
  setStatus(`Transcript ready (${view.entries.length} lines) — ↓ to save`, 'warn');
  els.save.classList.add('nudge');
}

function clearSaveOffer() {
  els.save.classList.remove('nudge');
}

els.clear.addEventListener('click', () => {
  view.entries = [];
  view.unsaved = false;
  clearSaveOffer();
  els.transcript.innerHTML = '<div id="empty">Cleared.</div>';
  view.autoScroll = true;
  els.scrollHint.classList.remove('on');
});

// ------------------------------------------------------- contact alerts
// Mirrored from the Salesloft page, colour-coded the same way: blue for a
// booked meeting, red for a hard no, green for interest.
const alertEl = document.getElementById('alert');

function renderAlert({ tags = [], color = 'amber' }) {
  if (!tags.length) {
    alertEl.className = '';
    alertEl.textContent = '';
    return;
  }
  const theme = SL_PALETTE[color] || SL_PALETTE.amber;
  alertEl.style.background = theme.bg;
  alertEl.style.borderColor = theme.border;
  alertEl.textContent = '';

  // The tags and nothing else: whoever is on screen is already named on the
  // page the rep is looking at, and the colour says how much this matters.
  const list = document.createElement('div');
  list.className = 'tags';
  for (const tag of tags) {
    const tagTheme = SL_PALETTE[slColorFor(tag)] || SL_PALETTE.amber;
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = tag;
    chip.style.background = tagTheme.bg;
    chip.style.borderColor = tagTheme.border;
    chip.style.color = tagTheme.text;
    list.appendChild(chip);
  }

  alertEl.appendChild(list);
  alertEl.className = 'show';
}

// ------------------------------------------------------------------ messages
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.target === 'offscreen') return;

  if (msg.type === 'status') setStatus(msg.msg, msg.kind);

  if (msg.type === 'contact-alert') renderAlert(msg);

  if (msg.type === 'transcript' && msg.payload) addEntry(msg.payload);

  if (msg.type === 'transcription-status') setConnection(msg.state, msg.detail);

  // Pause is one state shared with the on-page transcript; the worker echoes
  // whichever one the rep clicked so both show what capture is really doing.
  if (msg.type === 'transcription-paused') {
    view.paused = !!msg.paused;
    els.pause.setAttribute('aria-pressed', String(view.paused));
    els.pause.textContent = view.paused ? '▶' : '⏸';
    els.pause.title = view.paused ? 'Resume transcription' : 'Pause transcription';
  }

  // The call ended with lines nobody has saved. Nothing downloads on its own —
  // a cadence is dozens of dials and almost none of them are worth a file — so
  // this only points at the button. The worker sends it once the server has
  // flushed, so what the rep saves includes the call's last utterance.
  if (msg.type === 'transcript-unsaved') offerSave();

  if (msg.type === 'call-state') {
    if (msg.state === 'IN_CALL') {
      startTimer();
      const empty = document.getElementById('empty');
      if (empty) empty.textContent = 'Listening…';
    } else {
      stopTimer();
    }
  }
});

// ------------------------------------------------------------------- startup
chrome.storage.sync.get(self.SL_DEFAULTS, (settings) => {
  // The panel stays fully usable with transcription off — the pane is simply
  // not there.
  els.transcription.classList.toggle('on', !!settings.transcription);
  hotkeys = self.slNormalizeHotkeys(settings.hotkeys);
  renderKeys();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.transcription) {
    els.transcription.classList.toggle('on', !!changes.transcription.newValue);
  }
  if (changes.hotkeys) {
    hotkeys = self.slNormalizeHotkeys(changes.hotkeys.newValue);
    renderKeys();
  }
});

// This is an extension page, so it can ask Chrome directly. The buttons render
// with whatever is known and repaint when the answer arrives.
chrome.commands
  .getAll()
  .then((commands) => {
    for (const command of commands) commandKeys[command.name] = command.shortcut || '';
    renderKeys();
  })
  .catch(() => { /* keep whatever the rep's own bindings say */ });

renderKeys();
