// Optional. Serves the app and keeps the Gemini key on the server side, so the
// browser never holds it. Node 18+, no dependencies.
//
//   GEMINI_API_KEY=... node server/server.js
//
// Without this the app runs as pure static files and asks the user for a key.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { API_ROOT, SYSTEM_PROMPT, VOICE_DIRECTION } from '../src/config.js';
import { chooseModels, FALLBACK } from '../src/models.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.PORT) || 8787;
const KEY = process.env.GEMINI_API_KEY;

if (!KEY) {
  console.error('GEMINI_API_KEY is not set. Export it, or run the app as static files instead.');
  process.exit(1);
}

// Resolved from the live model list on first use, so the server does not go
// stale when Google renames or retires a model.
let models = null;

async function resolveModels() {
  if (models) return models;
  models = { ...FALLBACK };
  try {
    const res = await fetch(`${API_ROOT}?pageSize=200`, { headers: { 'x-goog-api-key': KEY } });
    if (res.ok) models = chooseModels((await res.json()).models);
  } catch {
    /* keep the fallback pair */
  }
  console.log(`Chico is using ${models.chat} to think and ${models.tts} to speak.`);
  return models;
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    if (req.url === '/api/health') return json(res, 200, { chico: true });
    if (req.url === '/api/chat') return await proxyChat(req, res);
    if (req.url === '/api/tts') return await proxyTts(req, res);
    return await serveStatic(req, res);
  } catch (err) {
    json(res, 500, { error: { message: err.message } });
  }
});

server.listen(PORT, () => console.log(`Chico is listening on http://localhost:${PORT}`));

// ------------------------------------------------------------------- routes

async function proxyChat(req, res) {
  const { contents } = await readJson(req);
  if (!Array.isArray(contents)) return json(res, 400, { error: { message: 'contents must be an array' } });

  await forward(res, (await resolveModels()).chat, {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.9, topP: 0.95, maxOutputTokens: 800 },
  });
}

async function proxyTts(req, res) {
  const { text, voice } = await readJson(req);
  if (typeof text !== 'string' || !text) return json(res, 400, { error: { message: 'text is required' } });

  await forward(res, (await resolveModels()).tts, {
    contents: [{ parts: [{ text: `${VOICE_DIRECTION}\n\nLINE: ${text}` }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Charon' } } },
    },
  });
}

async function forward(res, model, body, { rediscovered = false } = {}) {
  const upstream = await fetch(`${API_ROOT}/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
    body: JSON.stringify(body),
  });

  if (upstream.status === 404 && !rediscovered) {
    const stale = models;
    models = null;
    const fresh = await resolveModels();
    const retry = model === stale?.chat ? fresh.chat : fresh.tts;
    if (retry !== model) return forward(res, retry, body, { rediscovered: true });
  }

  const payload = await upstream.text();
  res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(payload);
}

// ------------------------------------------------------------------ statics

async function serveStatic(req, res) {
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const relative = normalize(requested === '/' ? 'index.html' : requested.replace(/^\/+/, ''));
  if (relative.startsWith('..')) return json(res, 403, { error: { message: 'forbidden' } });

  try {
    const file = await readFile(join(ROOT, relative));
    res.writeHead(200, { 'Content-Type': TYPES[extname(relative)] || 'application/octet-stream' });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

// ------------------------------------------------------------------- helpers

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) reject(new Error('payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}
