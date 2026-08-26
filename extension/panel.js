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
};

// ------------------------------------------------------------ dialer actions
function send(action) {
  chrome.runtime.sendMessage({ type: 'dialer-action', action }).catch(() => {
    setStatus('Background not reachable — reload extension', 'err');
  });
}

document.getElementById('kill').addEventListener('click', () => send('kill-and-log'));
document.getElementById('call').addEventListener('click', () => send('start-call'));

function setStatus(msg, kind) {
  els.status.textContent = msg;
  els.status.className = kind || '';
}

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

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

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
  return view.entries.map((e) => `[${formatClock(e.start)}] ${e.text}`).join('\n');
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

els.save.addEventListener('click', () => {
  if (!view.entries.length) { setStatus('Nothing to save'); return; }
  // Text only, never audio, and the filename carries no prospect details.
  const blob = new Blob([transcriptAsText()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  link.href = url;
  link.download = `transcript_${stamp}.txt`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Transcript saved', 'ok');
});

els.clear.addEventListener('click', () => {
  view.entries = [];
  els.transcript.innerHTML = '<div id="empty">Cleared.</div>';
  view.autoScroll = true;
  els.scrollHint.classList.remove('on');
});

// ------------------------------------------------------- contact alerts
// Mirrored from the Salesloft page, colour-coded the same way: blue for a
// booked meeting, red for a hard no, green for interest.
const alertEl = document.getElementById('alert');

function renderAlert({ tags = [], name = '', color = 'amber' }) {
  if (!tags.length) {
    alertEl.className = '';
    alertEl.textContent = '';
    return;
  }
  const theme = SL_PALETTE[color] || SL_PALETTE.amber;
  alertEl.style.background = theme.bg;
  alertEl.style.borderColor = theme.border;
  alertEl.textContent = '';

  const who = document.createElement('div');
  who.className = 'who';
  who.style.color = theme.text;
  who.textContent = name ? `${name} — ${SL_HEADLINE[color]}` : SL_HEADLINE[color];

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

  alertEl.appendChild(who);
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
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.transcription) {
    els.transcription.classList.toggle('on', !!changes.transcription.newValue);
  }
});
