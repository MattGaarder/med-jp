/**
 * promptBuilder.js
 * Constructs direction-specific prompts from raw input.
 * Applies preprocessing and adds /no_think directive for Qwen3.
 */

import { performance } from 'node:perf_hooks';
import path from 'path';
import { fileURLToPath } from 'url';
import { preprocessJapTrace, preprocessEng, rerankTrace } from './preprocessor.js';
import { loadIndex, searchANN, getIndex } from './load-index.js';
import Database from 'better-sqlite3';
import { GRAM_POS, isMedicalDomain } from './config/linguistics.js';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OLLAMA_URL = process.env.OLLAMA_BASE_URL;
const EMBED_MODEL = process.env.EMBED_MODEL;
// ─────────────────────────────────────────────
// RAG: HNSW ANN Index + SQLite Lookup 
// ─────────────────────────────────────────────
const DB_PATH  = path.join(__dirname, '../data/vocab.db');

let db         = null;   // better-sqlite3 connection
let annReady   = false;  // HNSW index loaded flag
let annInitPromise = null;

import { logSection } from './logger.js';

const DEBUG = true;

function logStep(label, data = null) {
  if (!DEBUG) return;
  logSection(label, data);
}

function isLogNoiseToken(t) {
  return (
    t.decision === 'punctuation' ||
    t.decision === 'particle' ||
    t.output === ' ' ||
    (t.output && t.output.length <= 1)
  );
}

/**
 * One-time startup: load the HNSW binary index from disk.
 * Fast — reads a compact binary; no JSONL streaming, no RAM spike.
 */
async function ensureANN() {
  if (annReady) return true;
  if (annInitPromise) return annInitPromise;

  annInitPromise = (async () => {
    try {
      console.log('\x1b[90m[RAG] Loading HNSW index from disk...\x1b[0m');
      loadIndex();                        // from load-index.js — reads hnsw.index + metadata.json
      db = new Database(DB_PATH, { readonly: true });
      annReady = true;
      console.log('\x1b[90m[RAG] ANN index + SQLite ready.\x1b[0m');
      return true;
    } catch (err) {
      console.warn(`\x1b[33m[RAG] Warning: could not load ANN index — ${err.message}. RAG disabled.\x1b[0m`);
      return false;
    }
  })();
  return annInitPromise;
}

// Embeddings (Semantic Understanding): text → Ollama → vector embedding
async function getSentenceEmbedding(text) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    return data.embedding;
  } catch (e) {
    console.error(`\x1b[31m[RAG] Embedding failed: ${e.message}\x1b[0m`);
    return null;
  }
}

/**
 * Run ANN search and hydrate results from SQLite.
 * @param {number[]} embedding
 * @param {string}   queryText
 * @param {number}   topK
 * @param {Set}      [anchorTokens] - forwarded to searchANN for anchor boost
 */

