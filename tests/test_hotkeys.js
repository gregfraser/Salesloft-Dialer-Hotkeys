// Key binding helpers.
//
// Run with:  node --test tests/test_hotkeys.js
//
// These live in extension/defaults.js because four contexts have to agree on
// what a binding is: the settings popup records one, the content script and the
// floating panel match a keypress against it, and all three print it on a
// button. A binding that recorded as one string and matched as another would
// mean a key that quietly stops dialing, which is exactly the thing a rep in a
// cadence would not notice until they had lost a call to it.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  DEFAULTS,
  slHotkeyFromEvent,
  slHotkeyMatches,
  slHotkeyLabel,
  slNormalizeHotkeys,
  SL_HOTKEY_ACTIONS,
} = require(path.join(__dirname, '..', 'extension', 'defaults.js'));

// Only the fields the helpers read — the real event carries far more.
function keyEvent(code, modifiers = {}) {
  return {
    code,
    ctrlKey: !!modifiers.ctrl,
    altKey: !!modifiers.alt,
    shiftKey: !!modifiers.shift,
    metaKey: !!modifiers.meta,
  };
}

// ---------------------------------------------------------------- recording
test('a bare key records as its code', () => {
  assert.strictEqual(slHotkeyFromEvent(keyEvent('F8')), 'F8');
  assert.strictEqual(slHotkeyFromEvent(keyEvent('Numpad1')), 'Numpad1');
});

test('the number pad is a different key from the digit row', () => {
  // The whole point of the feature: a rep with a hand on the pad presses
  // something `e.key` would call '1', the same as the 1 above the letters.
  assert.notStrictEqual(
    slHotkeyFromEvent(keyEvent('Numpad1')),
    slHotkeyFromEvent(keyEvent('Digit1'))
  );
});

test('a number pad binding does not depend on Num Lock', () => {
  // With Num Lock off the browser reports `key: 'End'` for that same key, and
  // 'Numpad1' either way. Storing the code is what makes the binding survive.
  assert.strictEqual(slHotkeyFromEvent(keyEvent('Numpad1')), 'Numpad1');
});

test('modifiers are recorded in one fixed order', () => {
  // Recorded on one press and compared against another, so the order cannot
  // depend on which modifier the rep happened to hold down first.
  const all = { ctrl: true, alt: true, shift: true, meta: true };
  assert.strictEqual(slHotkeyFromEvent(keyEvent('KeyK', all)), 'Ctrl+Alt+Shift+Meta+KeyK');
  assert.strictEqual(
    slHotkeyFromEvent(keyEvent('NumpadAdd', { shift: true, ctrl: true })),
    'Ctrl+Shift+NumpadAdd'
  );
});

test('a modifier on its own is not a binding', () => {
  // A recorder holding this would bind Shift the moment the rep reached for
  // Shift+F8, and every shifted keystroke afterwards would dial.
  for (const code of ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'AltLeft', 'MetaRight', 'OSLeft']) {
    assert.strictEqual(slHotkeyFromEvent(keyEvent(code, { shift: true })), null, code);
  }
});

test('an event with no code is not a binding', () => {
  assert.strictEqual(slHotkeyFromEvent({}), null);
  assert.strictEqual(slHotkeyFromEvent(null), null);
});

// ----------------------------------------------------------------- matching
test('a press matches the binding it recorded as', () => {
  assert.strictEqual(slHotkeyMatches('Numpad1', keyEvent('Numpad1')), true);
  assert.strictEqual(slHotkeyMatches('Ctrl+Shift+KeyK', keyEvent('KeyK', { ctrl: true, shift: true })), true);
});

test('a modifier the binding does not have blocks the match', () => {
  // Shift+F8 must not fire a plain F8 binding: a rep shift-clicking their way
  // around Salesloft would otherwise start logging calls.
  assert.strictEqual(slHotkeyMatches('F8', keyEvent('F8', { shift: true })), false);
  assert.strictEqual(slHotkeyMatches('Ctrl+F8', keyEvent('F8')), false);
});

test('no binding never matches anything', () => {
  // Every surface treats '' as "this action has no key", so it must not be
  // matched by a stray press with nothing held.
  assert.strictEqual(slHotkeyMatches('', keyEvent('F8')), false);
  assert.strictEqual(slHotkeyMatches(undefined, keyEvent('KeyA')), false);
});

