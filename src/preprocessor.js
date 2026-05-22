/**
 * preprocessor.js
 */

import { performance } from 'node:perf_hooks';
import * as wanakana from 'wanakana';
import Fuse from 'fuse.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deinflect, WordType, interpretReasonChains, getCanonicalSuffixes } from './deinflect.js';
import { calculateCandidateScore } from './config/linguistics.js';
import { loadGrammarAnchors, peelGrammarSuffix, collapseGrammarTokens } from './grammarPeel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'vocab.db');
const db = new Database(DB_PATH, { readonly: true });

const FUSE_OPTIONS = {
  includeScore: true,
  threshold: 0.3,
  distance: 50,
  minMatchCharLength: 2,
  shouldSort: true,
};

const CANONICAL_SUFFIXES = getCanonicalSuffixes().map(s => ({
  romaji: s,
  reversed: s.split('').reverse().join('')
}));

const suffixFuse = new Fuse(CANONICAL_SUFFIXES, {
  keys: ['reversed'],
  includeMatches: true,
  includeScore: true,
  threshold: 0.25,
  location: 0,
  distance: 3,
  minMatchCharLength: 2
});


function wkNormalize(text) {
  try {
    if (!wanakana.isRomaji(text)) return text;
    const hiragana = wanakana.toHiragana(text, { passRomaji: false });
    return wanakana.toRomaji(hiragana);
  } catch {
    return text;
  }
}

function toRomajiSafe(hiragana) {
  try {
    return wanakana.toRomaji(hiragana);
  } catch {
    return hiragana;
  }
}

function mapPosToVerbClass(posInput) {
  if (!posInput) return 0;
  const tags = Array.isArray(posInput)
    ? posInput.flatMap(t => t.split(',')).map(t => t.trim())
    : posInput.split(',').map(t => t.trim());
  let mask = 0;
  for (const t of tags) {
    if (t === 'v1') mask |= WordType.IchidanVerb;
    if (t.startsWith('v5')) mask |= WordType.GodanVerb;
    if (t === 'vk') mask |= WordType.KuruVerb;
    if (t === 'vs' || t === 'vz') mask |= (WordType.SuruVerb | WordType.NounVS);
    if (t === 'adj-i') mask |= WordType.IAdj;
  }
  return mask;
}

const PARTICLE_MAP = Object.freeze({
  'wa': { hira: 'は', romaji: 'wa' },
  'ha': { hira: 'は', romaji: 'wa' },
  'ga': { hira: 'が', romaji: 'ga' },
  'wo': { hira: 'を', romaji: 'wo' },
  'o': { hira: 'を', romaji: 'wo' },
  'ni': { hira: 'に', romaji: 'ni' },
  'e': { hira: 'へ', romaji: 'e' },
  'to': { hira: 'と', romaji: 'to' },
  'de': { hira: 'で', romaji: 'de' },
  'no': { hira: 'の', romaji: 'no' },
  'mo': { hira: 'も', romaji: 'mo' },
  'ka': { hira: 'か', romaji: 'ka' },
  'ya': { hira: 'や', romaji: 'ya' },
  'yo': { hira: 'よ', romaji: 'yo' },
  'ne': { hira: 'ね', romaji: 'ne' }
});
// ─────────────────────────────────────────────────────────────────
// Handle Special Cases
// ─────────────────────────────────────────────────────────────────

function handleSpecialCases(chunkSegment, hiraOrigin) {
  const pMatch = PARTICLE_MAP[chunkSegment];
  if (pMatch) {
    return {
      surface: hiraOrigin || pMatch.hira,
      output: pMatch.romaji,
      base: pMatch.romaji,
      meaning: 'particle',
      grammar_tags: [],
      decision: 'particle',
      meta: { type: 'particle' }
    };
  }
  return null;
}

function generateVariants(chunkSegment) {
  const variants = new Map([[chunkSegment, { isOriginal: true }]]);

  // ── 1. Corruption Repair ─────────────────────────────
  const hiraganaRaw = wanakana.toHiragana(chunkSegment);
  const hasCorruption = /[a-z]/.test(hiraganaRaw);
  if (hasCorruption) {
    const corruptionRegex = /[a-z]+/g;
    let match;

    while ((match = corruptionRegex.exec(hiraganaRaw)) !== null) {
      const hiraPos = match.index;

      let romajiPos = 0;
      for (let r = 1; r <= chunkSegment.length; r++) {
        const partialHira = wanakana.toHiragana(chunkSegment.slice(0, r));
        if (partialHira.length > hiraPos) {
          romajiPos = r - 1;
          break;
        }
        if (r === chunkSegment.length) romajiPos = r - 1;
      }

      const stuckLen = match[0].length;

      ['a', 'i', 'u', 'e', 'o'].forEach(v => {
        const repaired = chunkSegment.slice(0, romajiPos + stuckLen) + v + chunkSegment.slice(romajiPos + stuckLen);
        variants.set(repaired, { isRepair: true });
      });
    }
  }
  // ── 2. Consonant Doubling ─────────────────────────────
  const CONSONANTS_TO_DOUBLE = 'kstpcn';
  for (let i = 0; i < chunkSegment.length - 1; i++) {
    const char = chunkSegment[i];
    const next = chunkSegment[i + 1];
    if (CONSONANTS_TO_DOUBLE.includes(char) && 'aeiouy'.includes(next)) {
      const doubled = chunkSegment.slice(0, i + 1) + char + chunkSegment.slice(i + 1);
      variants.set(doubled, { isDoubling: true });
    }
  }
  // ── 3. Dakuten / Phonetic Swap ────────────────────────
  const DAKUTEN_MAP = { 'k': 'g', 's': 'z', 't': 'd', 'h': 'b', 'f': 'b', 'g': 'k', 'z': 's', 'd': 't', 'b': 'h' };
  for (let i = 0; i < chunkSegment.length; i++) {
    const char = chunkSegment[i];
    if (DAKUTEN_MAP[char]) {
      const phonetic =
        chunkSegment.slice(0, i) +
        DAKUTEN_MAP[char] +
        chunkSegment.slice(i + 1);
      variants.set(phonetic, { isPhonetic: true });
    }
  }
  // ── 4. WanaKana Normalization ─────────────────────────
  const wkNormalized = wkNormalize(chunkSegment);
  if (wkNormalized !== chunkSegment) {
    variants.set(wkNormalized, { isWkNorm: true });
  }

  return variants;
}

