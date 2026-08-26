// Offscreen document: audio graph, mandatory passthrough, WebSocket client.
//
// Lives here rather than in the service worker because MV3 workers terminate
// after ~30s idle and cannot hold MediaStream objects.
//
// ---------------------------------------------------------------------------
// THE PASSTHROUGH IS LOAD-BEARING. Chrome's tab capture removes audio from the
// normal output path by design. Without reconnecting the stream to the
// AudioContext destination, the rep hears silence and the call is dead. This
// does not show up in unit tests, synthetic tone tests, or any test that is not
// an actual call with an actual human on the other end.
//
// If the passthrough cannot be established, capture is torn down entirely.
// No transcription is always better than a broken call.
// ---------------------------------------------------------------------------

'use strict';

const CAPTURE_SAMPLE_RATE = 48000;
const TARGET_SAMPLE_RATE = 16000;
const CHUNK_MS = 100;
const RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000, 15000];

const state = {
  settings: Object.assign({}, self.SL_DEFAULTS || {}),
  audioContext: null,
  mediaStream: null,
  sourceNode: null,
  passthroughNode: null,
  workletNode: null,
  workletSink: null,
  socket: null,
  callId: null,
  paused: false,
  capturing: false,
  reconnectAttempt: 0,
  reconnectTimer: null,
  deliberateClose: false,
};

function report(stateName, detail) {
  chrome.runtime
    .sendMessage({ type: 'transcription-status', state: stateName, detail: detail || '' })
    .catch(() => {});
}

function forwardTranscript(payload) {
  chrome.runtime.sendMessage({ type: 'transcript', payload }).catch(() => {});
}

// ----------------------------------------------------------------- capture
async function startCapture(streamId, settings) {
  if (state.capturing) return;
  if (settings) state.settings = Object.assign({}, state.settings, settings);

  try {
    state.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId,
        },
      },
      video: false,
    });
  } catch (err) {
    report('error', 'Could not capture tab audio');
    console.error('[transcriber] getUserMedia failed', err);
    return;
  }

  try {
    await buildAudioGraph();
  } catch (err) {
    console.error('[transcriber] audio graph failed', err);
    // Tear everything down: a half-built graph is exactly the state where the
    // rep can no longer hear the call.
    await stopCapture();
    report('error', 'Audio setup failed — transcription off, call unaffected');
    return;
  }

  // The tab going away (navigation, close) ends the track.
  state.mediaStream.getAudioTracks().forEach((track) => {
    track.addEventListener('ended', () => {
      stopCapture();
      report('offline', 'Capture ended');
    });
  });

  state.capturing = true;
  connectSocket();
}

async function buildAudioGraph() {
  const context = new AudioContext({ sampleRate: CAPTURE_SAMPLE_RATE });
  state.audioContext = context;

  // Route the captured audio to the rep's speakers BEFORE anything else. If
  // the rest of setup throws, this connection is already in place.
  state.sourceNode = context.createMediaStreamSource(state.mediaStream);
  state.passthroughNode = context.createGain();
  state.passthroughNode.gain.value = 1.0;
  state.sourceNode.connect(state.passthroughNode);
  state.passthroughNode.connect(context.destination);

  await selectOutputDevice(context);
  await ensureRunning(context);

  // Transcription tap, entirely separate from the path above.
  await context.audioWorklet.addModule(chrome.runtime.getURL('pcm-worklet.js'));
  state.workletNode = new AudioWorkletNode(context, 'pcm-downsampler', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    processorOptions: { targetRate: TARGET_SAMPLE_RATE, chunkMs: CHUNK_MS },
  });
  state.sourceNode.connect(state.workletNode);

  // A worklet with no downstream connection is not guaranteed to be pulled by
  // the graph. Route it through a silent gain so it runs without adding sound.
  state.workletSink = context.createGain();
  state.workletSink.gain.value = 0;
  state.workletNode.connect(state.workletSink);
  state.workletSink.connect(context.destination);

  state.workletNode.port.onmessage = (event) => {
    if (state.paused) return;                       // dropped, never buffered
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
    try {
      state.socket.send(event.data);
    } catch (err) {
      console.warn('[transcriber] send failed', err);
    }
  };
}

