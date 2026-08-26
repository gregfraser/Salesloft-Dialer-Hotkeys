// Salesloft Dialer Hotkeys — background service worker
// Responsibilities:
//  1. Relay keyboard commands (Ctrl+Shift+9/0) to the Salesloft tab from anywhere.
//  2. Open/close the floating control panel window based on the setting.
//  3. Broadcast status updates from the content script to the panel.
//  4. Own the transcription state machine, capture arming and the offscreen
//     document that holds the audio graph.

importScripts('defaults.js');

const DEFAULTS = self.SL_DEFAULTS;
const PANEL = { url: 'panel.html', width: 320, height: 190 };
const PANEL_WITH_TRANSCRIPT = { width: 380, height: 520 };
const SALESLOFT_URL = 'https://app.salesloft.com/*';
const SALESLOFT_ORIGIN = 'https://app.salesloft.com/';
const OFFSCREEN_URL = 'offscreen.html';

// PR-9 states. DEGRADED is first-class: the call proceeds normally with
// transcription unavailable, which always beats interfering with a live call.
const STATE = {
  IDLE: 'IDLE',
  STARTING: 'STARTING',
  TRANSCRIBING: 'TRANSCRIBING',
  DEGRADED: 'DEGRADED',
  FINALIZING: 'FINALIZING',
};

let transcriptionState = STATE.IDLE;
let offscreenPromise = null;

async function getSettings() {
  return chrome.storage.sync.get(DEFAULTS);
}

// ---- Panel window management (id kept in session storage; survives worker sleep) ----
async function getPanelId() {
  const { panelWindowId } = await chrome.storage.session.get('panelWindowId');
  return panelWindowId ?? null;
}

async function openPanel() {
  const existing = await getPanelId();
  if (existing !== null) {
    try {
      await chrome.windows.update(existing, { focused: true });
      return;
    } catch (e) { /* window was closed manually — fall through and recreate */ }
  }
  const { transcription } = await getSettings();
  const size = transcription ? PANEL_WITH_TRANSCRIPT : PANEL;
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PANEL.url),
    type: 'popup',
    width: size.width,
    height: size.height,
    focused: false,
  });
  await chrome.storage.session.set({ panelWindowId: win.id });
}

async function closePanel() {
  const id = await getPanelId();
  if (id !== null) {
    try { await chrome.windows.remove(id); } catch (e) { /* already closed */ }
    await chrome.storage.session.remove('panelWindowId');
  }
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  const id = await getPanelId();
  if (windowId === id) await chrome.storage.session.remove('panelWindowId');
});

// React to settings being toggled from the settings popup.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'sync') return;
  if (changes.floatingPanel) {
    changes.floatingPanel.newValue ? openPanel() : closePanel();
  }
  if (changes.transcription && changes.transcription.newValue === false) {
    await stopTranscription('Transcription turned off');
  }
  // Keep the offscreen document's copy of the settings current.
  const settings = await getSettings();
  sendToOffscreen({ type: 'settings', settings });
});

// Reopen the panel on browser startup if the setting is on.
chrome.runtime.onStartup.addListener(async () => {
  const { floatingPanel } = await getSettings();
  if (floatingPanel) openPanel();
});

// ---- Relay actions to the Salesloft tab ----
async function findSalesloftTab() {
  const tabs = await chrome.tabs.query({ url: SALESLOFT_URL });
  if (!tabs.length) return null;
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
}

async function sendToSalesloft(action) {
  const target = await findSalesloftTab();
  if (!target) {
    broadcastStatus('No Salesloft tab open', 'err');
    return;
  }
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'dialer-action', action });
  } catch (e) {
    // Content script missing (tab predates install) — inject and retry once.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: target.id },
        files: ['defaults.js', 'call-detect.js', 'content.js'],
      });
      await chrome.tabs.sendMessage(target.id, { type: 'dialer-action', action });
    } catch (e2) {
      broadcastStatus('Could not reach Salesloft tab — refresh it once', 'err');
    }
  }
}

function broadcastStatus(msg, kind) {
  chrome.runtime.sendMessage({ type: 'status', msg, kind }).catch(() => {});
}

function reportTranscription(state, detail) {
  chrome.runtime
    .sendMessage({ type: 'transcription-status', state, detail: detail || '' })
    .catch(() => {});
}

// ---- Capture arming -------------------------------------------------------
// Chrome will not hand out a tab capture stream unless the extension was
// invoked on that tab. A keyboard command counts, but only for the tab that was
// active when it fired -- so pressing Ctrl+Shift+0 from LinkedIn arms LinkedIn,
// not Salesloft. Clicks on the in-page overlay and the panel are page and
// extension-page events, not invocations, so they cannot arm anything.
//
// Consequence: the rep must invoke the extension once while the Salesloft tab
// is in front. After that the stream persists across tab switches for the whole
// call, so the "trigger from any tab" workflow still works.
async function armTab(tabId) {
  if (typeof tabId !== 'number') return;
  await chrome.storage.session.set({ armedTabId: tabId, armedAt: Date.now() });
}

async function getArmedTabId() {
  const { armedTabId } = await chrome.storage.session.get('armedTabId');
  return typeof armedTabId === 'number' ? armedTabId : null;
}

function isSalesloftTab(tab) {
  return !!(tab && typeof tab.url === 'string' && tab.url.startsWith(SALESLOFT_ORIGIN));
}

// ---- Offscreen document ---------------------------------------------------
async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (offscreenPromise) return offscreenPromise;
  offscreenPromise = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['USER_MEDIA'],
      justification: 'Capture tab audio for live call transcription.',
    })
    .catch((err) => {
      // A concurrent create is the usual cause and is harmless.
      if (!String(err).includes('Only a single offscreen')) throw err;
    })
    .finally(() => { offscreenPromise = null; });
  return offscreenPromise;
}