function evaluateVariants({
  variant,
  vMeta,
  chunkSegment,
  exactMatchIndex,
  fuse
}) {
  const isOriginal = vMeta.isOriginal;
  let hasHighConfidenceExact = false;
  let candidates = [];
  const variantType = isOriginal ? 'exact'
    : (vMeta.isRepair ? 'exact:repair'
      : (vMeta.isPhonetic ? 'exact:phonetic'
        : (vMeta.isDoubling ? 'exact:doubling'
          : (vMeta.isWkNorm ? 'normalized' : 'aggressive:exact'))));
  // ── 1. EXACT ─────────────────────────────
  const exactRes = evaluateExact({
    variant,
    variantType,
    chunkSegment,
    exactMatchIndex,
    isOriginal
  });
  candidates.push(...exactRes.candidates);
  if (exactRes.hasHighConfidenceExact) {
    return { candidates, shortCircuit: true };
  }
  // ── 2. FUZZY ─────────────────────────────
  const fuzzyType = isOriginal
    ? 'fuzzy'
    : (vMeta.isRepair ? 'fuzzy:repair'
      : (vMeta.isDoubling ? 'fuzzy:doubling'
        : 'aggressive:fuzzy'));
  const fuzzyRes = evaluateFuzzy({
    variant,
    fuzzyType,
    exactMatchIndex,
    fuse,
    isOriginal
  });
  candidates.push(...fuzzyRes);
  // ── 3. DEINFLECT ─────────────────────────────
  const deinfType = isOriginal
    ? 'deinflect'
    : (vMeta.isRepair ? 'deinflect:repair'
      : (vMeta.isDoubling ? 'deinflect:doubling'
        : 'aggressive:deinflect'));
  const deinfRes = evaluateDeinflect({
    variant,
    deinfType,
    exactMatchIndex,
    fuse,
    isOriginal
  });
  candidates.push(...deinfRes.candidates);
  if (deinfRes.hasHighConfidenceExact) {
    hasHighConfidenceExact = true;
  }
  return { candidates, shortCircuit: hasHighConfidenceExact };
}

function evaluateExact({
  variant,
  variantType,
  chunkSegment,
  exactMatchIndex,
  isOriginal,
}) {
  let candidates = [];
  let hasHighConfidenceExact = false;
  const exactEntries = exactMatchIndex.get(variant);
  if (!exactEntries) {
    return { candidates, hasHighConfidenceExact };
  }
  for (const entry of exactEntries) {
    const scoreObj = calculateCandidateScore(entry, {
      type: variantType,
      isOriginal,
      inputLen: chunkSegment.length,
      matchLen: variant.length,
    });
    if (scoreObj.total > 1100) hasHighConfidenceExact = true;
    candidates.push({
      id: entry.id,
      entry,
      item: variant,
      type: variantType,
      distance: 0.0,
      freqScore: scoreObj.lexical,
      adjustedScore: scoreObj.total,
      breakdown: scoreObj.breakdown,
      meaning: entry.meaning,
      scoreObj,
    });
  }
  return { candidates, hasHighConfidenceExact };
}

function evaluateFuzzy({
  variant,
  fuzzyType,
  exactMatchIndex,
  fuse,
  isOriginal
}) {
  let candidates = [];
  if (variant.length > 25) return candidates;
  const results = fuse.search(variant).slice(0, 5);
  for (const res of results) {
    const item = res.item;
    const entries = exactMatchIndex.get(item);
    if (!entries) continue;
    for (const wordData of entries) {
      const scoreObj = calculateCandidateScore(wordData, {
        type: fuzzyType,
        distance: res.score,
        inputLen: variant.length,
        matchLen: item.length,
        isOriginal
      });

      candidates.push({
        id: wordData.id,
        entry: wordData,
        item,
        type: fuzzyType,
        distance: res.score,
        freqScore: scoreObj.lexical,
        adjustedScore: scoreObj.total,
        breakdown: scoreObj.breakdown,
        meaning: wordData.meaning,
        scoreObj
      });
    }
  }
  return candidates;
}

