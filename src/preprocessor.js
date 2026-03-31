/**
 * preprocessor.js
 *
 * A fast, token-based romaji preprocessing pipeline for medical interpreter use.
 *
 * Pipeline per input:
 *   1. Lowercase + collapse whitespace
 *   2. WanaKana round-trip (romaji → hiragana → romaji) — normalises variants
 *      e.g. "si" → "shi", "tu" → "tsu", "ti" → "chi"
 *   3. Tokenise by whitespace
 *   4. Per token: Fuse.js fuzzy search against vocabulary
 *      → replace only on confident match (score ≤ threshold)
 *   5. Reconstruct sentence
 *
 * Design decisions:
 *   - Fuse.js index is built ONCE per preprocessor instance, NOT per token.
 *   - Vocabulary is INJECTED (dependency injection) — never owned internally.
 *   - WanaKana round-trip tolerates non-romaji tokens gracefully (they pass through).
 *   - ENG preprocessing remains a lightweight regex map (no dependency needed).
 */

import * as wanakana from 'wanakana';
import Fuse          from 'fuse.js';
import { readFile }  from 'fs/promises';

// ─────────────────────────────────────────────────────────────────
// Fuse.js configuration
// ─────────────────────────────────────────────────────────────────

const FUSE_OPTIONS = {
  includeScore:    true,
  threshold:       0.2,   // very strict — only confident matches replace tokens (prevents forcing unrelated words)
  distance:        50,    // short strings; keep distance window small
  minMatchCharLength: 2,  // ignore single-char noise
  shouldSort:      true,
};

// ─────────────────────────────────────────────────────────────────
// WanaKana: normalise a single romaji token via round-trip
// romaji → hiragana → romaji  (enforces standard Hepburn)
// ─────────────────────────────────────────────────────────────────

function wkNormalize(token) {
  try {
    if (!wanakana.isRomaji(token)) return token; // not romaji — pass through
    const hiragana = wanakana.toHiragana(token, { passRomaji: false });
    return wanakana.toRomaji(hiragana);
  } catch {
    return token; // safety net — never crash on bad input
  }
}

// ─────────────────────────────────────────────────────────────────
// Romaji Verb Deconjugator
// ─────────────────────────────────────────────────────────────────

/**
 * Generates possible dictionary root forms for a conjugated romaji verb.
 */
export function getRoots(token) {
  const roots = [];
  
  // Progressive and V-te iru forms
  const teiruMatch = token.match(/^(.*)(teimasu|teimashita|teimasen|teiru|teita|tenai|teta|tetenai)$/);
  if (teiruMatch) {
    roots.push(...getRoots(teiruMatch[1] + 'te')); // hareteimasu -> harete
  }
  
  // Tte / Tta forms (Godan: u, tsu, ru)
  if (token.endsWith('tte') || token.endsWith('tta')) {
    const base = token.slice(0, -3); // motte -> mo
    roots.push(base + 'u', base + 'tsu', base + 'ru');
  }
  // Nde / Nda forms (Godan: mu, nu, bu)
  if (token.endsWith('nde') || token.endsWith('nda')) {
    const base = token.slice(0, -3); // nonde -> no
    roots.push(base + 'mu', base + 'nu', base + 'bu');
  }
  // Ite / Ita forms (Godan: ku)
  if (token.endsWith('ite') || token.endsWith('ita')) {
    const base = token.slice(0, -3); // kaite -> ka
    roots.push(base + 'ku');
  }
  // Ide / Ida forms (Godan: gu)
  if (token.endsWith('ide') || token.endsWith('ida')) {
    const base = token.slice(0, -3); // oyogu -> oyo
    roots.push(base + 'gu');
  }
  // Shite / Shita forms (Godan: su, suru-verbs)
  if (token.endsWith('shite') || token.endsWith('shita')) {
    const base = token.slice(0, -5); // hanashite -> hana
    roots.push(base + 'su', base + 'suru');
  }
  
  // Te / Ta forms for ALL Ichidan (ru-verbs)
  // This must run universally for anything ending in te/ta (e.g. ochi-te -> ochi-ru, hare-te -> hare-ru)
  if (token.endsWith('te') || token.endsWith('ta')) {
    const base = token.slice(0, -2);
    roots.push(base + 'ru');
  }
  
  // Helper to convert i-stem to u-stem in Hepburn Romaji
  const toGodanRoot = (baseI) => baseI.replace(/shi$/, 'su').replace(/chi$/, 'tsu').replace(/i$/, 'u');

  // Masu forms
  const masuMatch = token.match(/^(.*)(masu|mashita|masen)$/);
  if (masuMatch) {
    const base = masuMatch[1];
    roots.push(base + 'ru'); 
    roots.push(toGodanRoot(base)); // dashimashita -> dashi -> dasu
  }
  
  // Nai forms
  const naiMatch = token.match(/^(.*)(nai|nakatta|nakute|naide)$/);
  if (naiMatch) {
    const base = naiMatch[1];
    roots.push(base + 'ru');
    if (base.endsWith('a')) roots.push(base.slice(0, -1) + 'u'); // kakanai -> kaku
  }
  
  // Tai forms
  const taiMatch = token.match(/^(.*)(tai|takatta|takute)$/);
  if (taiMatch) {
    const base = taiMatch[1];
    roots.push(base + 'ru');
    roots.push(toGodanRoot(base)); // kakitai -> kaki -> kaku
  }
  
  // Reru / Rareru (Potential / Passive)
  const reruMatch = token.match(/^(.*)(reru|rareru|renai|rarenai|remasu|raremasu)$/);
  if (reruMatch) {
    const base = reruMatch[1];
    roots.push(base + 'ru', base + 'u'); // taberareru -> taberu
  }
  
  // Causative
  const seruMatch = token.match(/^(.*)(seru|saseru|senai|sasenai)$/);
  if (seruMatch) {
    const base = seruMatch[1];
    roots.push(base + 'ru', base + 'u');
  }

  return [...new Set(roots)];
}

