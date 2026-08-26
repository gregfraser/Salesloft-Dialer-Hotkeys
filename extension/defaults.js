// Shared settings defaults.
//
// Loaded as a plain script by every context (content script via the manifest,
// service worker via importScripts, panel and settings via a <script> tag), so
// there is exactly one definition of what a fresh install looks like.

(function (root) {
  'use strict';

  const DEFAULTS = {
    // -- dialer (existing behaviour) --
    floatingPanel: false,
    pageOverlay: true,
    disposition: 'No Answer',

    // -- transcription --
    transcription: false,          // master switch, off until opted into
    autoStartTranscription: true,  // arm capture when a call is detected
    saveTranscripts: false,        // PR-8: opt-in, text only
    // Empty means the system default output device. See docs/troubleshooting.md:
    // if the rep's headset is not the Windows default, passthrough plays the
    // call somewhere they cannot hear it.
    outputDeviceId: '',
    serverUrl: 'ws://127.0.0.1:8765/transcribe',
    healthUrl: 'http://127.0.0.1:8765/health',

    // -- contact alerts --
    alertsEnabled: true,
    alertTags: ['No Interest', 'Meeting Scheduled', 'Interested'],
    alertStrict: true,
  };

  root.SL_DEFAULTS = DEFAULTS;

  // ---------------- Contact alert colours ----------------
  // What colour each tag gets. Anything unrecognised falls back to amber.
  const TAG_COLORS = {
    'meeting scheduled': 'blue',
    'interested': 'green',
    'no interest': 'red',
    'not interested': 'red',
    'do not contact': 'red',
  };

  root.slColorFor = function (tag) {
    return TAG_COLORS[String(tag || '').replace(/\s+/g, ' ').trim().toLowerCase()] || 'amber';
  };

  // When several tags are on the page at once, this decides the toast's own
  // colour: a booked meeting outranks everything, then a hard no, then interest.
  // Each tag still keeps its own colour on its chip.
  const PRIORITY = ['blue', 'red', 'green', 'amber'];

  root.slTopColor = function (tags) {
    const present = new Set((tags || []).map(root.slColorFor));
    return PRIORITY.find((c) => present.has(c)) || 'amber';
  };

  // Palette for the on-page toast and the floating panel. Tuned for the dark
  // surfaces both already use.
  root.SL_PALETTE = {
    red:   { bg: '#3a1d1a', border: '#c0392b', text: '#ffb4a8' },
    blue:  { bg: '#17263a', border: '#2f6fd0', text: '#a8ccff' },
    green: { bg: '#1b3326', border: '#1e7e46', text: '#a8e6b8' },
    amber: { bg: '#3a3320', border: '#b8860b', text: '#ffd88a' },
  };

  root.SL_HEADLINE = {
    blue:  'Meeting already scheduled',
    red:   'No interest logged',
    green: 'Marked interested',
    amber: 'Heads up before you dial',
  };

  // "No Interest, Meeting Scheduled" -> ['No Interest', 'Meeting Scheduled'].
  // Accepts an array too, so it can also sanitise whatever is in storage.
  root.slParseTags = function (value) {
    const list = Array.isArray(value) ? value : String(value ?? '').split(',');
    const seen = new Set();
    const out = [];
    for (const raw of list) {
      const tag = String(raw).replace(/\s+/g, ' ').trim();
      if (!tag || seen.has(tag.toLowerCase())) continue;
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULTS };
  }
})(typeof self !== 'undefined' ? self : globalThis);