async function selectOutputDevice(context) {
  // AudioContext.destination plays through the *default* output device. A rep
  // whose headset is selected in Salesloft but is not the Windows default
  // would get capture working, passthrough "working", and the call coming out
  // of the laptop speakers. See docs/troubleshooting.md.
  const deviceId = state.settings.outputDeviceId;
  if (!deviceId || typeof context.setSinkId !== 'function') return;
  try {
    await context.setSinkId(deviceId);
  } catch (err) {
    console.warn('[transcriber] setSinkId failed, using system default', err);
    report('degraded', 'Could not select output device — using system default');
  }
}

async function ensureRunning(context) {
  if (context.state === 'running') return;
  try {
    await context.resume();
  } catch (err) {
    console.warn('[transcriber] resume failed', err);
  }
  if (context.state !== 'running') {
    // A suspended context means the passthrough is silent, which is the exact
    // failure this whole module exists to avoid.
    throw new Error(`AudioContext did not start (state: ${context.state})`);
  }
}

async function stopCapture() {
  state.capturing = false;

  if (state.workletNode) {
    try { state.workletNode.port.postMessage({ type: 'stop' }); } catch (err) { /* already gone */ }
    try { state.workletNode.disconnect(); } catch (err) { /* already gone */ }
  }
  [state.workletSink, state.passthroughNode, state.sourceNode].forEach((node) => {
    if (node) { try { node.disconnect(); } catch (err) { /* already gone */ } }
  });

  if (state.mediaStream) {
    // Stopping the tracks is what returns audio to the tab's normal path.
    state.mediaStream.getTracks().forEach((track) => track.stop());
  }
  if (state.audioContext && state.audioContext.state !== 'closed') {
    try { await state.audioContext.close(); } catch (err) { /* already closed */ }
  }

  state.workletNode = null;
  state.workletSink = null;
  state.passthroughNode = null;
  state.sourceNode = null;
  state.mediaStream = null;
  state.audioContext = null;

  closeSocket();
}

// --------------------------------------------------------------- transport
function connectSocket() {
  if (state.socket && (state.socket.readyState === WebSocket.OPEN || state.socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  clearTimeout(state.reconnectTimer);
  state.deliberateClose = false;

  let socket;
  try {
    socket = new WebSocket(state.settings.serverUrl);
  } catch (err) {
    scheduleReconnect();
    return;
  }
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

  socket.onopen = () => {
    state.reconnectAttempt = 0;
    report('ready', 'Transcription connected');
    if (state.callId) sendControl({ type: 'call_start', call_id: state.callId, ts: nowSeconds() });
  };

  socket.onmessage = (event) => {
    if (typeof event.data !== 'string') return;
    let payload;
    try {
      payload = JSON.parse(event.data);
    } catch (err) {
      return;
    }
    if (payload.type === 'transcript') forwardTranscript(payload);
    else if (payload.type === 'status') report(payload.state, payload.detail);
  };

  socket.onerror = () => {
    // onclose always follows; reconnection is handled there.
  };

  socket.onclose = () => {
    if (state.deliberateClose) return;
    // Server unavailability degrades to "offline" and never touches the call.
    report('offline', 'Transcription offline — call unaffected');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  if (!state.capturing) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(state.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  state.reconnectAttempt += 1;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = setTimeout(connectSocket, delay);
}

function closeSocket() {
  clearTimeout(state.reconnectTimer);
  state.deliberateClose = true;
  if (state.socket) {
    try { state.socket.close(); } catch (err) { /* already closed */ }
  }
  state.socket = null;
  state.reconnectAttempt = 0;
}

function sendControl(message) {
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) return;
  try {
    state.socket.send(JSON.stringify(message));
  } catch (err) {
    console.warn('[transcriber] control send failed', err);
  }
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- messages
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.target !== 'offscreen') return false;

  switch (message.type) {
    case 'start-capture':
      startCapture(message.streamId, message.settings);
      break;
    case 'stop-capture':
      stopCapture();
      break;
    case 'call-start':
      state.callId = message.callId;
      state.paused = false;
      sendControl({ type: 'call_start', call_id: message.callId, ts: nowSeconds() });
      break;
    case 'call-end':
      if (state.callId) sendControl({ type: 'call_end', call_id: state.callId, ts: nowSeconds() });
      state.callId = null;
      break;
    case 'set-paused':
      state.paused = !!message.paused;
      sendControl({ type: state.paused ? 'pause' : 'resume' });
      break;
    case 'settings':
      state.settings = Object.assign({}, state.settings, message.settings);
      break;
    default:
      break;
  }
  sendResponse({ ok: true });
  return false;
});
