// AudioWorklet downsampler tests (PR-3).
//
// Run with:  node --test tests/test_pcm_worklet.js
//
// The worklet runs in AudioWorkletGlobalScope, so its globals are stubbed here
// and the registered processor class is captured for direct exercise.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const INPUT_RATE = 48000;
const TARGET_RATE = 16000;

globalThis.sampleRate = INPUT_RATE;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {}, onmessage: null };
  }
};

let Downsampler = null;
globalThis.registerProcessor = (_name, cls) => { Downsampler = cls; };
require(path.join(__dirname, '..', 'extension', 'pcm-worklet.js'));

function makeProcessor(chunkMs = 100) {
  const processor = new Downsampler({
    processorOptions: { targetRate: TARGET_RATE, chunkMs },
  });
  const chunks = [];
  processor.port.postMessage = (buffer) => chunks.push(new Int16Array(buffer));
  return { processor, chunks };
}

/** Feed `seconds` of a tone, return every Int16 sample that came out. */
function run(processor, chunks, seconds, generator, channels = 1) {
  const blockSize = 128;
  const blocks = Math.floor((seconds * INPUT_RATE) / blockSize);
  let n = 0;
  for (let b = 0; b < blocks; b += 1) {
    const block = [];
    for (let c = 0; c < channels; c += 1) {
      const data = new Float32Array(blockSize);
      for (let i = 0; i < blockSize; i += 1) data[i] = generator(n + i, c);
      block.push(data);
    }
    processor.process([block]);
    n += blockSize;
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}

const tone = (hz, amplitude = 0.8) => (i) => amplitude * Math.sin((2 * Math.PI * hz * i) / INPUT_RATE);

function rms(samples) {
  if (!samples.length) return 0;
  let total = 0;
  for (const s of samples) total += (s / 32768) ** 2;
  return Math.sqrt(total / samples.length);
}

// ------------------------------------------------------------------- rates
test('48kHz in produces 16kHz out', () => {
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 1.0, tone(440));
  // One second in, one second out at the target rate (within a chunk).
  assert.ok(Math.abs(out.length - TARGET_RATE) <= 1600, `got ${out.length} samples`);
});

test('output arrives in 100ms chunks', () => {
  const { processor, chunks } = makeProcessor(100);
  run(processor, chunks, 1.0, tone(440));
  assert.ok(chunks.length >= 9);
  for (const chunk of chunks) assert.strictEqual(chunk.length, 1600);
});

test('sustained throughput is about 32 KB/sec', () => {
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 2.0, tone(440));
  const bytesPerSecond = (out.length * 2) / 2.0;
  assert.ok(Math.abs(bytesPerSecond - 32000) < 2000, `got ${bytesPerSecond} B/s`);
});

// ---------------------------------------------------------- anti-aliasing
test('speech-band content passes through', () => {
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 0.5, tone(300));
  assert.ok(rms(out) > 0.3, `300Hz tone was attenuated: rms ${rms(out)}`);
});

test('content above the output Nyquist is filtered, not aliased', () => {
  // A 12kHz tone decimated naively to 16kHz folds down to 4kHz -- right in
  // the middle of the speech band, and inaudible as a defect.
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 0.5, tone(12000));
  assert.ok(rms(out) < 0.02, `12kHz tone was not attenuated: rms ${rms(out)}`);
});

test('the filter has unity gain at DC', () => {
  let sum = 0;
  for (const tap of Downsampler.designLowPass(63, 7600 / INPUT_RATE)) sum += tap;
  assert.ok(Math.abs(sum - 1) < 1e-6, `DC gain ${sum}`);
});

test('a constant signal survives at full amplitude', () => {
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 0.3, () => 0.5);
  const settled = out.subarray(200);
  const mean = settled.reduce((a, b) => a + b, 0) / settled.length / 32768;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `DC level drifted to ${mean}`);
});

// -------------------------------------------------------------- channels
test('stereo is mixed down to mono', () => {
  const { processor, chunks } = makeProcessor();
  // Identical content in both channels must not double the amplitude.
  const out = run(processor, chunks, 0.3, () => 0.5, 2);
  const settled = out.subarray(200);
  const mean = settled.reduce((a, b) => a + b, 0) / settled.length / 32768;
  assert.ok(Math.abs(mean - 0.5) < 0.01, `stereo mix produced ${mean}`);
});

test('opposite-phase channels cancel, proving a real mix', () => {
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 0.3, (i, c) => (c === 0 ? 0.5 : -0.5), 2);
  assert.ok(rms(out) < 0.01, 'channels were not averaged');
});

// ------------------------------------------------------------- behaviour
test('silence in, silence out', () => {
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 0.5, () => 0);
  assert.strictEqual(rms(out), 0);
});

test('the processor stays alive while running', () => {
  const { processor } = makeProcessor();
  assert.strictEqual(processor.process([[new Float32Array(128)]]), true);
});

test('an empty input block does not end the processor', () => {
  const { processor } = makeProcessor();
  assert.strictEqual(processor.process([[]]), true);
  assert.strictEqual(processor.process([]), true);
});

test('a stop message retires the processor', () => {
  const { processor } = makeProcessor();
  processor.port.onmessage({ data: { type: 'stop' } });
  assert.strictEqual(processor.process([[new Float32Array(128)]]), false);
});

test('filter continuity is preserved across callbacks', () => {
  // A discontinuity at block boundaries would show up as broadband noise on
  // an otherwise pure tone.
  const { processor, chunks } = makeProcessor();
  const out = run(processor, chunks, 0.5, tone(1000));
  let jumps = 0;
  for (let i = 1; i < out.length; i += 1) {
    if (Math.abs(out[i] - out[i - 1]) > 12000) jumps += 1;
  }
  assert.strictEqual(jumps, 0, `${jumps} discontinuities in the output`);
});
