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
  };

  root.SL_DEFAULTS = DEFAULTS;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { DEFAULTS };
  }
})(typeof self !== 'undefined' ? self : globalThis);
