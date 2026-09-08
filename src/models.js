// Google renames and retires Gemini models often, so Chico asks the API which
// models the key can actually reach and picks the best fit, rather than
// hardcoding a name that quietly 404s six months from now.

// Used only when discovery fails (offline, restricted key, unexpected shape).
export const FALLBACK = {
  chat: 'gemini-flash-latest',
  tts: 'gemini-2.5-flash-preview-tts',
};

// Models that can generate text but are wrong for a spoken conversation.
const UNSUITABLE = /(embedding|embed|aqa|image|imagen|veo|vision|learnlm|gemma|transcribe|guard)/i;

/**
 * @param {{name: string, supportedGenerationMethods?: string[]}[]} list - ListModels output
 * @returns {{chat: string, tts: string}} bare model ids
 */
export function chooseModels(list) {
  const usable = (list || []).filter(
    (m) => m?.name && (m.supportedGenerationMethods || ['generateContent']).includes('generateContent'),
  );
  const names = usable.map((m) => m.name.replace(/^models\//, ''));

  return {
    chat: best(names.filter((n) => !isTts(n) && !UNSUITABLE.test(n)), scoreChat) || FALLBACK.chat,
    tts: best(names.filter(isTts), scoreTts) || FALLBACK.tts,
  };
}

const isTts = (name) => /tts/i.test(name);

function best(names, score) {
  let winner = null;
  let top = -Infinity;
  for (const name of names) {
    const value = score(name);
    if (value > top) {
      top = value;
      winner = name;
    }
  }
  return winner;
}

// Newest generation wins; among equals, flash beats pro (faster turnarounds
// matter more than depth in conversation), stable beats preview.
function scoreChat(name) {
  let score = generation(name) * 100;
  if (/flash/i.test(name)) score += 30;
  else if (/pro/i.test(name)) score += 20;
  if (/lite/i.test(name)) score -= 18;
  if (/preview|exp\b/i.test(name)) score -= 6;
  if (/latest/i.test(name)) score += 4;
  return score;
}

function scoreTts(name) {
  let score = generation(name) * 100;
  if (/flash/i.test(name)) score += 10;
  if (/lite/i.test(name)) score -= 8;
  if (/preview|exp\b/i.test(name)) score -= 6;
  return score;
}

// "gemini-3.8-flash" -> 3.8 ; an unversioned "-latest" alias reads as current.
function generation(name) {
  const match = /gemini-(\d+(?:\.\d+)?)/i.exec(name);
  if (match) return Number(match[1]);
  return /latest/i.test(name) ? 99 : 0;
}