function ragSearch(embedding, topK = 5, anchorTokens = new Set()) {
  const annHits = searchANN(embedding, topK, anchorTokens);

  const stmt = db.prepare(
    'SELECT romaji, kanji, kana, domain, pos, tags, freq, primary_meaning, secondary_meanings ' +
    'FROM vocab WHERE id = ?'
  );
  // ─────────────────────────────────────────────
  // Hydrate results from SQLite
  // ─────────────────────────────────────────────
  const hydrated = annHits.map(({ score, semanticScore, item }) => {
    const id = item?.id;
    if (!id) return { score, semanticScore, item };
    const row = stmt.get(id);
    if (!row) return { score, semanticScore, item };
    return {
      score,
      semanticScore,
      item: {
        id: id,
        romaji: row.romaji,
        kana: row.kana ?? '',
        kanji: row.kanji ?? '',
        meanings: [
          row.primary_meaning,
          ...(row.secondary_meanings
            ? row.secondary_meanings.split(', ')
            : [])
        ],
        tags: row.tags ? row.tags.split(', ') : [],
        domain: row.domain ?? null,
        source: 'semantic',
        pos: row.pos ? row.pos.split(', ') : [],
        frequency: row.freq ?? 0.1,
      }
    };
  });
  // ─────────────────────────────────────────────
  // 2. DEDUPE (critical)
  // ─────────────────────────────────────────────
  const seen = new Set();
  const deduped = hydrated.filter(h => {
    const id = h.item?.id;
    if (!id) return true; // keep weird edge cases
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  // logStep('ANN DEDUPED HITS',
  //   deduped.slice(0, 5).map(h => ({
  //     romaji: h.item?.romaji,
  //     meaning: h.item?.meanings?.[0],
  //     score: h.score,
  //     semantic: h.semanticScore
  //   }))
  // );
  return deduped;
}

/**
 * Checks if any of the query's content tokens (romaji) are present in the
 * meanings strings of the hit.
 * @param {Object} item
 * @param {string[]} contentTokens
 * @returns {number} 1 if match found, 0 otherwise
 */
function getContentOverlap(item, contentTokens) {
  if (!contentTokens || contentTokens.length === 0) return 0;
  const meanings = (item.meanings ?? []).join(' ').toLowerCase();
  const romaji   = (item.romaji   ?? '').toLowerCase();
  const kana     = (item.kana     ?? '').toLowerCase();

  for (const tok of contentTokens) {
    const ltok = tok.toLowerCase();
    // Match in meanings (semantic overlap) OR in romaji/kana (literal overlap)
    if (meanings.includes(ltok) || romaji === ltok || kana === ltok) return 1;
  }
  return 0;
}


// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

const ENG_TO_JP_TEMPLATE = (input, glossaryStr = '') => `\
TASK: Translate the following English medical input into one formal clinical Japanese sentence.

RULES:
- Silently correct grammar and fill in implied meaning.
- Use natural, formal clinical Japanese.
- Add readings in parentheses (ふりがな) only for rare or difficult kanji.
- Output ONLY the Japanese sentence — no labels, no explanation, no English.

EXAMPLES:
Input: patient chest pain
Output: 患者は胸痛（きょうつう）を訴えています。

Input: no allergy
Output: 既知のアレルギーはありません。

Input: tumour small no spread
Output: 腫瘍（しゅよう）は小さく、転移（てんい）は認められません。

Input: high fever three days
Output: 3日間の高熱が続いています。

Input: leg stiff wednesday taking prescription
Output: 水曜日から処方された薬を服用しており、足がこわばっています。

Input: ${input}
Output: /no_think`;

const JP_TO_ENG_TEMPLATE = (input, glossaryStr = '', toneStr = '') => `\
TASK:
Translate the following Japanese (romaji) dialogue into natural English.

You are an interpreter. The speaker may be a Japanese patient describing symptoms or a doctor asking screening questions.

RULES:
- Use FIRST PERSON ("I", "my", "I feel") when the speaker is a patient. 
- Use natural medical questioning ("Have you...", "Do you fee...") when the speaker is a doctor.
- Translate faithfully. Do NOT add information that is not present.
- If input is unnatural or fragmented, reconstruct into natural English meaning using standard Japanese grammar.
- CLINICAL PRIORITY: If a term is ambiguous, prioritize the most clinical or medical interpretation (e.g., "gein" as "cause", not "performance").
- Output ONLY the English sentence — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no allergies.

Input: zutsu hidoisugite ugokenai
Output: My headache is so bad I can't move.

${glossaryStr}${toneStr}

Input: ${input}
Output: /no_think`;

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Parse the input prefix, preprocess the content, and build the prompt.
 * @param {string} rawInput - e.g. "ENG: patient chest pain"
 * @returns {{ direction: string, prompt: string, timings: Object }}
 * @throws {Error} if the prefix is missing or unrecognised.
 */
export async function buildPrompt(rawInput) {
  logStep('RAW INPUT', rawInput);
  const tTotalStart = performance.now();
  const timings = {};

  let direction        = '';
  let templateFn       = null;
  let preprocessedInput = '';
  let tokenTrace        = [];

  if (/^ENG:/i.test(rawInput)) {
    const input = rawInput.replace(/^ENG:\s*/i, '').trim().toLowerCase();
    preprocessedInput = preprocessEng(input);
    direction  = 'ENG→JP';
    templateFn = ENG_TO_JP_TEMPLATE;

  } else if (/^JAP:/i.test(rawInput)) {
    const input = rawInput.replace(/^JAP:\s*/i, '').trim().toLowerCase();;
    
    const tPre0 = performance.now();
    const traced  = preprocessJapTrace(input);
    timings.preprocess = performance.now() - tPre0;
    preprocessedInput = traced.output;
    tokenTrace        = traced.tokens;
    direction  = 'JAP→ENG';
    templateFn = JP_TO_ENG_TEMPLATE;
  } else {
    throw new Error('Unknown prefix. Use "ENG: <text>" or "JAP: <text>".');
  }

  logStep('PREPROCESS OUTPUT', preprocessedInput);

  const cleanedTrace = tokenTrace
    .filter(t => !isLogNoiseToken(t))
    .map(t => {
      const top = t.meta?.candidates?.[0];
      return {
        input: t.input,
        output: t.output,
        decision: t.decision,
        topCandidate: top && {
          item: top.item,
          root: top.root,
          type: top.type,
          score: top.adjustedScore,
          distance: top.distance,
          freq: top.freqScore,
          meaning: top.meaning,
          breakdown: top.breakdown,
        },
        alternatives: t.meta?.candidates?.slice(1, 3).map(c => ({
          item: c.item,
          root: c.root,
          meaning: c.meaning,
          type: c.type,
          score: c.adjustedScore
        }))
      };
    });
  
  logStep('TOKEN TRACE SUMMARY', cleanedTrace);
  logStep('DIRECTION DETECTED', { direction, rawInput });


  // ─────────────────────────────────────────────
  // RAG Pipeline (ANN → SQLite hydration)
  // ─────────────────────────────────────────────

  // POS tags that are purely grammatical / non-medical — strip from RAG embedding query.
  // We keep: n (noun), vs (verbal noun), vt/vi (transitive/intransitive verb), v1/v2/v5 (verb groups),
  //          adj-i, adj-na, adj-pn, adj-no (all adjective types).
  // We strip: particles, conjunctions, copulas, auxiliaries, adverbs (discourse-level, not clinical),
  //           pronouns, interjections, suffixes, prefixes, classifiers.

  /**
   * Filter a list of romaji content tokens to keep only those whose
   * PRIMARY sense in the vocabulary is a content word (noun, verb, adjective).
   * Uses the open SQLite connection — O(1) per token, negligible latency.
   *
   * Strategy: if ALL pos tags for a token's best-matching DB row are grammatical,
   * drop it. If the token isn't in the DB at all, keep it (unknown = possibly medical).
   */
  function filterContentTokensByPos(tokens) {
    if (!db) return tokens;
    const stmt = db.prepare(
      'SELECT pos FROM vocab WHERE romaji = ? ORDER BY freq DESC LIMIT 1'
    );
    return tokens.filter(tok => {
      const row = stmt.get(tok);
      if (!row || !row.pos) return true; 
      const allPos = row.pos.split(',').map(p => p.trim());
      return allPos.some(p => !GRAM_POS.has(p));
    });
  }

  /**
   * Deduplicate RAG hits that share the same primary meaning.
   * Prevents "but / however / although" burning all 3 glossary slots.
   * Also deduplicates by romaji to avoid near-identical entries.
   */
  function deduplicateHits(hits) {
    const seenMeanings = new Set();
    const seenIds = new Set();
    return hits.filter(({ item }) => {
      if (seenIds.has(item.id)) return false;
      const primaryMeaning = (item.meanings?.[0] ?? '').toLowerCase().trim();
      if (primaryMeaning && seenMeanings.has(primaryMeaning)) return false;
      seenIds.add(item.id);
      if (primaryMeaning) seenMeanings.add(primaryMeaning);
      return true;
    });
  }

  let glossaryStr = '';
  let toneStr     = '';
  let ragHits     = [];     
  let toneHits    = [];     
  let finalContentTokens = [];
  const tAnnStart = performance.now();
  const ready = await ensureANN();
  timings.ensureANN = performance.now() - tAnnStart;

  if (ready && preprocessedInput.length > 0) {
    // ── 1. Build query tokens from top candidates ──────────────────────────
    // Instead of using the preprocessor's single (potentially wrong) winner,
    // we extract the top candidates' romaji from each token. This gives the
    // embedding model the actual dictionary entries being considered.
    let medQueryText = preprocessedInput;
    if (direction === 'JAP→ENG' && tokenTrace.length > 0) {
      
      const trackedTokens = [];
      const seenRomaji = new Set();
      for (let idx = 0; idx < tokenTrace.length; idx++) {
        const t = tokenTrace[idx];
        if (t.decision === 'particle' || t.decision?.startsWith('skipped') || t.output.length <= 1) continue;
        if (t.decision?.startsWith('passthrough') && !t.meta?.candidates?.length) continue;

        const winner = t.meta?.candidates?.[0];
        if (!winner) continue;

        const isHighConfidence = 
          winner.type === 'exact' ||
          winner.type === 'normalized' ||
          winner.type?.startsWith('deinflect') ||
          (winner.tags?.includes('spec1') || winner.tags?.includes('news1')) ||
          (winner.adjustedScore || 0) > 900; // Raised from 900 for non-medical

        if (!isHighConfidence) continue;

        const r = (winner.root || winner.item || '').toLowerCase();
        if (r.length <= 1) continue;
        seenRomaji.add(r);

        // Check clinical relevance
        const row = db.prepare("SELECT domain, tags FROM vocab WHERE romaji = ? ORDER BY freq DESC LIMIT 1").get(r);
        let priority = 3;
        if (row) {
          if (isMedicalDomain(row.domain)) priority = 1;
          else priority = 2;
        }
        trackedTokens.push({ romaji: r, priority, originalIndex: idx });
      }

      // ── RAG ANCHOR FALLBACK ──────────────────────────────────────
      // If the sentence is entirely fuzzy/low-confidence, we have no "winners"
      // to anchor the search. A search with 0 tokens is "blind" and returns noise.
      // Fallback: Use the first 5 non-particle tokens even if they are low-confidence.
      if (trackedTokens.length === 0) {
        for (let idx = 0; idx < Math.min(tokenTrace.length, 12); idx++) {
          const t = tokenTrace[idx];
          if (t.decision === 'particle' || t.decision?.startsWith('skip') || t.output.length <= 1) continue;
          
          const r = (t.output || '').toLowerCase();
          if (r.length <= 1) continue;
          
          trackedTokens.push({ romaji: r, priority: 3, originalIndex: idx });
          if (trackedTokens.length >= 5) break; 
        }
      }

      // Sort by clinical priority, then original position
      trackedTokens.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.originalIndex - b.originalIndex;
      });

      // POS filter and take top 10
      const contentTokens = filterContentTokensByPos(trackedTokens.map(c => c.romaji));
      finalContentTokens = contentTokens.slice(0, 10);

      // ── EMBEDDING SPACE FIX ──────────────────────────────────────
      // Instead of embedding bare romaji ("kokain kiraku nando"),
      // look up each token's combined_text from vocab.db.
      // combined_text was the EXACT string used to generate the dictionary embeddings,
      // e.g. "kokain 古加涅 (コカイン) type: noun meanings: cocaine"
      // This puts the query and dictionary entries in the SAME embedding space.
      const combinedTexts = [];
      const seenExpansion = new Set();

      const combinedStmt = db.prepare(`
        SELECT romaji, combined_text, domain, tags, freq, primary_meaning, common_words
        FROM vocab
        WHERE romaji = ?
      `);
      const CANDIDATES_TO_FETCH = 2;

      for (const t of tokenTrace) {
        if (!t.meta?.candidates?.length) continue;

        // Skip junk tokens (same logic as before)
        if (
          t.decision === 'particle' ||
          t.decision?.startsWith('skip') ||
          (t.output || '').length <= 1
        ) continue;

        // 👉 Take TOP 3 CANDIDATES (not DB senses)

        const topCandidates = [...t.meta.candidates].slice(0, CANDIDATES_TO_FETCH);

        const tokenExpansions = [];


        for (const cand of topCandidates) {
          const romaji = (cand.root || cand.item || '').toLowerCase();
          if (!romaji) continue;

          const row = combinedStmt.get(romaji);
          if (!row) continue;

          const text = row.combined_text;

          if (!seenExpansion.has(text)) {
            seenExpansion.add(text);
            combinedTexts.push(text);
          }
          
          tokenExpansions.push({
            romaji,
            meaning: row.primary_meaning,
            score: cand.adjustedScore,
            type: cand.type,
            decision: t.decision,
            root: cand.root ?? null,
            item: cand.item,
          });
        }
        // logStep(`EXPANSION: ${t.input}`, tokenExpansions);
      }

      logStep('EMBED QUERY EXPANSION', {
        tokens: finalContentTokens,
        expandedCount: combinedTexts.length,
        preview: combinedTexts.slice(0, 10)
      });
      if (combinedTexts.length > 0) medQueryText = combinedTexts.join(' | ');
      logStep('FINAL MEDQUERY STRING', medQueryText);
    }

    const tEmbedStart = performance.now();
    // ── 2. Run both embedding queries in parallel ──────────────────────────
    //    Medical: POS-filtered nouns/adjectives  → clinical glossary hints
    //    Tone:    full preprocessed sentence     → speech pattern context
    //    Both calls happen simultaneously — no added latency vs a single call.
    const [medEmbed, toneEmbed] = await Promise.all([
      getSentenceEmbedding(medQueryText),
      direction === 'JAP→ENG'
        ? getSentenceEmbedding(preprocessedInput)
        : Promise.resolve(null),        // ENG→JP: tone pass not needed
    ]);
    const tEmbedEnd = performance.now();
    timings.embedding = tEmbedEnd - tEmbedStart;

    // ── 3. Medical glossary hits ───────────────────────────────────────────
    if (medEmbed) {
      const anchorSet = new Set(finalContentTokens);
      const tSearchStart = performance.now();
      // Retrieve 20 neighbors — focused depth, less noise than previous 50
      const rawMed = ragSearch(medEmbed, 10, anchorSet);
      const tSearchEnd = performance.now();
      timings.ragSearch = tSearchEnd - tSearchStart;
      console.log(`\n\x1b[90m[Perf] RAG total: ${(tSearchEnd - tEmbedStart).toFixed(2)}ms (Embed: ${(tEmbedEnd - tEmbedStart).toFixed(2)}ms, Search: ${(tSearchEnd - tSearchStart).toFixed(2)}ms)\x1b[0m`);

      // --- HYBRID STEP: Extract direct dictionary medical hits from trace ---
      const directMedHits = [];
      const seenIds = new Set();
      const seenMeanings = new Set(); // Fixed: Restore initialization
      tokenTrace.forEach(t => {
        if (t.meta && t.meta.candidates) {
          t.meta.candidates
            .filter(c => c.distance === 0 || c.adjustedScore < 15) // keep your existing logic
            .forEach(c => {
              const row = db.prepare(`
                SELECT id, romaji, primary_meaning, secondary_meanings, domain 
                FROM vocab 
                WHERE romaji = ? 
                ORDER BY freq DESC 
                LIMIT 1
              `).get(c.item);
              if (row && isMedicalDomain(row.domain)) {
                // ✅ KEY FIX: dedupe by ID (fallback safe)
                const key = row.id ?? `${row.romaji}::${row.primary_meaning}`;
                if (seenIds.has(key)) return;
                seenIds.add(key);
                directMedHits.push({
                  score: 1.0,
                  semanticScore: 1.0,
                  item: {
                    id: row.id ?? null,
                    romaji: row.romaji,
                    domain: row.domain,
                    source: 'dictionary',
                    meanings: [
                      row.primary_meaning,
                      ...(row.secondary_meanings
                        ? row.secondary_meanings.split(', ')
                        : [])
                    ]
                  }
                });
              }
            });
        }
      });
      
      // Combine direct hits (priority) with RAG hits
      const combined = [...directMedHits, ...rawMed];
      // logStep('COMBINED HITS (pre-filter)', combined.slice(0, 3).map(h => ({
      //   romaji: h.item.romaji,
      //   score: h.score,
      //   semantic: h.semanticScore,
      //   domain: h.item.domain
      // })));

      const seenAllIds = new Set();

      const dedupCombined = combined.filter(h => {
        const id = h.item?.id ?? `${h.item?.romaji}::${h.item?.meanings?.[0]}`;
        if (seenAllIds.has(id)) return false;
        seenAllIds.add(id);
        return true;
      });

      const filterLog = [];
      
      const filteredMed = dedupCombined
        .filter(h => {
          const domainRaw = h.item.domain;
          const isClinical = isMedicalDomain(domainRaw);
          const overlap = finalContentTokens.length > 0
            ? getContentOverlap(h.item, finalContentTokens)
            : 0;
          const primaryMeaning = (h.item.meanings?.[0] ?? '').toLowerCase();
          const isDirect   = directMedHits.includes(h);
          const isCommon   = h.item.tags && h.item.tags.some(t => /nf0[1-3]/.test(t));

          let keep = false;
          let reason = '';

          if (isDirect) {
            keep = true;
            reason = 'DIRECT_HIT';
          } else if (isClinical) {
            keep = h.semanticScore >= 0.40;
            reason = keep ? 'CLINICAL_PASS' : 'CLINICAL_FAIL';
          } else if (isCommon && h.semanticScore < 0.90) {
            keep = false;
            reason = 'COMMON_LOW_SCORE_BLOCK';
          } else {
            keep = (
              h.semanticScore >= 0.92 ||
              (h.semanticScore >= 0.85 && overlap > 0)
            );
            reason = keep ? 'SEMANTIC_PASS' : 'SEMANTIC_FAIL';
          }

          filterLog.push({
            romaji: h.item.romaji,
            semantic: h.semanticScore,
            overlap,
            domain: domainRaw,
            keep,
            reason
          });
          return keep;
        })
        .filter(({ item }) => {
          const primary = (item.meanings?.[0] ?? '').toLowerCase().trim();
          if (!primary) return true;
          if (seenMeanings.has(primary)) return false;
          seenMeanings.add(primary);
          return true;
        })
        .sort((a, b) => b.score - a.score);
 

      const dedupMed = filteredMed.slice(0, 5);
      logStep('FILTER SUMMARY', {
        total: filterLog.length,
        kept: filterLog.filter(f => f.keep).length,
        dropped: filterLog.filter(f => !f.keep).length,
        byReason: Object.entries(
          filterLog.reduce((acc, f) => {
            acc[f.reason] = (acc[f.reason] || 0) + 1;
            return acc;
          }, {})
        ).map(([reason, count]) => ({ reason, count })),
        preview: filterLog.slice(0, 3) // optional
      });
      ragHits = dedupMed;

      if (dedupMed.length > 0) {
        const lines = dedupMed.map(({ item }) => {
          const reading = item.romaji;
          const meanings = (item.meanings ?? []).slice(0, 2).join(', ');
          return `- ${reading}: ${meanings}`;
        });
        glossaryStr = `\n\nMEDICAL GLOSSARY HINTS:\n${lines.join('\n')}`;
      }
    }

    if (toneEmbed) {
      const medRomaji  = new Set(ragHits.map(h => h.item.romaji));
      const rawTone    = ragSearch(toneEmbed, 9);
      
      const uniqueTone = rawTone
        .filter(h => !medRomaji.has(h.item.romaji))
        .filter(h => h.semanticScore >= 0.70); // Ensure minimal relevance for tone cues

      const dedupTone = deduplicateHits(uniqueTone).slice(0, 1);
      toneHits = dedupTone;

      if (dedupTone.length > 0) {
        const { item } = dedupTone[0];
        const term    = item.kanji || item.romaji;
        const reading = item.kanji ? `${item.kana} / ${item.romaji}` : item.romaji;
        const meanings = (item.meanings ?? []).slice(0, 3).join(', ');
        toneStr = `\n\nTONE HINT:\n- ${item.romaji}: ${(item.meanings ?? [])[0] ?? ''}`;
      }
    }
    // ── 6. Semantic Vector Reranking ──────────
    if (medEmbed) {
      const tRerankStart = performance.now();
      const reranked = rerankTrace(tokenTrace, medEmbed, getIndex(), 15);
      timings.rerank = performance.now() - tRerankStart;
      preprocessedInput = reranked.output;
      tokenTrace        = reranked.tokens;
    }
  }

  const tPromptBuild = performance.now();
  const prompt = direction === 'JAP→ENG'
    ? templateFn(preprocessedInput, glossaryStr, toneStr)
    : templateFn(preprocessedInput, glossaryStr);
  timings.promptAssembly = performance.now() - tPromptBuild;
  timings.total = performance.now() - tTotalStart;
  
  return { direction, prompt, preprocessedInput, ragHits, toneHits, tokenTrace, queryTokens: finalContentTokens, timings };
}
