// Salesloft Dialer Hotkeys — shared settings defaults and small helpers.
// Loaded by the service worker (importScripts), the content scripts, and the
// settings/panel pages, so every context agrees on the same default values.

(function (scope) {
  'use strict';

  scope.SL_DEFAULTS = {
    floatingPanel: false,
    pageOverlay: true,
    disposition: 'No Answer',

    // Contact alerts: flag Disposition / Sentiment tags already on the contact's
    // page so you know what you're walking into before you dial.
    alertsEnabled: true,
    alertTags: ['No Interest', 'Meeting Scheduled', 'Interested'],
    alertStrict: true,
  };

  // What colour each tag gets. Anything unrecognised falls back to amber.
  const TAG_COLORS = {
    'meeting scheduled': 'blue',
    'interested': 'green',
    'no interest': 'red',
    'not interested': 'red',
    'do not contact': 'red',
  };

  scope.slColorFor = function (tag) {
    return TAG_COLORS[String(tag || '').replace(/\s+/g, ' ').trim().toLowerCase()] || 'amber';
  };

  // When several tags are on the page at once, this decides the toast's own
  // colour: a booked meeting outranks everything, then a hard no, then interest.
  // Each tag still keeps its own colour on its chip.
  const PRIORITY = ['blue', 'red', 'green', 'amber'];

  scope.slTopColor = function (tags) {
    const present = new Set((tags || []).map(scope.slColorFor));
    return PRIORITY.find((c) => present.has(c)) || 'amber';
  };

  // Palette for the on-page toast and the floating panel. Tuned for the dark
  // surfaces both already use.
  scope.SL_PALETTE = {
    red:   { bg: '#3a1d1a', border: '#c0392b', text: '#ffb4a8' },
    blue:  { bg: '#17263a', border: '#2f6fd0', text: '#a8ccff' },
    green: { bg: '#1b3326', border: '#1e7e46', text: '#a8e6b8' },
    amber: { bg: '#3a3320', border: '#b8860b', text: '#ffd88a' },
  };

  scope.SL_HEADLINE = {
    blue:  'Meeting already scheduled',
    red:   'No interest logged',
    green: 'Marked interested',
    amber: 'Heads up before you dial',
  };

  // "No Interest, Meeting Scheduled" -> ['No Interest', 'Meeting Scheduled'].
  // Accepts an array too, so it can also sanitise whatever is in storage.
  scope.slParseTags = function (value) {
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
})(typeof self !== 'undefined' ? self : this);
