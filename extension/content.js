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
        statusEl.title = msg.detail;
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
      // The element shows one line, or two when there is no transcript beside
      // it; the tooltip is where the whole of a long "Stopped: …" stays
      // readable.
      statusEl.title = msg;
      statusEl.style.color =
        kind === 'err' ? '#ffb4a8' : kind === 'warn' ? '#ffd88a' : kind === 'ok' ? '#a8e6b8' : '#e8e6e1';
    }
    safeSend({ type: 'status', msg, kind });
  }

  // ---------------- Optional on-page overlay ----------------
  const OVERLAY_ID = 'sl-hotkey-overlay';

  // Every part of the overlay is a fixed size. The two action buttons are what
  // the rep aims at all day, so nothing the extension displays — a long status
  // line, a contact alert appearing, a talkative prospect — is allowed to move
  // them. That is why the alert keeps its space even when there is no alert,
  // and why these are constants rather than whatever the content needs.
  const CONTROLS_WIDTH = 210;   // the button column, unchanged whatever else is shown
  const TRANSCRIPT_WIDTH = 280;
  const PANEL_HEIGHT = 120;     // the buttons, the pane and the rail: one row, one height
  const BOX_PAD = 8;
  const MAIN_GAP = 8;           // between the button column and the pane
  const STACK_GAP = 5;          // between the alert, the row and the status
  const RAIL_GAP = 6;           // between the pane and its rail
  const ICON = 19;              // the rail's square buttons
  // Five rail buttons and their gaps have to fit PANEL_HEIGHT, which is what
  // stops the pane shrinking further.
  const RAIL_ICON_GAP = 3;
  // Reserved, never measured — that is what stops a long "Stopped: …" moving
  // the buttons. Beside a transcript the box is wide enough for any of them on
  // one line; on its own it is 210px, where the long ones need two. Either way
  // the tooltip carries whatever still does not fit.
  const STATUS_ONE_LINE = 15;
  const STATUS_TWO_LINES = 28;
  // With a transcript beside them the buttons stretch to meet it — same column
  // width, the pane's full height. With nothing to match they stay short: tall
  // enough for the glyph, the label and the keycaps and no taller, so the
  // dialer-only overlay is the smallest thing that still says what it does.
  const BUTTONS_SHORT = 76;

  // The browser's own easings are too weak to read as deliberate at these
  // durations, so the overlay uses one strong ease-out everywhere. Press is
  // near-instant and release is relaxed: the press is the interface saying it
  // heard the rep, and that has to land the moment the mouse goes down.
  const EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
  const PRESS_MS = 60;
  const RELEASE_MS = 160;

  let alertEl;
  let overlayEl = null; // the box this copy of the script built, if any
  let ctl = null;       // the two action buttons, or null with no overlay
  let tx = null;        // transcript DOM refs, or null when the pane is not built

  // Transcript state outlives the DOM: rebuilding the overlay (a settings
  // toggle, a stale copy being replaced) must not lose lines that are already
  // on screen, or a call would end with nothing to save.
  const txView = {
    entries: [],
    autoScroll: true,
    paused: false,
    minimized: false,      // the pane is hidden; everything else carries on
    unsaved: false,        // lines added since the last save
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
    ctl = null;
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
      alertEl.removeAttribute('title');
      return;
    }
    const theme = (window.SL_PALETTE || {})[alert.color] ||
      { bg: '#3a3320', border: '#b8860b', text: '#ffd88a' };
    const text = alert.tags.join(' • ');
    alertEl.textContent = text;
    alertEl.title = text;   // the banner is one line; narrow, it ellipsises
    alertEl.style.background = theme.bg;
    alertEl.style.borderColor = theme.border;
    alertEl.style.color = theme.text;
    alertEl.style.display = 'block';
  }
  window.__slOnContactAlert = renderOverlayAlert;

  // The only rules that cannot be expressed as inline styles. It lives inside
  // the overlay so removeOverlay() takes it with everything else, and so the
  // <style> node never lands in <head> where alerts.js would see it mutate.
  //
  // Every interactive state here is a colour or a transform. None of them may
  // change a size in the layout sense: a control that grew under the cursor
  // would move the one beside it, which is the thing the fixed geometry exists
  // to prevent. A scale() is safe because it does not touch layout.
  function overlayStyle() {
    const style = document.createElement('style');
    style.textContent = [
      '@keyframes sl-pulse{0%,100%{opacity:1}50%{opacity:.35}}',
      `#${OVERLAY_ID} ::-webkit-scrollbar{width:8px}`,
      `#${OVERLAY_ID} ::-webkit-scrollbar-thumb{background:#3a3d42;border-radius:4px}`,
      `#${OVERLAY_ID} ::-webkit-scrollbar-thumb:hover{background:#4c5057}`,
      `#${OVERLAY_ID} ::-webkit-scrollbar-track{background:transparent}`,
      `#${OVERLAY_ID} button{font-family:inherit;margin:0}`,
      `#${OVERLAY_ID} button:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}`,
      // Order matters below: hover, then press, then busy. All three are the
      // same specificity, so the later rule wins — the press has to beat the
      // hover it happens under, and a press that is being thrown away has to
      // beat both.
      //
      // The press is a scale rather than a 1px nudge: on a face this size a
      // nudge is invisible, and the point of press feedback is that the rep
      // sees the button answer before the flow starts.
      `#${OVERLAY_ID} .sl-act{transition:transform ${RELEASE_MS}ms ${EASE_OUT},filter ${RELEASE_MS}ms ease}`,
      `#${OVERLAY_ID} .sl-key{background:rgba(255,255,255,.17);border-radius:3px;padding:1px 4px;font-size:9px;font-weight:600;letter-spacing:.02em;white-space:nowrap}`,
      // The small square buttons on the rail. Their resting look lives here so
      // that a highlight set inline — the save nudge, the paused state — can be
      // cleared back to it with an empty string.
      `#${OVERLAY_ID} .sl-icon{background:transparent;border:1px solid #3a3d42;color:#e8e6e1;border-radius:6px;padding:0;font-size:10px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;transition:transform ${RELEASE_MS}ms ${EASE_OUT},background-color ${RELEASE_MS}ms ease,border-color ${RELEASE_MS}ms ease}`,
      `#${OVERLAY_ID} .sl-pill{transition:transform ${RELEASE_MS}ms ${EASE_OUT},filter ${RELEASE_MS}ms ease}`,

      // Hover is a mouse state. A touchscreen fires it on tap and then leaves
      // it stuck on the last thing touched, so it is gated rather than global.
      '@media (hover:hover) and (pointer:fine){' +
        `#${OVERLAY_ID} .sl-act:hover{filter:brightness(1.12)}` +
        `#${OVERLAY_ID} .sl-icon:hover{background:#2f3238;border-color:#5a5e66}` +
        `#${OVERLAY_ID} .sl-pill:hover{filter:brightness(1.25)}}`,

      // Press. Shorter than the release on purpose: the answer has to land as
      // the mouse goes down, and it can take its time coming back.
      `#${OVERLAY_ID} .sl-act:active{transform:scale(.97);filter:brightness(.94);transition-duration:${PRESS_MS}ms}`,
      // A shade deeper on the rail, which is small enough that .97 would not
      // register.
      `#${OVERLAY_ID} .sl-icon:active{transform:scale(.94);transition-duration:${PRESS_MS}ms}`,
      `#${OVERLAY_ID} .sl-pill:active{transform:scale(.96);transition-duration:${PRESS_MS}ms}`,

      // A flow is running and clicks are being ignored, so the buttons say so
      // rather than sitting there looking live — and a press that is being
      // thrown away must not answer as though it was not.
      `#${OVERLAY_ID}.sl-busy .sl-act{filter:saturate(.4) brightness(.72);cursor:progress}`,
      `#${OVERLAY_ID}.sl-busy .sl-act:active{transform:none}`,

      // Reduced motion is gentler, not absent: the colour still answers the
      // press, only the movement goes. Last, so it beats every :active above.
      '@media (prefers-reduced-motion:reduce){' +
        `#${OVERLAY_ID} .sl-act:active,#${OVERLAY_ID} .sl-icon:active,` +
        `#${OVERLAY_ID} .sl-pill:active{transform:none}}`,
    ].join('');
    return style;
  }

  // ✕ / ▶ over the label over the two keys that do the same thing. The keycaps
  // are what the extra height buys: a rep who reads them once stops reaching
  // for the mouse.
  function actionButton(glyph, label, keys, background, onClick) {
    const b = document.createElement('button');
    b.className = 'sl-act';
    b.type = 'button';
    b.title = `${label} — ${keys.join(' or ')}`;
    // The glyph and the label are one thing — what the button is — so they sit
    // close together. The keycaps say how else to fire it, which is a note
    // about the button rather than part of its name, so they get twice the
    // distance. An even stack of three read as three equal lines.
    b.innerHTML =
      '<span style="display:flex;flex-direction:column;align-items:center;gap:4px">' +
        `<span style="font-size:20px;line-height:1">${glyph}</span>` +
        `<span style="font-size:13px;font-weight:600;line-height:1.15;letter-spacing:.01em">${label}</span>` +
      '</span>' +
      `<span style="display:flex;gap:3px">${keys
        .map((k) => `<span class="sl-key">${k}</span>`)
        .join('')}</span>`;
    b.style.cssText = [
      'flex:1 1 0', 'min-width:0', 'height:100%', 'box-sizing:border-box',
      'display:flex', 'flex-direction:column', 'align-items:center', 'justify-content:center',
      'gap:8px', 'padding:5px 6px', 'border:none', 'border-radius:8px',
      'cursor:pointer', 'color:#fff', `background:${background}`,
      'box-shadow:inset 0 1px 0 rgba(255,255,255,.18),0 1px 2px rgba(0,0,0,.35)',
      'text-align:center', 'font-family:inherit',
    ].join(';');
    b.addEventListener('click', onClick);
    return b;
  }

  function buildOverlay() {
    if (!document.body) return;
    // An overlay may already exist, left behind by a previous copy of this
    // script whose extension context was invalidated by a reload/update. Its
    // buttons are wired to that dead context, so always replace it rather
    // than keep it.
    removeOverlay();

    const hasTranscript = !!settings.transcription;

    const box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.style.cssText = [
      // Anchored bottom-left. Its height changes only when transcription is
      // switched on or off, and its width only for that or the pane being
      // minimised — both a deliberate click, never something it is displaying.
      'position:fixed', 'bottom:16px', 'left:16px', 'z-index:999999',
      'box-sizing:border-box',
      'display:flex', 'flex-direction:column', `gap:${STACK_GAP}px`,
      'background:linear-gradient(180deg,#212429 0%,#191b1e 100%)',
      'border:1px solid #3a3d42', 'border-radius:10px',
      `padding:${BOX_PAD}px`, 'font-family:system-ui,sans-serif', 'font-size:11px',
      'color:#e8e6e1',
      'box-shadow:0 6px 22px rgba(0,0,0,.42)', 'user-select:none',
    ].join(';');
    if (busy) box.classList.add('sl-busy');
    box.appendChild(overlayStyle());

    // Full width and above everything else: the alert is the one thing that
    // appears and disappears on its own (a new contact has tags or it does
    // not), and up here it costs nothing — the overlay is anchored at its foot,
    // so it grows the box upward and leaves every control where it was. It also
    // gets the whole width, so several tags still fit on one line.
    alertEl = document.createElement('div');
    alertEl.style.cssText = [
      'display:none', 'flex:0 0 auto', 'box-sizing:border-box',
      // Takes the box's width without setting it: a long tag must not be what
      // decides how wide the overlay is.
      'width:0', 'min-width:100%',
      'padding:2px 7px', 'border:1px solid transparent', 'border-radius:5px',
      'font-size:10px', 'font-weight:600', 'line-height:14px',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';');
    box.appendChild(alertEl);

    const main = document.createElement('div');
    main.style.cssText = `display:flex;align-items:stretch;gap:${MAIN_GAP}px;`;

    // The buttons, the pane and the rail are one row at one height, so the
    // block reads as a block: the buttons finish exactly where the pane does
    // instead of stopping short of it.
    const row = document.createElement('div');
    row.style.cssText = [
      `flex:0 0 ${CONTROLS_WIDTH}px`, `width:${CONTROLS_WIDTH}px`, 'box-sizing:border-box',
      'display:flex', 'gap:6px',
      `height:${hasTranscript ? PANEL_HEIGHT : BUTTONS_SHORT}px`,
    ].join(';');

    const kill = actionButton('✕', 'No Answer', [CONFIG.keyKill, 'Ctrl⇧9'],
      'linear-gradient(180deg,#cf4436 0%,#a12d1e 100%)', killAndLog);
    const call = actionButton('▶', 'Call', [CONFIG.keyCall, 'Ctrl⇧0'],
      'linear-gradient(180deg,#259954 0%,#146639 100%)', startCall);
    row.appendChild(kill);
    row.appendChild(call);
    ctl = { kill, call, row };

    main.appendChild(row);
    if (hasTranscript) main.appendChild(buildTranscript());
    box.appendChild(main);

    // Under the whole box rather than inside the button column: a sentence
    // reads better across the width than down 210px, and the row above keeps
    // its full height instead of giving a third of it up to one word.
    statusEl = document.createElement('div');
    statusEl.style.cssText = [
      'flex:0 0 auto',
      `height:${hasTranscript ? STATUS_ONE_LINE : STATUS_TWO_LINES}px`,
      'box-sizing:border-box',
      'color:#e8e6e1', 'line-height:14px', 'overflow-wrap:break-word',
      'display:-webkit-box', `-webkit-line-clamp:${hasTranscript ? 1 : 2}`,
      '-webkit-box-orient:vertical', 'overflow:hidden',
    ].join(';');
    statusEl.textContent = 'Ready';
    box.appendChild(statusEl);

    document.body.appendChild(box);
    overlayEl = box;
    renderOverlayAlert(window.__slContactAlert || null);
    // Last, and only once the box is in the document: it scrolls the list, and
    // scrollHeight is 0 until then. It also re-applies the rep's last minimise
    // decision, which outlives the rebuild.
    renderTranscriptView();
  }

  // ---------------- Live transcript pane ----------------
  // The same lines the floating panel shows, on the page itself, for reps who
  // do not want a second window. This pane only renders: the audio never
  // touches this script, the lines are relayed by the background worker, and
  // nothing here clicks a Salesloft control.

  function iconButton(glyph, title, onClick, size) {
    const b = document.createElement('button');
    b.className = 'sl-icon';
    b.type = 'button';
    b.textContent = glyph;
    b.title = title;
    b.setAttribute('aria-label', title);
    const side = size || ICON;
    b.style.cssText = `width:${side}px;height:${side}px`;
    b.addEventListener('click', onClick);
    return b;
  }

  function saveFromButton() {
    if (saveTranscript()) setStatus('Transcript saved', 'ok');
    else setStatus('Nothing to save');
  }

  // Minimising hides the pane and nothing else. Capture carries on, the lines
  // keep arriving into a list that is merely not on screen, and the rail keeps
  // pause, copy, save and clear — plus a light saying whether it is still
  // running — within reach. So the rep can put the reading away mid-call
  // without putting the transcript away with it.
  function toggleTranscriptView() {
    txView.minimized = !txView.minimized;
    renderTranscriptView();
  }

  function renderTranscriptView() {
    if (!tx) return;
    const hidden = txView.minimized;
    tx.pane.style.display = hidden ? 'none' : 'flex';
    // The pane's own light goes with it, so the rail shows one in its place.
    // Reserved either way, so the rail's buttons do not shift.
    tx.railDot.style.visibility = hidden ? 'visible' : 'hidden';
    tx.toggle.textContent = hidden ? '»' : '«';
    tx.toggle.title = hidden ? 'Show transcript' : 'Hide transcript';
    tx.toggle.setAttribute('aria-label', tx.toggle.title);
    tx.toggle.setAttribute('aria-expanded', String(!hidden));
    if (hidden) return;
    // A hidden list has no measurable height, so anything that arrived while it
    // was away leaves the view stale. Come back at the newest line.
    txView.autoScroll = true;
    tx.list.scrollTop = tx.list.scrollHeight;
    tx.hint.style.display = 'none';
  }

  function buildTranscript() {
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex;gap:${RAIL_GAP}px;align-items:stretch;`;

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
      'display:flex', 'align-items:center', 'gap:6px', 'padding:3px 8px',
      'background:#26282c', 'border-bottom:1px solid #3a3d42', 'flex:0 0 auto',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText = 'width:6px;height:6px;border-radius:50%;background:#6b6f76;flex:0 0 auto;';

    const connection = document.createElement('span');
    connection.style.cssText = 'font-weight:600;letter-spacing:.05em;font-size:9px;color:#9aa0a6;';
    connection.textContent = 'OFFLINE';

    const timer = document.createElement('span');
    timer.style.cssText = 'margin-left:auto;font-variant-numeric:tabular-nums;color:#9aa0a6;font-size:10px;';
    timer.textContent = '00:00';

    bar.appendChild(dot);
    bar.appendChild(connection);
    bar.appendChild(timer);

    const list = document.createElement('div');
    list.style.cssText = [
      // Fills whatever the fixed pane height leaves: the pane is the size it is
      // whether the call has said one word or four hundred.
      'flex:1 1 auto', 'min-height:0', 'overflow-y:auto', 'padding:6px 8px',
      // Read out of the corner of the eye mid-sentence, so it stays larger and
      // higher-contrast than the rest of the overlay.
      'font-size:12px', 'line-height:1.4', 'user-select:text', 'cursor:text',
      'overflow-wrap:break-word',
    ].join(';');

    const empty = document.createElement('div');
    empty.style.cssText = 'color:#9aa0a6;font-size:11px;font-style:italic;';
    empty.textContent = 'Waiting for the call to start…';
    list.appendChild(empty);

    const hint = document.createElement('button');
    hint.className = 'sl-pill';
    hint.type = 'button';
    hint.textContent = '↓ New text';
    hint.style.cssText = [
      'display:none', 'position:absolute', 'right:8px', 'bottom:6px',
      'background:#3a3d42', 'color:#e8e6e1', 'border:none', 'border-radius:10px',
      'padding:2px 8px', 'font-size:9px', 'cursor:pointer', 'font-family:inherit',
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

    // The rail outlives the pane: minimising takes the reading away, not the
    // controls, so this column is the same whether the pane is there or not.
    const rail = document.createElement('div');
    rail.style.cssText = [
      'position:relative',
      'display:flex', 'flex-direction:column', 'align-items:center',
      // The five buttons are centred against the pane they belong to, evenly
      // spaced and evenly inset top and bottom.
      'justify-content:center', `gap:${RAIL_ICON_GAP}px`,
      'flex:0 0 auto', `height:${PANEL_HEIGHT}px`,
    ].join(';');

    // Out of the flow deliberately: in it, the light would hold a slot at the
    // top that is empty whenever the pane is showing, pushing the buttons down
    // and leaving the rail looking bottom-heavy against the pane.
    const railDot = document.createElement('span');
    railDot.style.cssText = [
      'visibility:hidden', 'position:absolute', 'top:0', 'left:50%',
      'transform:translateX(-50%)',
      'width:6px', 'height:6px', 'border-radius:50%', 'background:#6b6f76',
    ].join(';');

    const toggle = iconButton('«', 'Hide transcript', toggleTranscriptView);
    const pause = iconButton('⏸', 'Pause transcription', togglePause);
    const save = iconButton('↓', 'Save transcript as text', saveFromButton);
    rail.appendChild(railDot);
    rail.appendChild(toggle);
    rail.appendChild(pause);
    rail.appendChild(iconButton('⧉', 'Copy transcript', copyTranscript));
    rail.appendChild(save);
    rail.appendChild(iconButton('✕', 'Clear transcript', clearTranscript));

    wrap.appendChild(pane);
    wrap.appendChild(rail);

    tx = { pane, list, empty, dot, connection, timer, hint, railDot, toggle, pause, save };
    // A rebuild (settings toggle, or replacing a stale overlay) must not lose
    // what is already on screen.
    const shown = txView.entries.slice(-MAX_RENDERED_LINES);
    if (shown.length) {
      empty.remove();
      tx.empty = null;
      for (const entry of shown) appendEntryNode(entry);
    }
    renderPaused();
    return wrap;
  }

  function appendEntryNode(entry) {
    if (!tx) return;

    if (entry.newCall && tx.list.childElementCount) {
      const divider = document.createElement('div');
      divider.style.cssText = [
        'margin:7px 0 5px', 'border-top:1px solid #2c2f34', 'padding-top:4px',
        'color:#6b6f76', 'font-size:9px', 'letter-spacing:.06em', 'text-transform:uppercase',
      ].join(';');
      divider.textContent = 'Next call';
      tx.list.appendChild(divider);
    }

    const line = document.createElement('div');
    line.style.cssText = 'margin-bottom:5px;';

    const time = document.createElement('span');
    time.style.cssText =
      'color:#9aa0a6;font-size:10px;font-variant-numeric:tabular-nums;margin-right:5px;';
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
    tx.save.style.borderColor = '#b8860b';
    tx.save.style.color = '#ffd88a';
  }

  function clearSaveOffer() {
    if (!tx) return;
    // Cleared to '' rather than to a copy of the resting colours, so the
    // stylesheet's rule — and its hover — takes the button back.
    tx.save.style.borderColor = '';
    tx.save.style.color = '';
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
