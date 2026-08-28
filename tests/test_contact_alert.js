// Contact alert headline tests.
//
// Run with:  node --test tests/test_contact_alert.js
//
// The alert is rendered as a headline followed by the tags that raised it —
// "<headline> — Meeting Scheduled" in the on-page banner, and the same
// headline over a row of tag chips in the floating panel. So the headline's
// only job is to say what the tag does not: what to do about it. It used to
// paraphrase the tag instead ("Meeting already scheduled — Meeting Scheduled"),
// which said the same thing twice and, in a banner that holds one line, pushed
// the tag out of view. That is what these pin.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  DEFAULTS,
  SL_HEADLINE,
  SL_PALETTE,
  slColorFor,
  slTopColor,
} = require(path.join(__dirname, '..', 'extension', 'defaults.js'));

// Crude stem so "Scheduled" and "schedule", "Interested" and "interest" count
// as the same word. Enough to catch a headline that merely rephrases its tag.
const stem = (word) =>
  word.toLowerCase().replace(/[^a-z]/g, '').replace(/(ed|ing|s)$/, '');

const words = (text) => new Set(String(text).split(/\s+/).map(stem).filter(Boolean));

// Words too common to mean anything on their own: a headline sharing only
// these with a tag is not repeating it.
const FILLER = new Set(['a', 'an', 'the', 'no', 'not', 'to', 'you', 'your', 'it']);

function restatesTag(headline, tag) {
  const inHeadline = words(headline);
  const meaningful = [...words(tag)].filter((w) => !FILLER.has(w));
  if (!meaningful.length) return false;
  return meaningful.every((w) => inHeadline.has(w));
}

test('the helper itself catches a headline that repeats its tag', () => {
  // The wording this replaced, so the guard is known to bite.
  assert.ok(restatesTag('Meeting already scheduled', 'Meeting Scheduled'));
  assert.ok(restatesTag('No interest logged', 'No Interest'));
  assert.ok(restatesTag('Marked interested', 'Interested'));
  assert.ok(!restatesTag("Don't dial", 'Meeting Scheduled'));
});

test('every colour has a headline', () => {
  for (const color of Object.keys(SL_PALETTE)) {
    assert.strictEqual(typeof SL_HEADLINE[color], 'string', `${color} has no headline`);
    assert.ok(SL_HEADLINE[color].trim().length, `${color} headline is blank`);
  }
});

test('no headline restates the tag it is shown beside', () => {
  for (const tag of DEFAULTS.alertTags) {
    const headline = SL_HEADLINE[slColorFor(tag)];
    assert.ok(
      !restatesTag(headline, tag),
      `"${headline} — ${tag}" says the same thing twice`,
    );
  }
});

// Tags a team might use instead of the shipped ones. They land on the same
// colours, so the same headlines have to hold up next to them.
test('no headline restates a recognised alternative tag', () => {
  for (const tag of ['Not Interested', 'Do Not Contact', 'Meeting scheduled']) {
    const headline = SL_HEADLINE[slColorFor(tag)];
    assert.ok(
      !restatesTag(headline, tag),
      `"${headline} — ${tag}" says the same thing twice`,
    );
  }
});

test('an unrecognised tag falls back to a headline that adds something', () => {
  const headline = SL_HEADLINE[slColorFor('Left VM 3x')];
  assert.strictEqual(headline, SL_HEADLINE.amber);
  assert.ok(!restatesTag(headline, 'Left VM 3x'));
});

// The on-page banner is one line inside a fixed-width overlay: a long headline
// ellipsises away the tag that follows it. 24 characters leaves room for both.
test('headlines fit the one line the banner has', () => {
  for (const [color, headline] of Object.entries(SL_HEADLINE)) {
    assert.ok(headline.length <= 24, `${color} headline is ${headline.length} chars: "${headline}"`);
  }
});

test('the alert takes the colour of its most serious tag', () => {
  // Which headline gets shown is decided by this, so the pairing is only
  // right if the priority holds: a booked meeting outranks a no, then interest.
  assert.strictEqual(slTopColor(['Interested', 'Meeting Scheduled']), 'blue');
  assert.strictEqual(slTopColor(['Interested', 'No Interest']), 'red');
  assert.strictEqual(slTopColor(['Interested']), 'green');
  assert.strictEqual(slTopColor(['Left VM 3x']), 'amber');
  assert.strictEqual(SL_HEADLINE[slTopColor(['Interested', 'Meeting Scheduled'])], "Don't dial");
});
