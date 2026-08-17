// Settings popup — reads/writes chrome.storage.sync.
// The background worker reacts to floatingPanel changes (opens/closes the window);
// the content script reacts to pageOverlay and disposition changes live.

const DEFAULTS = { floatingPanel: false, pageOverlay: true, disposition: 'No Answer' };

const els = {
  floatingPanel: document.getElementById('floatingPanel'),
  pageOverlay: document.getElementById('pageOverlay'),
  disposition: document.getElementById('disposition'),
  shortcuts: document.getElementById('shortcuts'),
  saved: document.getElementById('saved'),
};

chrome.storage.sync.get(DEFAULTS, (s) => {
  els.floatingPanel.checked = s.floatingPanel;
  els.pageOverlay.checked = s.pageOverlay;
  els.disposition.value = s.disposition;
});

let savedTimer;
function flashSaved() {
  els.saved.style.opacity = '1';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (els.saved.style.opacity = '0'), 1200);
}

els.floatingPanel.addEventListener('change', () => {
  chrome.storage.sync.set({ floatingPanel: els.floatingPanel.checked }, flashSaved);
});

els.pageOverlay.addEventListener('change', () => {
  chrome.storage.sync.set({ pageOverlay: els.pageOverlay.checked }, flashSaved);
});

els.disposition.addEventListener('change', () => {
  const value = els.disposition.value.trim() || DEFAULTS.disposition;
  els.disposition.value = value;
  chrome.storage.sync.set({ disposition: value }, flashSaved);
});

els.shortcuts.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
