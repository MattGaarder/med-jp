/**
 * preprocessor.js
 *
 * Modernized romaji preprocessing pipeline using SQLite (vocab.db) and a robust deinflector.
 */

import { performance } from 'node:perf_hooks';
import * as wanakana from 'wanakana';
import Fuse from 'fuse.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deinflect, WordType, interpretReasonChains } from './deinflect.js';
import { calculateScore, calculateSegmentScore } from './config/linguistics.js';
import { loadGrammarAnchors, peelGrammarSuffix, collapseGrammarTokens } from './grammarPeel.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'vocab.db');

// ─────────────────────────────────────────────────────────────────
// Fuse.js configuration
// ─────────────────────────────────────────────────────────────────

const FUSE_OPTIONS = {
  includeScore: true,
  threshold: 0.3,
  distance: 50,
  minMatchCharLength: 2,
  shouldSort: true,
};

// ─────────────────────────────────────────────────────────────────
// Linguistic Transformers
// ─────────────────────────────────────────────────────────────────

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

function mapPosToVerbClass(posTag) {
  if (!posTag) return 0;
  const tags = posTag.split(',').map(t => t.trim());
  let mask = 0;

  // Verb Stem Mask: A dictionary verb can be ANY of these stems after deinflection.
  const ALL_STEMS = WordType.Initial | WordType.TaTeStem | WordType.DaDeStem | WordType.MasuStem | WordType.IrrealisStem;

  for (const t of tags) {
    if (t === 'v1') mask |= (WordType.IchidanVerb | ALL_STEMS);
    if (t.startsWith('v5')) mask |= (WordType.GodanVerb | ALL_STEMS);
    if (t === 'vk') mask |= (WordType.KuruVerb | ALL_STEMS);
    if (t === 'vs') mask |= (WordType.SuruVerb | WordType.NounVS | ALL_STEMS);
    if (t === 'vz') mask |= (WordType.SuruVerb | ALL_STEMS);
    if (t === 'adj-i') mask |= WordType.IAdj;
  }
  return mask;
}

// ─────────────────────────────────────────────────────────────────
// Preprocessor Engine Factory
// ─────────────────────────────────────────────────────────────────

