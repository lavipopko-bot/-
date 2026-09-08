// Playback for Chico's voice, plus the amplitude signal the orb breathes to.
// Gemini hands back raw 16-bit PCM, so we decode it ourselves rather than
// leaning on the browser's file decoders.

export class Voice {
  constructor() {
    this.ctx = null;
    this.analyser = null;
    this.source = null;
    this.bins = null;
    this.usedFallback = false;
  }

  // Must be called from inside a user gesture the first time, or iOS keeps
  // the context suspended and nothing is ever heard.
  async unlock() {
    if (!this.ctx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return false;
      this.ctx = new Ctx();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.75;
      this.analyser.connect(this.ctx.destination);
      this.bins = new Uint8Array(this.analyser.frequencyBinCount);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    return true;
  }

  /** Play raw PCM. Resolves when the last sample has been heard. */
  async play({ pcm, sampleRate }) {
    await this.unlock();
    this.stop();
    this.usedFallback = false;

    const samples = new Int16Array(pcm);
    const buffer = this.ctx.createBuffer(1, samples.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i += 1) channel[i] = samples[i] / 32768;

    return new Promise((resolve) => {
      const source = this.ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(this.analyser);
      source.onended = () => {
        if (this.source === source) this.source = null;
        resolve();
      };
      this.source = source;
      source.start();
    });
  }

  /**
   * Last resort when the speech model is unavailable: the browser's own voices.
   * A Brazilian Portuguese voice reading Latin script keeps the accent intact;
   * Hebrew needs a Hebrew voice or it comes out as nonsense.
   */
  speakFallback(text, lang) {
    if (!('speechSynthesis' in window)) return Promise.resolve();
    this.usedFallback = true;
    return new Promise((resolve) => {
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices();
      const hebrew = /[֐-׿]/.test(text);
      const wanted = hebrew ? /^he/i : /^pt[-_]?BR/i;
      const picked = voices.find((v) => wanted.test(v.lang)) || voices.find((v) => /^pt/i.test(v.lang));
      if (picked) {
        utterance.voice = picked;
        utterance.lang = picked.lang;
      } else {
        utterance.lang = hebrew ? 'he-IL' : lang || 'en-US';
      }
      utterance.rate = 0.95;
      utterance.pitch = 0.9;
      utterance.onend = resolve;
      utterance.onerror = resolve;
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
    });
  }

  stop() {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
      } catch {
        /* already finished */
      }
      this.source = null;
    }
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  }

  /** Current loudness, 0..1 — drives the orb. */
  level() {
    if (!this.analyser || !this.source) return 0;
    this.analyser.getByteFrequencyData(this.bins);
    let sum = 0;
    for (let i = 0; i < this.bins.length; i += 1) sum += this.bins[i];
    return Math.min(1, sum / this.bins.length / 90);
  }
}
