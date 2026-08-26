// Salesloft call-state detection (PR-1) -- observe only.
//
// This module never clicks anything. It answers one question: is a call in
// progress? The dialer automation in content.js is what acts; keeping the two
// apart means a detection bug can never mis-log a call.
//
// Selector strategy, in priority order:
//   1. ARIA labels      -- semantic, survives restyling
//   2. Visible button text
//   3. data-testid slugs
//
// Generated styled-components classes (.sc-imkklV, .sc-hUXJnP) are deliberately
// never matched: they change on every Salesloft deploy, so a detector that
// depended on them would silently break with no way to tell why.

(function (root, factory) {
  'use strict';
  const api = factory();
  root.SLCallDetect = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const END_CALL_LABELS = ['End Call', 'Hang Up'];
  const CALL_LABELS = ['Call'];

  const STATE_IDLE = 'IDLE';
  const STATE_IN_CALL = 'IN_CALL';

  function normalize(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function slug(value) {
    return normalize(value).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }

  // A data-testid matches when the target's slug appears as a run of whole
  // tokens, so "end-call" matches "end-call-button" and "call" matches
  // "dialer-call-button", while "recall-button" matches neither.
  //
  // Token runs alone cannot separate "Call" from "End Call" -- a bare "call"
  // token does occur inside "end-call-button". That disambiguation is the
  // exclude list's job in findControl, which is why findCallControl passes
  // END_CALL_LABELS as exclusions.
  function testidMatches(testid, target) {
    const wanted = slug(target);
    if (!wanted) return false;
    const wantedTokens = wanted.split('-');
    const tokens = slug(testid).split('-');
    for (let i = 0; i + wantedTokens.length <= tokens.length; i += 1) {
      let hit = true;
      for (let j = 0; j < wantedTokens.length; j += 1) {
        if (tokens[i + j] !== wantedTokens[j]) { hit = false; break; }
      }
      if (hit) return true;
    }
    return false;
  }

  function matchesLabel(element, target, tier) {
    if (tier === 'aria') return normalize(element.getAttribute('aria-label')) === normalize(target);
    if (tier === 'text') return normalize(element.textContent) === normalize(target);
    return testidMatches(element.getAttribute('data-testid'), target);
  }

  function matchesAny(element, targets, tier) {
    return targets.some((target) => matchesLabel(element, target, tier));
  }

  /**
   * Find a control by label, trying each tier in turn.
   *
   * @param {string[]} targets  labels to accept, e.g. ['End Call', 'Hang Up']
   * @param {object}   opts     {elements, isVisible} -- injected so this runs
   *                            under test without a DOM
   * @param {string[]} exclude  labels that disqualify a candidate. "Call"
   *                            would otherwise match an "end-call-button"
   *                            testid on the token tier.
   * @returns {{element: *, tier: string, label: string}|null}
   */
  function findControl(targets, opts, exclude) {
    const excluded = exclude || [];
    const candidates = Array.from(opts.elements()).filter(opts.isVisible);

    for (const tier of ['aria', 'text', 'testid']) {
      for (const element of candidates) {
        if (excluded.length && matchesAny(element, excluded, tier)) continue;
        for (const target of targets) {
          if (matchesLabel(element, target, tier)) {
            return { element: element, tier: tier, label: target };
          }
        }
      }
    }
    return null;
  }

  function findEndCallControl(opts) {
    return findControl(END_CALL_LABELS, opts);
  }

  function findCallControl(opts) {
    return findControl(CALL_LABELS, opts, END_CALL_LABELS);
  }

  /**
   * Current call state. Presence of an End Call control means a call is up;
   * its disappearance means the call ended.
   *
   * Detection failure must resolve to IDLE and never throw -- a broken
   * selector degrades to "no transcription", never to a broken call.
   */
  function detectState(opts) {
    try {
      const found = findEndCallControl(opts);
      return {
        state: found ? STATE_IN_CALL : STATE_IDLE,
        tier: found ? found.tier : null,
        label: found ? found.label : null,
      };
    } catch (err) {
      return { state: STATE_IDLE, tier: null, label: null, error: String(err) };
    }
  }

  // -- live DOM bindings -------------------------------------------------
  // Only clickable roles are considered, which is also why a generated class
  // can never be the thing that identifies a control.
  const LIVE_SELECTOR = 'button, [role="button"], [data-testid]';

  function liveOptions(doc) {
    const target = doc || (typeof document !== 'undefined' ? document : null);
    return {
      elements: function () {
        return target ? target.querySelectorAll(LIVE_SELECTOR) : [];
      },
      isVisible: function (element) {
        return !!element && element.offsetParent !== null && !element.disabled;
      },
    };
  }

  return {
    STATE_IDLE: STATE_IDLE,
    STATE_IN_CALL: STATE_IN_CALL,
    END_CALL_LABELS: END_CALL_LABELS,
    CALL_LABELS: CALL_LABELS,
    normalize: normalize,
    slug: slug,
    testidMatches: testidMatches,
    findControl: findControl,
    findEndCallControl: findEndCallControl,
    findCallControl: findCallControl,
    detectState: detectState,
    liveOptions: liveOptions,
  };
});
