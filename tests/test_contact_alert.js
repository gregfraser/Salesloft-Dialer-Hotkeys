// Contact alert tests.
//
// Run with:  node --test tests/test_contact_alert.js
//
// The alert says one thing: the tag Salesloft already put on the contact, in
// the colour that says how much it matters. It carries no wording of its own —
// a line in front of the tag either repeats it ("Meeting already scheduled —
// Meeting Scheduled") or tells the rep whether to dial, which is their call.
// So what is left to pin is which colour a tag gets, and which colour wins when
// a contact carries more than one.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const defaults = require(path.join(__dirname, '..', 'extension', 'defaults.js'));
const { DEFAULTS, SL_PALETTE, slColorFor, slTopColor } = defaults;

test('the alert has no wording of its own to put in front of a tag', () => {
  // Both surfaces render the tags themselves, so anything shared here that
  // reads like a sentence would end up in front of one. Nothing does.
  assert.strictEqual(defaults.SL_HEADLINE, undefined);
  assert.deepStrictEqual(
    Object.keys(SL_PALETTE).sort(),
    ['amber', 'blue', 'green', 'red'],
  );
  for (const theme of Object.values(SL_PALETTE)) {
    assert.deepStrictEqual(Object.keys(theme).sort(), ['bg', 'border', 'text']);
  }
});

test('every shipped tag gets its colour', () => {
  assert.strictEqual(slColorFor('Meeting Scheduled'), 'blue');
  assert.strictEqual(slColorFor('No Interest'), 'red');
  assert.strictEqual(slColorFor('Interested'), 'green');
  for (const tag of DEFAULTS.alertTags) {
    assert.ok(SL_PALETTE[slColorFor(tag)], `${tag} has no palette entry`);
  }
});

test('wordings a team might use instead land on the same colour', () => {
  assert.strictEqual(slColorFor('Not Interested'), 'red');
  assert.strictEqual(slColorFor('Do Not Contact'), 'red');
});

test('a tag matches however Salesloft cased or spaced it', () => {
  assert.strictEqual(slColorFor('MEETING SCHEDULED'), 'blue');
  assert.strictEqual(slColorFor('  meeting   scheduled  '), 'blue');
  assert.strictEqual(slColorFor('no interest'), 'red');
});

test("a tag we don't recognise still raises an alert", () => {
  // Amber, not nothing: the rep put it in "Tags to watch" on purpose.
  assert.strictEqual(slColorFor('Left VM 3x'), 'amber');
  assert.strictEqual(slColorFor(''), 'amber');
  assert.strictEqual(slColorFor(undefined), 'amber');
});

test('the alert takes the colour of its most serious tag', () => {
  assert.strictEqual(slTopColor(['Interested', 'Meeting Scheduled']), 'blue');
  assert.strictEqual(slTopColor(['Interested', 'No Interest']), 'red');
  assert.strictEqual(slTopColor(['No Interest', 'Meeting Scheduled']), 'blue');
  assert.strictEqual(slTopColor(['Interested']), 'green');
  assert.strictEqual(slTopColor(['Left VM 3x']), 'amber');
  assert.strictEqual(slTopColor([]), 'amber');
});
