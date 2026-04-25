/**
 * preprocessor.js
 *
 * Modernized romaji preprocessing pipeline using SQLite (vocab.db) and a robust deinflector.
 */

import * as wanakana from 'wanakana';
import Fuse from 'fuse.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deinflect, WordType, interpretReasonChains } from './deinflect.js';
import { calculateScore, calculateSegmentScore } from './config/linguistics.js';

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

function wkNormalize(token) {
  try {
    if (!wanakana.isRomaji(token)) return token;
    const hiragana = wanakana.toHiragana(token, { passRomaji: false });
    return wanakana.toRomaji(hiragana);
  } catch {
    return token;
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

  for (const t of tags) {
    if (t === 'v1') mask |= WordType.IchidanVerb;
    if (t.startsWith('v5')) mask |= WordType.GodanVerb;
    if (t === 'vk') mask |= WordType.KuruVerb;
    if (t === 'vs') mask |= WordType.SuruVerb;
    if (t === 'adj-i') mask |= WordType.IAdj;
  }
  return mask;
}

// getFrequencyScore and getSemanticImportance replaced by centralized calculateScore in Linguistics Engine.

// ─────────────────────────────────────────────────────────────────
// Preprocessor Engine Factory
// ─────────────────────────────────────────────────────────────────

export function createPreprocessor({ vocabulary = [], knownWords = new Map() } = {}) {

  const romajiList = vocabulary.map(v => v.romaji);
  const fuse = new Fuse(romajiList, FUSE_OPTIONS);

  function processTextSegment(tok, hiraOrigin = null) {
    const rawInput = tok.toLowerCase();
    const normalizedInput = rawInput;

    // 1. Particle Check
    const PARTICLES = {
      'wa': 'は', 'ha': 'は', 'ga': 'が', 'wo': 'を', 'o': 'を',
      'ni': 'に', 'e': 'へ', 'to': 'と', 'de': 'で',
      'no': 'の', 'mo': 'も', 'ka': 'か', 'ya': 'や',
      'yo': 'よ', 'ne': 'ね'
    };

    if (PARTICLES[normalizedInput]) {
      const particleOutput = (normalizedInput === 'o' ? 'wo' : normalizedInput);
      return {
        surface: hiraOrigin || PARTICLES[normalizedInput],
        output: particleOutput,
        base: particleOutput,
        meaning: 'particle',
        grammar_tags: [],
        decision: 'particle',
        type: 'text',
        meta: { kana: PARTICLES[normalizedInput] }
      };
    }

    if (normalizedInput.length < 2) {
      return {
        surface: hiraOrigin || normalizedInput,
        output: normalizedInput,
        base: normalizedInput,
        meaning: '',
        grammar_tags: [],
        type: 'text',
        decision: 'skipped (too short)'
      };
    }

    // 2. Corruption Detection & Repair Cycle
    const candidates = [];
    const hiraganaRaw = wanakana.toHiragana(normalizedInput);
    const hasCorruption = /[a-z]/.test(hiraganaRaw);

    let variants = new Map([[normalizedInput, { isOriginal: true }]]);

    // If normalizedInput is a normalized version (e.g. kudashi) and we have a more raw one (e.g. kudasi),
    // should we prioritize the raw one? Currently tok is the "most raw" available from evaluatePrefix.

    if (hasCorruption) {
      const corruptionMatch = hiraganaRaw.match(/[a-z]+/);
      if (corruptionMatch) {
        const failedPart = corruptionMatch[0];
        const failedIdx = normalizedInput.indexOf(failedPart);
        ['a', 'i', 'u', 'e', 'o'].forEach(v => {
          variants.set(normalizedInput.slice(0, failedIdx + 1) + v + normalizedInput.slice(failedIdx + 1), { isRepair: true });
        });
      }
    }

    const CONSONANTS_TO_DOUBLE = 'kstpbcgdrfvmzn';
    for (let i = 0; i < normalizedInput.length - 1; i++) {
      const char = normalizedInput[i];
      const next = normalizedInput[i + 1];
      if (CONSONANTS_TO_DOUBLE.includes(char) && 'aeiouy'.includes(next)) {
        const doubled = normalizedInput.slice(0, i + 1) + char + normalizedInput.slice(i + 1);
        variants.set(doubled, { isDoubling: true });
      }
    }

    const wkNormalized = wkNormalize(normalizedInput);
    if (wkNormalized !== normalizedInput) {
      variants.set(wkNormalized, { isWkNorm: true });
    }

    for (const [variant, vMeta] of variants.entries()) {
      const isOriginal = vMeta.isOriginal;
      const isWkNorm = vMeta.isWkNorm;

      if (hasCorruption && isOriginal) continue;

      let variantType = isOriginal ? 'exact' : (vMeta.isRepair ? 'exact:repair' : (vMeta.isDoubling ? 'exact:doubling' : (isWkNorm ? 'normalized' : 'aggressive:exact')));

      const exactEntries = knownWords.get(variant);
      if (exactEntries) {
        for (const entry of exactEntries) {
          const { score, breakdown } = calculateSegmentScore(entry, {
            type: variantType,
            isOriginal,
            inputLen: normalizedInput.length,
            matchLen: variant.length
          });

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

      const fuzzyType = isOriginal ? 'fuzzy' : (vMeta.isRepair ? 'fuzzy:repair' : (vMeta.isDoubling ? 'fuzzy:doubling' : 'aggressive:fuzzy'));
      let fuseResults = [];
      if (variant.length <= 15) {
        fuseResults = fuse.search(variant).slice(0, 10);
      }

      for (const res of fuseResults) {
        const item = res.item;
        const entries = knownWords.get(item);
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
        const entries = knownWords.get(rootRomaji);
        if (entries) {
          for (const wordData of entries) {
            const isMatch = wordData.pos.some(tag => (mapPosToVerbClass(tag) & c.type) !== 0);
            if (isMatch) {
              const steps = (c.reasonChains && c.reasonChains[0]) ? c.reasonChains[0].length : 1;
              const deinfDistance = 0.02 + (steps * 0.02);

              const { score, breakdown } = calculateSegmentScore(wordData, {
                type: deinfType,
                distance: deinfDistance,
                inputLen: variant.length,
                matchLen: rootRomaji.length,
                isOriginal
              });

              candidates.push({
                id: wordData.id,
                item: variant,
                root: rootRomaji,
                type: deinfType,
                distance: deinfDistance,
                freqScore: calculateScore(wordData),
                adjustedScore: score,
                breakdown,
                meaning: wordData.meaning,
                meta: { reasons: c.reasonChains, type: c.type, ruleWeight: c.ruleWeight || 1.0 }
              });
            }
          }
        }
      }

    }

    if (candidates.length > 0) {
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
          surface: hiraOrigin || normalizedInput,
          output: normalizedInput,
          base: normalizedInput,
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
          competition: candidates.slice(0, 3).map(c => ({
            item: c.root ? `${c.item}(->${c.root})` : c.item,
            type: c.type,
            adj: c.adjustedScore.toFixed(4)
          })),
          ...winner.meta
        }
      };
    }

    return {
      surface: hiraOrigin || normalizedInput,
      output: normalizedInput,
      base: normalizedInput,
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

    const MAX_PREFIX_LEN = 15;
    const BEAM_WIDTH = 3;
    const memo = new Map();

    function evaluatePrefix(j, i) {
      const prefix = hiraStr.slice(j, i);
      // Precise raw romaji extraction
      const startR = j === 0 ? 0 : hiraToRaw[j] + 1;
      const endR = hiraToRaw[i] + 1;
      const romaji = rawLower.slice(startR, endR);

      const memoKey = prefix + "|" + romaji;

      if (memo.has(memoKey)) return memo.get(memoKey);
      const results = [];
      const l = prefix.length;

      const BASE_SEGMENT_COST = 45; // Increased from 25 to penalize over-fragmentation
      const SHORT_PENALTY = Math.max(0, (4 - prefix.length) * 20); // More aggressive short penalty

      // 1. Text / deinflect candidate
      const textEval = processTextSegment(romaji, prefix);

      if (textEval.decision !== 'passthrough' && textEval.decision !== 'passthrough:low_confidence' && textEval.decision !== 'skipped (too short)') {
        // Path Cost = MaxPossiblePoints (2500) - ActualPoints
        // This allows the Beam Search (Dijkstra) to work with a minimization goal.
        let pathCost = 2000;

        if (textEval.meta?.winner) {
          pathCost = Math.max(0, 2500 - textEval.meta.winner.adjustedScore);

          // Extra bonus for high-confidence medical terms
          if (textEval.meta.winner.freqScore >= 80) {
            pathCost = Math.max(0, pathCost - 100);
          }
        }

        if (textEval.decision === 'particle') pathCost -= 50;

        results.push({ eval: textEval, cost: pathCost + SHORT_PENALTY });
      } else {
        // Low confidence passthrough
        let cost = 1200 - (l * 40);
        results.push({ eval: textEval, cost: cost + SHORT_PENALTY });
      }

      // Grammar matching removed — LLM handles grammar natively.
      // The beam search now focuses purely on vocabulary disambiguation.

      memo.set(memoKey, results);
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

      // Sort candidates by cost (lowest is better)
      candidatesForI.sort((a, b) => a.cost - b.cost);

      // Apply beam width
      topPaths[i] = candidatesForI.slice(0, BEAM_WIDTH);
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

    const tokenLog = [];
    const clauses = text.split(/([.。?？!！,、\s])/);

    const processed = clauses.map(part => {
      if (!part || /^[.。?？!！,、\s]+$/.test(part)) return part;

      const segments = segmentAndProcess(part, includeTrace);
      if (includeTrace) {
        tokenLog.push(...segments);
      }
      return segments.map(s => s.output).join('');
    });

    const output = processed.join('');
    return includeTrace ? { output, tokens: tokenLog } : output;
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
          if (cosSim > 0.55) {
            const ratio = Math.min(1.0, (cosSim - 0.55) / 0.15);
            semanticBoost = Math.round(MAX_BOOST * ratio);
          }

          return {
            ...c, cosSim, semanticBoost,
            finalScore: (c.contextScore || c.adjustedScore || 0) + semanticBoost
          };
        });

        if (candidates.length <= 1) {
          return { ...tok, meta: { ...tok.meta, candidates } };
        }

        // Exact Match Ceiling Protection
        if (initialWinner.type === 'exact' && initialWinner.adjustedScore >= 1000) {
          candidates.forEach(c => {
            if (c.type.includes('fuzzy') && c.cosSim < 0.85) {
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

const allEntries = db.prepare('SELECT id, romaji, pos, tags, freq, primary_meaning, domain, mesh_annotations, mesh_domains FROM vocab').all();
const knownWords = new Map();

for (const entry of allEntries) {
  const norm = entry.romaji.toLowerCase();
  let entries = knownWords.get(norm);

  if (!entries) {
    entries = [];
    knownWords.set(norm, entries);
  }

  entries.push({
    id: entry.id,
    pos: entry.pos ? [entry.pos] : [],
    tags: entry.tags || '',
    freq: entry.freq || 0,
    meaning: entry.primary_meaning || '',
    domain: entry.domain || null,
    mesh: entry.mesh_annotations ? JSON.parse(entry.mesh_annotations) : null,
    meshDomains: entry.mesh_domains ? JSON.parse(entry.mesh_domains) : []
  });
}

const candidates = db.prepare(`
  SELECT romaji FROM vocab 
  WHERE domain IS NOT NULL OR freq > 0.1
`).all();

// Grammar tables left in DB but no longer loaded by preprocessor.
// The LLM handles grammar natively — preprocessor focuses on vocab disambiguation.

const _default = createPreprocessor({
  vocabulary: candidates,
  knownWords
});

export const preprocessJap = _default.preprocessJap;
export const preprocessJapWithTrace = _default.preprocessJapWithTrace;
export const rerankTrace = _default.rerankTrace;
export const CONTENT_DECISIONS = new Set(['exact', 'normalization', 'fuzzy', 'passthrough', 'whitelist', 'correction', 'grammar']);
