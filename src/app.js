// Chico — the whole app is one loop: listen, think, speak, listen again.

import { DEFAULTS, LANGUAGES, VOICES } from './config.js';
import * as api from './api.js';
import { Voice } from './audio.js';
import { Ears, supported as sttSupported } from './speech.js';

const $ = (id) => document.getElementById(id);

const ui = {
  orb: $('orb'),
  stage: $('stage'),
  state: $('state'),
  caption: $('caption'),
  hint: $('hint'),
  error: $('error'),
  settingsToggle: $('settings-toggle'),
  settings: $('settings'),
  key: $('key'),
  keySave: $('key-save'),
  keyRow: $('key-row'),
  voice: $('voice'),
  lang: $('lang'),
  handsFree: $('hands-free'),
  captions: $('captions'),
  reset: $('reset'),
};

const prefs = loadPrefs();
const voice = new Voice();
let history = [];
let state = 'asleep';
let awake = false;
let turnId = 0; // bumped whenever the user takes the floor back, so an
                // in-flight reply knows it has been superseded

const ears = new Ears({
  onInterim: (text) => showCaption(text, 'interim'),
  onFinal: (text) => handleUtterance(text),
  onError: (message) => fail(message),
  onEnd: ({ heardSomething, deliberate }) => {
    if (state !== 'listening') return;
    if (heardSomething || deliberate) return;
    // Silence: in hands-free we keep the ear open, otherwise we settle.
    if (awake && prefs.handsFree) listen();
    else setState('idle');
  },
});

// ---------------------------------------------------------------- lifecycle

function boot() {
  fillSelect(ui.voice, VOICES, prefs.voice);
  fillSelect(ui.lang, LANGUAGES, prefs.lang);
  ui.handsFree.checked = prefs.handsFree;
  ui.captions.checked = prefs.captions;
  ui.key.value = api.getKey();
  document.body.classList.toggle('no-captions', !prefs.captions);

  ui.orb.addEventListener('click', onOrbTap);
  ui.settingsToggle.addEventListener('click', () => ui.settings.classList.toggle('open'));
  ui.keySave.addEventListener('click', saveKey);
  ui.key.addEventListener('keydown', (e) => e.key === 'Enter' && saveKey());
  ui.voice.addEventListener('change', () => savePrefs({ voice: ui.voice.value }));
  ui.lang.addEventListener('change', () => savePrefs({ lang: ui.lang.value }));
  ui.handsFree.addEventListener('change', () => savePrefs({ handsFree: ui.handsFree.checked }));
  ui.captions.addEventListener('change', () => {
    savePrefs({ captions: ui.captions.checked });
    document.body.classList.toggle('no-captions', !ui.captions.checked);
  });
  ui.reset.addEventListener('click', resetConversation);
  // Tapping the room outside the sheet puts it away. Captured on the way down
  // so a handler further in — the orb asking for a missing key — can still
  // open the sheet afterwards and have it stay open.
  ui.stage.addEventListener('click', (event) => {
    const outside = !ui.settings.contains(event.target) && event.target !== ui.settingsToggle;
    if (outside && ui.settings.classList.contains('open')) ui.settings.classList.remove('open');
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      onOrbTap();
    }
  });

  if (!sttSupported) {
    fail('הדפדפן הזה לא תומך בזיהוי דיבור. פתח את ציקו ב-Chrome או ב-Edge. / This browser cannot listen. Open Chico in Chrome or Edge.');
    ui.orb.classList.add('disabled');
  }

  api.hasProxy().then((viaProxy) => {
    if (viaProxy) ui.keyRow.hidden = true;
  });

  paint();
  setState('asleep');
}

async function onOrbTap() {
  if (!sttSupported) return;

  if (state === 'speaking') {
    // Barge-in: cut Chico off and hand the floor back.
    voice.stop();
    listen();
    return;
  }
  if (state === 'listening') {
    ears.stop();
    setState('idle');
    return;
  }
  if (state === 'thinking') return;

  await voice.unlock();
  clearError();

  if (!(await api.isReady())) {
    fail('חסר מפתח API של Gemini — הוסף אותו בהגדרות. / Missing Gemini API key — add one in settings.');
    ui.settings.classList.add('open');
    return;
  }

  if (!awake) {
    awake = true;
    await greet();
    return;
  }
  listen();
}

// First contact — Chico introduces himself in the chosen language.
async function greet() {
  const opener = prefs.lang === 'he-IL'
    ? 'המשתמש הרגע הפעיל אותך לראשונה. ברך אותו בקצרה בעברית, הצג את עצמך בשם ציקו במשפט אחד ושאל במה תוכל לעזור.'
    : 'The user has just switched you on for the first time. Greet them briefly in English, introduce yourself as Chico in one sentence, and ask what they need.';
  await respondTo(opener);
}

function listen() {
  if (!awake) return;
  turnId += 1;
  clearError();
  setState('listening');
  showCaption('', 'interim');
  ears.start(prefs.lang);
}