function evaluateDeinflect({
  variant,
  deinfType,
  exactMatchIndex,
  fuse,
  isOriginal
}) {
  let candidates = [];
  let hasHighConfidenceExact = false;
  const hira = wanakana.toHiragana(variant);
  const deinfResults = deinflect(hira);
  for (const c of deinfResults) {
    const rootRomaji = toRomajiSafe(c.word);
    let stemMatches = [];
    const exactStemEntries = exactMatchIndex.get(rootRomaji);
    if (exactStemEntries) {
      stemMatches = exactStemEntries.map(e => ({
        entry: e,
        type: deinfType,
        dist: 0
      }));
    } else if (rootRomaji.length >= 2 && c.reasonChains.length > 0) {
      const fuzzyRoots = fuse.search(rootRomaji).slice(0, 15);
      for (const f of fuzzyRoots) {
        const fEntries = exactMatchIndex.get(f.item);
        if (fEntries) {
          stemMatches.push(...fEntries.map(e => ({
            entry: e,
            type: `${deinfType}:fuzzy_stem`,
            dist: f.score
          })));
        }
      }
    }
    for (const { entry: wordData, type: mType, dist } of stemMatches) {
      const isMatch = (mapPosToVerbClass(wordData.pos) & c.type) !== 0;
      if (!isMatch) continue;
      const steps = (c.reasonChains?.[0]?.length) || 1;
      const totalDist = 0.02 + (steps * 0.02) + (dist * 0.5);
      const scoreObj = calculateCandidateScore(wordData, {
        type: mType,
        distance: totalDist,
        inputLen: variant.length,
        matchLen: rootRomaji.length,
        isOriginal
      });
      if (scoreObj.total > 1100) {
        hasHighConfidenceExact = true;
      }
      candidates.push({
        id: wordData.id,
        entry: wordData,
        item: variant,
        root: wordData.romaji,
        type: mType,
        distance: totalDist,
        freqScore: scoreObj.lexical,
        adjustedScore: scoreObj.total,
        breakdown: scoreObj.breakdown,
        meaning: wordData.meaning,
        scoreObj,
        meta: {
          reasons: c.reasonChains,
          type: c.type,
          ruleWeight: c.ruleWeight || 1.0,
          grammar: {
            isValidClassMatch: true, // Guaranteed by isMatch check above
            ruleWeight: c.ruleWeight || 1.0,
            steps: steps,
            fuzzyStemDistance: dist,
            stemExists: true
          }
        }
      });
    }
  }
  return { candidates, hasHighConfidenceExact };
}
// ─────────────────────────────────────────────────────────────────
// Fragment Validation
// ─────────────────────────────────────────────────────────────────

/**
 * Determines if a candidate fragment is "garbage" or linguistically implausible.
 * Beam search should fix bad wholes, not bad pieces.
 */
function isBadFragment(evalResult) {
  if (!evalResult) return true;
  if (evalResult.decision === 'particle') return false;

  const winner = evalResult.meta?.winner || evalResult;
  const type = winner.type || '';
  const score = winner.adjustedScore || 0;
  const distance = winner.distance || 0;
  const len = evalResult.input?.length || winner.item?.length || 0;

  // 1. Only prune 1-character non-exact matches (extremely noisy)
  // Prune "exact:repair" of length 1 (e.g. "t" -> "te")
  if (len <= 1 && (type !== 'exact')) return true;

  // 2. High-distance fuzzy matches on short tokens are unreliable
  if (len <= 3 && distance > 0.2 && type.includes('fuzzy')) return true;

  // 3. Low score relative to length
  if (score < 700 && type !== 'exact') return true;

  // 4. Deinflected garbage
  if (type.includes('deinflect') && distance > 0.6) return true;

  return false;
}

