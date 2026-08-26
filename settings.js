// Settings popup — reads/writes chrome.storage.sync.
// The background worker reacts to floatingPanel changes (opens/closes the window);
// the content scripts react to the rest live. Defaults live in defaults.js.

const DEFAULTS = SL_DEFAULTS;

const els = {
  floatingPanel: document.getElementById('floatingPanel'),
  pageOverlay: document.getElementById('pageOverlay'),
  disposition: document.getElementById('disposition'),
  alertsEnabled: document.getElementById('alertsEnabled'),
  alertTags: document.getElementById('alertTags'),
  alertStrict: document.getElementById('alertStrict'),
  swatches: document.getElementById('swatches'),
  shortcuts: document.getElementById('shortcuts'),
  saved: document.getElementById('saved'),
};

chrome.storage.sync.get(DEFAULTS, (s) => {
  els.floatingPanel.checked = s.floatingPanel;
  els.pageOverlay.checked = s.pageOverlay;
  els.disposition.value = s.disposition;
  els.alertsEnabled.checked = s.alertsEnabled;
  els.alertStrict.checked = s.alertStrict;
  els.alertTags.value = slParseTags(s.alertTags).join(', ');
  paintSwatches();
});

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

els.alertsEnabled.addEventListener('change', () => {
  chrome.storage.sync.set({ alertsEnabled: els.alertsEnabled.checked }, flashSaved);
});

els.alertStrict.addEventListener('change', () => {
  chrome.storage.sync.set({ alertStrict: els.alertStrict.checked }, flashSaved);
});

els.alertTags.addEventListener('input', paintSwatches);

els.alertTags.addEventListener('change', () => {
  const tags = slParseTags(els.alertTags.value);
  const value = tags.length ? tags : DEFAULTS.alertTags;
  els.alertTags.value = value.join(', ');
  paintSwatches();
  chrome.storage.sync.set({ alertTags: value }, flashSaved);
});

els.shortcuts.addEventListener('click', () => {
  chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
});