// ─────────────────────────────────────────────────────────────────
// Factory: createPreprocessor
// ─────────────────────────────────────────────────────────────────

/**
 * Build a romaji preprocessor backed by the given vocabulary list.
 *
 * @param {{ vocabulary: string[]|{romaji:string,freq:number}[], corrections?: Map<string,string> }} options
 *   vocabulary  - romaji strings OR {romaji, freq} objects for Fuse index
 *   corrections - optional Map of exact noisy→correct pairs checked BEFORE Fuse
 * @returns {{ preprocessJap: (text: string) => string }}
 */
export function createPreprocessor({ vocabulary = [], corrections = new Map(), knownWords = new Set() } = {}) {
  if (vocabulary.length === 0) {
    console.warn('[preprocessor] Warning: empty vocabulary — fuzzy correction disabled.');
  }

  // Normalise vocab entries — accept both plain strings and {romaji, freq} objects
  const entries = vocabulary.map((item) => {
    const raw    = typeof item === 'string' ? item : item.romaji;
    const freq   = typeof item === 'string' ? 4    : (item.freq ?? 4);  // unknown = rare
    const normalised = wkNormalize(raw.toLowerCase().trim());
    return { romaji: normalised, freq };
  });

  // Plain string list for Fuse (Fuse searches strings, not objects)
  const romajiList = entries.map(e => e.romaji);

  // freq lookup: romaji → freq score (lower = more common)
  const freqMap = new Map(entries.map(e => [e.romaji, e.freq]));

  // Also normalise all correction keys once
  const normalisedCorrections = new Map(
    [...corrections.entries()].map(([k, v]) => [wkNormalize(k.toLowerCase()), v])
  );

  // Build Fuse index once — reused for every token
  const fuse = new Fuse(romajiList, FUSE_OPTIONS);

  /**
   * Correct a single token via fuzzy match.
   * Returns the vocabulary match if confident, else the original token.
   */
  function correctToken(token) {
    if (token.length < 2) return token; // skip single-char tokens
    const results = fuse.search(token);
    if (results.length > 0 && results[0].score <= FUSE_OPTIONS.threshold) {
      return results[0].item;
    }
    return token;
  }

  /**
   * Split text on sentence-ending delimiters, preserving the delimiter.
   * Returns an array of { clause: string, delimiter: string } pairs.
   */
  function splitClauses(text) {
    // Split on . 。 ? ？ ! ！ , 、 — capturing the delimiter so we can reattach it
    const DELIMITERS = /([.。?？!！,、])/;
    const parts = text.split(DELIMITERS);
    const clauses = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (!part) continue;
      if (DELIMITERS.test(part)) {
        // It's a delimiter — attach to previous clause
        if (clauses.length > 0) {
          clauses[clauses.length - 1].delimiter = part;
        }
      } else {
        clauses.push({ clause: part, delimiter: '' });
      }
    }
    return clauses;
  }

  /**
   * Correct the tokens of a single flat clause string.
   * @param {string} clauseText - Already lowercased, whitespace-collapsed
   * @returns {string}
   */
  function processClause(clauseText) {
    const tokens = clauseText.split(' ');
    return tokens.map((tok) => {
      const normalised = wkNormalize(tok);
      if (vocabulary.length === 0) return normalised;
      if (normalised.length <= 3) {
        console.log(`\x1b[90m[debug] skipped (too short): ${tok}\x1b[0m`);
        return normalised;
      }

      // Tier 1: deterministic corrections map (O(1), checked before Fuse)
      if (normalisedCorrections.has(normalised)) {
        const correct = normalisedCorrections.get(normalised);
        console.log(`\x1b[90m[debug] exact match (correction): ${tok} -> ${correct}\x1b[0m`);
        return correct;
      }

      // Tier 1.5: If the word is already a perfectly spelled known word in the dictionary, PRESERVE IT
      if (knownWords.has(normalised)) {
        console.log(`\x1b[90m[debug] exact match (whitelist): ${tok} -> ${normalised}\x1b[0m`);
        return normalised;
      }

      // Tier 1.6: Deconjugate Romaji verbs to grab root. If root is valid, the conjugation is valid!
      const possibleRoots = getRoots(normalised);
      for (const root of possibleRoots) {
        if (knownWords.has(root)) {
          console.log(`\x1b[90m[debug] exact match (conjugation of ${root}): ${tok} -> ${normalised}\x1b[0m`);
          return normalised;
        }
      }

      // Tier 2: Fuse fuzzy search + frequency-weighted reranking
      //
      // Collect all candidates within the score threshold, then rerank by:
      //   combinedScore = fuseScore × freqWeight
      //
      // freqWeight by JMDict freq band:
      //   freq 1 (ichi1/news1) → weight 1.0  (most common, no penalty)
      //   freq 2               → weight 1.3
      //   freq 3               → weight 1.7
      //   freq 4 (untagged)    → weight 2.5  (rare — high penalty)
      //
      // Example: 'ahshi' → Fuse returns ashi (score 0.2, freq 1) and
      //          aishiau (score 0.2, freq 4). Combined: ashi=0.20, aishiau=0.50 → ashi wins.
      const FREQ_WEIGHTS = [0, 1.0, 1.3, 1.7, 2.5];  // index = freq score (1-4)

      const candidates = fuse
        .search(normalised)
        .filter(r => r.score <= FUSE_OPTIONS.threshold)
        .filter(r => Math.abs(r.item.length - normalised.length) <= 1)   // length guard
        .map(r => ({
          item:          r.item,
          combinedScore: r.score * (FREQ_WEIGHTS[freqMap.get(r.item) ?? 4] ?? 2.5),
        }))
        .sort((a, b) => a.combinedScore - b.combinedScore);

      if (candidates.length > 0) {
        const best = candidates[0].item;
        if (best !== normalised) {
          console.log(`\x1b[90m[debug] fuzzy match: ${tok} -> ${best}\x1b[0m`);
        } else {
          console.log(`\x1b[90m[debug] fuzzy match (unchanged): ${tok} -> ${best}\x1b[0m`);
        }
        return best;
      }
      
      console.log(`\x1b[90m[debug] no match (passed through): ${tok}\x1b[0m`);
      return normalised;
    }).join(' ');
  }

  /**
   * Preprocess a full romaji input, with clause-level isolation.
   */
  function preprocessJap(text) {
    if (!text || typeof text !== 'string') return '';

    let cleaned = text.toLowerCase().replace(/\s+/g, ' ').trim();

    // Catch common colloquial/grammar typos BEFORE tokenization
    const JAP_GRAMMAR_FIXES = [
      [/(hoshiku|taku)\s*t?nai/g, '$1nai'],        // hoshikutnai -> hoshikunai (don't want)
      [/\bomoimashit(?:a?)\b/g,   'omoimashita'], // omoimashit -> omoimashita (thought)
      [/\batemashita\b/g,         'ataemashita'], // atemashita -> ataemashita (gave/affected)
      [/\byamerarena(?:i|kya|kucha|kute)/g, 'yamerarenai'], // unify convoluted "must work" negatives if hopelessly broken
      // Globally expand all "have to" conversational verbs (e.g. shinakya -> shinakereba, modoranaikya -> modoranakereba)
      [/\b([a-z]*na)ikya\b/g,   '$1kereba'],
      [/\b([a-z]*na)kya\b/g,    '$1kereba'],
      [/\b([a-z]*na)ikucha\b/g, '$1kereba'],
      [/\b([a-z]*na)kucha\b/g,  '$1kereba'],
      [/\bnerasenai\b/g, 'nemurenai'],            // nerasenai -> nemurenai (cannot sleep)
      // Expand conversational slang contractions ("shiteru" -> "shiteiru" / "yatteru" -> "yatteiru")
      [/\b([a-z]{2,})teru\b/g,        '$1teiru'], 
      [/\b([a-z]{2,})temasu\b/g,      '$1teimasu'],
      [/\b([a-z]{2,})temashita\b/g,   '$1teimashita'],
      [/\b([a-z]{2,})tenai\b/g,       '$1teinai'],
      [/\b([a-z]{2,})teta\b/g,        '$1teita'],
    ];

    for (const [pattern, replacement] of JAP_GRAMMAR_FIXES) {
      cleaned = cleaned.replace(pattern, replacement);
    }

    const clauses = splitClauses(cleaned);

    if (clauses.length === 0) return '';

    const processed = clauses.map(({ clause, delimiter }) => {
      const corrected = processClause(clause.trim());
      return corrected + delimiter;
    });

    return processed.join(' ').trim();
  }

  return { preprocessJap };
}


