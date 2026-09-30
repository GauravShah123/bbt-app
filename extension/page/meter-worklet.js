/* Hybrid Audio — meter-worklet.js (AudioWorkletGlobalScope). Posts {rms} of its input every ~20 ms. */
class HaMeter extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = 0;
    this.n = 0;
    this.target = Math.max(128, Math.round(sampleRate * 0.02));
  }
  process(inputs) {
    var inp = inputs[0];
    var ch = inp && inp[0];
    var len = 128;
    if (ch) {
      len = ch.length;
      var s = 0;
      for (var i = 0; i < len; i++) s += ch[i] * ch[i];
      this.acc += s;
    }
    this.n += len;
    if (this.n >= this.target) {
      this.port.postMessage({ rms: Math.sqrt(this.acc / this.n) });
      this.acc = 0;
      this.n = 0;
    }
    return true;
  }
}
registerProcessor('ha-meter', HaMeter);
