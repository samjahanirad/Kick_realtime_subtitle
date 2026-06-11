// AudioWorklet: taps the captured tab audio, downmixes to mono,
// and posts ~46ms blocks of Float32 PCM to the main thread.

class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let s = 0;
      for (let c = 0; c < input.length; c++) s += input[c][i];
      this.buf[this.fill++] = s / input.length;
      if (this.fill === this.buf.length) {
        const out = this.buf.slice(0);
        this.port.postMessage(out, [out.buffer]);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-tap', PcmTap);