export function createPreprocessor({ vocabulary = [], exactMatchIndex = new Map() } = {}) {

  const romajiList = vocabulary.map(v => v.romaji);
  const fuse = new Fuse(romajiList, FUSE_OPTIONS);

  function evaluator(chunkSegment, hiraOrigin = null) {
    let candidates = [];

    const special = handleSpecialCases(chunkSegment, hiraOrigin);
    if (special) return special;

    const variants = generateVariants(chunkSegment);

    for (const [variant, vMeta] of variants.entries()) {
      const { candidates: newCands, shortCircuit } =
        evaluateVariants({
          variant,
          vMeta,
          chunkSegment,
          exactMatchIndex,
          fuse
        });
      candidates.push(...newCands);
      if (shortCircuit) break;
    }

    // ── DEDUPLICATE ──────────────────────────────────────────────
    if (candidates.length > 0) {
      const idSeen = new Set();
      candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);
      candidates = candidates.filter(c => {
        if (c.id && idSeen.has(c.id)) return false;
        if (c.id) idSeen.add(c.id);
        return true;
      });

      const TOP_N = 5;

      console.log(`\n[Chunk: "${chunkSegment}"]`);
      console.log("------------------");
      candidates.slice(0, TOP_N).forEach((c) => {
        console.log(
          `${c.id.toString().padEnd(8)} ${c.item.padEnd(12)} ${c.type.padEnd(30)} ${c.adjustedScore.toFixed(2).toString().padEnd(8)} ${c.meaning}`
        );
      });

      // If we found a real exact match that isn’t ultra-rare, don’t allow any non-exact candidate to outrank it.
      // I kind of want to get rid of this - my semantic parser should take care of it...
      const bestExact = candidates.find(c => c.type === 'exact' && c.freqScore > 5);
      if (bestExact) {
        const ceiling = bestExact.adjustedScore;
        let clamped = false;
        for (const c of candidates) {
          if (c.type !== 'exact' && c.adjustedScore > ceiling) {
            c.adjustedScore = ceiling - 1;
            clamped = true;
          }
        }
        if (clamped) candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);
      }

      const winner = candidates[0];

      if (winner.adjustedScore < 600) {
        return {
          surface: hiraOrigin || chunkSegment,
          output: chunkSegment,
          base: chunkSegment,
          meaning: '',
          grammar_tags: [],
          type: 'text',
          decision: `passthrough:low_confidence`,
          meta: { candidates: [] }
        };
      }

      const reasons = winner.meta && winner.meta.reasons || [];
      const grammar_tags = interpretReasonChains(reasons);

      return {
        input: chunkSegment,
        surface: hiraOrigin || winner.item,
        output: winner.item,
        base: winner.root || winner.item,
        meaning: winner.meaning,
        grammar_tags: grammar_tags,
        type: 'text',
        decision: winner.type.startsWith('deinflect') || winner.type.includes('deinflect')
          ? `${winner.type}:${winner.root || winner.item}`
          : winner.type,
        meta: {
          winner,
          candidates: candidates,
          competition: candidates.slice(0, 5).map(c => ({
            item: c.root ? `${c.item}(->${c.root})` : c.item,
            type: c.type,
            adj: c.adjustedScore.toFixed(2),
            cos: (c.cosSim || 0).toFixed(2),
            boost: (c.semanticBoost || 0).toFixed(0)
          })),
          ...winner.meta
        }
      };
    }

    return {
      surface: hiraOrigin || chunkSegment,
      output: chunkSegment,
      base: chunkSegment,
      meaning: '',
      grammar_tags: [],
      type: 'text',
      decision: 'passthrough'
    };
  }

  // I kind of want to get rid of this as well - semantic parser should handle it...
  function isConfidentWholeChunk(evalResult) {
    return (
      evalResult?.meta?.winner &&
      evalResult.meta.winner.adjustedScore > 1100
    );
  }

  function detectStrongVerbMatch(rawChunk) {
    const variants = generateVariants(rawChunk);

    for (const [variant, vMeta] of variants.entries()) {

      const deinfRes = evaluateDeinflect({
        variant,
        deinfType: 'deinflect',
        exactMatchIndex,
        fuse,
        isOriginal: vMeta.isOriginal || false
      });

      if (!deinfRes.candidates.length) continue;

      // Sort strongest first
      const sorted = deinfRes.candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);

      const winner = sorted[0];

      if (!winner?.meta?.grammar) continue;

      const grammar = winner.meta.grammar;

      // STRICT legality gate
      const isStrong = grammar.isValidClassMatch && grammar.ruleWeight >= 0.8 && grammar.fuzzyStemDistance <= 0.12;
      if (!isStrong) continue;

      console.log(
        `[Verb Gate Triggered] "${rawChunk}" -> "${winner.root}" ` +
        `(variant: "${variant}", steps: ${grammar.steps}, ` +
        `dist: ${grammar.fuzzyStemDistance.toFixed(2)})`
      );

      return [{
        input: rawChunk,
        surface: wanakana.toHiragana(rawChunk),
        output: winner.item,
        base: winner.root || winner.item,
        meaning: winner.meaning,
        grammar_tags: interpretReasonChains(
          winner.meta?.reasons || []
        ),
        type: 'text',
        decision: `deinflect:${winner.root || winner.item}`,
        meta: {
          winner,
          candidates: sorted
        }
      }];
    }
    return null;
  }

  function evaluatePrefix({ j, i, hiraChunk, rawChunk, hiraToRaw, globalEvalCache }) {
    const prefix = hiraChunk.slice(j, i);
    // Precise raw romaji extraction
    const startR = j === 0 ? 0 : hiraToRaw[j] + 1;
    const endR = hiraToRaw[i] + 1;
    const romaji = rawChunk.slice(startR, endR);

    const memoKey = prefix + "|" + romaji;
    if (globalEvalCache.has(memoKey)) return globalEvalCache.get(memoKey);

    // QoL / Performance: Skip evaluating sub-segments ending in a non-nasal consonant.
    // Whole chunks (j === 0 && i === hiraChunk.length) are kept to preserve typo-repairs.
    const isFullChunk = (j === 0 && i === hiraChunk.length);
    if (!isFullChunk) {
      const cleanRomaji = romaji.trim().toLowerCase();
      const endsWithConsonant = /[bcdfghjklmpqrstvwxyz]$/.test(cleanRomaji) && !cleanRomaji.endsWith('n');
      if (endsWithConsonant) {
        globalEvalCache.set(memoKey, []);
        return [];
      }
    }

    const results = [];
    const l = prefix.length;

    const BASE_SEGMENT_COST = 150;
    const SHORT_PENALTY = 120 / (l + 1);
    const MIN_SEGMENT_LEN = 3;

    if (prefix.length < MIN_SEGMENT_LEN) {
      globalEvalCache.set(memoKey, []);
      return [];
    }

    const textEval = evaluator(romaji, prefix);
    let addedMatch = false;

    if (textEval.decision === 'particle') {
      results.push({
        eval: textEval,
        cost: 100 + SHORT_PENALTY
      });
      addedMatch = true;
    } else if (textEval.meta?.winner && !isBadFragment(textEval)) {
      const winner = textEval.meta.winner;
      const margin = textEval.meta.margin || 0;
      const stability = (textEval.meta.candidates?.length > 1)
        ? Math.tanh(margin / 10)
        : 1.0;

      // Re-evaluate with beam context
      const scoreObj = calculateCandidateScore(winner.entry || winner, {
        type: winner.type,
        distance: winner.distance,
        inputLen: prefix.length,
        matchLen: winner.item?.length || prefix.length,
        stability,
        isBeamContext: true
      });

      const effectiveScore = scoreObj.total;

      if (effectiveScore >= 800 || winner.type === 'exact') {
        const finalCost = (4500 - effectiveScore) + SHORT_PENALTY + BASE_SEGMENT_COST;

        textEval.meta = {
          ...textEval.meta,
          costTrace: {
            effectiveScore: effectiveScore.toFixed(2),
            ...scoreObj.components
          },
          rootChunk: rawChunk
        };

        results.push({
          eval: textEval,
          cost: finalCost
        });
        addedMatch = true;
      }
    }

    // FALLBACK: Always allow a passthrough if no high-quality match exists
    if (!addedMatch) {
      let passthroughEval = textEval;
      if (textEval.meta?.winner) {
        // If we had a winner but it was "bad", downgrade to passthrough
        passthroughEval = {
          surface: prefix,
          output: romaji,
          base: romaji,
          meaning: '',
          grammar_tags: [],
          type: 'text',
          decision: 'passthrough:pruned'
        };
      }
      results.push({
        eval: passthroughEval,
        cost: 8000 - (l * 50) + SHORT_PENALTY
      });
    }

    // 2. Grammar suffix peel candidates
    // Try peeling known grammar suffixes (から, たり, ように, etc.) from the end
    // of the prefix. If the remaining stem matches a dictionary entry, emit it
    // as a high-confidence compound candidate.
    const grammarPeels = peelGrammarSuffix(prefix, romaji, exactMatchIndex, fuse);
    for (const peel of grammarPeels) {
      const stemEval = evaluator(peel.stemRomaji, peel.stemHira);
      if (stemEval.decision !== 'passthrough' && stemEval.decision !== 'passthrough:low_confidence' && stemEval.decision !== 'skipped (too short)') {
        let peelCost = 2000;
        if (stemEval.meta?.winner) {
          const winner = stemEval.meta.winner;
          const scoreObj = calculateCandidateScore(winner.entry || winner, {
            type: winner.type,
            distance: winner.distance,
            inputLen: peel.stemHira.length,
            matchLen: winner.item?.length || peel.stemHira.length,
            isBeamContext: true
          });
          peelCost = Math.max(0, 2000 - scoreObj.total);
        }
        // Grammar peel bonus
        peelCost -= 150;
        if (peel.priority > 0) peelCost -= peel.priority * 10;
        if (peel.isFuzzy) peelCost += (peel.distance * 100);

        results.push({
          eval: {
            ...stemEval,
            decision: `grammar_peel:${peel.grammarId}`,
            grammarSuffix: {
              anchor: peel.anchor,
              grammarId: peel.grammarId,
              meaning: peel.grammarMeaning,
              title: peel.grammarTitle
            }
          },
          cost: peelCost + SHORT_PENALTY + BASE_SEGMENT_COST
        });
      }
    }
    globalEvalCache.set(memoKey, results);
    return results;
  }

  function buildHiraToRawMap(rawChunk, hiraChunk) {
    const hiraToRaw = new Uint8Array(hiraChunk.length + 1);
    let hIdx = 0;
    for (let rIdx = 0; rIdx < rawChunk.length; rIdx++) {
      const subH = wanakana.toHiragana(rawChunk.slice(0, rIdx + 1));
      while (hIdx < subH.length) {
        hiraToRaw[hIdx] = rIdx;
        hIdx++;
      }
    }
    hiraToRaw[hiraChunk.length] = rawChunk.length - 1;
    return hiraToRaw;
  }

  function runBeamSearch({hiraChunk, rawChunk, hiraToRaw}){
    const globalEvalCache = new Map();
    const MAX_PREFIX_LEN = 25;
    const BEAM_WIDTH = 3;

    // Viterbi / Beam Search path building
    // topPaths[i] saves { cost: number, paths: Array of evaluations }
    let topPaths = Array(hiraChunk.length + 1).fill(null).map(() => []);
    topPaths[0] = [{ cost: 0, path: [] }];

    for (let i = 1; i <= hiraChunk.length; i++) {
      const startJ = Math.max(0, i - MAX_PREFIX_LEN);
      let candidatesForI = [];

      for (let j = startJ; j < i; j++) {
        if (topPaths[j].length === 0) continue;

        const evals = evaluatePrefix({
          j,
          i,
          hiraChunk,
          rawChunk,
          hiraToRaw,
          globalEvalCache
        });

        for (const state of topPaths[j]) {
          for (const ev of evals) {
            candidatesForI.push({
              cost: state.cost + ev.cost,
              path: [...state.path, ev.eval]
            });
          }
        }
      }
      candidatesForI.sort((a, b) => a.cost - b.cost);
      topPaths[i] = candidatesForI.slice(0, BEAM_WIDTH)
    }
    if (topPaths[hiraChunk.length].length === 0) {
      return {
        winningPath: [],
        topPaths
      };
    }
    let winningPath = topPaths[hiraChunk.length][0].path; 
    return {
      winningPath,
      topPaths
    };
  }

  function applyNeighborContextPass(winningPath, includeTrace = false) {
        // ── NEIGHBOR-CONTEXT SECOND PASS ─────────────────────────────────
    const CONTEXT_WINDOW = 3;
    const CONTEXT_BOOST = 200;

    // Build a context set for each position from neighboring winners' meanings/domains
    winningPath = winningPath.map((tok, idx) => {
      if (!tok.meta?.candidates || tok.meta.candidates.length <= 1) return tok;
      if (tok.decision === 'particle' || tok.decision?.startsWith('skipped')) return tok;

      // Collect meaning words and domains from ±3 neighbors
      const neighborContext = new Set();
      for (let offset = -CONTEXT_WINDOW; offset <= CONTEXT_WINDOW; offset++) {
        if (offset === 0) continue;
        const neighbor = winningPath[idx + offset];
        if (!neighbor || !neighbor.meaning) continue;

        // Add meaning words (split on common separators)
        neighbor.meaning.toLowerCase().split(/[\s,();/]+/).forEach(w => {
          if (w.length > 2) neighborContext.add(w);
        });

        // Add domain signals from neighbor's candidate data
        if (neighbor.meta?.candidates) {
          for (const c of neighbor.meta.candidates.slice(0, 3)) {
            if (c.meaning) {
              c.meaning.toLowerCase().split(/[\s,();/]+/).forEach(w => {
                if (w.length > 2) neighborContext.add(w);
              });
            }
          }
        }
      }

      if (neighborContext.size === 0) return tok;

      const contextTrace = {
        contextWords: Array.from(neighborContext),
        candidates: tok.meta.candidates.slice(0, 5).map(c => ({
          item: c.item,
          score: (c.adjustedScore || 0).toFixed(1),
          meaning: c.meaning || 'N/A'
        })),
        isFlipped: false
      };

      // Re-score candidates with context overlap
      const rescored = tok.meta.candidates.map(c => {
        let contextBoost = 0;
        if (c.meaning) {
          const mWords = c.meaning.toLowerCase().split(/[\s,();/]+/);
          const overlap = mWords.filter(w => w.length > 2 && neighborContext.has(w)).length;
          if (overlap > 0) contextBoost = CONTEXT_BOOST * Math.min(overlap, 3);
        }
        return { ...c, contextBoost, contextScore: (c.adjustedScore || 0) + contextBoost };
      });

      rescored.sort((a, b) => b.contextScore - a.contextScore);
      const newWinner = rescored[0];
      const oldWinner = tok.meta.candidates[0];

      if (newWinner.item !== oldWinner.item && newWinner.contextBoost > 0) {
        contextTrace.isFlipped = true;
        contextTrace.flipFrom = oldWinner.item;
        contextTrace.flipTo = newWinner.item;
        contextTrace.boost = newWinner.contextBoost;
      }

      if (includeTrace) {
        console.log(`\n\x1b[35m[Context Pass]\x1b[0m Evaluating token: \x1b[1m${tok.surface || tok.output}\x1b[0m`);
        console.log(`  Context words drawn from ±3 neighbors: [${contextTrace.contextWords.slice(0, 10).join(', ')}]`);
        console.log(`  Candidates considered:`);
        contextTrace.candidates.slice(0, 3).forEach(c => {
          console.log(`    - ${c.item} (score: ${c.score}) -> meaning: ${c.meaning}`);
        });

        if (contextTrace.isFlipped) {
          console.log(`  \x1b[32m⭐ FLIP TRIGGERED!\x1b[0m`);
          console.log(`  ${contextTrace.flipTo} beat ${contextTrace.flipFrom} by gaining +${contextTrace.boost} context points because its meaning overlapped with neighbors!`);
        }
      }

      // Only change winner if the context boost actually flipped the ranking
      if (newWinner.item !== oldWinner.item && newWinner.contextBoost > 0) {
        const grammar_tags = interpretReasonChains(newWinner.meta?.reasons || []);
        return {
          ...tok,
          output: newWinner.item,
          base: newWinner.root || newWinner.item,
          meaning: newWinner.meaning,
          grammar_tags,
          decision: newWinner.type.startsWith('deinflect') || newWinner.type.includes('deinflect')
            ? `${newWinner.type}:${newWinner.root || newWinner.item}`
            : newWinner.type,
          meta: {
            ...tok.meta,
            candidates: rescored,
            winner: newWinner,
            contextBoost: newWinner.contextBoost,
            contextResurrected: true,
            previousWinner: oldWinner.item,
            contextTrace
          }
        };
      }
      return { ...tok, meta: { ...tok.meta, contextTrace } };
    });
    return winningPath;
  }

  function traceBeamResults({
    rawChunk,
    hiraChunk,
    winningPath,
    topPaths
  }) {
    console.log(`\n\x1b[36m[BeamSearch] ${rawChunk}\x1b[0m`);
    console.log({
      hiragana: hiraChunk,
      final_cost: topPaths[hiraChunk.length][0].cost,

      segments: winningPath.map(s => ({
        type: s.type,
        surface: s.surface
      })),
      analysis: winningPath.map(r => ({
        surface: r.surface,
        base: r.base !== r.surface ? r.base : undefined,
        tags: r.grammar_tags.length > 0
          ? r.grammar_tags
          : undefined,
        contextResurrected:
          r.meta?.contextResurrected || undefined
      })),
      rejected_paths: topPaths[hiraChunk.length]
        .slice(1)
        .map(p => ({
          cost: p.cost,
          joined: p.path.map(s => s.surface).join('|')
        }))
    });
  }

  function resolveChunk(rawChunk, includeTrace = false) {
    const hiraChunk = wanakana.toHiragana(rawChunk, { passRomaji: false });
    if (hiraChunk.length === 0) return [];

    const fullEval = evaluator(rawChunk, hiraChunk);
    if (isConfidentWholeChunk(fullEval)) {
      return [fullEval];
    }

    const gateResult = detectStrongVerbMatch(rawChunk);
    if (gateResult) return gateResult;

    const hiraToRaw = buildHiraToRawMap(rawChunk, hiraChunk);

    let {
      winningPath,
      topPaths
    } = runBeamSearch({
      rawChunk,
      hiraChunk,
      hiraToRaw
    });

    winningPath = applyNeighborContextPass(winningPath, includeTrace);

    if (includeTrace && winningPath.length > 1) {
      traceBeamResults({
        rawChunk,
        hiraChunk,
        winningPath,
        topPaths
      });
    }
    return winningPath;
  }

  function dispatch(input, includeTrace = false) {
    if (!input) return includeTrace ? { output: '', tokens: [] } : '';

    const tDispatchStart = performance.now();
    let allTokens = [];
    const chunks = input.split(/([.。?？!！,、\s])/);

    for (const chunk of chunks) {
      if (!chunk) continue;
      if (/^[.。?？!！,、\s]+$/.test(chunk)) {
        allTokens.push({
          surface: chunk,
          output: chunk,
          base: chunk,
          meaning: '',
          grammar_tags: [],
          type: 'punctuation',
          decision: 'punctuation'
        });
        continue;
      }

      const segments = resolveChunk(chunk, includeTrace);
      allTokens.push(...segments);
    }

    const tBeamEnd = performance.now();

    // ── GRAMMAR COLLAPSE & ORPHAN MERGE PASS ───────────────────
    // Runs on the full token stream (across whitespace boundaries)
    // to detect multi-token grammar patterns and merge garbage orphans.
    allTokens = collapseGrammarTokens(allTokens, evaluator, resolveChunk);

    const tCollapseEnd = performance.now();

    if (includeTrace) {
      console.log(`\n\x1b[90m[Perf] Dispatch total: ${(tCollapseEnd - tDispatchStart).toFixed(2)}ms (Beam: ${(tBeamEnd - tDispatchStart).toFixed(2)}ms, Collapse: ${(tCollapseEnd - tBeamEnd).toFixed(2)}ms)\x1b[0m`);
    }

    const output = allTokens.map(s => s.output).join('');
    return includeTrace ? { output, tokens: allTokens } : output;
  }

  return {
    preprocessJapTrace: (input) => dispatch(input, true),
    rerankTrace: (tokens, queryEmbedding, hnswIndex, boost = 15) => {
      function cosineSimilarity(vecA, vecB) {
        if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
        let dot = 0, nA = 0, nB = 0;
        for (let i = 0; i < vecA.length; i++) {
          dot += vecA[i] * vecB[i];
          nA += vecA[i] * vecA[i];
          nB += vecB[i] * vecB[i];
        }
        if (nA === 0 || nB === 0) return 0;
        return dot / (Math.sqrt(nA) * Math.sqrt(nB));
      }

      const MAX_BOOST = Math.abs(boost) * 30; // Max 450 points
      const NEIGHBOR_WINDOW = 3;

      // ── Build per-token context vectors from ±3 neighbor winners ──────
      // Instead of comparing against a sentence-level embedding (which lives
      // in a different vector space), we average the HNSW vectors of the 
      // ±3 neighboring winning candidates. Because both the neighbors' vectors
      // and the candidates' vectors come from the SAME HNSW index, the cosine
      // similarities are directly comparable and meaningful.
      const winnerVecs = tokens.map(tok => {
        if (tok.type === 'grammar') return null;
        const winner = tok.meta?.candidates?.[0];
        if (!winner?.id || !hnswIndex) return null;
        try { return hnswIndex.getPoint(winner.id); }
        catch { return null; }
      });

      const newTokens = tokens.map((tok, idx) => {
        if (tok.type === 'grammar') return tok;
        if (!tok.meta || !tok.meta.candidates) return tok;

        const initialWinner = tok.meta.candidates[0];

        // Average the ±3 neighbor vectors to create a context vector
        let contextVec = null;
        let neighborCount = 0;
        for (let offset = -NEIGHBOR_WINDOW; offset <= NEIGHBOR_WINDOW; offset++) {
          if (offset === 0) continue;
          const nVec = winnerVecs[idx + offset];
          if (!nVec) continue;
          if (!contextVec) {
            contextVec = new Float64Array(nVec.length);
          }
          for (let d = 0; d < nVec.length; d++) contextVec[d] += nVec[d];
          neighborCount++;
        }

        // Also blend in the sentence-level query embedding (if available)
        // to add broader context beyond just local neighbors
        if (queryEmbedding && queryEmbedding.length > 0) {
          if (!contextVec) contextVec = new Float64Array(queryEmbedding.length);
          for (let d = 0; d < queryEmbedding.length; d++) contextVec[d] += queryEmbedding[d];
          neighborCount++;
        }

        if (!contextVec || neighborCount === 0) {
          // No neighbors, no context — pass through unchanged
          return {
            ...tok,
            meta: {
              ...tok.meta,
              candidates: tok.meta.candidates.map(c => ({
                ...c, cosSim: 0, semanticBoost: 0,
                finalScore: c.contextScore || c.adjustedScore || 0
              }))
            }
          };
        }

        // Normalize the averaged vector
        for (let d = 0; d < contextVec.length; d++) contextVec[d] /= neighborCount;

        const candidates = tok.meta.candidates.map(c => {
          let cosSim = 0;
          if (c.id && hnswIndex) {
            try {
              const cVec = hnswIndex.getPoint(c.id);
              cosSim = cosineSimilarity(contextVec, cVec);
            } catch (err) {
              // point might be missing from hnsw cache
            }
          }

          let semanticBoost = 0;
          // Absolute Curve: noise is < 0.55. Max similarity roughly ~0.70.
          if (cosSim > 0.60) { // Tightened from 0.55
            const ratio = Math.min(1.0, (cosSim - 0.60) / 0.15);
            let rawBoost = Math.round(MAX_BOOST * ratio);

            // ── DISTANCE SCALING ──────────────────────────────────────
            // High-confidence exact matches get full boost.
            // Poor fuzzy matches (dist 0.3) get scaled down drastically.
            const distScale = Math.max(0, 1.0 - (c.distance || 0) * 3);
            semanticBoost = Math.round(rawBoost * distScale);
          }

          return {
            ...c, cosSim, semanticBoost,
            finalScore: (c.contextScore || c.adjustedScore || 0) + semanticBoost
          };
        });

        if (candidates.length <= 1) {
          return { ...tok, meta: { ...tok.meta, candidates } };
        }

        // Exact Match & Grammar Ceiling Protection
        // If we have a literal exact match or a high-confidence deinflection,
        // protect it from loose fuzzy "hallucinations" unless they are near-perfect matches.
        const isStrongMatch = initialWinner.type === 'exact' || initialWinner.type.startsWith('deinflect');
        if (isStrongMatch) {
          candidates.forEach(c => {
            if (c.id === initialWinner.id) return;

            const isRiskyFuzzy = c.type.includes('fuzzy') && c.distance > 0.05;
            const isDifferentCandidate = (c.type.startsWith('exact') || c.type.startsWith('deinflect')) && c.id !== initialWinner.id;

            // SAFETY GATE: If it's a loose fuzzy or a different dictionary candidate, 
            // require an extreme semantic threshold (0.90) to allow a flip.
            // Tightened for grammar words to prevent "arimasuka" -> "himatsukaku"
            // Require a near-perfect match (0.95) to flip a literal match.
            const threshold = isStrongMatch ? 0.95 : 0.90;
            if ((isRiskyFuzzy || isDifferentCandidate) && c.cosSim < threshold) {
              c.finalScore = (c.contextScore || c.adjustedScore || 0); // Strip boost
              c.semanticBoost = 0;
            }
          });
        }

        candidates.sort((a, b) => b.finalScore - a.finalScore);
        const winner = candidates[0];
        const isResurrected = initialWinner.item !== winner.item;

        const grammar_tags = interpretReasonChains(winner.meta && winner.meta.reasons || []);

        let flipEvent = null;
        if (isResurrected && winner.semanticBoost > 0) {
          flipEvent = {
            oldItem: initialWinner.item,
            oldScore: initialWinner.contextScore || initialWinner.adjustedScore,
            oldCos: initialWinner.cosSim,
            newItem: winner.item,
            newCos: winner.cosSim,
            boost: winner.semanticBoost,
            contextDesc: `averaged ±${NEIGHBOR_WINDOW} neighbor vectors from HNSW`
          };

          console.log(`\n\x1b[36m[RAG Vector Rerank pass]\x1b[0m ⭐ FLIP TRIGGERED for token [${tok.surface || initialWinner.item}]!`);
          console.log(`  Old Target: ${initialWinner.item} (score: ${flipEvent.oldScore.toFixed(1)}, cos: ${flipEvent.oldCos?.toFixed(3) || 'N/A'})`);
          console.log(`  New Target: ${winner.item} (cos: ${winner.cosSim.toFixed(3)}, boost: +${winner.semanticBoost})`);
          console.log(`  └─ Context: ${flipEvent.contextDesc}`);
        }

        return {
          ...tok,
          output: winner.item,
          base: winner.root || winner.item,
          meaning: winner.meaning,
          grammar_tags: grammar_tags,
          decision: winner.type.startsWith('deinflect') || winner.type.includes('deinflect')
            ? `${winner.type}:${winner.root || winner.item}`
            : winner.type,
          meta: {
            ...tok.meta,
            candidates: candidates,
            winner: winner,
            semanticBoost: winner.semanticBoost,
            isResurrected: isResurrected,
            previousWinner: isResurrected ? initialWinner.item : null,
            competition: candidates.slice(0, 5).map(c => ({
              item: c.root ? `${c.item}(->${c.root})` : c.item,
              type: c.type,
              adj: c.finalScore.toFixed(2),
              cos: (c.cosSim || 0).toFixed(2),
              boost: (c.semanticBoost || 0).toFixed(0)
            })),
            flipEvent
          }
        };
      });

      const output = newTokens.map(t => t.output).join(' ');
      return { output, tokens: newTokens };
    }
  };
}

