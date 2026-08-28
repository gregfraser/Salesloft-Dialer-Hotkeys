// AudioWorkletProcessor: 48kHz stereo Float32 -> 16kHz mono Int16 (PR-3).
//
// This runs on the dedicated audio thread. ScriptProcessorNode would run on the
// main thread and drop samples whenever the page got busy -- which, on a React
// app mid-call, is constantly.
//
// Downsampling applies a windowed-sinc anti-aliasing filter before decimating.
// Naive decimation would fold everything above 8kHz back into the speech band
// as aliasing, and the result sounds fine to a human while measurably hurting
// word error rate.
//
// Note this is the transcription tap only. The passthrough the rep actually
// hears is a separate, untouched connection straight to the destination.

const FILTER_TAPS = 63;          // odd, so group delay is a whole sample
const DEFAULT_TARGET_RATE = 16000;
const DEFAULT_CHUNK_MS = 100;    // ~3.2 KB per message at 16kHz Int16

class PCMDownsampler extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const settings = (options && options.processorOptions) || {};
    this.targetRate = settings.targetRate || DEFAULT_TARGET_RATE;
    this.chunkSamples = Math.max(
      1,
      Math.round((this.targetRate * (settings.chunkMs || DEFAULT_CHUNK_MS)) / 1000)
    );

    // `sampleRate` is a global in AudioWorkletGlobalScope.
    this.ratio = sampleRate / this.targetRate;

    // Cut below the output Nyquist (8kHz at 16k) with margin for the
    // transition band. PSTN audio is band-limited to ~3.4kHz anyway, so
    // nothing of value lives above this.
    const cutoffHz = Math.min(0.45 * this.targetRate, 7600);
    this.taps = PCMDownsampler.designLowPass(FILTER_TAPS, cutoffHz / sampleRate);

    this.history = new Float32Array(this.taps.length - 1);
    this.phase = 0;
    this.pending = new Int16Array(this.chunkSamples);
    this.pendingCount = 0;
    this.running = true;

    this.port.onmessage = (event) => {
      if (event.data && event.data.type === 'stop') this.running = false;
    };
  }

  /** Windowed-sinc low-pass, Blackman window, unity DC gain. */
  static designLowPass(length, normalizedCutoff) {
    const taps = new Float32Array(length);
    const middle = (length - 1) / 2;
    let sum = 0;
    for (let i = 0; i < length; i += 1) {
      const x = i - middle;
      const sinc =
        x === 0 ? 2 * normalizedCutoff : Math.sin(2 * Math.PI * normalizedCutoff * x) / (Math.PI * x);
      const window =
        0.42 -
        0.5 * Math.cos((2 * Math.PI * i) / (length - 1)) +
        0.08 * Math.cos((4 * Math.PI * i) / (length - 1));
      taps[i] = sinc * window;
      sum += taps[i];
    }
    for (let i = 0; i < length; i += 1) taps[i] /= sum;
    return taps;
  }

  /**
   * Filtered value at input index `i`, where `buffer` is history followed by
   * the current block and index 0 of the block sits at buffer[taps-1].
   */
  filteredAt(buffer, i) {
    const taps = this.taps;
    const count = taps.length;
    let total = 0;
    for (let k = 0; k < count; k += 1) {
      total += taps[k] * buffer[i + count - 1 - k];
    }
    return total;
  }

  process(inputs) {
    if (!this.running) return false;

    const input = inputs[0];
    if (!input || input.length === 0 || !input[0] || input[0].length === 0) {
      // No input yet (or the stream ended); stay alive and wait.
      return true;
    }

    const frames = input[0].length;
    const channels = input.length;

    // Mix to mono. Tab capture is stereo but a phone call carries one voice
    // duplicated across both channels.
    const mono = new Float32Array(frames);
    if (channels === 1) {
      mono.set(input[0]);
    } else {
      for (let c = 0; c < channels; c += 1) {
        const channel = input[c];
        for (let i = 0; i < frames; i += 1) mono[i] += channel[i];
      }
      for (let i = 0; i < frames; i += 1) mono[i] /= channels;
    }

    // History + current block, so the filter has continuity across callbacks.
    const historyLength = this.history.length;
    const buffer = new Float32Array(historyLength + frames);
    buffer.set(this.history, 0);
    buffer.set(mono, historyLength);

    while (this.phase < frames) {
      const index = Math.floor(this.phase);
      const fraction = this.phase - index;
      let value = this.filteredAt(buffer, index);

      if (fraction > 1e-9) {
        // Only reached when the device refuses the requested 48kHz, making the
        // ratio fractional. At the block edge there is no next sample to
        // interpolate toward, so the last one is held; the error is one sample
        // per block on a path that never reaches the rep's ears.
        const next = index + 1 < frames ? this.filteredAt(buffer, index + 1) : value;
        value += (next - value) * fraction;
      }

      const clamped = value > 1 ? 1 : value < -1 ? -1 : value;
      this.pending[this.pendingCount] = clamped * 32767;
      this.pendingCount += 1;

      if (this.pendingCount >= this.chunkSamples) {
        const out = this.pending.slice(0, this.pendingCount);
        // Transferred, not copied: no allocation churn on the audio thread.
        this.port.postMessage(out.buffer, [out.buffer]);
        this.pendingCount = 0;
      }

      this.phase += this.ratio;
    }
    this.phase -= frames;

    // Carry the filter tail into the next callback.
    if (historyLength > 0) {
      if (frames >= historyLength) {
        this.history.set(mono.subarray(frames - historyLength));
      } else {
        this.history.copyWithin(0, frames);
        this.history.set(mono, historyLength - frames);
      }
    }

    return true;
  }
}

registerProcessor('pcm-downsampler', PCMDownsampler);