async function closeOffscreen() {
  if (await hasOffscreen()) {
    try { await chrome.offscreen.closeDocument(); } catch (e) { /* already gone */ }
  }
}

function sendToOffscreen(message) {
  chrome.runtime.sendMessage(Object.assign({ target: 'offscreen' }, message)).catch(() => {});
}

// ---- Transcription lifecycle ---------------------------------------------
function setTranscriptionState(next) {
  transcriptionState = next;
  chrome.storage.session.set({ transcriptionState: next }).catch(() => {});
}

async function startTranscription(preferredTabId) {
  const settings = await getSettings();
  if (!settings.transcription) return;
  if (transcriptionState === STATE.TRANSCRIBING || transcriptionState === STATE.STARTING) return;

  const tab = (await findSalesloftTab()) || null;
  const armedTabId = await getArmedTabId();
  const tabId = preferredTabId ?? armedTabId ?? (tab && tab.id);
  if (typeof tabId !== 'number') {
    setTranscriptionState(STATE.DEGRADED);
    reportTranscription('error', 'No Salesloft tab to capture');
    return;
  }

  setTranscriptionState(STATE.STARTING);
  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (err) {
    // Almost always "extension has not been invoked for this tab".
    setTranscriptionState(STATE.DEGRADED);
    reportTranscription(
      'error',
      'Transcription not armed — press Ctrl+Shift+8 with the Salesloft tab in front'
    );
    console.warn('[transcriber] getMediaStreamId failed', err);
    return;
  }

  await ensureOffscreen();
  sendToOffscreen({ type: 'start-capture', streamId, settings });
  setTranscriptionState(STATE.TRANSCRIBING);
  reportTranscription('ready', 'Transcription starting');
}

async function stopTranscription(detail) {
  if (transcriptionState === STATE.IDLE) return;
  setTranscriptionState(STATE.FINALIZING);
  sendToOffscreen({ type: 'call-end' });
  sendToOffscreen({ type: 'stop-capture' });
  // Give the server a moment to flush the queue before the document goes away.
  setTimeout(async () => {
    // A new call can start inside this window (back-to-back dials are the
    // whole point of a cadence). If one did, leave its capture alone.
    if (transcriptionState !== STATE.FINALIZING) return;
    await closeOffscreen();
    setTranscriptionState(STATE.IDLE);
    reportTranscription('offline', detail || 'Transcription stopped');
  }, 1500);
}

async function onCallStateChange(callState, tabId) {
  const settings = await getSettings();
  if (!settings.transcription) return;

  if (callState === 'IN_CALL') {
    if (!settings.autoStartTranscription) return;
    const callId = crypto.randomUUID();
    await startTranscription(tabId);
    if (transcriptionState === STATE.TRANSCRIBING) {
      sendToOffscreen({ type: 'call-start', callId });
    }
  } else if (callState === 'IDLE') {
    if (transcriptionState === STATE.TRANSCRIBING || transcriptionState === STATE.DEGRADED) {
      await stopTranscription('Call ended');
    }
  }
}

// Keyboard commands (work from any tab; set to Global in chrome://extensions/shortcuts
// to fire even when Chrome isn't focused).
chrome.commands.onCommand.addListener(async (command, tab) => {
  // Any command fired while Salesloft is in front is a valid extension
  // invocation for that tab, which is what makes capture legal to start.
  if (isSalesloftTab(tab)) await armTab(tab.id);

  if (command === 'kill-and-log' || command === 'start-call') {
    sendToSalesloft(command);
    return;
  }

  if (command === 'toggle-transcription') {
    const settings = await getSettings();
    if (!settings.transcription) {
      reportTranscription('error', 'Turn transcription on in settings first');
      return;
    }
    if (transcriptionState === STATE.TRANSCRIBING || transcriptionState === STATE.STARTING) {
      await stopTranscription('Transcription stopped');
    } else {
      await startTranscription(isSalesloftTab(tab) ? tab.id : undefined);
      const callId = crypto.randomUUID();
      if (transcriptionState === STATE.TRANSCRIBING) {
        sendToOffscreen({ type: 'call-start', callId });
      }
    }
  }
});

// Messages from the panel, settings, content script and offscreen document.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  if (msg.type === 'dialer-action') sendToSalesloft(msg.action);
  if (msg.type === 'status') broadcastStatus(msg.msg, msg.kind); // forward content → panel

  // The content script observes Salesloft's DOM and reports transitions. It
  // never touches audio, and this path never clicks anything.
  if (msg.type === 'call-state') {
    onCallStateChange(msg.state, sender && sender.tab && sender.tab.id);
  }

  // Arming from the toolbar popup, which is also an extension invocation.
  if (msg.type === 'arm-transcription') {
    (async () => {
      const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (isSalesloftTab(active)) await armTab(active.id);
    })();
  }

  if (msg.type === 'transcription-command') {
    if (msg.action === 'start') startTranscription();
    if (msg.action === 'stop') stopTranscription('Transcription stopped');
    if (msg.action === 'pause') sendToOffscreen({ type: 'set-paused', paused: !!msg.paused });
  }

  // Status from the offscreen document. The panel receives these directly, so
  // they are observed here rather than re-broadcast (which would double lines).
  if (msg.type === 'transcription-status' && !msg.target) {
    if (msg.state === 'degraded' && transcriptionState === STATE.TRANSCRIBING) {
      setTranscriptionState(STATE.DEGRADED);
    } else if (msg.state === 'ready' && transcriptionState === STATE.DEGRADED) {
      setTranscriptionState(STATE.TRANSCRIBING);
    }
  }

  sendResponse({ ok: true });
  return false;
});
