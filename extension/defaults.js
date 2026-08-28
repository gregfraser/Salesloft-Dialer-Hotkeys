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
    // The master switch is the only choice: with it on, transcription always
    // starts when a call is detected. Saving is never automatic — a cadence is
    // dozens of dials and a file per dial is noise — so the transcript (text
    // only, never audio) is written only when the rep asks for it.
    transcription: false,          // master switch, off until opted into
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

  // When several tags are on the page at once, this decides the alert's own
  // colour: a booked meeting outranks everything, then a hard no, then interest.
  // Each tag still keeps its own colour on its chip.
  const PRIORITY = ['blue', 'red', 'green', 'amber'];

  root.slTopColor = function (tags) {
    const present = new Set((tags || []).map(root.slColorFor));
    return PRIORITY.find((c) => present.has(c)) || 'amber';
  };

  // Palette for the overlay's alert line and the floating panel. Tuned for the
  // dark surfaces both already use.
  root.SL_PALETTE = {
    red:   { bg: '#3a1d1a', border: '#c0392b', text: '#ffb4a8' },
    blue:  { bg: '#17263a', border: '#2f6fd0', text: '#a8ccff' },
    green: { bg: '#1b3326', border: '#1e7e46', text: '#a8e6b8' },
    amber: { bg: '#3a3320', border: '#b8860b', text: '#ffd88a' },
  };

  // The line that leads the alert. The tags are rendered right beside it, so
  // they already state the fact — this states what to do about it. Saying the
  // fact twice ("Meeting already scheduled — Meeting Scheduled") wasted the
  // only line the on-page banner has and pushed the tag itself out of view.
  // Blue and red both say don't: the decision is the same either way, and the
  // tag beside it says which kind of stop it is.
  root.SL_HEADLINE = {
    blue:  "Don't dial",
    red:   "Don't dial again",
    green: 'Read the notes first',
    amber: 'Check before you dial',
  };

  // ---------------- Transcript formatting ----------------
  // Shared by the floating panel and the on-page transcript pane so a line
  // reads the same in both, and a saved file does not depend on which one
  // happened to write it.
  root.slFormatClock = function (seconds) {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = String(Math.floor(total / 60)).padStart(2, '0');
    return `${minutes}:${String(total % 60).padStart(2, '0')}`;
  };

  // A running transcript can span several calls. `newCall` on an entry marks
  // where the next one began, so the text keeps the boundary the on-screen
  // divider shows. Entries without it (the floating panel's) format unchanged.
  root.slTranscriptText = function (entries) {
    const lines = [];
    for (const entry of entries || []) {
      if (entry.newCall && lines.length) lines.push('', '--- next call ---', '');
      lines.push(`[${root.slFormatClock(entry.start)}] ${entry.text}`);
    }
    return lines.join('\n');
  };

  // transcript_2026-08-27T14-32-05.txt — a timestamp and nothing else. The
  // filename never carries the prospect's name.
  root.slTranscriptFilename = function (now) {
    const stamp = (now || new Date()).toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `transcript_${stamp}.txt`;
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

  // ---------------- Which pages the on-page controls belong on ----------------
  // The buttons dial one person, so they only make sense where one person is on
  // screen: a contact's own page, not the dashboard, a cadence, the People list
  // or analytics. Salesloft is a single-page app, so the content script is
  // injected once and this is re-checked on every navigation instead.
  //
  // Matched on the route rather than the DOM. A contact's page is
  // /app/people/{id} — older builds nest it as /app/people/details/{id} — while
  // the list itself is /app/people with nothing after it. So: a section that
  // names people, followed by something that looks like one record.
  const CONTACT_SECTIONS = ['people', 'person', 'contact', 'contacts', 'prospect', 'prospects'];

  // Segments that follow the section but are still a listing rather than a
  // record. Without these, /app/people/search would read as a contact.
  const NOT_A_RECORD = [
    'list', 'lists', 'search', 'filter', 'filters', 'import', 'imports',
    'all', 'new', 'bulk', 'tags', 'segments',
  ];

  root.slIsContactUrl = function (url) {
    let parsed;
    try {
      parsed = new URL(String(url == null ? '' : url), 'https://app.salesloft.com');
    } catch (e) {
      return false;
    }
    // Some Salesloft routes live in the fragment (#/people/123); treat that as
    // part of the path so both styles resolve the same way.
    const hash = parsed.hash.startsWith('#/') ? parsed.hash.slice(1) : '';
    const parts = (parsed.pathname + hash).split('/').filter(Boolean).map((p) => p.toLowerCase());

    const section = parts.findIndex((p) => CONTACT_SECTIONS.indexOf(p) !== -1);
    if (section < 0) return false;
    return parts.slice(section + 1).some((p) => NOT_A_RECORD.indexOf(p) === -1);
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      DEFAULTS,
      slFormatClock: root.slFormatClock,
      slTranscriptText: root.slTranscriptText,
      slTranscriptFilename: root.slTranscriptFilename,
      slParseTags: root.slParseTags,
      slIsContactUrl: root.slIsContactUrl,
      slColorFor: root.slColorFor,
      slTopColor: root.slTopColor,
      SL_PALETTE: root.SL_PALETTE,
      SL_HEADLINE: root.SL_HEADLINE,
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