// ─────────────────────────────────────────────────────────────────
// Async loader: loadVocabularyFromFile
// ─────────────────────────────────────────────────────────────────

/**
 * Load a JSON vocabulary file and return a ready preprocessor.
 *
 * @param {string} filePath - Absolute or relative path to a JSON file
 *                            containing a string[] of romaji words.
 * @returns {Promise<{ preprocessJap: (text: string) => string }>}
 */
export async function loadVocabularyFromFile(filePath) {
  const raw        = await readFile(filePath, 'utf-8');
  const vocabulary = JSON.parse(raw);
  if (!Array.isArray(vocabulary)) {
    throw new Error(`[preprocessor] ${filePath} must export a JSON array of strings.`);
  }
  return createPreprocessor({ vocabulary });
}

// ─────────────────────────────────────────────────────────────────
// English lightweight fix map (unchanged — regex is fast enough)
// ─────────────────────────────────────────────────────────────────

const ENG_FIXES = [
  [/\bpersription\b/gi,  'prescription'],
  [/\bprescirption\b/gi, 'prescription'],
  [/\bmedecine\b/gi,     'medicine'],
  [/\bopration\b/gi,     'operation'],
  [/\bopertion\b/gi,     'operation'],
  [/\bheadche\b/gi,      'headache'],
  [/\bstomoach\b/gi,     'stomach'],
  [/\bstomache\b/gi,     'stomach'],
  [/\bpaitent\b/gi,      'patient'],
  [/\bpatiant\b/gi,      'patient'],
  [/\bsymtom\b/gi,       'symptom'],
  [/\bsymtpom\b/gi,      'symptom'],
  [/\bdiabeetis\b/gi,    'diabetes'],
  [/\bhospitle\b/gi,     'hospital'],
  [/\bfevver\b/gi,       'fever'],
  [/\bfevr\b/gi,         'fever'],
  [/\bnazea\b/gi,        'nausea'],
];

