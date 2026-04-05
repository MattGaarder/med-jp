/**
 * preprocessor.js
 *
 * Modernized romaji preprocessing pipeline using SQLite (vocab.db) and a robust deinflector.
 */

import * as wanakana from 'wanakana';
import Fuse          from 'fuse.js';
import Database      from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deinflect, WordType } from './deinflect.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DB_PATH    = join(__dirname, '..', 'data', 'vocab.db');

// ─────────────────────────────────────────────────────────────────
// Fuse.js configuration
// ─────────────────────────────────────────────────────────────────

const FUSE_OPTIONS = {
  includeScore:    true,
  threshold:       0.2,   
  distance:        50,
  minMatchCharLength: 2,
  shouldSort:      true,
};

// ─────────────────────────────────────────────────────────────────
// Linguistic Transformers
// ─────────────────────────────────────────────────────────────────

/**
 * Normalise a single romaji token via WanaKana round-trip (enforces Hepburn).
 */
function wkNormalize(token) {
  try {
    if (!wanakana.isRomaji(token)) return token;
    const hiragana = wanakana.toHiragana(token, { passRomaji: false });
    return wanakana.toRomaji(hiragana);
  } catch {
    return token;
  }
}

/**
 * Helper to convert hiragana back to romaji safely.
 */
function toRomajiSafe(hiragana) {
  try {
    return wanakana.toRomaji(hiragana);
  } catch {
    return hiragana;
  }
}

/**
 * Maps JMDict POS tags to deinflector WordType bitmasks.
 */
function mapPosToVerbClass(posTag) {
  if (!posTag) return 0;
  const tags = posTag.split(',').map(t => t.trim());
  let mask = 0;
  
  for (const t of tags) {
    if (t === 'v1') mask |= WordType.IchidanVerb;
    if (t.startsWith('v5')) mask |= WordType.GodanVerb;
    if (t === 'vk') mask |= WordType.KuruVerb;
    if (t === 'vs') mask |= WordType.SuruVerb;
    if (t === 'adj-i') mask |= WordType.IAdj;
  }
  return mask;
}

/**
 * Advanced frequency scoring based on JMDict tags.
 * High scores indicate more common/prioritized words.
 */
function getFrequencyScore(tagsStr, freqVal = 0.1) {
  if (!tagsStr) return (freqVal || 0) * 10;
  const tags = tagsStr.split(',').map(t => t.trim());
  const has = (t) => tags.includes(t);
  let score = freqVal || 0;

  // 1. Primary Global Frequency (nf01 - nf48)
  const nf = tags.find(t => t.startsWith('nf'));
  if (nf) {
    const rank = parseInt(nf.slice(2), 10);
    if (!isNaN(rank)) {
      // nf01 gives 990, nf48 gives 520.
      score += Math.max(0, 1000 - (rank * 10));
    }
  }

  // 2. Priority Tags (Ancillary to nf ranking)
  if (has('news1')) score += 100;
  if (has('ichi1')) score += 100;
  if (has('spec1')) score += 100;
  if (has('spec2')) score += 50;
  if (has('gai1'))  score += 100;

  // 3. Secondary Tags
  if (has('news2')) score += 50;
  if (has('ichi2')) score += 50;
  if (has('gai2'))  score += 50;

  // 4. Usage Context Boosts (Spoken/Polite)
  if (has('uk'))  score += 250; // Usually kana
  if (has('hon')) score += 250; // Honorific
  if (has('exp')) score += 250; // Expression

  return score;
}

// ─────────────────────────────────────────────────────────────────
// Preprocessor Engine Factory
// ─────────────────────────────────────────────────────────────────

/**
 * Stripped-down preprocessor factory using DB-backed vocabulary.
 */
