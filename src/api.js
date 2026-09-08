// Gemini transport: conversation turns and speech synthesis.
// Runs either against a local proxy (key stays on the server) or, if no proxy
// is present, straight from the browser with a key the user pasted in.

import { API_ROOT, SYSTEM_PROMPT, VOICE_DIRECTION } from './config.js';
import { chooseModels, FALLBACK } from './models.js';

const KEY_STORAGE = 'chico.apiKey';
const MODEL_STORAGE = 'chico.models';
const MODEL_TTL = 24 * 60 * 60 * 1000;

let proxyProbe = null; // in-flight or settled probe, so we only ever ask once
let models = null;      // resolved { chat, tts }

export function getKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch {
    return '';
  }
}

export function setKey(key) {
  forgetModels();
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key.trim());
    else localStorage.removeItem(KEY_STORAGE);
  } catch {
    /* private mode — the key just lives for this page load */
  }
}

// Is there a server in front of us holding the key? Asked exactly once — the
// promise itself is the cache, so concurrent callers share one request.
export function hasProxy() {
  proxyProbe ??= fetch('/api/health')
    .then((res) => (res.ok ? res.json() : null))
    .then((body) => body?.chico === true)
    .catch(() => false);
  return proxyProbe;
}

export async function isReady() {
  return (await hasProxy()) || Boolean(getKey());
}

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

async function post(path, body, { attempt = 0, rediscovered = false } = {}) {
  const viaProxy = await hasProxy();
  let url = `/api${path}`;
  if (!viaProxy) {
    const chosen = await resolveModels();
    const model = path === '/chat' ? chosen.chat : chosen.tts;
    url = `${API_ROOT}/${model}:generateContent?key=${encodeURIComponent(getKey())}`;
  }

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(viaProxy ? body.proxy : body.direct),
    });
  } catch {
    throw new ApiError('אין חיבור לרשת. / No network connection.', 0);
  }

  if (!res.ok) {
    // A retired or renamed model: forget what we picked and choose again, once.
    if (res.status === 404 && !viaProxy && !rediscovered) {
      forgetModels();
      return post(path, body, { attempt, rediscovered: true });
    }
    if (RETRY_STATUS.has(res.status) && attempt < 3) {
      await sleep(600 * 2 ** attempt);
      return post(path, body, { attempt: attempt + 1, rediscovered });
    }
    throw new ApiError(await describeFailure(res), res.status);
  }
  return res.json();
}

/**
 * Which models this key can actually reach. Asked once per day, then cached —
 * hardcoded model ids go stale as Google ships and retires versions.
 */
async function resolveModels() {
  if (models) return models;

  try {
    const cached = JSON.parse(localStorage.getItem(MODEL_STORAGE) || 'null');
    if (cached?.at && Date.now() - cached.at < MODEL_TTL && cached.chat && cached.tts) {
      models = { chat: cached.chat, tts: cached.tts };
      return models;
    }
  } catch {
    /* no cache to read */
  }

  models = { ...FALLBACK };
  try {
    const res = await fetch(`${API_ROOT}?key=${encodeURIComponent(getKey())}&pageSize=200`);
    if (res.ok) models = chooseModels((await res.json()).models);
  } catch {
    /* stay on the fallback pair */
  }

  try {
    localStorage.setItem(MODEL_STORAGE, JSON.stringify({ ...models, at: Date.now() }));
  } catch {
    /* nothing to persist to */
  }
  return models;
}

/** Drop the cached choice so the next call re-discovers (a model was retired). */
function forgetModels() {
  models = null;
  try {
    localStorage.removeItem(MODEL_STORAGE);
  } catch {
    /* nothing to clear */
  }
}

async function describeFailure(res) {
  let detail = '';
  try {
    const data = await res.json();
    detail = data?.error?.message || '';
  } catch {
    /* body was not JSON */
  }
  if (res.status === 400 && /api[_ ]?key/i.test(detail)) {
    return 'מפתח ה-API לא תקין. / The API key is not valid.';
  }
  if (res.status === 403) return 'המפתח נדחה — בדוק שה-Generative Language API מופעל. / Key rejected — check the Generative Language API is enabled.';
  if (res.status === 429) return 'חרגת ממכסת השימוש, נסה שוב בעוד רגע. / Rate limit reached, try again shortly.';
  if (res.status === 404) return 'הדגם המבוקש לא זמין למפתח הזה. / The requested model is not available to this key.';
  return detail || `שגיאה ${res.status} מהשרת. / Server error ${res.status}.`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Send the conversation so far and get Chico's next line.
 * @param {{role: 'user'|'model', text: string}[]} history
 * @returns {Promise<string>}
 */
export async function chat(history) {
  const contents = history.map(({ role, text }) => ({ role, parts: [{ text }] }));
  const direct = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: {
      temperature: 0.9,
      topP: 0.95,
      maxOutputTokens: 800,
    },
  };
  const data = await post('/chat', { direct, proxy: { contents } });
  const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join(' ').trim();
  if (!text) {
    const blocked = data?.promptFeedback?.blockReason || data?.candidates?.[0]?.finishReason;
    throw new ApiError(
      blocked ? `לא הצלחתי לענות על זה (${blocked}). / I could not answer that (${blocked}).` : 'תשובה ריקה מהמודל. / Empty response from the model.',
      200,
    );
  }
  return text;
}

/**
 * Turn a line of Chico's into spoken audio.
 * @returns {Promise<{pcm: ArrayBuffer, sampleRate: number}>}
 */
export async function speak(text, voiceName) {
  const prompt = `${VOICE_DIRECTION}\n\nLINE: ${text}`;
  const speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName } } };
  const direct = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseModalities: ['AUDIO'], speechConfig },
  };
  const data = await post('/tts', { direct, proxy: { text, voice: voiceName } });

  const part = data?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new ApiError('לא התקבל אודיו מהמודל. / No audio came back from the model.', 200);

  return {
    pcm: base64ToBuffer(part.inlineData.data),
    sampleRate: sampleRateFrom(part.inlineData.mimeType),
  };
}

function sampleRateFrom(mimeType = '') {
  const match = /rate=(\d+)/.exec(mimeType);
  return match ? Number(match[1]) : 24000;
}

function base64ToBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export { ApiError };
