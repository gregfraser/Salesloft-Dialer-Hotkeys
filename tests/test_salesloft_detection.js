// Call-state detection tests (PR-1).
//
// Run with:  node --test tests/
//
// The detector takes its DOM access as an injected pair of functions, so these
// run against lightweight element stubs with no jsdom dependency.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const detect = require(path.join(__dirname, '..', 'extension', 'call-detect.js'));

function el(spec) {
  const attrs = {
    'aria-label': spec.aria == null ? null : spec.aria,
    'data-testid': spec.testid == null ? null : spec.testid,
    class: spec.className == null ? '' : spec.className,
  };
  return {
    tagName: spec.tag || 'BUTTON',
    textContent: spec.text == null ? '' : spec.text,
    disabled: !!spec.disabled,
    // The detector treats a null offsetParent as "not rendered", matching
    // how the existing overlay code decides visibility.
    offsetParent: spec.visible === false ? null : {},
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
    },
  };
}

function opts(elements) {
  return detect.liveOptions(null) && {
    elements: () => elements,
    isVisible: (e) => !!e && e.offsetParent !== null && !e.disabled,
  };
}

// ------------------------------------------------------------------ state
test('an End Call button means a call is in progress', () => {
  const result = detect.detectState(opts([el({ text: 'End Call' })]));
  assert.strictEqual(result.state, detect.STATE_IN_CALL);
});

test('no End Call button means idle', () => {
  const result = detect.detectState(opts([el({ text: 'Call' })]));
  assert.strictEqual(result.state, detect.STATE_IDLE);
});

test('an empty page is idle, not an error', () => {
  assert.strictEqual(detect.detectState(opts([])).state, detect.STATE_IDLE);
});

test('detection never throws, even if the DOM query fails', () => {
  const broken = {
    elements: () => { throw new Error('detached'); },
    isVisible: () => true,
  };
  const result = detect.detectState(broken);
  assert.strictEqual(result.state, detect.STATE_IDLE);
  assert.ok(result.error);
});

// ------------------------------------------------------------- tier order
test('an ARIA label is found', () => {
  const result = detect.detectState(opts([el({ aria: 'End Call', text: '' })]));
  assert.strictEqual(result.state, detect.STATE_IN_CALL);
  assert.strictEqual(result.tier, 'aria');
});

test('visible text is found when there is no ARIA label', () => {
  const result = detect.detectState(opts([el({ text: 'End Call' })]));
  assert.strictEqual(result.tier, 'text');
});

test('a data-testid is found when there is neither label nor text', () => {
  const result = detect.detectState(opts([el({ testid: 'end-call-button' })]));
  assert.strictEqual(result.tier, 'testid');
});

test('ARIA is preferred over text', () => {
  const aria = el({ aria: 'End Call' });
  const text = el({ text: 'End Call' });
  const found = detect.findEndCallControl(opts([text, aria]));
  assert.strictEqual(found.tier, 'aria');
  assert.strictEqual(found.element, aria);
});

test('text is preferred over data-testid', () => {
  const text = el({ text: 'End Call' });
  const testid = el({ testid: 'end-call-button' });
  const found = detect.findEndCallControl(opts([testid, text]));
  assert.strictEqual(found.tier, 'text');
});

// ------------------------------------------- generated classes are ignored
test('a generated styled-components class is never enough to identify a control', () => {
  // This is the whole point of the tier hierarchy: .sc-imkklV changes on
  // every Salesloft deploy, so matching it would break silently.
  const styled = el({ className: 'sc-imkklV sc-hUXJnP', text: '' });
  assert.strictEqual(detect.detectState(opts([styled])).state, detect.STATE_IDLE);
});

// ------------------------------------------------------------- visibility
test('hidden controls are ignored', () => {
  const hidden = el({ text: 'End Call', visible: false });
  assert.strictEqual(detect.detectState(opts([hidden])).state, detect.STATE_IDLE);
});

test('disabled controls are ignored', () => {
  const disabled = el({ text: 'End Call', disabled: true });
  assert.strictEqual(detect.detectState(opts([disabled])).state, detect.STATE_IDLE);
});

// --------------------------------------------------------- label matching
test('matching ignores case and collapses whitespace', () => {
  const messy = el({ text: '  end   CALL \n' });
  assert.strictEqual(detect.detectState(opts([messy])).state, detect.STATE_IN_CALL);
});

test('Hang Up is recognised as ending a call', () => {
  const result = detect.detectState(opts([el({ aria: 'Hang Up' })]));
  assert.strictEqual(result.state, detect.STATE_IN_CALL);
  assert.strictEqual(result.label, 'Hang Up');
});

test('a partial label does not match', () => {
  assert.strictEqual(detect.detectState(opts([el({ text: 'End Call Now' })])).state, detect.STATE_IDLE);
});

// ---------------------------------------------- Call vs End Call ambiguity
test('the Call control is not confused with the End Call control', () => {
  const endCall = el({ testid: 'end-call-button' });
  assert.strictEqual(detect.findCallControl(opts([endCall])), null);
});

test('the Call control is found when it is genuinely present', () => {
  const call = el({ testid: 'call-button' });
  const found = detect.findCallControl(opts([call]));
  assert.ok(found);
  assert.strictEqual(found.element, call);
});

test('Call and End Call can coexist without crossing wires', () => {
  const call = el({ text: 'Call' });
  const endCall = el({ text: 'End Call' });
  const all = opts([call, endCall]);
  assert.strictEqual(detect.findCallControl(all).element, call);
  assert.strictEqual(detect.findEndCallControl(all).element, endCall);
});

// ------------------------------------------------------- testid tokenising
test('testid matching finds a run of whole tokens', () => {
  assert.ok(detect.testidMatches('end-call-button', 'End Call'));
  assert.ok(detect.testidMatches('popout_logger_end_call', 'End Call'));
  assert.ok(detect.testidMatches('dialer-call-button', 'Call'));
  // Token boundaries are what stop a substring match from firing here.
  assert.ok(!detect.testidMatches('recall-button', 'Call'));
  assert.ok(!detect.testidMatches('', 'Call'));
});

test('separating Call from End Call is the exclude list, not the token matcher', () => {
  // A bare "call" token really does occur inside "end-call-button", so the
  // primitive matches it; findCallControl is what refuses to be fooled.
  assert.ok(detect.testidMatches('end-call-button', 'Call'));
  assert.strictEqual(
    detect.findCallControl({
      elements: () => [el({ testid: 'end-call-button' })],
      isVisible: () => true,
    }),
    null
  );
});

test('slug and normalize handle empty input', () => {
  assert.strictEqual(detect.normalize(null), '');
  assert.strictEqual(detect.slug(undefined), '');
});