/**
 * Light-clean English input — fixes known typos, preserves intent.
 * @param {string} text
 * @returns {string}
 */
export function preprocessEng(text) {
  let out = (text ?? '').trim();
  for (const [pattern, replacement] of ENG_FIXES) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────
// Default singleton — loaded from the JMDict-derived vocabulary.
// Uses medical-typed entries for Fuse (focused, ~34k terms).
// General language passes through WanaKana normalisation unchanged.
// ─────────────────────────────────────────────────────────────────

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync }  from 'fs';

const __dir = dirname(fileURLToPath(import.meta.url));

// Load the full enriched vocab (produced by scripts/parse-jmdict.js)
// Format: { romaji: string, en: string, type: 'medical' | 'general' }[]
const _vocabClean = JSON.parse(
  readFileSync(join(__dir, '..', 'data', 'vocab-clean.json'), 'utf-8')
);

// For Fuse: use only medical-typed entries to keep the index focused.
// Medical terms are the ones most likely to be misspelled in input.
// General words that are already correctly spelled pass through WanaKana fine.
const _medicalRomaji = _vocabClean
  .filter(e => e.type === 'medical')
  .map(e => e.romaji);

// Curated deterministic corrections — known noisy→correct romaji pairs.
// These are checked BEFORE Fuse, so they always win regardless of vocab size.
// Add any pattern here that you've observed Fuse getting wrong at scale.
const _corrections = new Map([
  // Transpositions
  ['ahsi',     'ashi'],
  ['ahshi',    'ashi'],
  // Long-vowel issues
  ['zutsu',    'zutsuu'],
  ['onakaa',   'onaka'],
  ['atamaa',   'atama'],
  ['munie',    'mune'],
  // Common misspellings from sample inputs
  ['duragu',   'doraggu'],
  ['yakubtsu', 'yakubutsu'],
  ['chuushabari', 'chuusha'],
  ['gein',     "gen'in"],
  ['waranai',  'wakaranai'],
  ['jyoutai',  'joutai'],
  ['isshoku',  'ishoku'],
  ['kitsutomerraru', 'tsukitomeru'],
  ['senjyutsu', 'senjitsu'],
  ['kyuukyusha', 'kyuukyuusha'],
  ['rakuni',   'raku ni'],
]);

