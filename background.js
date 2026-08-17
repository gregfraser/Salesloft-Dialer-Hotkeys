// Salesloft Dialer Hotkeys — background service worker
// Responsibilities:
//  1. Relay keyboard commands (Ctrl+Shift+9/0) to the Salesloft tab from anywhere.
//  2. Open/close the floating control panel window based on the setting.
//  3. Broadcast status updates from the content script to the panel.

const PANEL = { url: 'panel.html', width: 280, height: 170 };

// ---- Settings defaults ----
const DEFAULTS = { floatingPanel: false, pageOverlay: true, disposition: 'No Answer' };

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
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL(PANEL.url),
    type: 'popup',
    width: PANEL.width,
    height: PANEL.height,
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

// React to the setting being toggled from the settings popup.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'sync' && changes.floatingPanel) {
    changes.floatingPanel.newValue ? openPanel() : closePanel();
  }
});

// Reopen the panel on browser startup if the setting is on.
chrome.runtime.onStartup.addListener(async () => {
  const { floatingPanel } = await getSettings();
  if (floatingPanel) openPanel();
});

// ---- Relay actions to the Salesloft tab ----
async function sendToSalesloft(action) {
  const tabs = await chrome.tabs.query({ url: 'https://app.salesloft.com/*' });
  if (!tabs.length) {
    broadcastStatus('No Salesloft tab open', 'err');
    return;
  }
  const target = tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'dialer-action', action });
  } catch (e) {
    // Content script missing (tab predates install) — inject and retry once.
    try {
      await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ['content.js'] });
      await chrome.tabs.sendMessage(target.id, { type: 'dialer-action', action });
    } catch (e2) {
      broadcastStatus('Could not reach Salesloft tab — refresh it once', 'err');
    }
  }
}

function broadcastStatus(msg, kind) {
  chrome.runtime.sendMessage({ type: 'status', msg, kind }).catch(() => {});
}

// Keyboard commands (work from any tab; set to Global in chrome://extensions/shortcuts
// to fire even when Chrome isn't focused).
chrome.commands.onCommand.addListener((command) => {
  if (command === 'kill-and-log' || command === 'start-call') sendToSalesloft(command);
});

// Messages from the panel and settings pages.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'dialer-action') sendToSalesloft(msg.action);
  if (msg.type === 'status') broadcastStatus(msg.msg, msg.kind); // forward content → panel
  sendResponse({ ok: true });
});