// ------------------------------------------------------------------- labels
test('a number pad key reads as the glyph printed on it', () => {
  assert.strictEqual(slHotkeyLabel('Numpad1', false), 'Num 1');
  assert.strictEqual(slHotkeyLabel('NumpadAdd', false), 'Num +');
  assert.strictEqual(slHotkeyLabel('NumpadDivide', false), 'Num /');
  assert.strictEqual(slHotkeyLabel('NumpadEnter', false), 'Num Enter');
});

test('the compact form drops the spaces the keycaps have no room for', () => {
  // Two keycaps share a 210px column on the on-page buttons.
  assert.strictEqual(slHotkeyLabel('Numpad1', true), 'Num1');
  assert.strictEqual(slHotkeyLabel('Ctrl+Shift+Digit9', true), 'Ctrl⇧9');
  assert.strictEqual(slHotkeyLabel('Ctrl+Shift+Digit9', false), 'Ctrl+Shift+9');
});

test('a letter or digit reads as itself, not as its code', () => {
  assert.strictEqual(slHotkeyLabel('KeyK', false), 'K');
  assert.strictEqual(slHotkeyLabel('Digit4', false), '4');
  assert.strictEqual(slHotkeyLabel('F8', false), 'F8');
  assert.strictEqual(slHotkeyLabel('Period', false), '.');
});

test('the shortcut string Chrome hands back labels the same way', () => {
  // chrome.commands.getAll() returns 'Ctrl+Shift+9', not a code — the buttons
  // print the rep's own binding and Chrome's beside each other, so one
  // formatter has to take both.
  assert.strictEqual(slHotkeyLabel('Ctrl+Shift+9', true), 'Ctrl⇧9');
  assert.strictEqual(slHotkeyLabel('Ctrl+Shift+9', false), 'Ctrl+Shift+9');
  assert.strictEqual(slHotkeyLabel('Command+Shift+0', true), '⇧⌘0');
});

test('an unbound action labels as nothing at all', () => {
  // Not "None" or "—": the surfaces filter empties out, so an action with no
  // key gets no keycap rather than a keycap saying it has none.
  assert.strictEqual(slHotkeyLabel('', false), '');
  assert.strictEqual(slHotkeyLabel(null, true), '');
  assert.strictEqual(slHotkeyLabel(undefined, false), '');
});

// -------------------------------------------------------------- normalising
test('the shipped defaults survive normalising unchanged', () => {
  assert.deepStrictEqual(slNormalizeHotkeys(DEFAULTS.hotkeys), DEFAULTS.hotkeys);
});

test('every action is present, bound or not', () => {
  // The content script indexes this by action on every keypress; a missing key
  // there would be an undefined compared against a string on every keystroke.
  const normalized = slNormalizeHotkeys({ 'start-call': 'Numpad0' });
  assert.deepStrictEqual(Object.keys(normalized).sort(), [...SL_HOTKEY_ACTIONS].sort());
  assert.strictEqual(normalized['kill-and-log'], '');
  assert.strictEqual(normalized['start-call'], 'Numpad0');
});

test('two actions cannot share one key', () => {
  // Both flows would run off a single press; the busy flag swallows the second,
  // so the rep would see a key that sometimes does the other thing.
  const normalized = slNormalizeHotkeys({ 'kill-and-log': 'Numpad1', 'start-call': 'Numpad1' });
  assert.strictEqual(normalized['kill-and-log'], 'Numpad1');
  assert.strictEqual(normalized['start-call'], '');
});

test('anything that is not a binding resolves to no key', () => {
  // Storage is synced across a rep's machines and can hold whatever an older
  // install wrote. A wrong key is worse than none: none is visible in the UI.
  const normalized = slNormalizeHotkeys({ 'kill-and-log': 42, 'start-call': null });
  assert.deepStrictEqual(normalized, { 'kill-and-log': '', 'start-call': '' });
  assert.deepStrictEqual(slNormalizeHotkeys(undefined), { 'kill-and-log': '', 'start-call': '' });
});

test('a stored binding is trimmed rather than half-matched forever', () => {
  assert.strictEqual(slNormalizeHotkeys({ 'kill-and-log': '  F8 ' })['kill-and-log'], 'F8');
});
