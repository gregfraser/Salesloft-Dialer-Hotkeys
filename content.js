// Salesloft Dialer Hotkeys — content script
// Executes the dialer flows inside the Salesloft page. Receives actions from the
// background worker, optionally renders on-page buttons, and reports status back.

(function () {
  'use strict';
  if (window.__slHotkeysLoaded) return;
  window.__slHotkeysLoaded = true;

  // ---------------- Settings (live-synced) ----------------
  const settings = { floatingPanel: false, pageOverlay: true, disposition: 'No Answer' };

  chrome.storage.sync.get(settings, (stored) => {
    Object.assign(settings, stored);
    if (settings.pageOverlay) buildOverlay();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.disposition) settings.disposition = changes.disposition.newValue;
    if (changes.pageOverlay) {
      settings.pageOverlay = changes.pageOverlay.newValue;
      settings.pageOverlay ? buildOverlay() : removeOverlay();
    }
  });

  const CONFIG = { keyKill: 'F8', keyCall: 'F9', stepTimeout: 8000, autoAdvanceDelayMs: 400 };

  // ---------------- DOM helpers ----------------
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;

  const loggerRoot = () =>
    document.querySelector('[data-testid="popout-logger-container"]') || document;

  function buttonByText(text, root = document) {
    const t = text.toLowerCase();
    return [...root.querySelectorAll('button')].find(
      (b) => visible(b) && b.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === t
    );
  }

  function waitFor(fn, timeout = CONFIG.stepTimeout, interval = 100) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let result;
        try { result = fn(); } catch (e) { /* keep polling */ }
        if (result) return resolve(result);
        if (Date.now() - start > timeout) return reject(new Error('Timed out waiting for element'));
        setTimeout(tick, interval);
      };
      tick();
    });
  }

  function realClick(el) {
    const opts = { bubbles: true, cancelable: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---------------- Disposition (Downshift combobox) ----------------
  function findDispositionToggle() {
    const root = loggerRoot();
    const toggles = [...root.querySelectorAll('[id$="toggle-button"], [aria-haspopup="listbox"]')];
    return (
      toggles.find((t) => (t.closest('div')?.parentElement?.textContent || '').includes('Disposition')) ||
      toggles[0] ||
      null
    );
  }

  async function setDisposition(value) {
    const toggle = await waitFor(() => {
      const t = findDispositionToggle();
      return t && t.offsetParent !== null ? t : null;
    });
    realClick(toggle);

    const option = await waitFor(() => {
      const items = [...document.querySelectorAll('[role="option"], [role="listbox"] li, ul li')];
      return items.find(
        (li) => li.offsetParent !== null && li.textContent.trim().toLowerCase() === value.toLowerCase()
      );
    });
    realClick(option);
  }

  // ---------------- Core flows ----------------
  let busy = false;

  async function killAndLog() {
    if (busy) return;
    busy = true;
    try {
      const endBtn = buttonByText('End Call');
      if (endBtn) {
        setStatus('Ending call…');
        realClick(endBtn);
        await sleep(CONFIG.autoAdvanceDelayMs);
      }

      setStatus(`Setting "${settings.disposition}"…`);
      await setDisposition(settings.disposition);
      await sleep(CONFIG.autoAdvanceDelayMs);

      setStatus('Logging & completing…');
      const logBtn = await waitFor(() => buttonByText('Log & Complete', loggerRoot()));
      realClick(logBtn);

      setStatus(`Logged ${settings.disposition} ✓ — ready for next call`, 'ok');
    } catch (err) {
      setStatus(`Stopped: ${err.message}. Finish manually.`, 'err');
    } finally {
      busy = false;
    }
  }

  async function startCall() {
    if (busy) return;
    busy = true;
    try {
      const callBtn = await waitFor(() => buttonByText('Call'));
      realClick(callBtn);
      setStatus('Dialing…', 'ok');
    } catch (err) {
      setStatus('No Call button found — is the dialer open?', 'err');
    } finally {
      busy = false;
    }
  }

  // ---------------- Messages from background ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'dialer-action') {
      if (msg.action === 'kill-and-log') killAndLog();
      if (msg.action === 'start-call') startCall();
    }
    sendResponse({ ok: true });
  });

  // ---------------- Status (on-page + broadcast to floating panel) ----------------
  let statusEl;

  function setStatus(msg, kind) {
    if (statusEl) {
      statusEl.textContent = msg;
      statusEl.style.color = kind === 'err' ? '#ffb4a8' : kind === 'ok' ? '#a8e6b8' : '#e8e6e1';
    }
    chrome.runtime.sendMessage({ type: 'status', msg, kind }).catch(() => {});
  }

  // ---------------- Optional on-page overlay ----------------
  function removeOverlay() {
    document.getElementById('sl-hotkey-overlay')?.remove();
    statusEl = null;
  }

  function buildOverlay() {
    if (document.getElementById('sl-hotkey-overlay') || !document.body) return;
    const box = document.createElement('div');
    box.id = 'sl-hotkey-overlay';
    box.style.cssText = [
      'position:fixed', 'bottom:16px', 'left:16px', 'z-index:999999',
      'display:flex', 'flex-direction:column', 'gap:6px',
      'background:#1c1e21', 'border:1px solid #3a3d42', 'border-radius:10px',
      'padding:10px', 'font-family:system-ui,sans-serif', 'font-size:12px',
      'box-shadow:0 4px 16px rgba(0,0,0,.35)', 'user-select:none',
    ].join(';');

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;';

    const mkBtn = (label, sub, bg, onClick) => {
      const b = document.createElement('button');
      b.innerHTML = `<div style="font-weight:600;font-size:13px;">${label}</div><div style="opacity:.75;font-size:10px;margin-top:2px;">${sub}</div>`;
      b.style.cssText = `flex:1;padding:10px 14px;border:none;border-radius:8px;cursor:pointer;color:#fff;background:${bg};text-align:center;line-height:1.2;`;
      b.addEventListener('click', onClick);
      return b;
    };

    row.appendChild(mkBtn('✕ No Answer', `${CONFIG.keyKill} / Ctrl⇧9`, '#c0392b', killAndLog));
    row.appendChild(mkBtn('▶ Call', `${CONFIG.keyCall} / Ctrl⇧0`, '#1e7e46', startCall));

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'min-height:14px;color:#e8e6e1;';
    statusEl.textContent = 'Ready';

    box.appendChild(row);
    box.appendChild(statusEl);
    document.body.appendChild(box);
  }

  // ---------------- In-page fallback hotkeys (F8/F9) ----------------
  function isTyping() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      if (isTyping()) return;
      if (e.key === CONFIG.keyKill) { e.preventDefault(); killAndLog(); }
      if (e.key === CONFIG.keyCall) { e.preventDefault(); startCall(); }
    },
    true
  );
})();