async function handleUtterance(text) {
  ears.stop();
  showCaption(text, 'user');
  await respondTo(text);
}

/** One full turn: think, then speak. */
async function respondTo(text) {
  const turn = (turnId += 1);
  const current = () => turn === turnId;

  setState('thinking');
  history.push({ role: 'user', text });

  let reply;
  try {
    reply = await api.chat(history);
  } catch (err) {
    history.pop();
    if (!current()) return;
    fail(err.message);
    setState('idle');
    return;
  }
  if (!current()) return; // cut off or reset while we were thinking

  history.push({ role: 'model', text: reply });
  trimHistory();
  showCaption(reply, 'chico');

  setState('speaking');
  try {
    const audio = await api.speak(reply, prefs.voice);
    if (!current()) return; // cut off while the audio was still downloading
    await voice.play(audio);
  } catch {
    if (!current()) return;
    // The speech model can be busy or rate-limited; the browser can still talk.
    await voice.speakFallback(reply, prefs.lang);
  }

  if (!current() || state !== 'speaking') return; // barge-in already moved us on
  if (prefs.handsFree) listen();
  else setState('idle');
}

function resetConversation() {
  turnId += 1;
  voice.stop();
  ears.stop();
  history = [];
  awake = false;
  clearError();
  showCaption('', 'chico');
  setState('asleep');
  ui.settings.classList.remove('open');
}

function trimHistory() {
  // Keep the conversation bounded so long sessions stay fast and cheap.
  const MAX_TURNS = 40;
  if (history.length > MAX_TURNS) history = history.slice(-MAX_TURNS);
}

// ----------------------------------------------------------------- wake lock

// A phone screen that sleeps mid-sentence ends the conversation, so the screen
// is held awake while Chico is in play and released the moment he rests.
let wakeLock = null;

async function holdScreenAwake() {
  if (!('wakeLock' in navigator) || wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => { wakeLock = null; });
  } catch {
    /* denied, or the battery is too low — not worth telling the user */
  }
}

function letScreenSleep() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// Switching tabs drops the lock silently; take it back on return if we're mid-talk.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && awake && state !== 'asleep') holdScreenAwake();
});

// ---------------------------------------------------------------------- view

const STATE_TEXT = {
  asleep: { he: 'ציקו במנוחה', en: 'Chico is resting', hint: 'לחץ על העיגול כדי להתחיל · Tap the orb to begin' },
  idle: { he: 'ציקו מוכן', en: 'Chico is ready', hint: 'לחץ ודבר · Tap and speak' },
  listening: { he: 'מקשיב…', en: 'Listening…', hint: 'דבר חופשי · Speak freely' },
  thinking: { he: 'חושב…', en: 'Thinking…', hint: '' },
  speaking: { he: 'מדבר…', en: 'Speaking…', hint: 'לחץ כדי להפסיק אותו · Tap to cut in' },
};

function setState(next) {
  state = next;
  if (next === 'asleep') letScreenSleep();
  else holdScreenAwake();
  const copy = STATE_TEXT[next];
  ui.stage.dataset.state = next;
  ui.state.textContent = prefs.lang === 'he-IL' ? copy.he : copy.en;
  ui.hint.textContent = copy.hint;
}

function showCaption(text, who) {
  ui.caption.dataset.who = who;
  ui.caption.textContent = text;
  ui.caption.dir = /[֐-׿]/.test(text) ? 'rtl' : 'ltr';
}

function fail(message) {
  ui.error.textContent = message;
  ui.error.hidden = false;
}

function clearError() {
  ui.error.hidden = true;
  ui.error.textContent = '';
}

// The orb: idles on a slow breath, swells with Chico's actual voice.
function paint() {
  const t = performance.now() / 1000;
  let energy;
  if (state === 'speaking') energy = 0.25 + voice.level() * 0.85;
  else if (state === 'listening') energy = 0.18 + (Math.sin(t * 3.2) * 0.5 + 0.5) * 0.22;
  else if (state === 'thinking') energy = 0.14 + (Math.sin(t * 6) * 0.5 + 0.5) * 0.1;
  else energy = 0.06 + (Math.sin(t * 1.1) * 0.5 + 0.5) * 0.06;

  ui.orb.style.setProperty('--energy', energy.toFixed(3));
  ui.orb.style.setProperty('--spin', `${(t * 12) % 360}deg`);
  requestAnimationFrame(paint);
}

// ------------------------------------------------------------------- config

function fillSelect(select, options, selected) {
  select.innerHTML = '';
  for (const { id, label } of options) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    option.selected = id === selected;
    select.append(option);
  }
}

function saveKey() {
  api.setKey(ui.key.value);
  clearError();
  ui.keySave.textContent = '✓';
  setTimeout(() => {
    ui.keySave.textContent = 'שמור';
  }, 1400);
}

function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('chico.prefs') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

function savePrefs(patch) {
  Object.assign(prefs, patch);
  try {
    localStorage.setItem('chico.prefs', JSON.stringify(prefs));
  } catch {
    /* nothing to persist to */
  }
  setState(state);
}

boot();