export function createPreprocessor({ vocabulary = [], exactMatchIndex = new Map() } = {}) {

  const romajiList = vocabulary.map(v => v.romaji);
  const fuse = new Fuse(romajiList, FUSE_OPTIONS);

  function processTextSegment(candidateSegment, hiraOrigin = null) {
    const rawInput = candidateSegment.toLowerCase();

    // 1. Particle Check (Unified Kana + Standardized Romaji mapping)
    const PARTICLE_MAP = {
      'wa': { hira: 'は', romaji: 'wa' },
      'ha': { hira: 'は', romaji: 'wa' },
      'ga': { hira: 'が', romaji: 'ga' },
      'wo': { hira: 'を', romaji: 'wo' },
      'o':  { hira: 'を', romaji: 'wo' },
      'ni': { hira: 'に', romaji: 'ni' },
      'e':  { hira: 'へ', romaji: 'e' },
      'to': { hira: 'と', romaji: 'to' },
      'de': { hira: 'で', romaji: 'de' },
      'no': { hira: 'の', romaji: 'no' },
      'mo': { hira: 'も', romaji: 'mo' },
      'ka': { hira: 'か', romaji: 'ka' },
      'ya': { hira: 'や', romaji: 'ya' },
      'yo': { hira: 'よ', romaji: 'yo' },
      'ne': { hira: 'ね', romaji: 'ne' }
    };

    const pMatch = PARTICLE_MAP[rawInput];
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

    if (rawInput.length < 2) {
      return {
        surface: hiraOrigin || rawInput,
        output: rawInput,
        base: rawInput,
        meaning: '',
        grammar_tags: [],
        type: 'text',
        decision: 'skipped (too short)'
      };
    }

    // 2. Corruption Detection & Repair Cycle
    let candidates = [];
    const hiraganaRaw = wanakana.toHiragana(rawInput);
    const hasCorruption = /[a-z]/.test(hiraganaRaw);

    let variants = new Map([[rawInput, { isOriginal: true }]]);

    // If rawInput is a normalized version (e.g. kudashi) and we have a more raw one (e.g. kudasi),
    // should we prioritize the raw one? Currently candidateSegment is the "most raw" available from evaluatePrefix.

    if (hasCorruption) {
      // Find ALL corruption sites in the hiragana string and map each
      // back to its correct position in the romaji input.
      // The old code used rawInput.indexOf(failedPart) which found the WRONG
      // instance (e.g., the first 'm' in 'shimaimsu' instead of the orphan 'm').
      const corruptionRegex = /[a-z]+/g;
      let match;
      while ((match = corruptionRegex.exec(hiraganaRaw)) !== null) {
        const hiraPos = match.index; // position in the hiragana string
        // Map hiragana position back to romaji position:
        // Count how many romaji chars produce the kana up to hiraPos
        let romajiPos = 0;
        for (let r = 1; r <= rawInput.length; r++) {
          const partialHira = wanakana.toHiragana(rawInput.slice(0, r));
          if (partialHira.length > hiraPos) {
            romajiPos = r - 1; // the romaji char at r-1 is where the corruption starts
            break;
          }
          if (r === rawInput.length) romajiPos = r - 1;
        }
        // Insert vowels after the stuck consonant(s)
        const stuckLen = match[0].length;
        ['a', 'i', 'u', 'e', 'o'].forEach(v => {
          const repaired = rawInput.slice(0, romajiPos + stuckLen) + v + rawInput.slice(romajiPos + stuckLen);
          variants.set(repaired, { isRepair: true });
        });
      }
    }

    const CONSONANTS_TO_DOUBLE = 'kstpbcgdrfvmzn';
    for (let i = 0; i < rawInput.length - 1; i++) {
        const char = rawInput[i];
        const next = rawInput[i + 1];
        if (CONSONANTS_TO_DOUBLE.includes(char) && 'aeiouy'.includes(next)) {
            const doubled = rawInput.slice(0, i + 1) + char + rawInput.slice(i + 1);
            variants.set(doubled, { isDoubling: true });
        }
    }
 
    // Voicing/Dakuten Repair (ks th -> gz db)
    const DAKUTEN_MAP = { 'k':'g', 's':'z', 't':'d', 'h':'b', 'f':'b', 'g':'k', 'z':'s', 'd':'t', 'b':'h' };

    for (let i = 0; i < rawInput.length; i++) {
      const char = rawInput[i];
      if (DAKUTEN_MAP[char]) {
        const phonetic = rawInput.slice(0, i) + DAKUTEN_MAP[char] + rawInput.slice(i + 1);
        variants.set(phonetic, { isPhonetic: true });
      }
    }


    const wkNormalized = wkNormalize(rawInput);
    if (wkNormalized !== rawInput) {
      variants.set(wkNormalized, { isWkNorm: true });
    }

    for (const [variant, vMeta] of variants.entries()) {
      const isOriginal = vMeta.isOriginal;
      const isWkNorm = vMeta.isWkNorm;
      // We no longer skip corrupted originals here. 
      // If deinflect() can find a valid morphological parse for a "corrupted" string, 
      // we want to allow it.


      let variantType = isOriginal ? 'exact' 
        : (vMeta.isRepair ? 'exact:repair' 
        : (vMeta.isPhonetic ? 'exact:phonetic'
        : (vMeta.isDoubling ? 'exact:doubling' 
        // to handle highly-transformed future mutations
        : (isWkNorm ? 'normalized' : 'aggressive:exact'))));


      const exactEntries = exactMatchIndex.get(variant);
      let hasHighConfidenceExact = false;
      if (exactEntries) {
        for (const entry of exactEntries) {
          const { score, breakdown } = calculateSegmentScore(entry, {
            type: variantType,
            isOriginal,
            inputLen: rawInput.length,
            matchLen: variant.length
          });

          if (score > 1000) hasHighConfidenceExact = true;

          candidates.push({
            id: entry.id,
            item: variant,
            type: variantType,
            distance: 0.0,
            freqScore: calculateScore(entry),
            adjustedScore: score,
            breakdown,
            meaning: entry.meaning
          });
        }
      }

      // SHORT-CIRCUIT: If we found a high-confidence exact match, skip the expensive fuzzy search for this variant.
      if (hasHighConfidenceExact) continue;

      const fuzzyType = isOriginal ? 'fuzzy' : (vMeta.isRepair ? 'fuzzy:repair' : (vMeta.isDoubling ? 'fuzzy:doubling' : 'aggressive:fuzzy'));
      let fuseResults = [];
      if (variant.length <= 25) {
        fuseResults = fuse.search(variant).slice(0, 5); // Reduced from 20 for latency
      }

      for (const res of fuseResults) {
        const item = res.item;
        const entries = exactMatchIndex.get(item);
        if (!entries) continue;

        for (const wordData of entries) {
          const { score, breakdown } = calculateSegmentScore(wordData, {
            type: fuzzyType,
            distance: res.score,
            inputLen: variant.length,
            matchLen: item.length,
            isOriginal
          });

          candidates.push({
            id: wordData.id,
            item: item,
            type: fuzzyType,
            distance: res.score,
            freqScore: calculateScore(wordData),
            adjustedScore: score,
            breakdown,
            meaning: wordData.meaning
          });
        }
      }

      const deinfType = isOriginal ? 'deinflect' : (vMeta.isRepair ? 'deinflect:repair' : (vMeta.isDoubling ? 'deinflect:doubling' : 'aggressive:deinflect'));
      const hira = wanakana.toHiragana(variant);
      const deinfResults = deinflect(hira);
      for (const c of deinfResults) {
        const rootRomaji = toRomajiSafe(c.word);
        
        let stemMatches = [];
        const exactStemEntries = exactMatchIndex.get(rootRomaji);
        
        if (exactStemEntries) {
          stemMatches = exactStemEntries.map(e => ({ entry: e, type: deinfType, dist: 0 }));
        } else if (rootRomaji.length >= 2 && c.reasonChains.length > 0) {
          // FUZZY STEM REPAIR: If we have a valid deinflection reason but no exact root match,
          // fuzzy match the stem against the dictionary. This prevents "kitdukare" 
          // from being fragmented when it could be a corrupted "kizuka" or "katazuka".
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

        for (const { entry: wordData, type: mType, dist: stemDist } of stemMatches) {
          const isMatch = wordData.pos.some(tag => (mapPosToVerbClass(tag) & c.type) !== 0);
          if (isMatch) {
            const steps = (c.reasonChains && c.reasonChains[0]) ? c.reasonChains[0].length : 1;
            // Combined distance: base penalty for deinflection depth + any stem corruption
            const totalDist = 0.02 + (steps * 0.02) + (stemDist * 0.5);

            const { score, breakdown } = calculateSegmentScore(wordData, {
              type: mType,
              distance: totalDist,
              inputLen: variant.length,
              matchLen: rootRomaji.length,
              isOriginal
            });

            if (score > 1050) {
              // VERB SHORT-CIRCUIT: If we find a high-confidence verb via morphological deinflection,
              // we treat it with the same priority as a direct exact match, making it the dominant
              // candidate for this segment and preventing fragmentation.
              hasHighConfidenceExact = true; 
            }

            candidates.push({
              id: wordData.id,
              item: variant,
              root: wordData.romaji,
              type: mType,
              distance: totalDist,
              freqScore: calculateScore(wordData),
              adjustedScore: score,
              breakdown,
              meaning: wordData.meaning,
              meta: { reasons: c.reasonChains, type: c.type, ruleWeight: c.ruleWeight || 1.0 }
            });
          }
        }
      }

      if (hasHighConfidenceExact) break; // Exit variant loop early if we found our verb


    }

    if (candidates.length > 0) {
      // ── DEDUPLICATE ──────────────────────────────────────────────
      // Prevent multiple variations of the same word (e.g. yuragu vs yuragu:repair)
      // from filling the top pool, allowing room for other words (like drug).
      const idSeen = new Set();
      candidates = candidates.filter(c => {
        if (c.id && idSeen.has(c.id)) return false;
        if (c.id) idSeen.add(c.id);
        return true;
      });

      candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);

      // ── EXACT-MATCH SAFETY CLAMP ──────────────────────────────────
      // If the original input has an exact dictionary match with reasonable
      // frequency, no pure fuzzy match on the original input should beat it.
      const bestExact = candidates.find(c => c.type === 'exact' && c.freqScore > 5);
      if (bestExact) {
        const ceiling = bestExact.adjustedScore;
        let clamped = false;
        for (const c of candidates) {
          if (c.type === 'fuzzy' && c.adjustedScore > ceiling) {
            c.adjustedScore = ceiling - 1;
            clamped = true;
          }
        }
        if (clamped) candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);
      }

      const winner = candidates[0];

      if (winner.adjustedScore < 600) {
        return {
          surface: hiraOrigin || rawInput,
          output: rawInput,
          base: rawInput,
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
          candidates: candidates,
          competition: candidates.slice(0, 5).map(c => ({
            item: c.root ? `${c.item}(->${c.root})` : c.item,
            type: c.type,
            adj: c.adjustedScore.toFixed(4)
          })),
          ...winner.meta
        }
      };
    }

    return {
      surface: hiraOrigin || rawInput,
      output: rawInput,
      base: rawInput,
      meaning: '',
      grammar_tags: [],
      type: 'text',
      decision: 'passthrough'
    };
  }

  function segmentAndProcess(rawChunk, includeTrace = false) {
    const hiraStr = wanakana.toHiragana(rawChunk.toLowerCase(), { passRomaji: false });
    if (hiraStr.length === 0) return [];

    // Build map for raw romaji slicing
    const rawLower = rawChunk.toLowerCase();
    const hiraToRaw = new Uint8Array(hiraStr.length + 1);
    let hIdx = 0;
    for (let rIdx = 0; rIdx < rawLower.length; rIdx++) {
      const subH = wanakana.toHiragana(rawLower.slice(0, rIdx + 1));
      while (hIdx < subH.length) {
        hiraToRaw[hIdx] = rIdx;
        hIdx++;
      }
    }
    hiraToRaw[hiraStr.length] = rawLower.length - 1;

    const MAX_PREFIX_LEN = 25;
    const BEAM_WIDTH = 3;
    const globalEvalCache = new Map();

    function evaluatePrefix(j, i) {
      const prefix = hiraStr.slice(j, i);
      // Precise raw romaji extraction
      const startR = j === 0 ? 0 : hiraToRaw[j] + 1;
      const endR = hiraToRaw[i] + 1;
      const romaji = rawLower.slice(startR, endR);

      const memoKey = prefix + "|" + romaji;
      if (globalEvalCache.has(memoKey)) return globalEvalCache.get(memoKey);
      const results = [];
      const l = prefix.length;

      const BASE_SEGMENT_COST = 100; // Increased from 45 to heavily penalize over-fragmentation
      const SHORT_PENALTY = Math.max(0, (4 - prefix.length) * 40); // More aggressive short penalty

      // 1. Text / deinflect candidate
      const textEval = processTextSegment(romaji, prefix);

      if (textEval.decision !== 'passthrough' && textEval.decision !== 'passthrough:low_confidence' && textEval.decision !== 'skipped (too short)') {
        // Path Cost = MaxPossiblePoints (2000) - ActualPoints
        // This allows the Beam Search (Dijkstra) to work with a minimization goal.
        let pathCost = 2000;

        if (textEval.meta?.winner) {
          pathCost = Math.max(0, 2000 - textEval.meta.winner.adjustedScore);

          // Extra bonus for high-confidence medical terms
          if (textEval.meta.winner.freqScore >= 80) {
            pathCost = Math.max(0, pathCost - 150);
          }
        }

        if (textEval.decision === 'particle') pathCost -= 50;

        results.push({ eval: textEval, cost: pathCost + SHORT_PENALTY + BASE_SEGMENT_COST });
      } else {
        // Low confidence passthrough - Make this extremely expensive to force dictionary matches
        // Scaling cost high ensures that even a deinflected match with a typo is cheaper than two passthrough chunks.
        let cost = 8000 - (l * 50);
        results.push({ eval: textEval, cost: cost + SHORT_PENALTY });
      }

      // 2. Grammar suffix peel candidates
      // Try peeling known grammar suffixes (から, たり, ように, etc.) from the end
      // of the prefix. If the remaining stem matches a dictionary entry, emit it
      // as a high-confidence compound candidate.
      const grammarPeels = peelGrammarSuffix(prefix, romaji, exactMatchIndex, fuse);
      for (const peel of grammarPeels) {
        const stemEval = processTextSegment(peel.stemRomaji, peel.stemHira);
        if (stemEval.decision !== 'passthrough' && stemEval.decision !== 'passthrough:low_confidence' && stemEval.decision !== 'skipped (too short)') {
          let peelCost = 2000;
          if (stemEval.meta?.winner) {
            peelCost = Math.max(0, 2000 - stemEval.meta.winner.adjustedScore);
          }
          // Grammar peel bonus: reward finding a real word + grammar structure
          // We provide a "Togetherness Boost" of -150 to keep these together.
          peelCost -= 150; 
          if (peel.priority > 0) peelCost -= peel.priority * 10; // DB priority boost
          if (peel.isFuzzy) peelCost += (peel.distance * 100); // Penalty for fuzzy stem

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

    // Viterbi / Beam Search path building
    // topPaths[i] saves { cost: number, paths: Array of evaluations }
    let topPaths = Array(hiraStr.length + 1).fill(null).map(() => []);
    topPaths[0] = [{ cost: 0, path: [] }];

    for (let i = 1; i <= hiraStr.length; i++) {
      const startJ = Math.max(0, i - MAX_PREFIX_LEN);
      let candidatesForI = [];

      for (let j = startJ; j < i; j++) {
        if (topPaths[j].length === 0) continue;

        const prefix = hiraStr.slice(j, i);
        const evals = evaluatePrefix(j, i);

        for (const state of topPaths[j]) {
          for (const ev of evals) {
            candidatesForI.push({
              cost: state.cost + ev.cost,
              path: [...state.path, ev.eval]
            });
          }
        }
      }

      // Sort and prune candidates at each position to prevent exponential growth
      candidatesForI.sort((a, b) => a.cost - b.cost);

      // BEAM PRUNING:
      // 1. Hard limit on beam width (Reduced from 20 to 5 for latency)
      // 2. Cost threshold: drop anything significantly worse than the best candidate
      const bestCost = candidatesForI[0]?.cost || Infinity;
      topPaths[i] = candidatesForI.slice(0, 5).filter(c => c.cost < (bestCost + 800));
    }

    if (topPaths[hiraStr.length].length === 0) return [];

    let winningPath = topPaths[hiraStr.length][0].path;

    // ── NEIGHBOR-CONTEXT SECOND PASS ─────────────────────────────────
    // After the beam search picks winners purely by score, re-examine each
    // token's candidate list using ±3 neighbor tokens as context.
    // Example: if neighbors mention drugs (kusuri, kokain), a candidate
    // like "crack" (drug) should beat "kiraku" (carefree).
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

      if (includeTrace) {
        console.log(`\n\x1b[35m[Context Pass]\x1b[0m Evaluating token: \x1b[1m${tok.surface || tok.output}\x1b[0m`);
        console.log(`  Context words drawn from ±3 neighbors: [${Array.from(neighborContext).slice(0, 10).join(', ')}]`);
        console.log(`  Candidates considered:`);
        tok.meta.candidates.slice(0, 3).forEach(c => {
          console.log(`    - ${c.item} (score: ${(c.adjustedScore || 0).toFixed(1)}) -> meaning: ${c.meaning || 'N/A'}`);
        });

        if (newWinner.item !== oldWinner.item && newWinner.contextBoost > 0) {
          console.log(`  \x1b[32m⭐ FLIP TRIGGERED!\x1b[0m`);
          console.log(`  ${newWinner.item} beat ${oldWinner.item} by gaining +${newWinner.contextBoost} context points because its meaning overlapped with neighbors!`);
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
            previousWinner: oldWinner.item
          }
        };
      }

      return tok;
    });

    if (includeTrace && winningPath.length > 1) {
      console.log(`\n\x1b[36m[BeamSearch] ${rawChunk}\x1b[0m`);
      console.log({
        hiragana: hiraStr,
        final_cost: topPaths[hiraStr.length][0].cost,
        segments: winningPath.map(s => ({ type: s.type, surface: s.surface })),
        analysis: winningPath.map(r => ({
          surface: r.surface,
          base: r.base !== r.surface ? r.base : undefined,
          tags: r.grammar_tags.length > 0 ? r.grammar_tags : undefined,
          contextResurrected: r.meta?.contextResurrected || undefined
        })),
        rejected_paths: topPaths[hiraStr.length].slice(1).map(p => ({ cost: p.cost, joined: p.path.map(s => s.surface).join('|') }))
      });
    }

    return winningPath;
  }

  function dispatch(text, includeTrace = false) {
    if (!text) return includeTrace ? { output: '', tokens: [] } : '';

    const tDispatchStart = performance.now();
    let allTokens = [];
    const clauses = text.split(/([.。?？!！,、\s])/);

    for (const part of clauses) {
      if (!part) continue;
      if (/^[.。?？!！,、\s]+$/.test(part)) {
        allTokens.push({
          surface: part,
          output: part,
          base: part,
          meaning: '',
          grammar_tags: [],
          type: 'punctuation',
          decision: 'punctuation'
        });
        continue;
      }

      const segments = segmentAndProcess(part, includeTrace);
      allTokens.push(...segments);
    }

    const tBeamEnd = performance.now();

    // ── GRAMMAR COLLAPSE & ORPHAN MERGE PASS ───────────────────
    // Runs on the full token stream (across whitespace boundaries)
    // to detect multi-token grammar patterns and merge garbage orphans.
    allTokens = collapseGrammarTokens(allTokens, processTextSegment, segmentAndProcess);

    const tCollapseEnd = performance.now();

    if (includeTrace) {
      console.log(`\n\x1b[90m[Perf] Dispatch total: ${(tCollapseEnd - tDispatchStart).toFixed(2)}ms (Beam: ${(tBeamEnd - tDispatchStart).toFixed(2)}ms, Collapse: ${(tCollapseEnd - tBeamEnd).toFixed(2)}ms)\x1b[0m`);
    }

    const output = allTokens.map(s => s.output).join('');
    return includeTrace ? { output, tokens: allTokens } : output;
  }

  return {
    preprocessJap: (text) => dispatch(text, false),
    preprocessJapWithTrace: (text) => dispatch(text, true),
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
            const isDifferentExact = c.type.startsWith('exact') && c.id !== initialWinner.id;

            // SAFETY GATE: If it's a loose fuzzy or a different exact match, 
            // require an extreme semantic threshold (0.90) to allow a flip.
            // Tightened for grammar words to prevent "arimasuka" -> "himatsukaku"
            // Require a near-perfect match (0.95) to flip a literal match.
            const threshold = isStrongMatch ? 0.95 : 0.90;
            if ((isRiskyFuzzy || isDifferentExact) && c.cosSim < threshold) {
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
const db = new Database(DB_PATH, { readonly: true });

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

export const preprocessJap = _default.preprocessJap;
export const preprocessJapWithTrace = _default.preprocessJapWithTrace;
export const rerankTrace = _default.rerankTrace;
export const CONTENT_DECISIONS = new Set(['exact', 'normalization', 'fuzzy', 'passthrough', 'whitelist', 'correction', 'grammar']);
