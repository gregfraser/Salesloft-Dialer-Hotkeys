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
    if (changes.notInServiceDisposition) settings.notInServiceDisposition = changes.notInServiceDisposition.newValue;
    // The third control is present or absent, never hidden in place, so
    // turning it on or off rebuilds the overlay the same way the transcript
    // pane does. The pair above it keeps its exact geometry either way; all
    // that changes is 34px of plate below them.
    if (changes.notInService) {
      settings.notInService = changes.notInService.newValue;
      syncOverlay(true);
    }
    if (changes.pageOverlay) {
      settings.pageOverlay = changes.pageOverlay.newValue;
      syncOverlay();
    }
    // A different way of drawing the same controls, so the plate is rebuilt
    // rather than restyled.
    if (changes.compactBar) {
      settings.compactBar = changes.compactBar.newValue;
      syncOverlay(true);
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

  // confirmTimeout is deliberately short and deliberately not stepTimeout: it
  // is how long to wait for a confirmation dialog that may not exist in this
  // Salesloft build at all, so its absence has to cost a moment, not 8s.
  const CONFIG = { stepTimeout: 8000, autoAdvanceDelayMs: 400, confirmTimeout: 1500 };

  // What each button is, keyed by the action it fires — the same names the
  // manifest's commands and the message protocol use.
  const ACTION_LABELS = {
    'kill-and-log': 'No Answer',
    'start-call': 'Call',
    'not-in-service': 'Not in Service',
  };

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
  // Good for anything *inside* a container — which is every control this
  // extension clicks — but not for a container that is itself positioned:
  // offsetParent is null for a position:fixed element, so a modal read as
  // hidden however plainly it is on screen. isShown() below is for those.
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;

  // Is this element actually on screen? Measured rather than inferred, because
  // the one place it is needed is a modal, and a modal is position:fixed.
  function isShown(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  const loggerRoot = () =>
    document.querySelector('[data-testid="popout-logger-container"]') || document;

  function buttonByText(text, root = document) {
    const t = text.toLowerCase();
    return [...root.querySelectorAll('button')].find(
      (b) => visible(b) && b.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === t
    );
  }

  // `what` names the thing being waited for, so a timeout says which step gave
  // up rather than "Timed out waiting for element" — which told a rep nothing
  // and told whoever read the bug report even less.
  function waitFor(fn, timeout = CONFIG.stepTimeout, interval = 100, what) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const tick = () => {
        let result;
        try { result = fn(); } catch (e) { /* keep polling */ }
        if (result) return resolve(result);
        if (Date.now() - start > timeout) {
          return reject(new Error(what ? `could not find ${what}` : 'Timed out waiting for element'));
        }
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

  // Salesloft moves, and when it does the status strip has room for one
  // sentence. This is the rest of it: which element each step actually picked,
  // in the page's own console, where a rep can copy it into a bug report. Quiet
  // by default — console.debug is hidden unless Verbose is on in DevTools — and
  // it never carries anything the prospect said.
  function trace(step, el) {
    try {
      console.debug('[dialer]', step, el && {
        tag: el.tagName,
        label: el.getAttribute && (el.getAttribute('aria-label') || el.getAttribute('data-testid')),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      });
    } catch (e) { /* never let logging break a flow */ }
  }

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

  // Every list that could be the one the toggle opened, best first. Downshift
  // names it (`aria-controls` / `aria-owns`, on the toggle or on the input and
  // root beside it, or the `-menu` twin of a `-toggle-button` / `-input` id),
  // and that is worth using, because the alternative is searching the page and
  // the page is full of decoys. After the named ones comes any list that is on
  // screen now and was not before the click.
  //
  // `shownBefore` is the lists that were *on screen* before the click, not the
  // ones that merely existed. Downshift keeps its menu in the DOM while closed
  // (an empty listbox with no height), so recording every list ruled out the
  // very one the toggle was about to open, and the flow took whatever other
  // list React happened to re-render for the menu. That is the rep's
  // `could not find "No Answer"` with the option plainly on screen.
  function dispositionLists(toggle, shownBefore) {
    const out = [];
    const add = (el) => { if (el && !out.includes(el) && isShown(el)) out.push(el); };
    const near = [toggle, toggle.closest('[role="combobox"],[aria-haspopup]'),
      ...((toggle.closest('div') || toggle).querySelectorAll('input,[role="combobox"]'))];
    for (const el of near) {
      if (!el) continue;
      for (const attr of ['aria-controls', 'aria-owns']) {
        for (const id of (el.getAttribute(attr) || '').split(/\s+/)) {
          if (id) add(document.getElementById(id));
        }
      }
      if (el.id && /-(toggle-button|input)$/.test(el.id)) {
        add(document.getElementById(el.id.replace(/-(toggle-button|input)$/, '-menu')));
      }
    }
    for (const el of document.querySelectorAll(OPEN_LISTS)) {
      if (!shownBefore.has(el)) add(el);
    }
    return out;
  }

  // The option, looked for in each candidate list in turn. Re-resolved on every
  // poll rather than settled once, so a menu React replaces as it renders is
  // read in its current form, and a list that appeared alongside it cannot win
  // just by being found first.
  function dispositionOption(toggle, shownBefore, value) {
    const want = value.toLowerCase();
    for (const list of dispositionLists(toggle, shownBefore)) {
      const option = [...list.querySelectorAll('[role="option"],li,[role="menuitem"]')].find(
        (li) => isShown(li) && li.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === want
      );
      if (option) return option;
    }
    return null;
  }

  // The status strip holds one sentence. This is what the next bug report needs:
  // what the toggle said about itself and what each candidate list held.
  function dumpDisposition(toggle, shownBefore) {
    try {
      const attrs = {};
      for (const a of ['id', 'role', 'aria-controls', 'aria-owns', 'aria-haspopup', 'aria-expanded']) {
        if (toggle.hasAttribute(a)) attrs[a] = toggle.getAttribute(a);
      }
      const lists = dispositionLists(toggle, shownBefore).map((l) => ({
        tag: l.tagName, id: l.id, role: l.getAttribute('role'),
        items: [...l.querySelectorAll('[role="option"],li,[role="menuitem"]')]
          .slice(0, 12).map((li) => li.textContent.replace(/\s+/g, ' ').trim().slice(0, 40)),
      }));
      console.warn('[dialer] disposition option not found. Toggle:', attrs, 'Candidate lists:', lists);
    } catch (e) { /* never let logging break a flow */ }
  }

  // The disposition field as an element that outlives the click. Salesloft
  // swaps the toggle's chevron for a clear (×) button once a value is picked,
  // so the toggle the flow clicked is detached by the time it reads back, and
  // the value is in an input beside it rather than in any button's text.
  // Downshift puts that input and the toggle side by side, so the nearest
  // ancestor holding exactly one input is the field. More than one means the
  // climb has left the field (Sentiment, the due date), and it stops there.
  function dispositionField(toggle) {
    let el = toggle;
    for (let i = 0; i < 5 && el && el !== document.body; i++) {
      const inputs = el.querySelectorAll('input').length;
      if (inputs === 1) return el;
      if (inputs > 1) break;
      el = el.parentElement;
    }
    return toggle.closest('div') || toggle;
  }

  // What the field says it holds now: the input's value, or else its text with
  // any list inside it left out, so an open menu's options never read as the
  // choice.
  function dispositionValue(field) {
    const input = field.matches('input') ? field : field.querySelector('input');
    if (input && typeof input.value === 'string' && input.value.trim()) return input.value.trim();
    const copy = field.cloneNode(true);
    copy.querySelectorAll(OPEN_LISTS + ',[role="option"]').forEach((n) => n.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const OPEN_LISTS = '[role="listbox"],[role="menu"],ul';

  async function setDisposition(value) {
    const toggle = await waitFor(() => {
      const t = findDispositionToggle();
      return t && t.offsetParent !== null ? t : null;
    });

    // Scoped to the list the toggle opened, never to the document. It used to
    // be `[role="option"], [role="listbox"] li, ul li` across the whole page,
    // and `ul li` matches every list item Salesloft renders — so on a contact
    // who has been logged "Not in Service" a dozen times, the activity feed and
    // the cadence sidebar are full of elements whose entire text is exactly the
    // disposition being looked for. The click landed on one of those, the field
    // stayed empty, and the flow carried on as though it had chosen.
    const shownBefore = new Set([...document.querySelectorAll(OPEN_LISTS)].filter(isShown));
    const field = dispositionField(toggle);
    realClick(toggle);
    const option = await waitFor(
      () => dispositionOption(toggle, shownBefore, value),
      CONFIG.stepTimeout, 100, `"${value}" in the Disposition list`
    ).catch((e) => { dumpDisposition(toggle, shownBefore); throw e; });
    trace('disposition option', option);
    realClick(option);

    // Read it back. "Never log with a wrong or missing disposition" was only an
    // intention while nothing checked, and a click that misses is silent — the
    // control simply stays empty and the next step logs the call without it.
    // Read from the field captured before the click, and if React has replaced
    // even that, from wherever the field is now.
    const current = () => {
      if (field.isConnected) return field;
      const t = findDispositionToggle();
      return t ? dispositionField(t) : field;
    };
    await waitFor(
      () => dispositionValue(current()).toLowerCase().includes(value.toLowerCase()),
      CONFIG.stepTimeout
    ).catch(() => {
      try {
        const f = current();
        console.warn('[dialer] disposition did not read back. Field:',
          { tag: f.tagName, connected: f.isConnected, read: dispositionValue(f).slice(0, 80) });
      } catch (e) { /* never let logging break a flow */ }
      throw new Error(`"${value}" did not take in the Disposition field`);
    });
  }

  // ---------------- Not in Service (DOM) ----------------
  // The steps below are Salesloft's own, taken from a recording of the flow
  // done by hand rather than guessed at. Tier order is the same as everywhere
  // else in this extension: the accessible name first, a data-testid second, a
  // generated styled-components class never — those change on every deploy.

  // Salesloft splits logging into a button and a caret beside it. "Log Only" is
  // in the caret's menu, and it is the right one here: completing the step is
  // what removing the person from the cadence replaces.
  function logMenuToggle() {
    const root = loggerRoot();
    const nodes = [...root.querySelectorAll('button,[role="button"],[data-testid="menuToggle"]')];
    return (
      nodes.find((n) => visible(n) && /log only/i.test(n.getAttribute('aria-label') || '')) ||
      nodes.find((n) => visible(n) && n.matches('[data-testid="menuToggle"]')) ||
      null
    );
  }

  // The opened menu is portalled to the end of the body, so this is not scoped
  // to the logger the way the buttons are.
  function menuItemByText(text) {
    const t = text.toLowerCase();
    return [...document.querySelectorAll('[role="menuitem"],[role="option"],li,button')].find(
      (el) => el.offsetParent !== null && el.textContent.replace(/\s+/g, ' ').trim().toLowerCase() === t
    );
  }

  // What a screen reader would call this element. An icon button gets its name
  // from any of several places, and reading only `aria-label` is how the
  // cadence control came to be unfindable: Salesloft names it from the
  // `<title>` inside its SVG — which is what a recorded
  // `::-p-aria(Remove person from cadence) >>>> ::-p-aria([role="graphics-symbol"])`
  // was saying all along — so the attribute lookup found nothing and the step
  // timed out after logging the call.
  function accessibleName(el) {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return label;

    const owned = el.getAttribute('aria-labelledby');
    if (owned) {
      const text = owned.split(/\s+/)
        .map((id) => { const node = document.getElementById(id); return node ? node.textContent : ''; })
        .join(' ');
      if (text.trim()) return text;
    }

    const title = el.getAttribute('title');
    if (title && title.trim()) return title;

    // An icon has no text, so its name lives in the <title> of its own artwork.
    const drawn = el.querySelector('title');
    if (drawn && drawn.textContent.trim()) return drawn.textContent;

    return el.textContent || '';
  }

  // The cadence's own control, on the page behind the logger rather than in it.
  const REMOVE_FROM_CADENCE = /remove\s+(?:person|this person|them)?\s*from\s+(?:the\s+)?cadence/i;

  // Every named control on the page, for when the one we wanted was not there.
  // Names only — never a transcript line, never anything the prospect said.
  function dumpNames() {
    try {
      const names = [...document.querySelectorAll('button,[role="button"],a[href]')]
        .filter((el) => isShown(el))
        .map((el) => accessibleName(el).replace(/\s+/g, ' ').trim())
        .filter((name) => name && name.length < 60);
      console.warn('[dialer] no single Remove from cadence control for this contact. Named controls on the page:',
        [...new Set(names)].sort());
    } catch (e) { /* never let logging break a flow */ }
  }

  // Every control on the page named for taking someone out of a cadence.
  function removalControls() {
    const found = [];
    for (const el of document.querySelectorAll('button,[role="button"],a[href]')) {
      // Cheap first. Resolving a proper accessible name for every control on a
      // Salesloft page, ten times a second for eight seconds, is not free — but
      // the word has to appear *somewhere* on the element first, and
      // textContent already reaches into the svg <title> where this one keeps
      // its name. Only aria-labelledby puts the text in another element
      // entirely, and almost nothing uses it.
      const attrs = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
      if (!el.hasAttribute('aria-labelledby') && !/cadence/i.test(attrs + ' ' + (el.textContent || ''))) continue;
      // Not filtered on being visible: the queue draws a row's control only
      // while that row is hovered, and a control the rep cannot see is still
      // one this flow must account for before it clicks any of them.
      if (el.disabled) continue;
      const name = accessibleName(el).replace(/\s+/g, ' ').trim();
      if (REMOVE_FROM_CADENCE.test(name)) found.push(el);
    }
    // Falling back to text content means an outer container holding a control
    // can match as well as the control inside it. The innermost is the control.
    return found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  }

  // The name as a whole word or phrase, so "Eric Kersten" is not found inside
  // "Erica Kerstenson".
  function namePattern(name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?=$|[^\\p{L}\\p{N}])`, 'iu');
  }

  // A task row is well under this; anything bigger is a region of the page,
  // not a row. A backstop only: the landmarks below are the real boundary.
  const ROW_TEXT_LIMIT = 800;

  // What no queue row ever contains: the page's own heading, the logger, this
  // extension's plate. Each one carries the contact's name, so a climb that
  // reaches one has left every row behind and would find the name there
  // instead — which is exactly how the only control on a page, belonging to
  // someone else, would come to read as this person's.
  function removalLandmarks() {
    return [
      window.slContactNameElement && window.slContactNameElement(document),
      document.querySelector('[data-testid="popout-logger-container"]'),
      document.getElementById('sl-hotkey-overlay'),
    ].filter(Boolean);
  }

  // Is this control about the person named? Salesloft puts one of these on
  // the rows of the task queue, each for a different person, identical but for
  // the row around them. The row is the first container around the control
  // that holds any text of its own: in the queue, the icon cell's parent,
  // which carries "Call 2 … Corey Adamonis at Omnicell". The name has to be
  // in *that*, and nowhere further up.
  //
  // Further up is where both field failures came from. The queue draws a
  // row's control only while the mouse is over that row, so the one control on
  // the page was whichever row the rep's pointer rested on: first the flow
  // clicked it, and then a looser version of this rule climbed from it to the
  // whole queue, found the contact's row in there, and would have clicked it
  // all the same.
  function removalIsFor(el, controls, pattern, landmarks) {
    for (let node = el.parentElement; node && node !== document.body; node = node.parentElement) {
      if (controls.some((other) => other !== el && node.contains(other))) return false;
      if (landmarks.some((mark) => node.contains(mark))) return false;
      if ((node.textContent || '').length > ROW_TEXT_LIMIT) return false;
      if (hasTextBeyond(node, el)) return pattern.test(spacedText(node));
    }
    return false;
  }

  // Whether `node` holds any text that is not inside `el`.
  function hasTextBeyond(node, el) {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (!el.contains(t) && t.nodeValue.trim()) return true;
    }
    return false;
  }

  // Put the pointer, as far as the page can tell, over every place the
  // contact's name is written outside the landmarks, so the queue draws the
  // remove control on their row the way it does under the rep's hand. Only
  // hover events: nothing is clicked here, and whatever this reveals is still
  // held to removalIsFor() before anything is.
  function revealRowsFor(pattern, landmarks) {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hosts = [];
    while (walker.nextNode() && hosts.length < 20) {
      const t = walker.currentNode;
      const host = t.parentElement;
      if (!host || !pattern.test(t.nodeValue)) continue;
      if (landmarks.some((mark) => mark.contains(host))) continue;
      hosts.push(host);
    }
    for (const host of hosts) hoverOver(host);
  }

  function hoverOver(el) {
    const opts = { bubbles: true, cancelable: true, view: window, relatedTarget: null };
    try {
      el.dispatchEvent(new PointerEvent('pointerover', opts));
      el.dispatchEvent(new MouseEvent('mouseover', opts));
      for (let n = el, i = 0; n && n !== document.body && i < 8; n = n.parentElement, i++) {
        n.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
        n.dispatchEvent(new MouseEvent('mouseenter', { ...opts, bubbles: false }));
      }
    } catch (e) { /* a hover that cannot be sent only means nothing is revealed */ }
  }

  // A row's text with its pieces kept apart. textContent runs adjacent
  // elements together with no space — "Account-Based TargetingEric Kersten at
  // Acme" — and a name glued to the word before it is not a whole word.
  function spacedText(node) {
    const parts = [];
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) parts.push(walker.currentNode.nodeValue);
    return parts.join(' ');
  }

  // What the removal step saw, for the next bug report: whose name it looked
  // for, and for each remove control on the page, the row text it read.
  function dumpRemoval(person) {
    try {
      const controls = removalControls();
      const landmarks = removalLandmarks();
      const rows = controls.map((el) => {
        let node = el.parentElement;
        while (node && node !== document.body && !hasTextBeyond(node, el)) node = node.parentElement;
        return {
          shown: isShown(el),
          row: node ? spacedText(node).replace(/\s+/g, ' ').trim().slice(0, 160) : '',
          landmarked: !!node && landmarks.some((mark) => node.contains(mark)),
        };
      });
      console.warn('[dialer] remove from cadence: looked for', JSON.stringify(person),
        '(title:', JSON.stringify(document.title), ') and saw', rows);
    } catch (e) { /* never let logging break a flow */ }
  }

  // The one removal control for this person, or a reason there is not exactly
  // one. Two is as much a stop as none: guessing between them is how the wrong
  // person comes out of a cadence.
  function removalFor(person, reveal) {
    const pattern = namePattern(person);
    const landmarks = removalLandmarks();
    if (reveal) revealRowsFor(pattern, landmarks);
    const controls = removalControls();
    const mine = controls.filter((el) => removalIsFor(el, controls, pattern, landmarks));
    if (mine.length === 1) return { el: mine[0] };
    return { count: mine.length, total: controls.length };
  }

  // Waits for exactly one control for this person, and throws a sentence the
  // status strip can carry when there is not.
  async function findRemovalFor(person) {
    let last = { count: 0, total: 0 };
    let tick = 0;
    const found = await waitFor(() => {
      // Hover on the first poll and about once a second after, in case the
      // queue re-renders the row out from under the first one.
      last = removalFor(person, tick++ % 10 === 0);
      return (last.el || last.count > 1) ? last : null;
    }, CONFIG.stepTimeout).catch(() => null);
    if (found && found.el) return found.el;
    // By this point nobody has been removed, but the rep has to finish by hand
    // and nobody can see why. The names that *were* on the page go to the
    // console, where the next report can pick them up.
    dumpNames();
    dumpRemoval(person);
    if (last.count > 1) {
      throw new Error(`found ${last.count} Remove from cadence controls for ${person}, so none was clicked`);
    }
    throw new Error(last.total
      ? `none of the ${last.total} Remove from cadence controls is beside ${person}'s name, so none was clicked`
      : `could not find the Remove from cadence control for ${person}`);
  }

  // Salesloft asks before it removes someone. The dialog is not in the
  // recording of this flow, so its absence is a normal outcome and not a
  // failure — but a dialog that does appear and has no button this recognises
  // is, because leaving one open would mean the rep thinks the person is out of
  // the cadence when they are still in it.
  const CONFIRM_TEXTS = [
    'remove from cadence', 'remove person from cadence', 'remove', 'confirm',
    'yes, remove', 'yes', 'ok', 'delete', 'continue',
  ];

  const DIALOGS = '[role="dialog"],[role="alertdialog"]';

  // A dialog is only this removal's confirmation if it says so. Being new is
  // not enough: Salesloft throws toasts for unrelated things — "Task deleted
  // for <someone else>", with a View and a dismiss — and a toast carrying a
  // dialog role arrives in the same window and matches on novelty alone. So a
  // candidate has to mention what it is about, and anything else on screen is
  // left where it is rather than being answered.
  const REMOVAL_WORDS = /cadence|remove/i;

  // `existing` is whatever was already open when the removal was clicked.
  // Salesloft's own logger popout carries role="dialog", so without that
  // snapshot this matched the popout the flow had just been driving, found no
  // button it recognised, and reported a removal that had in fact succeeded as
  // "Stopped: … Finish manually."
  async function confirmCadenceRemoval(existing) {
    let dialog;
    try {
      dialog = await waitFor(
        () => [...document.querySelectorAll(DIALOGS)].find(
          (d) => !existing.has(d) && isShown(d) && REMOVAL_WORDS.test(d.textContent || '')
        ),
        CONFIG.confirmTimeout
      );
    } catch (e) {
      return; // no confirmation step — the click above was the whole of it
    }
    const buttons = [...dialog.querySelectorAll('button')].filter(visible);
    const button = buttons.find(
      (b) => CONFIRM_TEXTS.indexOf(b.textContent.replace(/\s+/g, ' ').trim().toLowerCase()) !== -1
    );
    if (!button) {
      // Name them. This dialog's wording is the one part of the flow that was
      // never recorded, so a stop here has to hand back what it actually saw
      // rather than leaving the next person to guess at it.
      const labels = buttons.map((b) => b.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      throw new Error(
        labels.length
          ? `the removal dialog offers ${labels.map((l) => `"${l}"`).join(', ')} — confirm it there`
          : 'a removal dialog is open — confirm it there'
      );
    }
    realClick(button);
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

  // A dead number. Log the call under its own disposition and take the person
  // out of the cadence, so tomorrow's list does not hand it back.
  //
  // Same invariant as killAndLog: the disposition is set before anything logs,
  // and any failed step throws and leaves the call unlogged rather than logging
  // it wrong. The removal is last for the same reason — a person who is out of
  // the cadence with no call logged against them is the worse half-state.
  async function runNotInService() {
    // Gated here as well as at the control, because the panel and the worker
    // can both reach this directly and a stale window must not drive a feature
    // that has since been turned off.
    if (busy || !settings.notInService) return;
    setBusy(true);
    const disposition = settings.notInServiceDisposition || 'Not in Service';
    try {
      // Whose removal this is, settled before anything is touched. The queue
      // beside a contact carries an identical remove control for every person
      // in it, so without a name to hold each one against, "the" control is
      // whichever comes first on the page, and that is someone else as often
      // as not. Checked now, while nothing is ended or logged, so a page this
      // cannot read stops the flow clean rather than halfway.
      //
      // Only on the contact's own page. Dialled from a list or a cadence, the
      // heading is that page's name, not a person's, and a queue row that
      // happens to mention it would read as theirs.
      if (!onPersonPage()) {
        throw new Error('Not in Service removes from a cadence only on the contact\'s own page, so nothing was logged or removed');
      }
      const person = window.slContactName ? window.slContactName(document) : '';
      if (!person) throw new Error('could not tell whose page this is, so nothing was logged or removed');
      setStatus(`Finding ${person} in the cadence…`);
      await findRemovalFor(person).catch((err) => {
        throw new Error(`${err.message}. Nothing was logged`);
      });

      const endBtn = buttonByText('End Call');
      if (endBtn) {
        setStatus('Ending call…');
        realClick(endBtn);
        await sleep(CONFIG.autoAdvanceDelayMs);
      }

      setStatus(`Setting "${disposition}"…`);
      await setDisposition(disposition);
      await sleep(CONFIG.autoAdvanceDelayMs);

      setStatus('Logging…');
      const menu = await waitFor(
        logMenuToggle, CONFIG.stepTimeout, 100, 'the Log & Complete menu');
      trace('log menu', menu);
      realClick(menu);
      const logOnly = await waitFor(
        () => menuItemByText('Log Only'), CONFIG.stepTimeout, 100, '"Log Only" in that menu');
      trace('Log Only', logOnly);
      realClick(logOnly);
      await sleep(CONFIG.autoAdvanceDelayMs);

      // Found again rather than reused: logging re-renders the queue, and the
      // rows can move under a reference taken before it. Held to the same rule
      // — exactly one control, beside this person's name.
      setStatus(`Removing ${person} from cadence…`);
      const remove = await findRemovalFor(person);
      trace('remove from cadence', remove);
      hoverOver(remove);
      // Snapshot first: only a dialog that was not already open can be this
      // removal's own.
      const openDialogs = new Set(document.querySelectorAll(DIALOGS));
      realClick(remove);
      await confirmCadenceRemoval(openDialogs);

      setStatus(`Logged ${disposition} ✓, ${person} removed from cadence`, 'ok');
    } catch (err) {
      setStatus(`Stopped: ${err.message}. Finish manually.`, 'err');
    } finally {
      setBusy(false);
    }
  }

  // One press arms, a second within three seconds commits. This is the only
  // control on the plate that takes a person out of a cadence, and undoing that
  // means finding them and adding them back by hand — but a modal mid-call is
  // exactly what this extension does not do, so the confirmation lives in the
  // control itself: it says what it is about to do and waits.
  const ARM_MS = 3000;
  let armed = false;
  let armHandle = null;

  function disarm() {
    clearTimeout(armHandle);
    armHandle = null;
    if (!armed) return;
    armed = false;
    renderSecondary();
  }

  function notInService() {
    if (busy || !settings.notInService) return;
    // The arming *is* the confirmation, so it has to be somewhere the rep can
    // see it. Two surfaces have no strip to turn red — the page controls off
    // entirely, and the compact bar, which deliberately does not carry this
    // control — and arming silently on either would mean a second keypress
    // removing someone from a cadence with nothing having asked. The panel
    // confirms on its own surface and commits directly, so it never lands here.
    if (!nis) {
      setStatus('Not in Service needs the full plate or the floating panel', 'err');
      return;
    }
    if (!armed) {
      armed = true;
      clearTimeout(armHandle);
      armHandle = setTimeout(disarm, ARM_MS);
      renderSecondary();
      // Short enough to survive the 214px strip when there is no pane beside
      // it; the button itself is already saying what "again" would do.
      setStatus('Press again to confirm', 'warn');
      return;
    }
    disarm();
    runNotInService();
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
      // `confirmed` means the rep already answered the question on the surface
      // they were looking at — the floating panel arms and confirms itself.
      // Without this the panel's confirming press only armed the content
      // script, so the removal took four presses rather than two and the last
      // two had to land inside a 3s window.
      if (msg.action === 'not-in-service') {
        if (msg.confirmed) runNotInService();
        else notInService();
      }
    }

    // Transcription traffic, relayed by the background worker: content scripts
    // do not receive the offscreen document's broadcasts directly.
    if (msg.type === 'transcript' && msg.payload) addTranscriptEntry(msg.payload);
    if (msg.type === 'transcription-status') {
      setTranscriptConnection(msg.state, msg.detail);
      // Only a real error takes the status strip, and "not armed" is not one:
      // it is the normal state before the rep has armed capture once, and the
      // strip's error colour belongs to a call that may now be half-logged.
      // That prompt lives in the pane instead, where there is room to say which
      // key and why. Written straight to the element rather than through
      // setStatus(), because the panel already has this message from the worker
      // and would otherwise show it twice.
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

  // The plate has always started the call timer the moment call-detect sees a
  // call, so the number climbed with no word beside it. This is that word.
  // It is the detection path talking, so it only ever adds: a flow that is
  // part-way through logging owns the status line (busy), and a
  // "Stopped: ... Finish manually." has to outlive the call it is about.
  function setCallLive(live) {
    if (statusDot) statusDot.style.background = live ? CALL_LIVE : FG_DIM;
    if (live && !busy) setStatus('Connected');
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
  const PANEL_HEIGHT = 104;     // the buttons and the pane: one row, one height
  const BOX_PAD = 10;
  // Grouping is carried by space. Inside the button pair is 6 and the pane sits
  // 10 from them, so the two groups read as two. The stack — tag, row, status —
  // is 8, which is more than the pair and less than the plate's own padding.
  const MAIN_GAP = 10;          // the button column | the transcript pane
  const PAIR_GAP = 6;           // between the two action buttons
  const STACK_GAP = 8;          // between the tag slot, the row and the status
  // The pane header's square buttons. 24 is the floor a pointer target may
  // have (WCAG 2.2 target size, minimum); 21 was under it, and these three are
  // aimed at mid-call.
  const ICON = 24;
  // Collapsed, the pane is a rail: one column of 24px controls with the light
  // above them, and nothing else. 24 + 4 of padding either side and there is
  // no room for a word — which is the point, because the base row below it
  // already carries the timer and the line count. A rail that repeated them
  // was 96px wide for information that was on screen twice.
  const PANE_MINI_WIDTH = 34;
  // The third control. Two thirds the height of a keycap row and a quarter of
  // the pair's, because it is the thing a rep reaches for once in a hundred
  // dials, not once in three.
  const SECONDARY_HEIGHT = 26;
  // The strip is the whole button column when the transcript pane is open
  // beside it, and its mark and key alone when the plate is narrow: at 278
  // there is no room for a name, and the tooltip still carries it.
  // 80, not 64: the mark is 13, the gap 6, and a real cap reads "Ctrl⇧7" at
  // about 44. A box sized for a one-character cap clips the one Chrome
  // actually assigns.
  const NIS_TIGHT_WIDTH = 80;
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
  // The status dot while a call is up. Green, not the pane's recording red:
  // that one means "we are transcribing", this one means "the call is
  // connected", and both can be true at once.
  const CALL_LIVE = '#5fc98d';

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
  let timerEl = null;   // the call timer, on the base row
  let linesEl = null;   // how many lines are waiting, while the pane is a rail
  let plateX = null;    // the drag springs, kept so a resize can nudge the plate
  let plateY = null;
  let plateResizeBound = false;
  let overlayEl = null; // the box this copy of the script built, if any
  let ctl = null;       // the two action buttons, or null with no overlay
  let nis = null;       // the Not in Service strip, or null when it is off
  let tx = null;        // transcript DOM refs, or null when the pane is not built

  // Transcript state outlives the DOM: rebuilding the overlay (a settings
  // toggle, a stale copy being replaced) must not lose lines that are already
  // on screen, or a call would end with nothing to save.
  const txView = {
    entries: [],
    autoScroll: true,
    paused: false,
    minimized: false,      // the pane is hidden; everything else carries on
    notArmed: false,       // Chrome has not authorised a capture of this tab yet
    armKey: '',            // and this is the key that would, as Chrome has it
    connection: 'offline', // what the worker last said, so a rebuilt pane opens on it
    unsaved: false,        // lines added since the last save
    pendingNewCall: false, // draw a divider before the next call's first line
    startedAt: 0,
    timerHandle: null,
  };

  // The lines are kept in full for saving; only the rendered nodes are capped,
  // so a whole day of dialing cannot pile up DOM on the Salesloft page.
  const MAX_RENDERED_LINES = 400;

  // A contact can be on screen without the route saying so — a person-detail
  // view rendered inside another section is still one person — so the DOM gets
  // a say after the route.
  const CONTACT_DOM = '[data-testid*="person-detail" i]';

  // The logger popout is a weaker signal than it looks. It opens over whatever
  // the rep was on and *stays* open, so on a cadence's People list it is there
  // beside 170 rows with nothing dialled — which is not a contact, and not
  // somewhere a dialer plate belongs. But it is also the only thing on screen
  // once a rep dials from that list, and taking the buttons away mid-call is
  // the one outcome worse than showing them early. So the popout counts only
  // while a call is actually up: browsing a cadence gets nothing, calling in
  // one gets the buttons wherever it was started from.
  const LOGGER_DOM = '[data-testid="popout-logger-container"]';

  // Strictly a contact's own page: the route or the person-detail marker, and
  // never the logger popout, which is on screen wherever a call was dialled
  // from. The plate may show on a list mid-call; a cadence removal may not.
  function onPersonPage() {
    try {
      return !!((window.slIsContactUrl && window.slIsContactUrl(location.href)) ||
        document.querySelector(CONTACT_DOM));
    } catch (e) {
      return false;
    }
  }

  function onContactPage() {
    if (window.slIsContactUrl && window.slIsContactUrl(location.href)) return true;
    try {
      if (document.querySelector(CONTACT_DOM)) return true;
      if (!document.querySelector(LOGGER_DOM)) return false;
      // busy as well as live: a flow part-way through logging keeps its plate
      // and its status line even as the call it is about ends under it.
      return lastCallState === 'IN_CALL' || busy;
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
    linesEl = null;
    alertEl = null;
    alertSlot = null;
    alertIn = null;
    alertDot = null;
    alertText = null;
    timerEl = null;
    plateX = null;
    plateY = null;
    ctl = null;
    nis = null;
    tx = null;
    // The arming window belongs to the control that is armed. An overlay
    // replaced mid-window would otherwise leave a press half-made against a
    // button that is no longer on the page.
    disarm();
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
    alertIn.tune(0.26, 0.08);
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
      // A keycap is a shape with a character centred in it, so it is centred
      // like one. It used to be padding alone — 1px top and bottom around an
      // uncontrolled line-height — which left a single character sitting in a
      // 14px sliver, and letter-spacing applies after the last character too,
      // so a one-character cap was pushed left of its own middle. An explicit
      // line-height, a minimum size and inline-flex centring fix all three, and
      // the padding-inline compensates the trailing letter-space.
      `#${OVERLAY_ID} .sl-key{display:inline-flex;align-items:center;justify-content:center;` +
        `min-width:18px;min-height:16px;box-sizing:border-box;` +
        `background:rgba(0,0,0,.24);border:1px solid rgba(255,255,255,.16);` +
        `box-shadow:inset 0 1px 0 rgba(255,255,255,.08);border-radius:4px;padding:2px 4px 2px 5px;` +
        `font-size:${TYPE.overline}px;font-weight:600;line-height:1;letter-spacing:.04em;white-space:nowrap}`,
      // The third control. A raised face like the pane header rather than a
      // third gradient: it is a smaller thing than the pair above it and has to
      // read that way at a glance, or the plate grows a third primary action.
      `#${OVERLAY_ID} .sl-second{display:flex;align-items:center;gap:6px;` +
        `box-sizing:border-box;width:100%;height:${SECONDARY_HEIGHT}px;padding:0 8px;` +
        `border-radius:5px;background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.07);` +
        `box-shadow:inset 0 1px 0 rgba(255,255,255,.06);color:${FG_SOFT};` +
        `font-size:${TYPE.alert}px;font-weight:500;cursor:pointer;` +
        `transition:background-color ${RELEASE_MS}ms ease,border-color ${RELEASE_MS}ms ease,color ${RELEASE_MS}ms ease}`,
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
        `#${OVERLAY_ID} .sl-second:not(.sl-armed):hover{background:rgba(255,255,255,.09);` +
          `border-color:rgba(255,255,255,.14);color:${FG}}` +
        `#${OVERLAY_ID} .sl-icon:hover{background:rgba(255,255,255,.12);color:#fff}` +
        `#${OVERLAY_ID} .sl-icon.sl-save:hover{background:rgba(184,134,11,.3);color:#ffd88a}` +
        `#${OVERLAY_ID} .sl-pill:hover{filter:brightness(1.25)}}`,

      // A flow is running and clicks are being ignored, so the buttons say so
      // rather than sitting there looking live. The press spring is suppressed
      // in the same state (see pressable's guard in buildOverlay), so a press
      // that is being thrown away does not answer as though it was not.
      `#${OVERLAY_ID}.sl-busy .sl-act,#${OVERLAY_ID}.sl-busy .sl-second` +
        '{filter:saturate(.4) brightness(.72);cursor:progress}',

      // Reduced motion: the springs already snap (spring.js checks the query on
      // every call), so all that is left to stop is the looping LIVE dot.
      '@media (prefers-reduced-motion:reduce){' +
        `#${OVERLAY_ID} .sl-live{animation:none}` +
        `#${OVERLAY_ID} .sl-line{animation:none}}`,
    ].join('');
    return style;
  }

  // Which key to print on a button: the rep's own binding, which fires on this
  // page. Chrome's shortcut for the same action fires from any tab, but it is
  // printed only when the action has no binding of its own.
  //
  // Both used to show, and the pair stopped reading as a pair the moment the
  // rep rebound anything: Chrome takes the suggested keys it can get and
  // silently drops the ones already claimed, so it typically holds one of the
  // two actions and not the other. Rebind to F11/F12 and one button reads
  // "F11 Ctrl⇧9" while its neighbour reads "F12" — the rep's eye lands on the
  // difference, not the keys. The button is a reminder of the key under the
  // hand; the tooltip still names both, and the settings popup is where the
  // full account of what Chrome actually has lives.
  //
  // Either can still be unset — a rep who works from the number pad has no use
  // for Chrome's combination, and Chrome may have left it unassigned — so a
  // keycap appears only for a key that really does something.
  function keysFor(action) {
    const hotkeys = settings.hotkeys || {};
    const own = window.slHotkeyLabel(hotkeys[action], true);
    if (own) return [own];
    const anywhere = window.slHotkeyLabel(commandKeys[action], true);
    return anywhere ? [anywhere] : [];
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
    // The cap shows one key; the tooltip is where the other one still lives,
    // along with where each of them works.
    const hotkeys = settings.hotkeys || {};
    const own = window.slHotkeyLabel(hotkeys[action], true);
    const anywhere = window.slHotkeyLabel(commandKeys[action], true);
    const said = [];
    if (own) said.push(`${own} here and on this page`);
    if (anywhere && anywhere !== own) said.push(`${anywhere} from any tab`);
    const label = ACTION_LABELS[action];
    button.title = said.length ? `${label} — ${said.join(', ')}` : `${label} — no key bound`;
  }

  function renderKeycaps() {
    if (ctl) {
      paintKeys(ctl.kill, 'kill-and-log');
      paintKeys(ctl.call, 'start-call');
    }
    if (nis) paintKeys(nis.el, 'not-in-service');
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
      'gap:8px', 'padding:10px', 'border:none', 'border-radius:11px',
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

  // Compact is a way of drawing the page controls, not a fourth surface: the
  // same two actions, the same status, the same keys, in a 42px bar instead of
  // a 160px plate. It is off by default — the full plate is what a rep gets
  // unless they ask otherwise — and it stands down the moment a call is up,
  // because mid-call is exactly when the large targets earn their size.
  const COMPACT_ACTION = 26;

  function compactMode() {
    return !!settings.compactBar && lastCallState !== 'IN_CALL' && !busy;
  }

  // Drawn, like every other centred mark on this plate. The first cut of this
  // button set textContent and centred it with flex, which is the one thing the
  // icon rule exists to stop: flex centres the line box and a glyph sits
  // wherever its own font puts it inside that box, so ✕ and ▶ both rode high
  // and off-centre in a 26px square. The big faces get away with text glyphs
  // because they are corner-aligned and nothing is being centred; these are
  // centred, so they are SVG.
  function miniAction(icon, action, background, onClick) {
    const b = document.createElement('button');
    b.className = 'sl-act sl-mini';
    b.type = 'button';
    b.innerHTML = icon;
    b.style.cssText = [
      `width:${COMPACT_ACTION}px`, `height:${COMPACT_ACTION}px`, 'flex:0 0 auto',
      'display:flex', 'align-items:center', 'justify-content:center',
      'border:none', 'border-radius:7px', 'cursor:pointer', 'color:#fff',
      `background:${background}`, `box-shadow:${BUTTON_SHADOW}`,
      'line-height:1', 'font-family:inherit', 'user-select:none', 'padding:0',
    ].join(';');
    b.addEventListener('click', onClick);
    // No keycap fits at 26px, so the key lives in the tooltip alone. paintKeys
    // writes that tooltip whether or not there is a row to draw caps into.
    paintKeys(b, action);
    window.slPressable(b, () => !busy);
    return b;
  }

  // The third control. Everything about it is smaller than the pair above: a
  // raised face rather than a gradient, one line rather than two, 26px rather
  // than 108. That is the whole point of it — a rep reaches for this once in a
  // hundred dials, and a control that looks like the other two would be read as
  // often as them.
  function buildSecondary() {
    const b = document.createElement('button');
    b.className = 'sl-second';
    b.type = 'button';
    // Mark, label, key — the same left-to-right order the pair reads in, at a
    // quarter of the height. The shape lives in overlayStyle(); only the colour
    // changes below, and only when the control is armed.
    b.innerHTML =
      `<span style="display:flex;flex:0 0 auto;align-items:center">${window.SL_ICONS.block}</span>` +
      '<span class="sl-second-label" style="flex:1 1 auto;min-width:0;text-align:start;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>' +
      '<span class="sl-keys" style="display:flex;gap:4px;flex:0 0 auto"></span>';
    b.addEventListener('click', notInService);
    // Same gate as the pair: a press whose click is about to be swallowed by
    // the busy flag must not answer as though it was not.
    window.slPressable(b, () => !busy);

    const wrap = document.createElement('div');
    wrap.style.cssText = ['flex:0 0 auto', 'box-sizing:border-box', 'display:flex'].join(';');
    wrap.appendChild(b);

    nis = { el: b, wrap, label: b.querySelector('.sl-second-label') };
    renderSecondaryWidth();
    renderSecondary();
    paintKeys(b, 'not-in-service');
    return wrap;
  }

  // Two widths, and which one is in use follows the pane beside it: with the
  // transcript open the plate is 552 and the strip is the whole button column;
  // collapsed or with transcription off it is 278 or 234, and the name does not
  // fit next to a status line that has to hold "Stopped: …". The mark and the
  // key stay, so the control is still a control; the tooltip keeps the name.
  function renderSecondaryWidth() {
    if (!nis) return;
    const wide = !!settings.transcription && !txView.minimized;
    nis.wrap.style.width = `${wide ? CONTROLS_WIDTH : NIS_TIGHT_WIDTH}px`;
    nis.el.style.justifyContent = wide ? '' : 'center';
    nis.label.style.display = wide ? '' : 'none';
  }

  // Rest, and armed. Armed is the red the rest of the extension uses for a
  // thing that has already gone wrong, because this is the one control here
  // whose result cannot be undone from this plate — and it says what it is
  // about to do rather than repeating its own name.
  function renderSecondary() {
    if (!nis) return;
    const theme = window.SL_PALETTE.red;
    nis.label.textContent = armed ? 'Remove from cadence?' : ACTION_LABELS['not-in-service'];
    nis.el.classList.toggle('sl-armed', armed);
    nis.el.style.background = armed ? theme.bg : '';
    nis.el.style.borderColor = armed ? theme.border : '';
    nis.el.style.color = armed ? theme.text : '';
    nis.el.setAttribute('aria-pressed', String(armed));
    // The keycap goes while it is asking. The question is longer than the
    // label it replaces, and the key is not news at the moment the control is
    // waiting to hear whether it should go ahead — a truncated
    // "Remove from cad…" is the one thing here a rep must not have to guess at.
    const keys = nis.el.querySelector('.sl-keys');
    if (keys) keys.style.display = armed ? 'none' : 'flex';
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

  // The dot, the line, the timer and the line count. One builder, because the
  // full plate and the compact bar both show exactly this.
  function buildStatusRow() {
    const statusRow = document.createElement('div');
    statusRow.style.cssText = [
      'display:flex', 'align-items:center', 'gap:7px',
      'flex:1 1 auto', 'min-width:0', 'height:100%',
      'padding-inline-start:2px', 'box-sizing:border-box',
    ].join(';');

    statusDot = document.createElement('span');
    statusDot.style.cssText =
      `width:5px;height:5px;border-radius:50%;background:${FG_DIM};flex:0 0 auto`;

    statusEl = document.createElement('div');
    // Named, so nothing has to find it by its position in the box. It has
    // moved twice now, and each time something that counted children broke.
    statusEl.className = 'sl-status';
    statusEl.style.cssText = [
      'flex:1 1 auto', 'min-width:0',
      `font-size:${TYPE.read}px`, 'letter-spacing:-.005em', `color:${FG}`,
      // One line, always. The tooltip carries whatever does not fit.
      'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';');
    statusEl.textContent = 'Ready';

    statusRow.appendChild(statusDot);
    statusRow.appendChild(statusEl);

    // An overlay is not always built before the call it belongs to. So it opens
    // on the state the page is actually in, set here rather than through
    // setCallLive() because that one announces to the panel and a rebuild is
    // not news.
    if (lastCallState === 'IN_CALL') {
      statusEl.textContent = 'Connected';
      statusDot.style.background = CALL_LIVE;
    }

    // The timer lives here now whether or not there is a pane, and the line
    // count joins it while the pane is collapsed. Both used to be drawn inside
    // the pane as well, which is how a 96px rail came to be 96px: it was
    // repeating what the line below it already said.
    timerEl = document.createElement('span');
    timerEl.style.cssText = [
      'margin-inline-start:auto', `font-size:${TYPE.read}px`, 'font-variant-numeric:tabular-nums',
      'letter-spacing:-.01em', `color:${FG_MUTED}`, 'flex:0 0 auto',
    ].join(';');
    timerEl.textContent = '00:00';
    statusRow.appendChild(timerEl);

    linesEl = document.createElement('span');
    linesEl.style.cssText = [
      `font-size:${TYPE.caption}px`, `color:${FG_MUTED}`, 'flex:0 0 auto',
      'padding-inline-end:2px', 'display:none',
    ].join(';');
    statusRow.appendChild(linesEl);

    return statusRow;
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
    alertIn = window.slSlot(alertSlot, { axis: 'col', gap: STACK_GAP, duration: 0.26, bounce: 0.08 });

    // Compact: one 42px bar, and nothing else is built. The pane, the strip and
    // the pair's large faces all belong to the full plate.
    if (compactMode()) {
      buildCompactRow(box);
      finishOverlay(box);
      return;
    }

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

    // One row under the pair, carrying both the third control and the status.
    // They used to be two stacked rows, and the strip was 214 wide inside a
    // plate that is 278 or 552 — so the corner under the transcript pane was
    // bare, which is what read as unfinished. Sharing the line fills that
    // corner and gives back 26px of plate at the same time.
    const baseRow = document.createElement('div');
    baseRow.style.cssText = [
      'display:flex', 'align-items:center', `gap:${STACK_GAP}px`,
      `height:${SECONDARY_HEIGHT}px`, 'flex:0 0 auto', 'box-sizing:border-box',
      // Takes the box's width without setting it: "Stopped: Timed out waiting
      // for element." must not be what decides how wide the plate is.
      'width:0', 'min-width:100%',
    ].join(';');
    if (settings.notInService) baseRow.appendChild(buildSecondary());

    baseRow.appendChild(buildStatusRow());
    box.appendChild(baseRow);
    finishOverlay(box);
  }

  // The compact bar: the status the full plate shows, and the same two actions
  // at 26px. No strip — a control that removes someone from a cadence does not
  // belong on the surface a rep chose because they wanted the plate out of the
  // way — and no pane, which is what the panel and the full plate are for.
  function buildCompactRow(box) {
    box.style.padding = '8px';
    // The same width as the button column it stands in for, so switching modes
    // moves the plate's contents and not its left edge. Sized by content it
    // came out at 103px, which reads as a stray chip rather than the controls.
    box.style.width = `${CONTROLS_WIDTH}px`;
    box.style.boxSizing = 'border-box';
    const row = document.createElement('div');
    row.style.cssText = [
      'display:flex', 'align-items:center', 'gap:8px',
      `height:${COMPACT_ACTION}px`, 'flex:0 0 auto', 'box-sizing:border-box',
      'width:0', 'min-width:100%',
    ].join(';');

    row.appendChild(buildStatusRow());

    const kill = miniAction(window.SL_ICONS.clear, 'kill-and-log',
      'linear-gradient(180deg,#d9503f 0%,#a02c1d 100%)', killAndLog);
    const call = miniAction(window.SL_ICONS.play, 'start-call',
      'linear-gradient(180deg,#2aa55c 0%,#13623a 100%)', startCall);
    row.appendChild(kill);
    row.appendChild(call);
    // Same shape as the full plate's, so renderKeycaps() and the busy class
    // find what they expect on either surface.
    ctl = { kill, call, row };
    box.appendChild(row);
  }

  function finishOverlay(box) {
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

  function iconButton(icon, title, onClick, size) {
    const b = document.createElement('button');
    b.className = 'sl-icon';
    b.type = 'button';
    // A constant from ICONS, never anything that came off the page or out of
    // storage.
    b.innerHTML = icon;
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

  // How many lines are waiting behind a collapsed pane. Only ever read there,
  // so it is the counter that replaces the reading rather than a second copy
  // of it.
  // Shown on the base row while the pane is a rail, because that is when the
  // reading it stands in for is not on screen.
  function renderLineCount() {
    if (!linesEl) return;
    const show = !!tx && txView.minimized;
    linesEl.style.display = show ? '' : 'none';
    if (!show) return;
    const count = txView.entries.length;
    linesEl.textContent = count === 1 ? '1 line' : `${count} lines`;
    linesEl.style.color = count ? FG_MUTED : FG_DIM;
  }

  // The prompt owns what the pane's body shows, because the two states it
  // arbitrates are mutually exclusive: either capture is not armed and the
  // pane says which key arms it, or the transcript is there to read.
  function renderArmPrompt() {
    if (!tx) return;
    // It stands in for the placeholder, so it appears only where the
    // placeholder would: with lines already on screen there is something worth
    // reading in that space, and the header's word is enough to say capture is
    // not running. Nothing a rep has captured is ever covered by this.
    const show = txView.notArmed && !txView.minimized && !txView.entries.length;
    tx.prompt.style.display = show ? 'block' : 'none';
    tx.list.style.display = show || txView.minimized ? 'none' : '';
    if (!show) return;
    // Read back from chrome.commands, never the manifest's suggestion: Chrome
    // silently leaves a command unassigned when something else already holds
    // the key, so printing the suggested one is how a prompt comes to name a
    // shortcut the rep does not have.
    const label = window.slHotkeyLabel(txView.armKey, false);
    // With no key there is no keycap between the two spans, so the whole line
    // goes in the lead rather than leaving the tail to butt against it.
    tx.promptLead.textContent = label ? 'Press' : 'No shortcut arms capture yet.';
    tx.promptKey.textContent = label;
    tx.promptKey.style.display = label ? '' : 'none';
    // Short enough to hold one line in the pane's own font. The header already
    // says NOT ARMED, so this only has to say what ends it.
    tx.promptTail.textContent = label
      ? 'with Salesloft in front'
      : ' Set one at chrome://extensions/shortcuts';
    // The whole of the explanation, one hover away rather than on screen.
    tx.pane.title = label
      ? `Capture is not armed. Chrome only lets it start from this tab, so ${label} has to be pressed with Salesloft in front.`
      : 'Capture is not armed, and no Chrome shortcut is assigned to arm it. Set one at chrome://extensions/shortcuts.';
  }

  function renderTranscriptView() {
    if (!tx) return;
    const hidden = txView.minimized;
    tx.hint.style.display = 'none';
    // Width as well as height, or minimising would reclaim nothing: the wrapper
    // stretches to the button row either way, so a pane that only lost its list
    // would leave the plate exactly as wide as before.
    tx.pane.style.width = hidden ? `${PANE_MINI_WIDTH}px` : `${TRANSCRIPT_WIDTH}px`;
    tx.pane.style.flexBasis = hidden ? `${PANE_MINI_WIDTH}px` : `${TRANSCRIPT_WIDTH}px`;
    // Always the full row height. This used to go to 'auto', which left a 40px
    // header hanging at the top of a 108px row with bare plate under it — the
    // one place on this overlay where a control did not end where its
    // neighbour did.
    tx.pane.style.height = `${PANEL_HEIGHT}px`;

    // Minimising takes the reading away, not the controls. Open, the header is
    // a strip across the top of the pane; collapsed, the pane becomes a rail —
    // the light above the same three buttons, in a column 34px wide. Nothing
    // else goes in there: the timer and the line count moved to the base row,
    // and a rail that repeated them needed 96px to say what was already on
    // screen one line below.
    tx.bar.style.flexDirection = hidden ? 'column' : 'row';
    tx.bar.style.justifyContent = hidden ? 'space-between' : '';
    tx.bar.style.gap = hidden ? '0' : `${HEADER_GAP}px`;
    tx.bar.style.padding = hidden ? '5px 4px' : '5px 7px';
    tx.bar.style.background = hidden ? 'transparent' : 'rgba(255,255,255,.035)';
    tx.bar.style.borderBottom = hidden ? 'none' : '1px solid rgba(255,255,255,.05)';
    tx.bar.style.flex = hidden ? '1 1 auto' : '0 0 auto';
    // The word goes with the width. The light stays, because it is the one
    // thing the rail has to say, and its colour says it without a word.
    tx.connection.style.display = hidden ? 'none' : '';
    tx.controls.style.flexDirection = hidden ? 'column' : 'row';
    tx.controls.style.gap = hidden ? '4px' : `${HEADER_GAP}px`;

    tx.toggle.innerHTML = hidden ? window.SL_ICONS.expand : window.SL_ICONS.collapse;
    tx.toggle.title = hidden ? 'Show transcript' : 'Hide transcript';
    tx.toggle.setAttribute('aria-label', tx.toggle.title);
    tx.toggle.setAttribute('aria-expanded', String(!hidden));

    renderLineCount();
    renderArmPrompt();
    renderSecondaryWidth();
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
    // Open, this is a header strip across the top of the pane. Collapsed, it
    // becomes the whole pane — so it is built as two groups with a spacer
    // between them, and renderTranscriptView() only has to turn the axis.
    const bar = document.createElement('div');
    bar.style.cssText = [
      'display:flex', 'align-items:center', `gap:${HEADER_GAP}px`, 'padding:5px 7px',
      'background:rgba(255,255,255,.035)', 'border-bottom:1px solid rgba(255,255,255,.05)',
      'flex:0 0 auto', 'box-sizing:border-box', 'min-width:0',
    ].join(';');

    // What the pane says about itself: the light, its word, how long, how much.
    const meta = document.createElement('div');
    meta.style.cssText = [
      'display:flex', 'align-items:center', `gap:${HEADER_GAP}px`, 'flex:0 1 auto', 'min-width:0',
    ].join(';');

    const light = document.createElement('div');
    light.style.cssText = 'display:flex;align-items:center;gap:5px;min-width:0;flex:0 0 auto';

    const dot = document.createElement('span');
    dot.style.cssText =
      `width:6px;height:6px;border-radius:50%;background:${FG_DIM};flex:0 0 auto`;

    const connection = document.createElement('span');
    connection.style.cssText = [
      'font-weight:600', 'letter-spacing:.06em', `font-size:${TYPE.overline}px`,
      `color:${FG_MUTED}`, 'flex:0 0 auto', 'white-space:nowrap',
    ].join(';');
    connection.textContent = 'OFFLINE';

    light.appendChild(dot);
    light.appendChild(connection);
    meta.appendChild(light);

    // Holds the two groups apart on either axis, so one rule covers both the
    // header's left/right split and the collapsed pane's top/bottom one.
    const spacer = document.createElement('div');
    spacer.style.cssText = 'flex:1 1 auto';

    const controls = document.createElement('div');
    controls.style.cssText =
      `display:flex;align-items:center;gap:${HEADER_GAP}px;flex:0 0 auto`;

    const toggle = iconButton(window.SL_ICONS.collapse, 'Hide transcript', toggleTranscriptView);
    const pause = iconButton(window.SL_ICONS.pause, 'Pause transcription', togglePause);
    const save = iconButton(window.SL_ICONS.save, 'Save transcript as text', saveFromButton);
    save.classList.add('sl-save');

    controls.appendChild(toggle);
    controls.appendChild(pause);
    controls.appendChild(save);

    bar.appendChild(meta);
    bar.appendChild(spacer);
    bar.appendChild(controls);

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

    // Capture is not armed yet. Nothing is wrong: Chrome only lets a capture
    // start from an invocation on this tab, so this is the ordinary state of a
    // fresh tab and one keypress ends it. It is therefore built as the pane's
    // own placeholder — the same corner, size and italic as "Waiting for the
    // call to start…" — rather than as a banner across the middle. The reason
    // it exists at all lives in the pane's tooltip; a rep who has read it once
    // does not need it on screen for the rest of the day.
    // A block rather than a flex row: it is a sentence with a key in the
    // middle of it, so it has to wrap like one. A wrapping flex container
    // spreads its rows down whatever height it is given, which on a 108px pane
    // put half a sentence at the top and half at the bottom.
    const prompt = document.createElement('div');
    prompt.style.cssText = [
      'display:none', 'flex:1 1 auto', 'min-height:0', 'padding:7px 9px',
      `font-size:${TYPE.caption}px`, 'font-style:italic', `color:${FG_MUTED}`,
      `line-height:${LEADING.read}`, 'text-wrap:pretty',
    ].join(';');

    const promptLead = document.createElement('span');
    const promptKey = document.createElement('span');
    promptKey.className = 'sl-key';
    // The one part of the line that is not italic grey: it is the thing the rep
    // acts on, and a keycap set in the surrounding italic stops reading as a key.
    promptKey.style.cssText = `color:${FG_SOFT};font-style:normal;margin:0 4px`;
    const promptTail = document.createElement('span');

    prompt.appendChild(promptLead);
    prompt.appendChild(promptKey);
    prompt.appendChild(promptTail);

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
    pane.appendChild(prompt);
    pane.appendChild(hint);
    wrap.appendChild(pane);

    for (const b of [toggle, pause, save]) window.slPressable(b);

    tx = {
      pane, list, empty, bar, meta, light, dot, connection, controls,
      hint, toggle, pause, save,
      prompt, promptLead, promptKey, promptTail,
    };
    // A rebuild (settings toggle, or replacing a stale overlay) must not lose
    // what is already on screen.
    const shown = txView.entries.slice(-MAX_RENDERED_LINES);
    if (shown.length) {
      empty.remove();
      tx.empty = null;
      for (const entry of shown) appendEntryNode(entry);
    }
    renderPaused();
    // A rebuilt pane opens on the state the worker last reported, the same way
    // a rebuilt overlay opens on "Connected" rather than "Ready". Without this
    // the header hard-coded OFFLINE while the body still showed the arming
    // prompt underneath it.
    setTranscriptConnection(txView.connection, txView.armKey);
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
    renderLineCount();
    renderArmPrompt();
    while (tx.list.childElementCount > MAX_RENDERED_LINES) tx.list.firstElementChild.remove();

    if (txView.autoScroll) {
      tx.list.scrollTop = tx.list.scrollHeight;
      tx.hint.style.display = 'none';
    } else {
      tx.hint.style.display = 'block';
    }
  }

  const CONNECTION_WARN = '#e0a020';

  function setTranscriptConnection(state, detail) {
    // Kept even with no pane on screen: the pane may be built later, and it has
    // to open on the state the worker last reported rather than on OFFLINE.
    txView.notArmed = state === 'notarmed';
    txView.connection = state || 'offline';
    if (state === 'notarmed') txView.armKey = String(detail || '');
    if (!tx) return;
    // NOT ARMED is its own word, in the colour for "waiting on you", because it
    // is not an error: nothing failed, capture has simply not been authorised
    // on this tab yet, and one keypress fixes it.
    const labels = {
      ready: 'LIVE', busy: 'LIVE', degraded: 'BEHIND', notarmed: 'NOT ARMED',
      error: 'ERROR', offline: 'OFFLINE',
    };
    const colors = {
      ready: '#ff5c4d', busy: '#ff5c4d', degraded: CONNECTION_WARN,
      notarmed: CONNECTION_WARN, error: '#6b6f76', offline: '#6b6f76',
    };
    const live = state === 'ready' || state === 'busy';
    tx.connection.textContent = labels[state] || 'OFFLINE';
    // Amber on the dot only. The word in amber read as a warning about a state
    // that is not one, and it was the loudest thing on a plate whose whole job
    // is to stay out of the way mid-call.
    tx.connection.style.color = live ? '#e8e6e1' : '#9aa0a6';
    tx.dot.style.background = colors[state] || '#6b6f76';
    if (state !== 'notarmed') tx.pane.title = '';
    renderArmPrompt();
    // The rail is gone — the light now lives in the pane header, which stays
    // put when the reading is minimised, so there is nothing to mirror it onto.
    tx.dot.style.animation =
      live && !window.slReducedMotion() ? 'sl-pulse 1.6s ease-in-out infinite' : 'none';
    tx.dot.title = `Transcription: ${tx.connection.textContent}`;
  }

  function renderPaused() {
    if (!tx) return;
    tx.pause.innerHTML = txView.paused ? window.SL_ICONS.play : window.SL_ICONS.pause;
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
    renderLineCount();
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
      else if (pressed === hotkeys['not-in-service']) { e.preventDefault(); notInService(); }
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
    const wasCompact = compactMode();
    lastCallState = result.state;
    safeSend({ type: 'call-state', state: result.state, tier: result.tier });
    // The compact bar opens to the full plate for the duration of a call and
    // closes again after. Only that crossing rebuilds — every other state
    // change leaves the surface alone.
    if (settings.compactBar && wasCompact !== compactMode()) syncOverlay(true);
    setCallLive(result.state === 'IN_CALL');

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
