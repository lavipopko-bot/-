// Microphone → text, via the browser's own speech recognition.
// Deliberately one utterance at a time: Chico answers, then listens again,
// which keeps his own voice out of the transcript.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const supported = Boolean(Recognition);

export class Ears {
  constructor({ onInterim, onFinal, onError, onEnd }) {
    this.handlers = { onInterim, onFinal, onError, onEnd };
    this.recognition = null;
    this.listening = false;
    this.gotResult = false;
    this.stoppedByUs = false;
  }

  start(lang) {
    if (!supported || this.listening) return;
    const recognition = new Recognition();
    recognition.lang = lang;
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    this.gotResult = false;
    this.stoppedByUs = false;

    recognition.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (result.isFinal) {
          // One utterance per session, so the first final is the only one we
          // trust: Safari on iOS is known to repeat finals, which would
          // otherwise send the same sentence to Chico twice.
          if (text && !this.gotResult) {
            this.gotResult = true;
            this.handlers.onFinal?.(text);
          }
        } else {
          interim += result[0].transcript;
        }
      }
      if (interim) this.handlers.onInterim?.(interim.trim());
    };

    recognition.onerror = (event) => {
      // "no-speech" and "aborted" are ordinary silence, not failures.
      if (event.error === 'no-speech' || event.error === 'aborted') return;
      this.handlers.onError?.(describe(event.error));
    };

    recognition.onend = () => {
      this.listening = false;
      this.recognition = null;
      this.handlers.onEnd?.({ heardSomething: this.gotResult, deliberate: this.stoppedByUs });
    };

    this.recognition = recognition;
    this.listening = true;
    try {
      recognition.start();
    } catch {
      this.listening = false;
      this.recognition = null;
    }
  }

  stop() {
    this.stoppedByUs = true;
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        /* already gone */
      }
    }
  }
}

function describe(code) {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'אין הרשאה למיקרופון. אשר גישה בדפדפן. / Microphone permission denied — allow access in the browser.';
    case 'audio-capture':
      return 'לא נמצא מיקרופון. / No microphone found.';
    case 'network':
      return 'זיהוי הדיבור נכשל בגלל הרשת. / Speech recognition failed on the network.';
    default:
      return `תקלה בזיהוי הדיבור (${code}). / Speech recognition problem (${code}).`;
  }
}