export function createPreprocessor({ vocabulary = [], knownWords = new Map() } = {}) {
  const FREQ_WEIGHTS = [0, 1.0, 1.3, 1.7, 2.5]; 

  const romajiList = vocabulary.map(v => v.romaji);
  const freqMap    = new Map(vocabulary.map(v => [v.romaji, v.freq]));
  const fuse       = new Fuse(romajiList, FUSE_OPTIONS);

  /**
   * Internal logic for processing a single token with optional tracing.
   */
  function processToken(tok) {
    const rawInput = tok.toLowerCase();
    /**
     * Pre-normalization (e.g. jya -> ja)
     */
    const normalizedInput = wkNormalize(rawInput);
    
    // 1. Particle Check (Early exit for core grammar)
    const PARTICLES = {
      'wa': 'は', 'ha': 'は', 'ga': 'が', 'wo': 'を', 'o': 'を', 
      'ni': 'に', 'e': 'へ', 'to': 'と', 'de': 'で', 
      'no': 'の', 'mo': 'も', 'ka': 'か', 'ya': 'や',
      'yo': 'よ', 'ne': 'ね'
    };

    if (PARTICLES[normalizedInput]) {
      const particleOutput = (normalizedInput === 'o' ? 'wo' : normalizedInput);
      return { 
        output: particleOutput, 
        decision: 'particle', 
        meta: { kana: PARTICLES[normalizedInput] } 
      };
    }

    // Skip very short tokens that aren't particles
    if (normalizedInput.length < 2) {
      return { output: normalizedInput, decision: 'skipped (too short)' };
    }

    // 2. Corruption Detection & Repair Cycle
    const candidates = [];
    const hiraganaRaw = wanakana.toHiragana(normalizedInput);
    const hasCorruption = /[a-z]/.test(hiraganaRaw);
    
    let variants = new Set([normalizedInput]);
    if (hasCorruption) {
      // Find the first index where wanakana failed (remained as romaji)
      const corruptionMatch = hiraganaRaw.match(/[a-z]+/);
      if (corruptionMatch) {
         const failedPart = corruptionMatch[0];
         const failedIdx = normalizedInput.indexOf(failedPart);
         
         // Vowel Insertion (waktta -> wakatta)
         ['a','i','u','e','o'].forEach(v => {
           variants.add(normalizedInput.slice(0, failedIdx + 1) + v + normalizedInput.slice(failedIdx + 1));
         });
      }
    }

    // Double-Consonant Check (sunai -> sunnai, matte -> mate)
    for (let i = 0; i < normalizedInput.length - 1; i++) {
        const char = normalizedInput[i];
        const next = normalizedInput[i+1];
        if (/[bcdfghjklmnpqrstvwxyz]/.test(char)) {
            if (char === next) {
                // Halve it
                variants.add(normalizedInput.slice(0, i) + normalizedInput.slice(i + 1));
            } else if (char !== 'n' || next !== 'n') { // Don't just double 'n' indiscriminately
                // Double it
                variants.add(normalizedInput.slice(0, i + 1) + char + normalizedInput.slice(i + 1));
            }
        }
    }

    const processedVariants = Array.from(variants);

    /**
     * Confidence Tiers:
     * Tier 1 (Exact): 0
     * Tier 2 (Fuzzy): 15
     * Tier 3 (Deinflect): 40
     * Tier 4 (Aggressive): 80
     */
    const TIER = { EXACT: 0, FUZZY: 15, DEINFLECT: 40, AGGRESSIVE: 80 };

    for (const variant of processedVariants) {
      const isOriginal = (variant === normalizedInput);
      
      // 1. Strict Corruption Gate: If it's a "Rogue English Letter" string, skip it.
      if (hasCorruption && isOriginal) continue;

      // Forced repairs of corrupt tokens are treated as Exact (Tier 1) for their variant
      // since we MUST repair them. Non-corrupt repairs (typo fix) are Tier 4.
      const baseTier = isOriginal ? TIER.EXACT : (hasCorruption ? TIER.EXACT : TIER.AGGRESSIVE);

      // A. Exact Match / Normalization Match
      const exactWord = knownWords.get(variant);
      if (exactWord) {
        const fScore = getFrequencyScore(exactWord.tags, exactWord.freq);
        candidates.push({
          item: variant,
          type: isOriginal ? 'exact' : (hasCorruption ? 'repair:exact' : 'aggressive:exact'),
          distance: 0.0,
          freqScore: fScore,
          adjustedScore: baseTier - (fScore / 40)
        });
      }

      // B. Dictionary-First Override (Fuzzy)
      const fuseResults = fuse.search(variant);
      if (fuseResults.length > 0) {
          const res = fuseResults[0];
          const item = res.item;
          const wordData = knownWords.get(item);
          const fScore = getFrequencyScore(wordData.tags, wordData.freq);
          
          // Fuzzy is Tier 2
          const fuzzyTier = Math.max(baseTier, TIER.FUZZY);
          
          candidates.push({
              item: item,
              type: isOriginal ? 'fuzzy' : (hasCorruption ? 'repair:fuzzy' : 'aggressive:fuzzy'),
              distance: res.score,
              freqScore: fScore,
              adjustedScore: fuzzyTier + (res.score * 100) - (fScore / 40)
          });
      }

      // C. Deinflection
      const hira = wanakana.toHiragana(variant);
      const deinfResults = deinflect(hira);
      for (const c of deinfResults) {
        const rootRomaji = toRomajiSafe(c.word);
        const wordData = knownWords.get(rootRomaji);
        if (wordData) {
          const isMatch = wordData.pos.some(tag => (mapPosToVerbClass(tag) & c.type) !== 0);
          if (isMatch) {
            const fScore = getFrequencyScore(wordData.tags, wordData.freq);
            const rWeight = c.ruleWeight || 1.0;
            
            // Standard deinflection is Tier 3. Low-weight (ambiguous) is Tier 4.
            const deinfTier = (rWeight < 0.5) ? TIER.AGGRESSIVE : Math.max(baseTier, TIER.DEINFLECT);

            candidates.push({
              item: variant,
              root: rootRomaji,
              type: isOriginal ? 'deinflect' : (hasCorruption ? 'repair:deinflect' : 'aggressive:deinflect'),
              distance: 0.15,
              freqScore: fScore,
              adjustedScore: deinfTier + (0.15 / (rWeight + 0.1)) * 100 - (fScore / 40),
              meta: { reasons: c.reasonChains, type: c.type, ruleWeight: rWeight }
            });
          }
        }
      }
    }

    // 5. Cleanup and Selection
    if (candidates.length > 0) {
      // Sort by adjusted score ascending (lower cost wins)
      candidates.sort((a, b) => a.adjustedScore - b.adjustedScore);
      const winner = candidates[0];
      
      return { 
        output: winner.item, 
        decision: winner.type.startsWith('deinflect') || winner.type.includes('deinflect') 
          ? `${winner.type}:${winner.root || winner.item}` 
          : winner.type,
        meta: { 
          competition: candidates.slice(0, 3).map(c => ({
            item: c.root ? `${c.item}(->${c.root})` : c.item,
            type: c.type,
            adj: c.adjustedScore.toFixed(4),
            freq: c.freqScore.toFixed(1)
          })),
          ...winner.meta 
        }
      };
    }

    return { output: normalizedInput, decision: 'passthrough' };
  }

  /**
   * Main Dispatch: handles sentence splitting and token mapping.
   */
  function dispatch(text, includeTrace = false) {
    if (!text) return includeTrace ? { output: '', tokens: [] } : '';
    
    const tokenLog = [];
    const clauses = text.split(/([.。?？!！,、\s])/);
    
    const processed = clauses.map(part => {
      if (!part || /^[.。?？!！,、\s]+$/.test(part)) return part;
      const res = processToken(part);
      if (includeTrace) tokenLog.push({ input: part, output: res.output, decision: res.decision, meta: res.meta });
      return res.output;
    });

    const output = processed.join('');
    return includeTrace ? { output, tokens: tokenLog } : output;
  }

  return {
    preprocessJap: (text) => dispatch(text, false),
    preprocessJapWithTrace: (text) => dispatch(text, true)
  };
}

