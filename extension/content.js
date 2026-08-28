// Salesloft Dialer Hotkeys — content script
// Executes the dialer flows inside the Salesloft page. Receives actions from the
// background worker, optionally renders on-page buttons, and reports status back.

(function () {
  'use strict';
  if (window.__slHotkeysLoaded) return;
  window.__slHotkeysLoaded = true;

  // ---------------- Settings (live-synced) ----------------
  const settings = Object.assign({}, window.SL_DEFAULTS);
  // Nothing is drawn until storage has answered: the page re-renders within
  // milliseconds of injection, and a rep who turned the overlay off should not
  // see it flash up first.
  let settingsReady = false;

  chrome.storage.sync.get(settings, (stored) => {
    Object.assign(settings, stored);
    settingsReady = true;
    syncOverlay();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.disposition) settings.disposition = changes.disposition.newValue;
    if (changes.pageOverlay) {
      settings.pageOverlay = changes.pageOverlay.newValue;
      syncOverlay();
    }
    // Turning transcription on or off adds or removes the transcript pane, so
    // the overlay is rebuilt. Lines already on screen are carried across.
    if (changes.transcription) {
      settings.transcription = changes.transcription.newValue;
      syncOverlay(true);
    }
  });

  const CONFIG = { keyKill: 'F8', keyCall: 'F9', stepTimeout: 8000, autoAdvanceDelayMs: 400 };

  // Reloading or updating the extension invalidates this script's context:
  // chrome.runtime becomes undefined, but the script (and its overlay) live on
  // in the page. The dialer flows are pure DOM automation and still work, so a
  // dead message channel must degrade to "no status broadcast", never to a
  // thrown error that aborts the flow mid-call.
  function safeSend(message) {
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage(message).catch(() => {});
      }
    } catch (e) { /* context invalidated — on-page status still updates */ }
  }

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

  // A flow is serialized: while one runs, hotkeys and clicks are ignored. The
  // buttons say so rather than sitting there looking live and doing nothing —
  // dimming only, no layout change and nothing that steals focus mid-call.
  function setBusy(value) {
    busy = value;
    if (overlayEl) overlayEl.classList.toggle('sl-busy', value);
  }

  async function killAndLog() {
    if (busy) return;
    setBusy(true);
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
      setBusy(false);
    }
  }

  async function startCall() {
    if (busy) return;
    setBusy(true);
    try {
      const callBtn = await waitFor(() => buttonByText('Call'));
      realClick(callBtn);
      // alerts.js shares this isolated world; repeat its warning here so it's
      // visible in the floating panel too.
      const alert = window.__slContactAlert;
      if (alert) setStatus(`Dialing… ⚠ ${alert.tags.join(' • ')}`, 'warn');
      else setStatus('Dialing…', 'ok');
    } catch (err) {
      setStatus('No Call button found — is the dialer open?', 'err');
    } finally {
      setBusy(false);
    }
  }

  // ---------------- Messages from background ----------------
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === 'dialer-action') {
      if (msg.action === 'kill-and-log') killAndLog();
      if (msg.action === 'start-call') startCall();
    }

    // Transcription traffic, relayed by the background worker: content scripts
    // do not receive the offscreen document's broadcasts directly.
    if (msg.type === 'transcript' && msg.payload) addTranscriptEntry(msg.payload);
    if (msg.type === 'transcription-status') {
      setTranscriptConnection(msg.state);
      // Only errors are worth taking the status line for — "not armed" is the
      // one the rep has to act on. Written straight to the element rather than
      // through setStatus(), because the panel already has this message from
      // the worker and would otherwise show it twice.
      if (msg.state === 'error' && msg.detail && statusEl) {
        statusEl.textContent = msg.detail;
        statusEl.style.color = '#ffb4a8';
      }
    }
    if (msg.type === 'transcription-paused') {
      txView.paused = !!msg.paused;
      renderPaused();
    }
    // The call ended with lines nobody has saved. Offer it in the status line;
    // never grab a download the rep did not ask for.
    if (msg.type === 'transcript-unsaved') offerSave();

    sendResponse({ ok: true });
  });

  // ---------------- Status (on-page + broadcast to floating panel) ----------------
  let statusEl;

  function setStatus(msg, kind) {
    if (statusEl) {
      statusEl.textContent = msg;
      // The element shows at most two lines (see FOOT_HEIGHT); the tooltip is
      // where the whole of a long "Stopped: …" stays readable.
      statusEl.title = msg;
      statusEl.style.color =
        kind === 'err' ? '#ffb4a8' : kind === 'warn' ? '#ffd88a' : kind === 'ok' ? '#a8e6b8' : '#e8e6e1';
    }
    safeSend({ type: 'status', msg, kind });
  }

  // ---------------- Optional on-page overlay ----------------
  const OVERLAY_ID = 'sl-hotkey-overlay';
  const CONTROLS_WIDTH = 240;    // the button column, unchanged whatever else is shown
  const TRANSCRIPT_WIDTH = 300;
  const TRANSCRIPT_HEIGHT = 152; // the scrolling list itself
  const TRANSCRIPT_BAR = 28;     // its title bar
  // The transcript side's whole box: bar + list + the list's 8px of padding top
  // and bottom + the pane's own 1px borders. The controls column is given the
  // same height, which is what balances the two sides — and, more importantly,
  // means the buttons sit under exactly the same pixels whether the transcript
  // is shown, switched off, or minimised.
  const PANEL_HEIGHT = TRANSCRIPT_BAR + TRANSCRIPT_HEIGHT + 16 + 2;
  const GAP = 8;
  // Reserved for the contact alert and the status line. Fixed, and both of
  // those are clamped to fit inside it (two lines each, which is what a
  // two-tag alert and a "Stopped: … Finish manually." both need), so nothing
  // either one says can move a button.
  const FOOT_HEIGHT = 78;
  const ACTION_HEIGHT = Math.round((PANEL_HEIGHT - FOOT_HEIGHT - GAP * 2) / 2);

  const ACCENT = '#8ab4ff'; // focus ring only — never a resting colour

  let alertEl;
  let overlayEl = null; // the box this copy of the script built, if any
  let tx = null; // transcript DOM refs, or null when the pane is not shown

  // Transcript state outlives the DOM: rebuilding the overlay (a settings
  // toggle, a stale copy being replaced) must not lose lines that are already
  // on screen, or a call would end with nothing to save.
  const txView = {
    entries: [],
    autoScroll: true,
    paused: false,
    minimized: false,     // pane collapsed to its rail, by the rep's own click
    unsaved: false,       // lines added since the last save
    pendingNewCall: false, // draw a divider before the next call's first line
    startedAt: 0,
    timerHandle: null,
  };

  // The lines are kept in full for saving; only the rendered nodes are capped,
  // so a whole day of dialing cannot pile up DOM on the Salesloft page.
  const MAX_RENDERED_LINES = 400;

  // A contact can be on screen without the route saying so: the call logger
  // pops out over whatever page the rep dialled from, and it is always about one
  // person. Losing the buttons there would take them away exactly when a call is
  // running, so the DOM gets the last word after the route.
  const CONTACT_DOM = '[data-testid="popout-logger-container"],[data-testid*="person-detail" i]';

  function onContactPage() {
    if (window.slIsContactUrl && window.slIsContactUrl(location.href)) return true;
    try {
      return !!document.querySelector(CONTACT_DOM);
    } catch (e) {
      return false;
    }
  }

  // The single place that decides whether the overlay is on screen. Salesloft is
  // a single-page app — this script is injected once and then sees every
  // navigation as a re-render — so it is called again on each of those, not just
  // when a setting changes. Pass `rebuild` when the overlay's contents changed
  // (the transcript pane appearing) rather than its presence.
  function syncOverlay(rebuild) {
    if (!settingsReady) return;
    const present = document.getElementById(OVERLAY_ID);
    if (settings.pageOverlay && onContactPage()) {
      // An overlay that is on the page but not the one this script built was
      // left behind by a previous copy whose context a reload invalidated. Its
      // buttons are wired to that dead context, so it counts as missing.
      const mine = !!present && present === overlayEl;
      if (!mine || rebuild) buildOverlay();
      return;
    }
    // Never pull the controls, or the status line reporting on them, out from
    // under a flow that is part-way through logging a call.
    if (present && !busy) removeOverlay();
  }

  function removeOverlay() {
    document.getElementById(OVERLAY_ID)?.remove();
    overlayEl = null;
    statusEl = null;
    alertEl = null;
    tx = null;
  }

  // Subtle mirror of the contact alert inside the overlay — one tinted line,
  // nothing floating over the Salesloft UI. alerts.js computes the alert and
  // calls the hook below from the shared isolated world.
  function renderOverlayAlert(alert) {
    if (!alertEl) return;
    if (!alert || !alert.tags || !alert.tags.length) {
      alertEl.style.display = 'none';
      alertEl.textContent = '';
      alertEl.title = '';
      return;
    }
    const theme = (window.SL_PALETTE || {})[alert.color] ||
      { bg: '#3a3320', border: '#b8860b', text: '#ffd88a' };
    const headline = (window.SL_HEADLINE || {})[alert.color] || 'Heads up before you dial';
    const text = `${headline} — ${alert.tags.join(' • ')}`;
    alertEl.textContent = text;
    // Clamped to two lines (see FOOT_HEIGHT); the tooltip is where a longer
    // list of tags stays readable.
    alertEl.title = text;
    alertEl.style.background = theme.bg;
    alertEl.style.borderColor = theme.border;
    alertEl.style.color = theme.text;
    // -webkit-box, not block: the two-line clamp is what keeps it inside the
    // space the foot reserves for it.
    alertEl.style.display = '-webkit-box';
  }
  window.__slOnContactAlert = renderOverlayAlert;

  // The only rules that cannot be expressed as inline styles. It lives inside
  // the overlay so removeOverlay() takes it with everything else, and so the
  // <style> node never lands in <head> where alerts.js would see it mutate.
  //
  // Every hover/active effect here is a filter or a transform — things that
  // paint differently without changing a box — so nothing a mouse does can
  // reflow the column.
  function overlayStyle() {
    const style = document.createElement('style');
    const id = `#${OVERLAY_ID}`;
    style.textContent = [
      '@keyframes sl-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      `${id} ::-webkit-scrollbar{width:8px}`,
      `${id} ::-webkit-scrollbar-thumb{background:#3a3d42;border-radius:4px}`,
      `${id} ::-webkit-scrollbar-thumb:hover{background:#4c5057}`,
      `${id} ::-webkit-scrollbar-track{background:transparent}`,
      `${id} .sl-act{cursor:pointer;transition:filter .12s ease,transform .06s ease}`,
      `${id} .sl-act:hover{filter:brightness(1.13)}`,
      `${id} .sl-act:active{transform:translateY(1px);filter:brightness(.92)}`,
      `${id} .sl-act:focus-visible{outline:2px solid ${ACCENT};outline-offset:2px}`,
      `${id} .sl-icon{background:none;transition:background .12s ease,border-color .12s ease}`,
      `${id} .sl-icon:hover{background:#2e3136}`,
      `${id} .sl-icon:active{transform:translateY(1px)}`,
      `${id} .sl-icon:focus-visible{outline:2px solid ${ACCENT};outline-offset:1px}`,
      // A flow is running and clicks are being ignored: say so, rather than
      // letting the buttons look live and unresponsive.
      `${id}.sl-busy .sl-act{filter:saturate(.5) brightness(.78);cursor:progress}`,
      `${id}.sl-busy .sl-act:hover{filter:saturate(.5) brightness(.78)}`,
    ].join('');
    return style;
  }

  // A key hint, drawn as a key. Two of them ride on each action button: the
  // in-page F-key and the global Chrome command, which are not the same thing
  // and are worth telling apart at a glance.
  function keycap(label) {
    const cap = document.createElement('kbd');
    cap.textContent = label;
    cap.style.cssText = [
      'font-family:inherit', 'font-size:9px', 'font-weight:600', 'line-height:1',
      'padding:3px 5px', 'border-radius:4px', 'white-space:nowrap',
      'background:rgba(0,0,0,.3)', 'border:1px solid rgba(255,255,255,.2)',
      'color:rgba(255,255,255,.92)', 'letter-spacing:.02em',
    ].join(';');
    return cap;
  }

  // One full-width bar: glyph, what it does, and the two ways to fire it. Its
  // height is fixed at ACTION_HEIGHT — the pair of them plus the reserved foot
  // is exactly the transcript's height, which is what "balanced" means here.
  function actionButton(opts) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sl-act';
    b.title = `${opts.label} — ${opts.keys.join(' or ')}`;
    b.style.cssText = [
      'width:100%', `height:${ACTION_HEIGHT}px`, 'box-sizing:border-box',
      'display:flex', 'align-items:center', 'gap:9px', 'padding:0 10px',
      'border-radius:9px', 'text-align:left',
      `background:${opts.bg}`, `border:1px solid ${opts.border}`,
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.14),0 1px 2px rgba(0,0,0,.35)',
      'color:#fff', 'font-family:inherit',
    ].join(';');

    const glyph = document.createElement('span');
    glyph.textContent = opts.glyph;
    glyph.setAttribute('aria-hidden', 'true');
    glyph.style.cssText = [
      'flex:0 0 auto', 'width:26px', 'height:26px', 'border-radius:7px',
      'display:flex', 'align-items:center', 'justify-content:center',
      'background:rgba(255,255,255,.15)', 'font-size:13px', 'line-height:1',
    ].join(';');

    const text = document.createElement('span');
    text.style.cssText = 'flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;';

    const label = document.createElement('span');
    label.textContent = opts.label;
    label.style.cssText = 'font-size:13px;font-weight:600;line-height:1.15;white-space:nowrap;';

    const sub = document.createElement('span');
    sub.textContent = opts.sub;
    sub.style.cssText = [
      'font-size:10px', 'opacity:.82', 'line-height:1.15',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';');

    text.appendChild(label);
    text.appendChild(sub);

    const caps = document.createElement('span');
    caps.style.cssText = 'flex:0 0 auto;display:flex;gap:4px;';
    for (const key of opts.keys) caps.appendChild(keycap(key));

    b.appendChild(glyph);
    b.appendChild(text);
    b.appendChild(caps);
    b.addEventListener('click', opts.onClick);
    return b;
  }

  function buildOverlay() {
    if (!document.body) return;
    // An overlay may already exist, left behind by a previous copy of this
    // script whose extension context was invalidated by a reload/update. Its
    // buttons are wired to that dead context, so always replace it rather
    // than keep it.
    removeOverlay();
    const box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.style.cssText = [
      // Anchored bottom-left, and every part of it a fixed size: the buttons
      // must stay under the same pixels all day, however long the status line
      // gets or how much the prospect says. Text wraps, clips and scrolls; the
      // box itself only ever changes width, and only when the rep asks — by
      // switching transcription on or off, or minimising the pane.
      'position:fixed', 'bottom:16px', 'left:16px', 'z-index:999999',
      'box-sizing:border-box',
      'display:flex', 'align-items:stretch', 'gap:10px',
      'background:#1c1e21', 'border:1px solid #3a3d42', 'border-radius:12px',
      'padding:10px', 'font-family:system-ui,sans-serif', 'font-size:12px',
      'color:#e8e6e1',
      'box-shadow:0 6px 22px rgba(0,0,0,.45)', 'user-select:none',
    ].join(';');
    box.appendChild(overlayStyle());
    // A rebuild mid-flow (a settings toggle while a call is being logged) must
    // come back wearing the same dimmed, clicks-ignored look it had before.
    if (busy) box.classList.add('sl-busy');

    const controls = document.createElement('div');
    controls.style.cssText = [
      `flex:0 0 ${CONTROLS_WIDTH}px`, `width:${CONTROLS_WIDTH}px`,
      `height:${PANEL_HEIGHT}px`, 'box-sizing:border-box',
      'display:flex', 'flex-direction:column', `gap:${GAP}px`,
    ].join(';');

    const row = document.createElement('div');
    row.style.cssText = `display:flex;flex-direction:column;gap:${GAP}px;flex:0 0 auto;`;

    row.appendChild(actionButton({
      glyph: '✕',
      label: 'No Answer',
      sub: 'End · log · next',
      keys: [CONFIG.keyKill, 'Ctrl⇧9'],
      bg: 'linear-gradient(180deg,#cf4436 0%,#a52f22 100%)',
      border: '#8d2a1e',
      onClick: killAndLog,
    }));
    row.appendChild(actionButton({
      glyph: '▶',
      label: 'Call',
      sub: 'Dial this contact',
      keys: [CONFIG.keyCall, 'Ctrl⇧0'],
      bg: 'linear-gradient(180deg,#249a55 0%,#166b3b 100%)',
      border: '#135f34',
      onClick: startCall,
    }));

    // A fixed block the buttons sit above, not a stack that grows under them.
    // The alert reads directly beneath the buttons; the status stays pinned to
    // the bottom edge, where it has been all along.
    const foot = document.createElement('div');
    foot.style.cssText = [
      `flex:0 0 ${FOOT_HEIGHT}px`, `height:${FOOT_HEIGHT}px`, 'box-sizing:border-box',
      'display:flex', 'flex-direction:column', 'gap:6px', 'overflow:hidden',
    ].join(';');

    alertEl = document.createElement('div');
    alertEl.style.cssText = [
      'flex:0 0 auto', 'padding:4px 8px', 'border:1px solid',
      'border-radius:6px', 'font-size:11px', 'font-weight:600', 'line-height:1.35',
      'overflow-wrap:break-word',
      // Two lines is a headline plus two tags; a third tag ellipses and the
      // tooltip carries the rest. It must not be able to grow the column.
      'display:-webkit-box', '-webkit-box-orient:vertical', '-webkit-line-clamp:2',
      'overflow:hidden',
    ].join(';');
    alertEl.style.display = 'none';

    statusEl = document.createElement('div');
    statusEl.style.cssText = [
      'flex:0 0 auto', 'margin-top:auto', 'min-height:14px', 'color:#e8e6e1',
      'font-size:12px', 'line-height:1.35', 'overflow-wrap:break-word',
      // Same deal: two lines, then ellipsis, with the whole of a long
      // "Stopped: … Finish manually." on the tooltip.
      'display:-webkit-box', '-webkit-box-orient:vertical', '-webkit-line-clamp:2',
      'overflow:hidden',
    ].join(';');
    statusEl.textContent = 'Ready';

    foot.appendChild(alertEl);
    foot.appendChild(statusEl);

    controls.appendChild(row);
    controls.appendChild(foot);
    box.appendChild(controls);

    if (settings.transcription) box.appendChild(buildTranscript());

    document.body.appendChild(box);
    overlayEl = box;
    renderOverlayAlert(window.__slContactAlert || null);
    // scrollHeight is 0 until the box is in the document, so carried-over lines
    // can only be scrolled into view once it is.
    if (tx) tx.list.scrollTop = tx.list.scrollHeight;
  }

  // ---------------- Live transcript pane ----------------
  // The same lines the floating panel shows, on the page itself, for reps who
  // do not want a second window. This pane only renders: the audio never
  // touches this script, the lines are relayed by the background worker, and
  // nothing here clicks a Salesloft control.

  function iconButton(glyph, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sl-icon';
    b.textContent = glyph;
    b.title = title;
    b.setAttribute('aria-label', title);
    b.style.cssText = [
      'border:1px solid #3a3d42', 'color:#e8e6e1',
      'border-radius:6px', 'padding:0', 'width:26px', 'height:24px',
      'font-size:11px', 'line-height:1', 'cursor:pointer', 'font-family:inherit',
      'flex:0 0 auto',
    ].join(';');
    // Resting colour is a property rather than a constant so a button can be
    // highlighted (the save nudge) without hover wiping it.
    b.restBorder = '#3a3d42';
    b.addEventListener('mouseenter', () => { b.style.borderColor = '#5a5e66'; });
    b.addEventListener('mouseleave', () => { b.style.borderColor = b.restBorder; });
    b.addEventListener('click', onClick);
    return b;
  }

  function buildTranscript() {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:6px;align-items:stretch;flex:0 0 auto;';

    const pane = document.createElement('div');
    pane.style.cssText = [
      'position:relative', `flex:0 0 ${TRANSCRIPT_WIDTH}px`, `width:${TRANSCRIPT_WIDTH}px`,
      `height:${PANEL_HEIGHT}px`, 'box-sizing:border-box',
      'display:flex', 'flex-direction:column',
      'background:#141618', 'border:1px solid #3a3d42', 'border-radius:8px',
      'overflow:hidden',
    ].join(';');

    const bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'gap:7px', 'padding:0 8px',
      `flex:0 0 ${TRANSCRIPT_BAR}px`, `height:${TRANSCRIPT_BAR}px`, 'box-sizing:border-box',
      'background:#26282c', 'border-bottom:1px solid #3a3d42',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#6b6f76;flex:0 0 auto;';

    const connection = document.createElement('span');
    connection.style.cssText = 'font-weight:600;letter-spacing:.04em;font-size:10px;color:#9aa0a6;';
    connection.textContent = 'OFFLINE';

    const timer = document.createElement('span');
    timer.style.cssText = 'margin-left:auto;font-variant-numeric:tabular-nums;color:#9aa0a6;font-size:11px;';
    timer.textContent = '00:00';

    bar.appendChild(dot);
    bar.appendChild(connection);
    bar.appendChild(timer);

    const list = document.createElement('div');
    list.style.cssText = [
      `height:${TRANSCRIPT_HEIGHT}px`, 'overflow-y:auto', 'padding:8px 9px',
      // Read out of the corner of the eye mid-sentence, so it stays larger and
      // higher-contrast than the rest of the overlay.
      'font-size:13px', 'line-height:1.45', 'user-select:text', 'cursor:text',
      'overflow-wrap:break-word',
    ].join(';');

    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9aa0a6;font-size:12px;font-style:italic;';
    empty.textContent = 'Waiting for the call to start…';
    list.appendChild(empty);

    const hint = document.createElement('button');
    hint.type = 'button';
    hint.textContent = '↓ New text';
    hint.style.cssText = [
      'display:none', 'position:absolute', 'right:10px', 'bottom:8px',
      'background:#3a3d42', 'color:#e8e6e1', 'border:none', 'border-radius:12px',
      'padding:3px 9px', 'font-size:10px', 'cursor:pointer', 'font-family:inherit',
      'box-shadow:0 2px 6px rgba(0,0,0,.4)',
    ].join(';');
    hint.addEventListener('click', () => {
      txView.autoScroll = true;
      list.scrollTop = list.scrollHeight;
      hint.style.display = 'none';
    });

    list.addEventListener('scroll', () => {
      // Scroll-lock: the rep is reading back something earlier, so new lines
      // must not yank the view away from them.
      const fromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
      txView.autoScroll = fromBottom < 24;
      if (txView.autoScroll) hint.style.display = 'none';
    });

    pane.appendChild(bar);
    pane.appendChild(list);
    pane.appendChild(hint);

    // The rail stays whatever the pane does, so minimising cannot strand the
    // controls that act on the transcript — save and copy still reach every
    // line that was captured.
    const rail = document.createElement('div');
    rail.style.cssText = 'display:flex;flex-direction:column;gap:5px;flex:0 0 auto;';
    const toggle = iconButton('»', 'Minimize transcript', toggleMinimized);
    // Only shown while minimised, where the bar's own indicator is not on
    // screen: capture is still running and the rep should still be able to see
    // that at a glance.
    const railDot = document.createElement('span');
    railDot.style.cssText = [
      'display:none', 'width:8px', 'height:8px', 'border-radius:50%',
      'background:#6b6f76', 'flex:0 0 auto', 'align-self:center', 'margin:2px 0',
    ].join(';');
    const pause = iconButton('⏸', 'Pause transcription', togglePause);
    const save = iconButton('↓', 'Save transcript as text', () => {
      if (saveTranscript()) setStatus('Transcript saved', 'ok');
      else setStatus('Nothing to save');
    });
    rail.appendChild(toggle);
    rail.appendChild(railDot);
    rail.appendChild(pause);
    rail.appendChild(iconButton('⧉', 'Copy transcript', copyTranscript));
    rail.appendChild(save);
    rail.appendChild(iconButton('✕', 'Clear transcript', clearTranscript));

    wrap.appendChild(pane);
    wrap.appendChild(rail);

    tx = { pane, list, empty, dot, connection, timer, hint, toggle, railDot, pause, save };
    // A rebuild (settings toggle, or replacing a stale overlay) must not lose
    // what is already on screen.
    const shown = txView.entries.slice(-MAX_RENDERED_LINES);
    if (shown.length) {
      empty.remove();
      tx.empty = null;
      for (const entry of shown) appendEntryNode(entry);
    }
    renderPaused();
    renderMinimized();
    return wrap;
  }

  // Minimising hides the pane and leaves the rail: the overlay loses the
  // transcript's 300px of width and keeps its height, and because the box is
  // anchored bottom-left, not one button moves. Transcription itself is
  // untouched — lines keep arriving and keep being kept.
  function renderMinimized() {
    if (!tx) return;
    const min = txView.minimized;
    tx.pane.style.display = min ? 'none' : 'flex';
    tx.railDot.style.display = min ? 'block' : 'none';
    tx.toggle.textContent = min ? '«' : '»';
    tx.toggle.title = min ? 'Show transcript' : 'Minimize transcript';
    tx.toggle.setAttribute('aria-label', tx.toggle.title);
    tx.toggle.setAttribute('aria-expanded', String(!min));
    if (!min) {
      // Nothing scrolls while display:none, so coming back always lands on the
      // newest line rather than wherever the view was left.
      txView.autoScroll = true;
      tx.list.scrollTop = tx.list.scrollHeight;
      tx.hint.style.display = 'none';
    }
  }

  function toggleMinimized() {
    txView.minimized = !txView.minimized;
    renderMinimized();
  }

  function appendEntryNode(entry) {
    if (!tx) return;

    if (entry.newCall && tx.list.childElementCount) {
      const divider = document.createElement('div');
      divider.style.cssText = [
        'margin:10px 0 8px', 'border-top:1px solid #2c2f34', 'padding-top:6px',
        'color:#6b6f76', 'font-size:10px', 'letter-spacing:.06em', 'text-transform:uppercase',
      ].join(';');
      divider.textContent = 'Next call';
      tx.list.appendChild(divider);
    }

    const line = document.createElement('div');
    line.style.cssText = 'margin-bottom:7px;';

    const time = document.createElement('span');
    time.style.cssText =
      'color:#9aa0a6;font-size:11px;font-variant-numeric:tabular-nums;margin-right:6px;';
    time.textContent = window.slFormatClock(entry.start);
    if (entry.merged > 1) {
      // Coalesced under backpressure: the speech is all there, the timestamps
      // are approximate.
      time.textContent += ' ~';
      time.style.color = '#e0a020';
      time.title = 'Coalesced under load — timestamps approximate';
    }

    const text = document.createElement('span');
    text.style.color = '#e8e6e1';
    text.textContent = entry.text;

    line.appendChild(time);
    line.appendChild(text);
    tx.list.appendChild(line);
  }

  function addTranscriptEntry(payload) {
    // No pane means no transcript to keep: the lines still reach the floating
    // panel, and holding a day of them here for nobody to read would be a leak.
    // A rebuild swaps the DOM synchronously, so this cannot drop a live line.
    if (!tx) return;
    const entry = {
      start: payload.start || 0,
      text: payload.text || '',
      merged: payload.merged || 1,
    };
    if (!entry.text) return;
    // Only mark a boundary once the next call actually says something, so a
    // dial that nobody picks up leaves no divider behind.
    if (txView.pendingNewCall) {
      entry.newCall = true;
      txView.pendingNewCall = false;
    }
    txView.entries.push(entry);
    txView.unsaved = true;

    if (tx.empty) { tx.empty.remove(); tx.empty = null; }
    appendEntryNode(entry);
    while (tx.list.childElementCount > MAX_RENDERED_LINES) tx.list.firstElementChild.remove();

    if (txView.autoScroll) {
      tx.list.scrollTop = tx.list.scrollHeight;
      tx.hint.style.display = 'none';
    } else {
      tx.hint.style.display = 'block';
    }
  }

  function setTranscriptConnection(state) {
    if (!tx) return;
    const labels = { ready: 'LIVE', busy: 'LIVE', degraded: 'BEHIND', error: 'ERROR', offline: 'OFFLINE' };
    const colors = { ready: '#ff5c4d', busy: '#ff5c4d', degraded: '#e0a020', error: '#6b6f76', offline: '#6b6f76' };
    const live = state === 'ready' || state === 'busy';
    tx.connection.textContent = labels[state] || 'OFFLINE';
    tx.connection.style.color = live ? '#e8e6e1' : '#9aa0a6';
    tx.dot.style.background = colors[state] || '#6b6f76';
    tx.dot.style.animation = live ? 'sl-pulse 1.6s ease-in-out infinite' : 'none';
    // Same state, on the one indicator that survives minimising.
    tx.railDot.style.background = tx.dot.style.background;
    tx.railDot.style.animation = tx.dot.style.animation;
    tx.railDot.title = `Transcription: ${tx.connection.textContent}`;
  }

  function renderPaused() {
    if (!tx) return;
    tx.pause.textContent = txView.paused ? '▶' : '⏸';
    tx.pause.title = txView.paused ? 'Resume transcription' : 'Pause transcription';
    tx.pause.setAttribute('aria-label', tx.pause.title);
    // '' rather than 'none': an inline value would beat the stylesheet's
    // resting/hover rules for this one button.
    tx.pause.style.background = txView.paused ? '#3a3d42' : '';
    tx.pause.setAttribute('aria-pressed', String(txView.paused));
  }

  function togglePause() {
    txView.paused = !txView.paused;
    renderPaused();
    safeSend({ type: 'transcription-command', action: 'pause', paused: txView.paused });
    setStatus(txView.paused ? 'Transcription paused' : 'Transcription resumed');
  }

  function clearTranscript() {
    txView.entries = [];
    txView.unsaved = false;
    txView.autoScroll = true;
    txView.pendingNewCall = false;
    if (!tx) return;
    clearSaveOffer();
    tx.list.textContent = '';
    tx.empty = document.createElement('div');
    tx.empty.style.cssText = 'color:#9aa0a6;font-size:12px;font-style:italic;';
    tx.empty.textContent = 'Cleared.';
    tx.list.appendChild(tx.empty);
    tx.hint.style.display = 'none';
  }

  // Text only, never audio. Returns false when there is nothing to write.
  //
  // Only ever called from the ↓ button, and that is the rule everywhere: no
  // call saves a transcript on its own. Two reasons, and either alone settles
  // it — a cadence is dozens of dials, so a file per dial buries the few worth
  // keeping; and Chrome allows a web page one uninvited download before it
  // starts asking the rep's permission for the rest, which would put a
  // permission bubble on the Salesloft page partway through a call block.
  function saveTranscript() {
    if (!txView.entries.length) return false;
    const blob = new Blob([window.slTranscriptText(txView.entries)], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = window.slTranscriptFilename();
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    txView.unsaved = false;
    clearSaveOffer();
    return true;
  }

  // Quiet, and quiet is the point: a line in the status the rep already reads,
  // plus a highlight on the button that acts on it. No modal, no focus steal.
  function offerSave() {
    if (!tx || !txView.unsaved || !txView.entries.length) return;
    setStatus(`Transcript ready (${txView.entries.length} lines) — ↓ to save`, 'warn');
    tx.save.restBorder = '#b8860b';
    tx.save.style.borderColor = '#b8860b';
    tx.save.style.color = '#ffd88a';
  }

  function clearSaveOffer() {
    if (!tx) return;
    tx.save.restBorder = '#3a3d42';
    tx.save.style.borderColor = '#3a3d42';
    tx.save.style.color = '#e8e6e1';
  }

  async function copyTranscript() {
    if (!txView.entries.length) { setStatus('Nothing to copy'); return; }
    const text = window.slTranscriptText(txView.entries);
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      // The clipboard API needs focus and can refuse; fall back rather than
      // fail. The scratch node goes inside the overlay, which alerts.js
      // already ignores, so this cannot set off a contact-alert rescan.
      const scratch = document.createElement('textarea');
      scratch.style.cssText = 'position:absolute;opacity:0;pointer-events:none;';
      scratch.value = text;
      (document.getElementById(OVERLAY_ID) || document.body).appendChild(scratch);
      scratch.select();
      try { document.execCommand('copy'); } catch (e) { /* nothing more to try */ }
      scratch.remove();
    }
    setStatus(`Copied ${txView.entries.length} lines`, 'ok');
  }

  function startTranscriptTimer() {
    if (txView.timerHandle) return;
    txView.startedAt = Date.now();
    if (tx) tx.timer.textContent = '00:00';
    txView.timerHandle = setInterval(() => {
      if (tx) tx.timer.textContent = window.slFormatClock((Date.now() - txView.startedAt) / 1000);
    }, 1000);
  }

  function stopTranscriptTimer() {
    clearInterval(txView.timerHandle);
    txView.timerHandle = null;
  }

  // A new call keeps the previous one on screen behind a divider rather than
  // wiping it: nothing here saves on its own, so clearing would be the one way
  // this pane could lose speech the rep never got to read or keep.
  function onTranscriptCallStart() {
    if (txView.entries.length) txView.pendingNewCall = true;
    if (tx && tx.empty) tx.empty.textContent = 'Listening…';
    startTranscriptTimer();
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

  // ---------------- Call state detection (PR-1, observe only) ----------------
  // This path never clicks anything. It watches for the End Call control and
  // reports transitions so the background worker can start and stop
  // transcription. Keeping observation and automation separate is what stops a
  // detection bug from ever mis-logging a call.
  let lastCallState = null;
  let detectTimer = null;

  function reportCallState() {
    if (!window.SLCallDetect) return;
    const detector = window.SLCallDetect;
    // detectState swallows its own errors and resolves to IDLE, so a Salesloft
    // DOM change degrades to "no transcription", never to a thrown error.
    const result = detector.detectState(detector.liveOptions(document));
    if (result.state === lastCallState) return;
    lastCallState = result.state;
    safeSend({ type: 'call-state', state: result.state, tier: result.tier });

    // The transcript pane follows the call it is transcribing. This is still
    // observation only — nothing below clicks anything.
    if (result.state === 'IN_CALL') onTranscriptCallStart();
    else stopTranscriptTimer();
  }

  function scheduleDetect() {
    // Salesloft's React tree mutates constantly; debounce so this costs
    // nothing measurable during a call.
    clearTimeout(detectTimer);
    detectTimer = setTimeout(() => {
      reportCallState();
      // Every in-app navigation re-renders, so this is also where the overlay
      // learns it has moved off (or onto) a contact.
      syncOverlay();
    }, 250);
  }

  // A route change with no re-render worth noticing is unlikely, but these cost
  // nothing and keep the overlay honest if one happens.
  window.addEventListener('popstate', () => scheduleDetect());
  window.addEventListener('hashchange', () => scheduleDetect());

  if (typeof MutationObserver === 'function') {
    // Ignore our own overlay, which churns with every transcript line once a
    // call is running. Only Salesloft's DOM can change the call state, and
    // alerts.js filters the same way for the same reason.
    new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (node && node.closest && node.closest(`#${OVERLAY_ID}`)) continue;
        return scheduleDetect();
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
    reportCallState();
  }
})();
