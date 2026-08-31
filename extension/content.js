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
    settings.hotkeys = window.slNormalizeHotkeys(settings.hotkeys);
    settingsReady = true;
    syncOverlay();
  });

  // The rep's last plate position. Local, and read as early as the settings
  // are: it has to be in hand before the overlay is built, or the plate appears
  // in the corner and then jumps to where they left it.
  chrome.storage.local.get({ overlayPos: null }, (stored) => {
    if (!stored || !stored.overlayPos) return;
    platePos.x = Number(stored.overlayPos.x) || 0;
    platePos.y = Number(stored.overlayPos.y) || 0;
    // hold(), not to(): if the plate is already on screen this is a correction,
    // not an animation the rep asked for.
    if (plateX && plateY) { plateX.hold(platePos.x); plateY.hold(platePos.y); }
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
    // A rebound key repaints the keycaps and nothing else. The buttons keep
    // their size — the caps sit inside a fixed column — so this cannot move
    // anything, and a flow that is part-way through logging a call is left
    // alone with its status line.
    if (changes.hotkeys) {
      settings.hotkeys = window.slNormalizeHotkeys(changes.hotkeys.newValue);
      renderKeycaps();
    }
  });

  const CONFIG = { stepTimeout: 8000, autoAdvanceDelayMs: 400 };

  // What each button is, keyed by the action it fires — the same names the
  // manifest's commands and the message protocol use.
  const ACTION_LABELS = { 'kill-and-log': 'No Answer', 'start-call': 'Call' };

  // Chrome's own shortcut for each action, as Chrome has it right now: '' for a
  // command it left unassigned. Answered by the service worker, which is the
  // only context with chrome.commands, so this starts empty and the keycaps are
  // repainted when the reply lands.
  let commandKeys = {};

  function loadCommandKeys() {
    try {
      if (!chrome.runtime || !chrome.runtime.id) return;
      chrome.runtime.sendMessage({ type: 'command-keys' }, (reply) => {
        // lastError has to be read or Chrome logs the unchecked one; a worker
        // that did not answer just means the keycaps stay as they are.
        if (chrome.runtime.lastError || !reply || !reply.keys) return;
        commandKeys = reply.keys;
        renderKeycaps();
      });
    } catch (e) { /* context invalidated — the buttons still work */ }
  }

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

  // Four sizes, named for what they are for, and nothing off the scale. The
  // overlay used to run 9/10/11/12/13px with no system behind it, and 9px is
  // below the floor for UI text however dense the tool is. Weight and colour
  // carry the rest of the hierarchy.
  // Five sizes, named for what they are for, and nothing off the scale. The
  // plate leads with its buttons, so the action label is the largest thing
  // here; everything else steps down from it. Weight and colour carry the rest
  // of the hierarchy.
  const TYPE = {
    action: 15,     // the button labels and their glyph — the point of the plate
    read: 13,       // what the prospect said, and what the extension says back
    alert: 12,      // the contact tag
    caption: 11,    // the pane's timer and its placeholder
    overline: 10,   // keycaps, LIVE, ON PAGE; the floor
  };
  // Wrapping text needs 1.4 or better; a label on one line can sit tighter.
  const LEADING = { read: 1.45, label: 1.1 };

  // Every part of the plate is a fixed size. The two action buttons are what
  // the rep aims at all day, so nothing the extension displays — a long status
  // line, a talkative prospect — is allowed to move them. The contact tag is
  // the one exception, and it is deliberate: it lands on the page scan, before
  // the rep has decided to dial, and it springs the layout open rather than
  // holding a permanently empty band.
  const CONTROLS_WIDTH = 214;   // the button column, unchanged whatever else is shown
  const TRANSCRIPT_WIDTH = 308;
  const PANEL_HEIGHT = 108;     // the buttons and the pane: one row, one height
  const BOX_PAD = 10;
  // Grouping is carried by space. Inside the button pair is 6 and the pane sits
  // 10 from them, so the two groups read as two. The stack — tag, row, status —
  // is 8, which is more than the pair and less than the plate's own padding.
  const MAIN_GAP = 10;          // the button column | the transcript pane
  const PAIR_GAP = 6;           // between the two action buttons
  const STACK_GAP = 8;          // between the tag slot, the row and the status
  const ICON = 21;              // the pane header's square buttons
  // Minimised, the pane keeps its header and nothing else: the light, the
  // timer and the three buttons. Wide enough for exactly those.
  const PANE_MINI_WIDTH = 146;
  const HEADER_GAP = 6;         // inside the pane header
  // The status is one line, always, and reserved whether or not it has
  // anything to say — that is what stops a long "Stopped: …" from resizing the
  // plate under the rep's cursor. Anything longer ellipsises and the tooltip
  // carries the rest.
  const STATUS_HEIGHT = 18;

  // How close to the viewport edge a dragged plate may come to rest.
  const DRAG_EDGE = 8;

  // The plate itself: a translucent slab over the Salesloft page rather than a
  // panel bolted onto it. The blur is what makes it read as glass; without it
  // the alpha just looks like a washed-out solid.
  const PLATE_RADIUS = 15;
  const PLATE_BG = 'rgba(20,22,25,.74)';
  const PLATE_BORDER = '1px solid rgba(255,255,255,.08)';
  const PLATE_BLUR = 'blur(26px) saturate(160%)';
  const PLATE_SHADOW =
    'inset 0 1px 0 rgba(255,255,255,.10),0 20px 46px rgba(0,0,0,.5),0 2px 6px rgba(0,0,0,.35)';
  // Three elevations, used everywhere including the panel and the settings
  // popup: the plate floats, a raised face sits on it, an inset field is cut
  // into it. Nothing in this UI is flat.
  const INSET_BG = '#0f1113';
  const INSET_BORDER = '1px solid rgba(255,255,255,.05)';
  const INSET_SHADOW = 'inset 0 2px 6px rgba(0,0,0,.6)';
  const BUTTON_SHADOW =
    'inset 0 1px 0 rgba(255,255,255,.28),inset 0 -1px 0 rgba(0,0,0,.34),0 2px 5px rgba(0,0,0,.42)';

  // Text, dimmest last.
  const FG = '#e8e6e1';
  const FG_SOFT = '#c9c6c0';
  const FG_MUTED = '#9aa0a6';
  const FG_DIM = '#6b6f76';

  // Press and release are springs now (spring.js), not transitions — a thrown
  // drag has to hand its release velocity to whatever carries it to rest, and
  // no CSS easing accepts a velocity. These two remain for the colour-only
  // states, where a transition is still the right tool.
  const EASE_OUT = 'cubic-bezier(.23,1,.32,1)';
  const RELEASE_MS = 160;

  let alertEl;          // the tinted band itself
  let alertSlot = null; // the slot that holds no space until the band arrives
  let alertIn = null;   // spring that opens that slot
  let alertDot = null;
  let alertText = null;
  let statusDot = null;
  let timerEl = null;   // wherever the call timer currently lives
  let plateX = null;    // the drag springs, kept so a resize can nudge the plate
  let plateY = null;
  let plateResizeBound = false;
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
    statusDot = null;
    alertEl = null;
    alertSlot = null;
    alertIn = null;
    alertDot = null;
    alertText = null;
    timerEl = null;
    plateX = null;
    plateY = null;
    ctl = null;
    tx = null;
  }

  // Subtle mirror of the contact alert inside the overlay — one tinted line,
  // nothing floating over the Salesloft UI. alerts.js computes the alert and
  // calls the hook below from the shared isolated world.
  // '#2f6fd0' -> '47,111,208'. SL_PALETTE is authored as hex for the opaque
  // surfaces that came first; the plate needs the same hue at an alpha, because
  // a solid mixed for an opaque background goes muddy over the blur.
  function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
    if (!m) return '47,111,208';
    const n = parseInt(m[1], 16);
    return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255}`;
  }

  function renderOverlayAlert(alert) {
    if (!alertEl || !alertIn) return;
    if (!alert || !alert.tags || !alert.tags.length) {
      // Closes the slot and takes the band's space with it, so the plate
      // settles back to its compact height. Quicker and flatter than the way in:
      // a tag leaving is bookkeeping, a tag arriving is news.
      alertIn.tune(0.26, 0);
      alertIn.to(0);
      return;
    }
    const theme = (window.SL_PALETTE || {})[alert.color] ||
      { bg: '#3a3320', border: '#b8860b', text: '#ffd88a' };
    const text = alert.tags.join(' • ');
    alertText.textContent = text;
    alertEl.title = text;   // the band is one line; narrow, it ellipsises
    const rgb = hexToRgb(theme.border);
    alertEl.style.background = `rgba(${rgb},.16)`;
    alertEl.style.borderColor = `rgba(${rgb},.42)`;
    alertEl.style.color = theme.text;
    alertDot.style.background = theme.text;
    alertIn.tune(0.44, 0.3);
    alertIn.to(1);
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
      '@keyframes sl-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '@keyframes sl-line{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      // Thin and pale: on the inset pane a system scrollbar is a bright slab
      // down the one dark surface here.
      `#${OVERLAY_ID} ::-webkit-scrollbar{width:8px}`,
      `#${OVERLAY_ID} ::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:4px}`,
      `#${OVERLAY_ID} ::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.24)}`,
      `#${OVERLAY_ID} ::-webkit-scrollbar-track{background:transparent}`,
      `#${OVERLAY_ID} button{font-family:inherit;margin:0}`,
      // Selection off on the controls, where a double-click would highlight a
      // label instead of firing the button — and on nothing else. The status
      // and the contact tag stay selectable, because "Stopped: …" is the line a
      // rep wants to paste into a message when something breaks.
      `#${OVERLAY_ID} .sl-act,#${OVERLAY_ID} .sl-icon{user-select:none}`,
      `#${OVERLAY_ID} button:focus-visible{outline:2px solid #8ab4f8;outline-offset:2px}`,

      // No transform transitions anywhere below. Every press, drag and reveal
      // on this plate is a spring writing an inline transform (spring.js), and
      // a CSS transition on the same property would fight it — the spring would
      // set a value and the transition would ease toward it, so the motion
      // would arrive late and overshoot twice. Colour is still a transition,
      // because colour has no velocity to hand over.
      `#${OVERLAY_ID} .sl-act{transition:filter ${RELEASE_MS}ms ease}`,
      `#${OVERLAY_ID} .sl-key{background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.16);` +
        `box-shadow:inset 0 1px 0 rgba(255,255,255,.08);border-radius:4px;padding:1px 5px;` +
        `font-size:${TYPE.overline}px;font-weight:600;letter-spacing:.04em;white-space:nowrap}`,
      // The small square buttons in the pane header. Their resting look lives
      // here so a highlight set inline — the save nudge, the paused state — can
      // be cleared back to it with an empty string.
      `#${OVERLAY_ID} .sl-icon{background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.09);` +
        `color:${FG_SOFT};border-radius:5px;padding:0;font-size:${TYPE.read}px;line-height:1;` +
        `cursor:pointer;display:flex;align-items:center;justify-content:center;flex:0 0 auto;` +
        `transition:background-color ${RELEASE_MS}ms ease,border-color ${RELEASE_MS}ms ease,color ${RELEASE_MS}ms ease}`,
      // Saving is the one thing here that produces a file, so it carries the
      // amber the rest of the extension already uses for "this writes something".
      `#${OVERLAY_ID} .sl-icon.sl-save{background:rgba(184,134,11,.18);border-color:rgba(184,134,11,.6);color:#ffd88a}`,
      `#${OVERLAY_ID} .sl-pill{transition:filter ${RELEASE_MS}ms ease}`,
      `#${OVERLAY_ID} .sl-live{animation:sl-pulse 1.6s ease-in-out infinite}`,

      // Hover is a mouse state. A touchscreen fires it on tap and then leaves
      // it stuck on the last thing touched, so it is gated rather than global.
      '@media (hover:hover) and (pointer:fine){' +
        `#${OVERLAY_ID} .sl-act:hover{filter:brightness(1.10)}` +
        `#${OVERLAY_ID} .sl-icon:hover{background:rgba(255,255,255,.12);color:#fff}` +
        `#${OVERLAY_ID} .sl-icon.sl-save:hover{background:rgba(184,134,11,.3);color:#ffd88a}` +
        `#${OVERLAY_ID} .sl-pill:hover{filter:brightness(1.25)}}`,

      // A flow is running and clicks are being ignored, so the buttons say so
      // rather than sitting there looking live. The press spring is suppressed
      // in the same state (see pressable's guard in buildOverlay), so a press
      // that is being thrown away does not answer as though it was not.
      `#${OVERLAY_ID}.sl-busy .sl-act{filter:saturate(.4) brightness(.72);cursor:progress}`,

      // Reduced motion: the springs already snap (spring.js checks the query on
      // every call), so all that is left to stop is the looping LIVE dot.
      '@media (prefers-reduced-motion:reduce){' +
        `#${OVERLAY_ID} .sl-live{animation:none}` +
        `#${OVERLAY_ID} .sl-line{animation:none}}`,
    ].join('');
    return style;
  }

  // Which keys to print on a button: the rep's own binding, which fires on this
  // page, and the shortcut Chrome currently has for the same action, which
  // fires from any tab. Either can be unset — a rep who works from the number
  // pad has no use for Chrome's combination, and Chrome drops a suggested key
  // that collides with something already installed — so a keycap appears only
  // for a key that really does something.
  function keysFor(action) {
    const hotkeys = settings.hotkeys || {};
    const keys = [
      window.slHotkeyLabel(hotkeys[action], true),
      window.slHotkeyLabel(commandKeys[action], true),
    ];
    // Bind the key Chrome already has and both caps read the same; one is
    // enough to say it.
    return keys.filter((key, i) => key && keys.indexOf(key) === i);
  }

  // Written as nodes rather than innerHTML: a binding is whatever key the rep
  // pressed, carried through storage, and it is never worth interpolating that
  // into markup on the Salesloft page.
  function paintKeys(button, action) {
    const row = button.querySelector('.sl-keys');
    if (!row) return;
    const keys = keysFor(action);
    row.textContent = '';
    for (const key of keys) {
      const cap = document.createElement('span');
      cap.className = 'sl-key';
      cap.textContent = key;
      row.appendChild(cap);
    }
    const label = ACTION_LABELS[action];
    button.title = keys.length ? `${label} — ${keys.join(' or ')}` : `${label} — no key bound`;
  }

  function renderKeycaps() {
    if (!ctl) return;
    paintKeys(ctl.kill, 'kill-and-log');
    paintKeys(ctl.call, 'start-call');
  }

  // ✕ / ▶ over the label over the keys that do the same thing. The keycaps are
  // what the extra height buys: a rep who reads them once stops reaching for
  // the mouse. They are also the only place the extension says what the keys
  // are while the rep is working, so they show what is bound now rather than
  // what the manifest once suggested.
  function actionButton(glyph, action, background, glow, onClick) {
    const b = document.createElement('button');
    b.className = 'sl-act';
    b.type = 'button';
    // Glyph at the top, name and keys at the foot, pushed apart. The rep reads
    // this button at a glance a hundred times a day, so the two things it has
    // to say sit at the two ends of the face rather than stacked in the middle
    // — the name lands on the same baseline on both buttons whatever the glyph
    // above it is doing. Left-aligned for the same reason: two centred labels
    // of different lengths give the pair no shared edge to read down.
    b.innerHTML =
      `<span style="font-size:${TYPE.action}px;line-height:1;opacity:.9">${glyph}</span>` +
      '<span style="display:flex;flex-direction:column;gap:7px;align-items:flex-start;max-width:100%;min-width:0">' +
        `<span style="font-size:${TYPE.action}px;font-weight:600;letter-spacing:-.012em;line-height:${LEADING.label}">${ACTION_LABELS[action]}</span>` +
        // Clipped at the button's edge rather than allowed to paint over its
        // neighbour: a long pair of caps is the one thing here whose width the
        // extension does not choose.
        '<span class="sl-keys" style="display:flex;gap:4px;max-width:100%;min-width:0;overflow:hidden"></span>' +
      '</span>';
    b.style.cssText = [
      'flex:1 1 0', 'min-width:0', 'height:100%', 'box-sizing:border-box',
      'display:flex', 'flex-direction:column', 'align-items:flex-start', 'justify-content:space-between',
      'gap:8px', 'padding:11px 10px', 'border:none', 'border-radius:11px',
      'cursor:pointer', 'color:#fff', `background:${background}`,
      // The glow is the button's own colour thrown onto the plate under it, so
      // the two faces read as lit rather than pasted on.
      `box-shadow:${BUTTON_SHADOW},${glow}`,
      'text-align:start', 'font-family:inherit', 'user-select:none',
    ].join(';');
    b.addEventListener('click', onClick);
    paintKeys(b, action);
    return b;
  }

  // Where the rep last put the plate, as an offset from the bottom-left anchor.
  // Local rather than synced: it is a position on this monitor, and a rep with
  // a laptop and a 27" screen does not want one to dictate the other.
  const platePos = { x: 0, y: 0 };
  let savePosHandle = null;
  // Set once the rep has actually moved the plate. Without it the very first
  // paint of every page load would write the position straight back.
  let plateMoved = false;

  function savePlatePos() {
    clearTimeout(savePosHandle);
    // Re-armed on every painted frame, so the write lands 250ms after motion
    // *stops* rather than 250ms after the release: a thrown plate is still
    // travelling then, and saving mid-flight would restore it next page load to
    // somewhere it only passed through.
    savePosHandle = setTimeout(() => {
      try {
        chrome.storage.local.set({ overlayPos: { x: platePos.x, y: platePos.y } });
      } catch (e) { /* context invalidated by a reload; a position is not worth throwing over */ }
    }, 250);
  }

  // Keeps the plate on screen with a small margin. Returns offsets, not
  // coordinates: the box is anchored bottom-left and only ever transformed.
  function plateBounds(box) {
    const r = box.getBoundingClientRect();
    return {
      minX: platePos.x + (DRAG_EDGE - r.left),
      maxX: platePos.x + (window.innerWidth - DRAG_EDGE - r.right),
      minY: platePos.y + (DRAG_EDGE - r.top),
      maxY: platePos.y + (window.innerHeight - DRAG_EDGE - r.bottom),
    };
  }

  // Drag the plate by its own chrome. Unlike the design prototype there is no
  // host canvas scaling the page, so pointer deltas are already layout pixels
  // and need no scale correction.
  function makeDraggable(box) {
    const paint = () => {
      box.style.transform = `translate3d(${platePos.x}px,${platePos.y}px,0)`;
      if (plateMoved) savePlatePos();
    };
    const X = window.slSpring(platePos.x, (v) => { platePos.x = v; paint(); }, 0.4, 0);
    const Y = window.slSpring(platePos.y, (v) => { platePos.y = v; paint(); }, 0.4, 0);

    let sx = 0, sy = 0, ox = 0, oy = 0, hist = [], b = null, on = false, moved = false;

    box.addEventListener('pointerdown', (e) => {
      // Anything the rep might be aiming at, or reading, is not a drag handle.
      // The transcript list is marked because its text is selectable, and a
      // drag starting inside it would fight the selection.
      if (e.target.closest('button,input,textarea,select,[data-sl-nodrag]')) return;
      on = true;
      moved = false;
      try { box.setPointerCapture(e.pointerId); } catch (err) { /* not available */ }
      sx = e.clientX; sy = e.clientY;
      ox = platePos.x; oy = platePos.y;
      hist = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      b = plateBounds(box);
      box.style.cursor = 'grabbing';
      box.style.willChange = 'transform';
    });

    box.addEventListener('pointermove', (e) => {
      if (!on) return;
      const rawX = e.clientX - sx, rawY = e.clientY - sy;
      // A few pixels of slop, so a click that wobbles is still a click.
      if (!moved && Math.abs(rawX) + Math.abs(rawY) < 4) return;
      moved = true;
      plateMoved = true;
      hist.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      if (hist.length > 6) hist.shift();
      // hold(), not to(): while the pointer is down the plate *is* the pointer,
      // and a spring chasing it would trail behind the cursor.
      X.hold(window.slBand(ox + rawX, b.minX, b.maxX, box.offsetWidth));
      Y.hold(window.slBand(oy + rawY, b.minY, b.maxY, box.offsetHeight));
    });

    const release = () => {
      if (!on) return;
      on = false;
      box.style.cursor = 'grab';
      box.style.willChange = '';
      if (!moved) return;
      const a = hist[0], z = hist[hist.length - 1];
      const dt = Math.max(16, z.t - a.t) / 1000;
      const vx = (z.x - a.x) / dt, vy = (z.y - a.y) / dt;
      const bb = plateBounds(box);
      X.tune(0.4, 0.06); Y.tune(0.4, 0.06);
      X.to(window.slClamp(platePos.x + window.slProject(vx), bb.minX, bb.maxX), vx);
      Y.to(window.slClamp(platePos.y + window.slProject(vy), bb.minY, bb.maxY), vy);
    };
    box.addEventListener('pointerup', release);
    box.addEventListener('pointercancel', release);

    // A window that got smaller can leave the plate off screen entirely, and a
    // plate the rep cannot reach is a plate they cannot put back.
    if (!plateResizeBound) {
      plateResizeBound = true;
      window.addEventListener('resize', () => {
        if (!overlayEl) return;
        const bb = plateBounds(overlayEl);
        const nx = window.slClamp(platePos.x, bb.minX, bb.maxX);
        const ny = window.slClamp(platePos.y, bb.minY, bb.maxY);
        if (nx !== platePos.x || ny !== platePos.y) {
          plateMoved = true;
          plateX.to(nx); plateY.to(ny);
        }
      });
    }
    plateX = X;
    plateY = Y;
    paint();
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
      // Anchored bottom-left, then moved by transform alone, so the rep's own
      // position survives every rebuild without touching the layout.
      'position:fixed', 'bottom:16px', 'left:16px', 'z-index:999999',
      'box-sizing:border-box',
      'display:flex', 'flex-direction:column', `gap:${STACK_GAP}px`,
      // Glass, not a panel: the Salesloft page stays legible underneath, which
      // is what lets the plate sit over content instead of beside it. The blur
      // does the work — without it the alpha reads as a washed-out solid.
      `background:${PLATE_BG}`,
      `backdrop-filter:${PLATE_BLUR}`, `-webkit-backdrop-filter:${PLATE_BLUR}`,
      `border:${PLATE_BORDER}`, `border-radius:${PLATE_RADIUS}px`,
      `padding:${BOX_PAD}px`, 'font-family:system-ui,sans-serif', `font-size:${TYPE.read}px`,
      // Light text on a dark surface renders heavy on macOS. This box is its
      // own root, so it is set once here rather than on each part of it.
      '-webkit-font-smoothing:antialiased', '-moz-osx-font-smoothing:grayscale',
      `color:${FG}`,
      `box-shadow:${PLATE_SHADOW}`,
      // The whole plate is the drag handle; the controls opt out individually.
      'cursor:grab', 'touch-action:none',
    ].join(';');
    if (busy) box.classList.add('sl-busy');
    box.appendChild(overlayStyle());

    // The contact tag holds no space until the page scan reports one. That scan
    // lands before the rep has decided to dial, so the layout settles well
    // ahead of the aim — which is what buys the plate its compact resting size
    // instead of a permanently reserved, usually empty band.
    alertSlot = document.createElement('div');
    alertSlot.style.cssText = 'overflow:hidden;flex:0 0 auto';

    alertEl = document.createElement('div');
    alertEl.style.cssText = [
      'display:flex', 'align-items:center', 'gap:7px',
      'padding:4px 8px', 'border-radius:8px',
      'border:1px solid transparent', 'box-shadow:inset 0 1px 0 rgba(255,255,255,.06)',
      'min-width:0',
    ].join(';');

    alertDot = document.createElement('span');
    alertDot.style.cssText = 'width:5px;height:5px;border-radius:50%;flex:0 0 auto';

    alertText = document.createElement('span');
    alertText.style.cssText = [
      `font-size:${TYPE.alert}px`, 'font-weight:600', 'letter-spacing:-.005em',
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis', 'min-width:0',
    ].join(';');

    // Says where the tag came from, so the band is not mistaken for something
    // the extension decided.
    const alertSource = document.createElement('span');
    alertSource.style.cssText = [
      'margin-inline-start:auto', `font-size:${TYPE.overline}px`, 'letter-spacing:.05em',
      'opacity:.6', 'flex:0 0 auto',
    ].join(';');
    alertSource.textContent = 'ON PAGE';

    alertEl.appendChild(alertDot);
    alertEl.appendChild(alertText);
    alertEl.appendChild(alertSource);
    alertSlot.appendChild(alertEl);
    box.appendChild(alertSlot);
    alertIn = window.slSlot(alertSlot, { axis: 'col', gap: STACK_GAP, duration: 0.44, bounce: 0.3 });

    const main = document.createElement('div');
    main.style.cssText = 'display:flex;align-items:stretch;gap:0;';

    // The buttons and the pane are one row at one height, so the block reads as
    // a block: the buttons finish exactly where the pane does instead of
    // stopping short of it.
    const row = document.createElement('div');
    row.style.cssText = [
      `flex:0 0 ${CONTROLS_WIDTH}px`, `width:${CONTROLS_WIDTH}px`, 'box-sizing:border-box',
      'display:flex', `gap:${PAIR_GAP}px`,
      `height:${PANEL_HEIGHT}px`,
    ].join(';');

    const kill = actionButton('✕', 'kill-and-log',
      'linear-gradient(180deg,#d9503f 0%,#a02c1d 100%)',
      '0 10px 20px rgba(190,50,40,.16)', killAndLog);
    const call = actionButton('▶', 'start-call',
      'linear-gradient(180deg,#2aa55c 0%,#13623a 100%)',
      '0 10px 20px rgba(30,140,80,.16)', startCall);
    row.appendChild(kill);
    row.appendChild(call);
    ctl = { kill, call, row };
    // A press whose click is about to be ignored must not answer as though it
    // was not, so the spring is gated on the same flag the click checks.
    window.slPressable(kill, () => !busy);
    window.slPressable(call, () => !busy);

    main.appendChild(row);
    if (hasTranscript) main.appendChild(buildTranscript());
    box.appendChild(main);

    // Under the whole box rather than inside the button column: a sentence
    // reads better across the width than down 214px, and the row above keeps
    // its full height instead of giving a third of it up to one word.
    const statusRow = document.createElement('div');
    statusRow.style.cssText = [
      'display:flex', 'align-items:center', 'gap:7px',
      `height:${STATUS_HEIGHT}px`, 'flex:0 0 auto',
      'padding-inline-start:2px', 'box-sizing:border-box',
      // Takes the box's width without setting it: "Stopped: Timed out waiting
      // for element." must not be what decides how wide the plate is.
      'width:0', 'min-width:100%',
    ].join(';');

    statusDot = document.createElement('span');
    statusDot.style.cssText =
      `width:5px;height:5px;border-radius:50%;background:${FG_DIM};flex:0 0 auto`;

    statusEl = document.createElement('div');
    statusEl.style.cssText = [
      'flex:1 1 auto', 'min-width:0',
      `font-size:${TYPE.read}px`, 'letter-spacing:-.005em', `color:${FG}`,
      // One line, always. The tooltip carries whatever does not fit.
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';');
    statusEl.textContent = 'Ready';

    statusRow.appendChild(statusDot);
    statusRow.appendChild(statusEl);

    // With no pane there is nowhere else for the call timer to live, so it
    // takes the free end of the status line — the only thing a call changes on
    // a plate with transcription off.
    if (!hasTranscript) {
      timerEl = document.createElement('span');
      timerEl.style.cssText = [
        'margin-inline-start:auto', `font-size:${TYPE.read}px`, 'font-variant-numeric:tabular-nums',
        'letter-spacing:-.01em', `color:${FG_MUTED}`, 'padding-inline-end:2px', 'flex:0 0 auto',
      ].join(';');
      timerEl.textContent = '00:00';
      statusRow.appendChild(timerEl);
    }

    box.appendChild(statusRow);

    document.body.appendChild(box);
    overlayEl = box;
    makeDraggable(box);
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

  // The pane's placeholder — "Waiting…", "Listening…", "Cleared." It was built
  // in two places at two different sizes; one builder means one size.
  function emptyLine(text) {
    const el = document.createElement('div');
    el.style.cssText = `color:#9aa0a6;font-size:${TYPE.caption}px;font-style:italic;`;
    el.textContent = text;
    return el;
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
    // Minimising takes the reading away, not the controls: the list goes and
    // the pane collapses onto its own header, which still carries the light,
    // the timer, pause and save. The design draws the pane open only — it has
    // no closed state — so this is the smallest thing that honours its shape
    // without putting a control out of reach.
    tx.list.style.display = hidden ? 'none' : '';
    tx.hint.style.display = 'none';
    // Width as well as height, or minimising would reclaim nothing: the wrapper
    // stretches to the button row either way, so a pane that only lost its list
    // would leave the plate exactly as wide as before. The label goes and the
    // timer stays — a call in progress is still worth reading at a glance.
    tx.pane.style.width = hidden ? `${PANE_MINI_WIDTH}px` : `${TRANSCRIPT_WIDTH}px`;
    tx.pane.style.flexBasis = hidden ? `${PANE_MINI_WIDTH}px` : `${TRANSCRIPT_WIDTH}px`;
    tx.pane.style.height = hidden ? 'auto' : `${PANEL_HEIGHT}px`;
    tx.connection.style.display = hidden ? 'none' : '';
    tx.toggle.textContent = hidden ? '»' : '«';
    tx.toggle.title = hidden ? 'Show transcript' : 'Hide transcript';
    tx.toggle.setAttribute('aria-label', tx.toggle.title);
    tx.toggle.setAttribute('aria-expanded', String(!hidden));
    if (hidden) return;
    // A hidden list has no measurable height, so anything that arrived while it
    // was away leaves the view stale. Come back at the newest line.
    txView.autoScroll = true;
    tx.list.scrollTop = tx.list.scrollHeight;
  }

  function buildTranscript() {
    // The gap to the buttons lives on the wrapper rather than on the row, so
    // that a future collapse animates one box's width and takes its own gap
    // with it instead of leaving a hole.
    const wrap = document.createElement('div');
    wrap.style.cssText = [
      'overflow:hidden', 'box-sizing:border-box',
      `padding-inline-start:${MAIN_GAP}px`, 'flex:0 0 auto',
    ].join(';');

    const pane = document.createElement('div');
    pane.style.cssText = [
      'position:relative', `flex:0 0 ${TRANSCRIPT_WIDTH}px`, `width:${TRANSCRIPT_WIDTH}px`,
      `height:${PANEL_HEIGHT}px`, 'box-sizing:border-box',
      'display:flex', 'flex-direction:column',
      // The one inset surface on the plate: the transcript is a well cut into
      // the glass, not another face sitting on it.
      `background:${INSET_BG}`, `border:${INSET_BORDER}`, 'border-radius:11px',
      `box-shadow:${INSET_SHADOW}`,
      'overflow:hidden',
    ].join(';');

    // The header carries what the old rail carried, inside the pane it belongs
    // to: the light, what it says, how long the call has run, and the three
    // things a rep does to a running transcript.
    const bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'align-items:center', `gap:${HEADER_GAP}px`, 'padding:5px 7px',
      'background:rgba(255,255,255,.035)', 'border-bottom:1px solid rgba(255,255,255,.05)',
      'flex:0 0 auto',
    ].join(';');

    const dot = document.createElement('span');
    dot.style.cssText =
      `width:6px;height:6px;border-radius:50%;background:${FG_DIM};flex:0 0 auto`;

    const connection = document.createElement('span');
    connection.style.cssText = [
      'font-weight:600', 'letter-spacing:.08em', `font-size:${TYPE.overline}px`,
      `color:${FG_MUTED}`, 'flex:0 0 auto',
    ].join(';');
    connection.textContent = 'OFFLINE';

    const timer = document.createElement('span');
    timer.style.cssText = [
      `font-size:${TYPE.caption}px`, 'font-variant-numeric:tabular-nums', `color:${FG_MUTED}`,
      // Pushes the buttons to the far end, so the reading half and the acting
      // half of the header sit at opposite edges.
      'margin-inline-end:auto', 'margin-inline-start:2px', 'flex:0 0 auto',
    ].join(';');
    timer.textContent = '00:00';
    timerEl = timer;

    const toggle = iconButton('«', 'Hide transcript', toggleTranscriptView);
    const pause = iconButton('⏸', 'Pause transcription', togglePause);
    const save = iconButton('↓', 'Save transcript as text', saveFromButton);
    save.classList.add('sl-save');

    bar.appendChild(dot);
    bar.appendChild(connection);
    bar.appendChild(timer);
    bar.appendChild(toggle);
    bar.appendChild(pause);
    bar.appendChild(save);

    const list = document.createElement('div');
    // Selectable text, so it is not a drag handle: a drag starting in here
    // would fight the selection the rep is trying to make.
    list.setAttribute('data-sl-nodrag', '');
    list.style.cssText = [
      // Fills whatever the fixed pane height leaves: the pane is the size it is
      // whether the call has said one word or four hundred.
      'flex:1 1 auto', 'min-height:0', 'overflow-y:auto', 'padding:7px 9px',
      // Read out of the corner of the eye mid-sentence, so it stays larger and
      // higher-contrast than the rest of the plate.
      `font-size:${TYPE.read}px`, `line-height:${LEADING.read}`, `color:${FG}`,
      'user-select:text', 'cursor:text',
      // A prospect's sentence wraps to three lines often enough that an orphan
      // on the last one is the normal case, not the edge one.
      'overflow-wrap:break-word', 'text-wrap:pretty',
      // The top line fades under the header instead of being guillotined by it,
      // which is what says the list continues upward.
      '-webkit-mask-image:linear-gradient(180deg,transparent 0,#000 8px,#000 100%)',
      'mask-image:linear-gradient(180deg,transparent 0,#000 8px,#000 100%)',
    ].join(';');

    const empty = emptyLine('Waiting for the call to start…');
    list.appendChild(empty);

    const hint = document.createElement('button');
    hint.className = 'sl-pill';
    hint.type = 'button';
    hint.textContent = '↓ New text';
    hint.style.cssText = [
      'display:none', 'position:absolute', 'inset-inline-end:8px', 'bottom:6px',
      'background:rgba(255,255,255,.14)', `color:${FG}`, 'border:1px solid rgba(255,255,255,.12)',
      'border-radius:10px', 'padding:2px 8px', `font-size:${TYPE.overline}px`,
      'cursor:pointer', 'font-family:inherit',
      'backdrop-filter:blur(8px)', '-webkit-backdrop-filter:blur(8px)',
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
    wrap.appendChild(pane);

    for (const b of [toggle, pause, save]) window.slPressable(b);

    tx = { pane, list, empty, dot, connection, timer, hint, toggle, pause, save };
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
        'color:#6b6f76', `font-size:${TYPE.overline}px`, 'letter-spacing:.06em', 'text-transform:uppercase',
      ].join(';');
      divider.textContent = 'Next call';
      tx.list.appendChild(divider);
    }

    const line = document.createElement('div');
    // Each line rises in rather than blinking on. A transcript arrives while
    // the rep is listening, not looking, so movement in the corner of the eye
    // is what says a new line landed. Stopped under reduced motion by the rule
    // in overlayStyle().
    line.className = 'sl-line';
    line.style.cssText =
      `margin-bottom:7px;animation:sl-line .3s ${EASE_OUT} both;`;

    const time = document.createElement('span');
    time.style.cssText =
      `color:${FG_MUTED};font-size:${TYPE.caption}px;font-variant-numeric:tabular-nums;margin-inline-end:6px;`;
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
    // The rail is gone — the light now lives in the pane header, which stays
    // put when the reading is minimised, so there is nothing to mirror it onto.
    tx.dot.style.animation =
      live && !window.slReducedMotion() ? 'sl-pulse 1.6s ease-in-out infinite' : 'none';
    tx.dot.title = `Transcription: ${tx.connection.textContent}`;
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
    tx.empty = emptyLine('Cleared.');
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
    if (timerEl) timerEl.textContent = '00:00';
    txView.timerHandle = setInterval(() => {
      // timerEl is the pane header's timer with transcription on and the status
      // line's with it off — the call is timed either way.
      if (timerEl) timerEl.textContent = window.slFormatClock((Date.now() - txView.startedAt) / 1000);
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

  // ---------------- In-page key bindings ----------------
  // The rep's own keys, set in the settings popup. This is the layer Chrome
  // cannot offer: chrome://extensions/shortcuts takes a Ctrl or Alt
  // combination and nothing else, so a number pad binding can only be heard
  // here, by the page it fires on. Chrome's commands still cover the from-any-
  // tab case, and both routes end at the same two functions.
  function isTyping() {
    const el = document.activeElement;
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  document.addEventListener(
    'keydown',
    (e) => {
      // Typing a note during a call must never dial. This is why a bare letter
      // is a usable binding at all, and why the settings popup can say so.
      if (isTyping()) return;
      // A held key repeats; a held dial key would queue flows behind the busy
      // flag rather than doing anything the rep asked for.
      if (e.repeat) return;
      const pressed = window.slHotkeyFromEvent(e);
      if (!pressed) return;
      const hotkeys = settings.hotkeys || {};
      if (pressed === hotkeys['kill-and-log']) { e.preventDefault(); killAndLog(); }
      else if (pressed === hotkeys['start-call']) { e.preventDefault(); startCall(); }
    },
    true
  );

  // Chrome has no event for a shortcut being reassigned, and the page the rep
  // reassigns it on is chrome://extensions/shortcuts — another tab. Coming back
  // to Salesloft is the moment the keycaps can be wrong, so that is when they
  // are re-read.
  loadCommandKeys();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) loadCommandKeys();
  });

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