// ─────────────────────────────────────────────────────────────────
// English Lightweight (Stripped)
// ─────────────────────────────────────────────────────────────────

export function preprocessEng(text) {
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────────────────────────
// Default Instance (Singleton)
// ─────────────────────────────────────────────────────────────────

console.log('[preprocessor] Initializing from vocab.db with deinflector...');
const db = new Database(DB_PATH, { readonly: true });

// Load all romaji and their POS/Tags for validation and scoring
const allEntries = db.prepare('SELECT romaji, pos, tags, freq FROM vocab').all();
const knownWords = new Map();

for (const entry of allEntries) {
  const norm = entry.romaji.toLowerCase();
  let data = knownWords.get(norm);
  
  if (!data) {
    data = { 
      pos:     [], 
      tagsSet: new Set(), 
      freq:    0 
    };
    knownWords.set(norm, data);
  }
  
  if (entry.pos)  data.pos.push(entry.pos);
  if (entry.tags) {
    entry.tags.split(',').forEach(t => data.tagsSet.add(t.trim()));
    data.tags = Array.from(data.tagsSet).join(', ');
  }
  
  data.freq = Math.max(data.freq, entry.freq || 0);
}

// Compact tags back to strings for scoring
for (const [norm, data] of knownWords.entries()) {
  data.tags = Array.from(data.tagsSet).join(', ');
}

// Load candidate terms for fuzzy matching
const candidates = db.prepare(`
  SELECT romaji FROM vocab 
  WHERE domain IS NOT NULL OR freq > 0.1
`).all();

const _default = createPreprocessor({
  vocabulary: candidates,
  knownWords
});

export const preprocessJap          = _default.preprocessJap;
export const preprocessJapWithTrace = _default.preprocessJapWithTrace;
export const CONTENT_DECISIONS      = new Set(['exact', 'normalization', 'fuzzy', 'passthrough', 'whitelist', 'correction']);