export function preprocessEng(text) {
  return (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

console.log('[preprocessor] Initializing from vocab.db with deinflector and grammar indices...');
// const db = new Database(DB_PATH, { readonly: true });

const allEntries = db.prepare('SELECT id, romaji, pos, tags, freq, primary_meaning, domain, mesh_annotations, mesh_domains, common_words FROM vocab').all();
const exactMatchIndex = new Map();

for (const entry of allEntries) {
  const norm = entry.romaji.toLowerCase();
  let entries = exactMatchIndex.get(norm);

  if (!entries) {
    entries = [];
    exactMatchIndex.set(norm, entries);
  }

  entries.push({
    id: entry.id,
    pos: entry.pos ? [entry.pos] : [],
    tags: entry.tags || '',
    freq: entry.freq || 0,
    romaji: entry.romaji,
    meaning: entry.primary_meaning || '',
    domain: entry.domain || null,
    mesh: entry.mesh_annotations ? JSON.parse(entry.mesh_annotations) : null,
    meshDomains: entry.mesh_domains ? JSON.parse(entry.mesh_domains) : [],
    commonWords: entry.common_words || null
  });
}

const candidates = db.prepare(`
  SELECT romaji FROM vocab 
  WHERE domain IS NOT NULL OR freq > 0.1
`).all();

// Load grammar anchors for the suffix peel system
loadGrammarAnchors(db);

const _default = createPreprocessor({
  vocabulary: candidates,
  exactMatchIndex
});

export const preprocessJapTrace = _default.preprocessJapTrace;
export const rerankTrace = _default.rerankTrace;
