// Salesloft Dialer Hotkeys — contact alerts
// Watches the Salesloft page for Disposition / Sentiment tags that mean "don't
// just dial this person" (No Interest, Meeting Scheduled, Interested). This
// script only detects: the alert itself renders in the floating panel and as a
// subtle line inside the on-page button overlay — never as its own popup over
// the Salesloft UI.
//
// Runs as a content script alongside content.js and shares its isolated world:
// content.js reads window.__slContactAlert and registers
// window.__slOnContactAlert to repaint its overlay's alert line.

(function () {
  'use strict';
  if (window.__slContactAlertsLoaded) return;
  window.__slContactAlertsLoaded = true;

  const D = (self.SL_DEFAULTS || {});
  const settings = {
    alertsEnabled: D.alertsEnabled !== false,
    alertTags: D.alertTags || ['No Interest', 'Meeting Scheduled', 'Interested'],
    alertStrict: D.alertStrict !== false,
  };

  const OVERLAY_ID = 'sl-hotkey-overlay';
  const RESCAN_DEBOUNCE_MS = 600;
  const POLL_MS = 3000;      // safety net for re-renders the observer sleeps through
  const MAX_CANDIDATES = 500; // cap the work done on very long activity feeds

  // Never treat text inside these as an existing tag on the contact: they are
  // either our own UI, or the disposition dropdown the rep is filling in now.
  const EXCLUDE = [
    `#${OVERLAY_ID}`,
    '[data-testid="popout-logger-container"]',
    '[role="listbox"]',
    '[role="option"]',
    '[aria-haspopup="listbox"]',
    'select',
    'option',
  ].join(',');

  // No word boundary: Salesloft stacks <p>Sentiment</p><p>Interested</p>, and
  // adjacent element text concatenates with no whitespace between it.
  const LABEL_RE = /(sentiment|disposition)/i;
  const EXACT_LABEL_RE = /^(sentiment|disposition)\s*:?$/i;
  const CONTEXT_DEPTH = 6;      // ancestors to search for a "Disposition"/"Sentiment" label
  const CONTEXT_MAX_TEXT = 300; // …but only ones small enough for the label to be attached

  // A logged call's tags show up in the activity feed as bare pills with no
  // label anywhere near them — that is where they actually live, so being in an
  // activity row counts as context on its own.
  const ACTIVITY_ROW = [
    '[class*="activity__"]',
    '[class*="ActivityItem"]',
    '[class*="ActivityTitle"]',
    '[class*="ActivityInitialContent"]',
    '[class*="ActivityExpandedContent"]',
  ].join(',');

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const titled = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

  // ---------------- State ----------------
  // Declared up front: the settings callback below can fire synchronously and
  // reaches scheduleScan().
  let scanTimer = null;
  let lastSignature = null;  // the matches currently on screen
  let lastContact = null;    // which contact those matches belong to

  function scheduleScan(delay = RESCAN_DEBOUNCE_MS) {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      try { apply(); } catch (e) { /* never let a bad scan break the page */ }
    }, delay);
  }

  // ---------------- Settings (live-synced) ----------------
  chrome.storage.sync.get(settings, (stored) => {
    Object.assign(settings, stored);
    settings.alertTags = self.slParseTags(settings.alertTags);
    scheduleScan(0);
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    let touched = false;
    for (const key of Object.keys(settings)) {
      if (changes[key]) { settings[key] = changes[key].newValue; touched = true; }
    }
    if (!touched) return;
    settings.alertTags = self.slParseTags(settings.alertTags);
    lastSignature = null;  // changing what we watch for should re-raise anything live
    scheduleScan(0);
  });

  // ---------------- Scanning ----------------
  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    return getComputedStyle(el).visibility !== 'hidden';
  }

  // Salesloft renders a labelled field as two stacked elements — <p>Sentiment</p>
  // followed by <p>Interested</p> — so read the label off the preceding sibling.
  function labelFromSibling(el) {
    for (let node = el, depth = 0; node && depth < 2; depth++, node = node.parentElement) {
      const hit = norm(node.previousElementSibling?.textContent).match(EXACT_LABEL_RE);
      if (hit) return titled(hit[1]);
    }
    return null;
  }

  // In an activity table the label is the column header, which can sit well
  // outside the ancestor walk below. Match the cell to its header by index.
  function columnLabel(el) {
    const cell = el.closest('td, th');
    const table = cell && cell.closest('table');
    if (!table) return null;
    const index = [...cell.parentElement.children].indexOf(cell);
    const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
    const hit = norm(headerRow && headerRow.children[index]?.textContent).match(LABEL_RE);
    return hit ? titled(hit[1]) : null;
  }

  // Decide whether this really is a tag on the contact rather than incidental
  // text. Returns null for no context, otherwise { field } — where field names
  // the Disposition/Sentiment column it came from, or is null for an activity
  // pill, which Salesloft renders with no label at all.
  function contextFor(el) {
    const sibling = labelFromSibling(el);
    if (sibling) return { field: sibling };

    const column = columnLabel(el);
    if (column) return { field: column };

    let node = el;
    for (let depth = 0; node && depth < CONTEXT_DEPTH; depth++, node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;

      const attrs = [
        node.getAttribute('data-testid'),
        node.getAttribute('aria-label'),
        node.id,
        typeof node.className === 'string' ? node.className : '',
      ].join(' ');
      const attrHit = attrs.match(LABEL_RE);
      if (attrHit) return { field: titled(attrHit[1]) };

      // Only trust a text label from a container small enough that it plausibly
      // belongs to this value — otherwise a "Disposition" heading three sections
      // away would claim every tag on the page.
      const text = norm(node.textContent);
      if (text.length > CONTEXT_MAX_TEXT) break;
      const textHit = text.match(LABEL_RE);
      if (textHit) return { field: titled(textHit[1]) };
    }

    return el.closest(ACTIVITY_ROW) ? { field: null } : null;
  }

  // Highlighter extensions wrap matched words in a custom element, which both
  // splits the text node and hides the real value. Climb past those — a standard
  // HTML tag name never contains a hyphen.
  function valueElement(node) {
    let el = node.parentElement;
    while (el && el.tagName.includes('-')) el = el.parentElement;
    return el;
  }

  function scan() {
    if (!settings.alertsEnabled || !document.body) return [];
    const wanted = new Map(settings.alertTags.map((t) => [t.toLowerCase(), t]));
    if (!wanted.size) return [];

    // The filter runs against every text node on the page, so reject on a cheap
    // length check before paying for whitespace normalisation.
    const keys = [...wanted.keys()];
    let maxLen = 0;
    for (const t of keys) maxLen = Math.max(maxLen, t.length);

    // Accept a fragment of a tag as well as a whole one: a highlighter extension
    // can split "Meeting Scheduled" across two text nodes. This only nominates a
    // candidate — the element-level check below is what decides a match.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const raw = node.nodeValue;
        if (!raw || raw.length < 3 || raw.length > maxLen + 16) return NodeFilter.FILTER_REJECT;
        const text = norm(raw).toLowerCase();
        if (!text) return NodeFilter.FILTER_REJECT;
        return wanted.has(text) || keys.some((k) => k.includes(text))
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });

    const found = new Map();
    const checked = new Set();
    let node;
    let seen = 0;
    while ((node = walker.nextNode()) && seen++ < MAX_CANDIDATES) {
      const el = valueElement(node);
      if (!el || checked.has(el)) continue;
      checked.add(el);

      // The element must be the tag and nothing else. This is what keeps a call
      // note reading "Interested but doesn't work with…" from counting.
      const key = norm(el.textContent).toLowerCase();
      if (!wanted.has(key)) continue;
      if (el.closest(EXCLUDE)) continue;
      if (!isVisible(el)) continue;

      const context = contextFor(el);
      if (!context && settings.alertStrict) continue;
      if (found.has(key) && found.get(key).field !== 'Tag') continue; // keep the labelled hit

      found.set(key, { tag: wanted.get(key), field: (context && context.field) || 'Tag' });
    }
    return [...found.values()];
  }

  // ---------------- Which contact are we looking at? ----------------
  function contactName() {
    const selectors = [
      '[data-testid="person-details-name"]',
      '[data-testid*="person-name" i]',
      '[data-testid*="personName" i]',
      'h1',
      'h2',
    ];
    for (const sel of selectors) {
      let el;
      try { el = document.querySelector(sel); } catch (e) { continue; }
      const text = norm(el && el.textContent);
      if (!text || text.length > 60) continue;
      // The page heading is a breadcrumb ("People / Peter Nidever") — keep the leaf.
      const leaf = text.split('/').pop().trim();
      return leaf || text;
    }
    return '';
  }

  const contactKey = () => `${location.pathname}${location.search}|${contactName()}`;

  const signatureOf = (matches) =>
    matches.map((m) => `${m.field}|${m.tag}`).sort().join(' • ');

  function apply() {
    const contact = contactKey();
    if (contact !== lastContact) {
      lastContact = contact;
      lastSignature = null;
    }

    const matches = scan();
    const signature = signatureOf(matches);
    if (signature === lastSignature) return;
    lastSignature = signature;

    const name = contactName();
    const tags = matches.map((m) => m.tag);
    const color = self.slTopColor(tags);

    window.__slContactAlert = matches.length ? { matches, tags, name, color } : null;
    notifyOverlay();

    if (!matches.length) {
      report({ tags: [] });
      return;
    }
    report({ tags, name, color });
  }

  // Repaint the subtle alert line inside content.js's button overlay. Same
  // isolated world, so this is a direct call — no messaging, no popup over
  // the Salesloft UI.
  function notifyOverlay() {
    try {
      if (typeof window.__slOnContactAlert === 'function') {
        window.__slOnContactAlert(window.__slContactAlert);
      }
    } catch (e) { /* overlay disabled or not built yet */ }
  }

  // Mirror the alert into the floating panel, which sits in its own window and
  // can't see this page.
  function report(payload) {
    try {
      chrome.runtime.sendMessage(Object.assign({ type: 'contact-alert' }, payload)).catch(() => {});
    } catch (e) { /* extension context reloaded — the panel will catch up */ }
  }

  // ---------------- Rescan triggers ----------------
  const observer = new MutationObserver((records) => {
    // Ignore mutations inside the button overlay — the alert line and status
    // text we (and content.js) write there must not retrigger the scan.
    for (const r of records) {
      const target = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      if (target && target.closest && target.closest(`#${OVERLAY_ID}`)) continue;
      return scheduleScan();
    }
  });

  function startObserving() {
    if (!document.body) return setTimeout(startObserving, 200);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    scheduleScan(0);
  }

  startObserving();
  setInterval(() => scheduleScan(0), POLL_MS);

  // Let the settings popup / panel ask for a re-check on demand.
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === 'rescan-alerts') {
      lastSignature = null;
      scheduleScan(0);
    }
    sendResponse({ ok: true });
  });
})();