// Pass {romaji, freq} objects so the freqMap is populated with real frequency data
const _medicalVocab = _vocabClean
  .filter(e => e.type === 'medical')
  .map(e => ({ romaji: e.romaji, freq: e.freq }));

// Set of all valid romaji (both medical and general) to prevent fuzzy matching correct words
const _allRomajiSet = new Set(_vocabClean.map(e => e.romaji));

// JMDict only contains root forms (e.g. "aru", "da").
// We must manually whitelist common conjugations so they don't get trapped by the fuzzy medical search.
const COMMON_CONJUGATIONS = [
  'desu', 'masu', 'mashita', 'masen', 'mashou', 'deshou', 'darou', 'kamoshirenai',
  'arimasu', 'arimasen', 'atta', 'nakatta', 'nai', 'nakute', 'naide',
  'imasu', 'imasen', 'ita', 'inai', 'teiru', 'teimasu', 'teita',
  'nondemasu', 'taberarenakute', 'natte', 'shimaimasu', 'surun',
  'node', 'kedo', 'kara', 'tara', 'nara', 'tari', 'shi',
  'iku', 'ikimasu', 'itta', 'ikanai',
  'kuru', 'kimasu', 'kita', 'konai',
  'suru', 'shimasu', 'shita', 'shinai', 'shite', 'shiteiru',
  'naru', 'narimasu', 'natta', 'naranai',
  'wakaru', 'wakarimasu', 'wakatta', 'wakaranai',
  'iru', 'iranai', 'irimasu',
  'kudasai', 'onegai', 'onegashimasu', 'arigatou', 'gozaimasu'
];

for (const word of COMMON_CONJUGATIONS) {
  _allRomajiSet.add(word);
}

const _default = createPreprocessor({
  vocabulary:  _medicalVocab,
  corrections: _corrections,
  knownWords:  _allRomajiSet,
});

/** Drop-in for the old export — backed by the full JMDict medical vocab. */
export const preprocessJap = _default.preprocessJap;

/**
 * The full enriched vocabulary, available for future use
 * (e.g. debug logging, RAG lookup table, glossary endpoint).
 * @type {{ romaji: string, en: string, type: string }[]}
 */
export const vocabIndex = _vocabClean;

