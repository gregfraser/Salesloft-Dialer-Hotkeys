// Shared transcript formatting tests.
//
// Run with:  node --test tests/test_transcript_format.js
//
// These helpers live in extension/defaults.js because the floating panel and
// the on-page transcript both render and save the same lines. A line has to
// read the same in either, and a saved file must not depend on which surface
// happened to write it — that is what is pinned here.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const {
  slFormatClock,
  slTranscriptText,
  slTranscriptFilename,
} = require(path.join(__dirname, '..', 'extension', 'defaults.js'));

test('formats a clock as mm:ss', () => {
  assert.strictEqual(slFormatClock(0), '00:00');
  assert.strictEqual(slFormatClock(9), '00:09');
  assert.strictEqual(slFormatClock(65), '01:05');
  assert.strictEqual(slFormatClock(599), '09:59');
});

test('truncates fractional seconds rather than rounding up', () => {
  // The stamp marks when an utterance began; showing 00:10 for a line that
  // starts at 9.9s would put it after a line stamped 00:10 that came later.
  assert.strictEqual(slFormatClock(9.9), '00:09');
});

test('keeps counting minutes past an hour', () => {
  // A long discovery call must not wrap back to 00:00.
  assert.strictEqual(slFormatClock(3600), '60:00');
  assert.strictEqual(slFormatClock(3661), '61:01');
});

test('never renders a negative or non-numeric clock', () => {
  // A malformed payload should cost a wrong timestamp, not "NaN:NaN" sitting
  // in the middle of a live transcript.
  assert.strictEqual(slFormatClock(-5), '00:00');
  assert.strictEqual(slFormatClock(undefined), '00:00');
  assert.strictEqual(slFormatClock(NaN), '00:00');
  assert.strictEqual(slFormatClock('nonsense'), '00:00');
});

test('renders each entry as a stamped line', () => {
  const text = slTranscriptText([
    { start: 0, text: 'Hi, is this Peter?' },
    { start: 4, text: 'It is, who is this?' },
  ]);
  assert.strictEqual(text, '[00:00] Hi, is this Peter?\n[00:04] It is, who is this?');
});

test('handles an empty or missing transcript', () => {
  assert.strictEqual(slTranscriptText([]), '');
  assert.strictEqual(slTranscriptText(undefined), '');
});

test('marks where the next call began', () => {
  // The on-page pane keeps several calls; the saved file has to show the same
  // boundary the divider shows, since every call's stamps restart at 00:00.
  const text = slTranscriptText([
    { start: 0, text: 'First call.' },
    { start: 0, text: 'Second call.', newCall: true },
  ]);
  assert.strictEqual(text, '[00:00] First call.\n\n--- next call ---\n\n[00:00] Second call.');
});

test('does not open the file with a divider', () => {
  // The pane can be cleared mid-cadence, leaving the first line it ever
  // renders flagged as a new call.
  const text = slTranscriptText([{ start: 0, text: 'Only line.', newCall: true }]);
  assert.strictEqual(text, '[00:00] Only line.');
});

test('names the file by timestamp alone', () => {
  const name = slTranscriptFilename(new Date(Date.UTC(2026, 7, 27, 14, 32, 5)));
  assert.strictEqual(name, 'transcript_2026-08-27T14-32-05.txt');
});

test('keeps the filename free of characters a filesystem rejects', () => {
  const name = slTranscriptFilename(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)));
  assert.ok(!/[:*?"<>|]/.test(name), `unsafe filename: ${name}`);
});
