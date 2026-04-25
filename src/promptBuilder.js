/**
 * promptBuilder.js
 * Constructs direction-specific prompts from raw prefixed input.
 * Applies preprocessing and adds /no_think directive for Qwen3.
 *
 * Supported prefixes:
 *   ENG:  → Translate broken English to formal clinical Japanese
 *   JAP:  → Translate broken Japanese / romaji to professional English
 */

import path from 'path';
import { fileURLToPath } from 'url';
import { preprocessJap, preprocessJapWithTrace, preprocessEng, CONTENT_DECISIONS, rerankTrace } from './preprocessor.js';
import wanakana from 'wanakana';
import { loadIndex, searchANN, getIndex } from './load-index.js';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────────────────────────
// RAG: HNSW ANN Index + SQLite Lookup (Lazy Singleton)
// ─────────────────────────────────────────────

const DB_PATH  = path.join(__dirname, '../data/vocab.db');

let db         = null;   // better-sqlite3 connection
let annReady   = false;  // HNSW index loaded flag
let annInitPromise = null;

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

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBED_MODEL = 'qwen3-embedding:latest';

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
function ragSearch(embedding, queryText, topK = 9, anchorTokens = new Set()) {
  const annHits = searchANN(queryText, embedding, topK, anchorTokens);
  const stmt = db.prepare(
    'SELECT romaji, kanji, kana, domain, pos, tags, freq, primary_meaning, secondary_meanings ' +
    'FROM vocab WHERE id = ?'
  );

  return annHits.map(({ score, semanticScore, item }) => {
    const id  = item?.entryId ?? item?.id;
    if (!id) return { score, semanticScore, item };
    
    const row = stmt.get(id);
    if (!row) return { score, semanticScore, item };

    return {
      score,
      semanticScore,
      item: {
        romaji:      row.romaji,
        kana:        row.kana              ?? '',
        kanji:       row.kanji             ?? '',
        meanings:    [row.primary_meaning, ...(row.secondary_meanings ? row.secondary_meanings.split(', ') : [])],
        tags:        row.tags ? row.tags.split(', ') : [],
        domain:      row.domain            ?? null,
        source:      'semantic',
        pos:         row.pos ? row.pos.split(', ') : [],
        frequency:   row.freq              ?? 0.1,
      }
    };
  });
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
// Grammatical Particle Gloss (Commonly skipped tokens)
// ─────────────────────────────────────────────

const PARTICLE_GLOSS = {
  'ha': 'marks the topic of the sentence',
  'ga': 'marks the grammatical subject',
  'no': 'indicates possessive or relationship (of)',
  'ni': 'marks target, location, time, or indirect object',
  'wo': 'marks the direct object of the verb',
  'he': 'marks destination or direction (to)',
  'mo': 'means also or too',
  'to': 'means and / with, or marks a quotation',
  'de': 'marks location of action, or means (by way of)',
};

// JMdict specialist domain tags — expanded to full English words in v3 schema.
const MEDICAL_DOMAINS = new Set([
  'medicine', 'anatomy', 'pharmacology', 'physiology', 'biochemistry', 
  'dentistry', 'genetics', 'orthopaedics', 'psychiatric', 'psychiatry', 'surgery', 
  'pathology', 'biology', 'embryology', 'psychology', 'psychoanalysis',
  'veterinary', 'ent', 'ophthalmology', 'dermatology', 'gastroenterology', 'melaena', 'stool',
  'med', 'anat', 'pharm', 'dent', 'surg', 'pathol', 'physiol',
  'biochem', 'biol', 'embryo', 'psy',
]);

// Negative keywords for medical hints — terms often confused with medical ones
// but carrying non-clinical meanings.
const NON_CLINICAL_SENSES = new Set([
  'officer', 'military', 'army', 'performance', 'entertainment', 'acting', 
  'drama', 'comedy', 'show', 'game', 'play', 'manufacturing', 'trade', 
  'factory', 'construction', 'building', 'company', 'corporation',
  'intuition', 'carefree', 'disastrous', 'miserable', 'public', 'entertainer'
]);


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
 * @returns {{ direction: string, prompt: string }}
 * @throws {Error} if the prefix is missing or unrecognised.
 */
export async function buildPrompt(rawInput) {
  const trimmed = rawInput.trim();

  let direction        = '';
  let templateFn       = null;
  let preprocessedInput = '';
  let tokenTrace        = [];   // structured token decisions — for eval + RAG query

  if (/^ENG:/i.test(trimmed)) {
    const raw = trimmed.replace(/^ENG:\s*/i, '').trim();
    preprocessedInput = preprocessEng(raw);
    direction  = 'ENG→JP';
    templateFn = ENG_TO_JP_TEMPLATE;
  } else if (/^JAP:/i.test(trimmed)) {
    const raw = trimmed.replace(/^JAP:\s*/i, '').trim();
    // Use the structured trace variant: same corrections, also returns per-token decisions
    const traced  = preprocessJapWithTrace(raw);
    preprocessedInput = traced.output;
    tokenTrace        = traced.tokens;
    direction  = 'JAP→ENG';
    templateFn = JP_TO_ENG_TEMPLATE;
  } else {
    throw new Error('Unknown prefix. Use "ENG: <text>" or "JAP: <text>".');
  }

  // ─────────────────────────────────────────────
  // RAG Pipeline (ANN → SQLite hydration)
  // ─────────────────────────────────────────────

  // POS tags that are purely grammatical / non-medical — strip from RAG embedding query.
  // We keep: n (noun), vs (verbal noun), vt/vi (transitive/intransitive verb), v1/v2/v5 (verb groups),
  //          adj-i, adj-na, adj-pn, adj-no (all adjective types).
  // We strip: particles, conjunctions, copulas, auxiliaries, adverbs (discourse-level, not clinical),
  //           pronouns, interjections, suffixes, prefixes, classifiers.
  const GRAM_POS = new Set([
    'prt','conj','cop','cop-da','aux','aux-v','aux-adj',
    'int','exp',
    'adv','adv-to',           // adverbs: "a little", "continuously" — not medical glossary words
    'pn',                     // pronouns: itsu (when?), kore (this)
    'n-suf','n-pref',         // suffixes/prefixes used as grammatical morphemes
    'ctr',                    // counter words
  ]);

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
    // pos column is a CSV string: 'n, vs, vt'. We check the first token.
    const stmt = db.prepare(
      'SELECT pos FROM vocab WHERE romaji = ? ORDER BY freq DESC LIMIT 1'
    );
    return tokens.filter(tok => {
      const row = stmt.get(tok);
      if (!row || !row.pos) return true; 
      const primaryPos = row.pos.split(',')[0].trim();
      return !GRAM_POS.has(primaryPos);
    });
  }

  /**
   * Deduplicate RAG hits that share the same primary meaning.
   * Prevents "but / however / although" burning all 3 glossary slots.
   * Also deduplicates by romaji to avoid near-identical entries.
   */
  function deduplicateHits(hits) {
    const seenMeanings = new Set();
    const seenRomaji   = new Set();
    return hits.filter(({ item }) => {
      if (seenRomaji.has(item.romaji)) return false;
      const primaryMeaning = (item.meanings?.[0] ?? '').toLowerCase().trim();
      if (primaryMeaning && seenMeanings.has(primaryMeaning)) return false;
      seenRomaji.add(item.romaji);
      if (primaryMeaning) seenMeanings.add(primaryMeaning);
      return true;
    });
  }

  let glossaryStr = '';
  let toneStr     = '';
  let grammarStr  = '';
  let verbStr     = '';
  let ragHits     = [];     // medical hits — exposed for eval
  let toneHits    = [];     // tone/sentiment hits — exposed for eval
  let deepContextHits = []; // deep semantic hits for reranking
  let finalContentTokens = [];
  const ready = await ensureANN();

  if (ready && preprocessedInput.length > 0) {
    // ── 1. Build query tokens from top candidates ──────────────────────────
    // Instead of using the preprocessor's single (potentially wrong) winner,
    // we extract the top candidates' romaji from each token. This gives the
    // embedding model the actual dictionary entries being considered.
    let medQueryText = preprocessedInput;
    if (direction === 'JAP→ENG' && tokenTrace.length > 0) {
      const BLACKLIST = new Set([
        'sensei', 'shonichi', 'genki', 'aru', 'koto', 'demo', 'to', 'go', 'kyou', 'ima',
        'yokunaru', 'naru', 'taberu', 'omoimasu', 'omou', 'omoidasu',
        'nai', 'kara', 'desu', 'masu', 'da', 'suru',
        'nado', 'toki', 'sou', 'shite', 'jaa', 'mama', 'nara',
        'kore', 'sore', 'are', 'dore', 'kono', 'sono', 'ano', 'dono',
        'nani', 'nan', 'ichi', 'ni', 'san', 'yon', 'go', 'roku', 'nana', 'hachi', 'kyuu', 'juu'
      ]);

      // Prepared statement for combined_text lookup (matches the embedding format)
      const combinedStmt = db.prepare(
        "SELECT combined_text FROM vocab WHERE romaji = ? ORDER BY freq DESC LIMIT 1"
      );

      const seenRomaji = new Set();  // Deduplicate across all tokens
      const trackedTokens = [];

      for (let idx = 0; idx < tokenTrace.length; idx++) {
        const t = tokenTrace[idx];
        if (t.decision === 'particle' || t.decision?.startsWith('skipped') || t.output.length <= 1) continue;
        if (t.decision?.startsWith('passthrough') && !t.meta?.candidates?.length) continue;

        // ── QUERY POLLUTION FIX ──────────────────────────────────────
        // Only use the WINNER, not runner-ups.
        // Including losing candidates (like "kokkai" when the winner is "kokain")
        // dilutes the query embedding with noise, creating a feedback loop where
        // wrong words reinforce themselves.
        //
        // Additionally, only include HIGH-CONFIDENCE winners:
        //   - exact matches (base 1000+)
        //   - deinflections (base 900+)
        //   - fuzzy matches only if score > 900 (very close match)
        // This prevents fuzzy hallucinations from polluting the query.
        const winner = t.meta?.candidates?.[0];
        if (!winner) continue;

        const isHighConfidence = 
          winner.type === 'exact' ||
          winner.type === 'normalized' ||
          winner.type?.startsWith('deinflect') ||
          (winner.adjustedScore || 0) > 900;

        if (!isHighConfidence) continue;

        const r = (winner.root || winner.item || '').toLowerCase();
        if (r.length <= 1 || BLACKLIST.has(r) || seenRomaji.has(r)) continue;
        seenRomaji.add(r);

        // Check clinical relevance
        const row = db.prepare("SELECT domain, tags FROM vocab WHERE romaji = ? ORDER BY freq DESC LIMIT 1").get(r);
        let priority = 3;
        if (row) {
          if (row.domain && MEDICAL_DOMAINS.has(row.domain)) priority = 1;
          else if (row.tags && (row.tags.includes('spec1') || row.tags.includes('spec2'))) priority = 1;
          else priority = 2;
        }
        trackedTokens.push({ romaji: r, priority, originalIndex: idx });
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
      for (const tok of finalContentTokens) {
        const row = combinedStmt.get(tok);
        if (row?.combined_text) {
          combinedTexts.push(row.combined_text);
        } else {
          combinedTexts.push(tok); // fallback to bare romaji if no DB entry
        }
      }

      console.log(`\x1b[90m[RAG] Query tokens (winners only): [${finalContentTokens.join(', ')}]\x1b[0m`);
      if (combinedTexts.length > 0) medQueryText = combinedTexts.join(' | ');
    }

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

    // ── 3. Medical glossary hits ───────────────────────────────────────────
    // Anchor tokens: the exact romaji the user typed (after POS filter).
    // Any HNSW hit whose romaji matches an anchor gets +0.25 in the reranker,
    // ensuring memai is always retrieved when the user said memai.
    if (medEmbed) {
      const anchorSet = new Set(finalContentTokens);
      // Retrieve 20 neighbors — focused depth, less noise than previous 50
      const rawMed = ragSearch(medEmbed, medQueryText, 20, anchorSet);

      // --- HYBRID STEP: Extract direct dictionary medical hits from trace ---
      const directMedHits = [];
      const seenRomaji = new Set();
      const seenMeanings = new Set(); // Fixed: Restore initialization

      tokenTrace.forEach(t => {
        // If the preprocessor already found medical candidates, harvest them.
        if (t.meta && t.meta.candidates) {
          t.meta.candidates
            .filter(c => c.distance === 0 || c.adjustedScore < 15) // High confidence
            .forEach(c => {
               // Sub-lookup for domain info (since it's not in candidate object yet)
               const row = db.prepare("SELECT romaji, primary_meaning, secondary_meanings, domain FROM vocab WHERE romaji = ? ORDER BY freq DESC LIMIT 1").get(c.item);
               if (row && row.domain && MEDICAL_DOMAINS.has(row.domain) && !seenRomaji.has(row.romaji)) {
                 seenRomaji.add(row.romaji);
                 directMedHits.push({
                   score: 1.0, semanticScore: 1.0,
                   item: {
                     romaji: row.romaji,
                     source: 'dictionary',
                     meanings: [row.primary_meaning, ...(row.secondary_meanings ? row.secondary_meanings.split(', ') : [])]
                   }
                 });
               }
            });
        }
      });

      // Combine direct hits (priority) with RAG hits
      const combined = [...directMedHits, ...rawMed];
      const filteredMed = combined
        .filter(h => {
          if (directMedHits.includes(h)) return true; // Keep all direct hits
          
          const domain = h.item.domain ? h.item.domain.toLowerCase().split(',')[0].trim() : null;
          const isClinical = domain && MEDICAL_DOMAINS.has(domain);
          const overlap = finalContentTokens.length > 0 ? getContentOverlap(h.item, finalContentTokens) : 0;
          
          // RELEVANCE GATE: Check for non-clinical senses in meanings
          const primaryMeaning = (h.item.meanings?.[0] ?? '').toLowerCase();
          const containsNonClinical = [...NON_CLINICAL_SENSES].some(sense => primaryMeaning.includes(sense));
          
          if (isClinical) {
            // Reward clinical domain heavily
            return h.semanticScore >= 0.40; 
          }
          
          // For non-clinical domain items:
          if (containsNonClinical) return false; // Strictly exclude "Commanding Officer" or "Public Entertainment"
          
          const isCommon = h.item.tags && h.item.tags.some(t => /nf0[1-3]/.test(t));
          if (isCommon && h.semanticScore < 0.90) return false; // Don't let common dictionary noise through as a hint

          return h.semanticScore >= 0.92 || (h.semanticScore >= 0.85 && overlap > 0);
        })
        .filter(({ item }) => {
          const primary = (item.meanings?.[0] ?? '').toLowerCase().trim();
          if (!primary) return true;
          const stems = ['medicin', 'medicatt', 'pill', 'prescript', 'drug', 'pharmacy', 'hospital', 'treatment'];
          const foundStem = stems.find(s => primary.includes(s));
          if (foundStem) {
            if (seenMeanings.has(foundStem)) return false;
            seenMeanings.add(foundStem);
          } else {
            if (seenMeanings.has(primary)) return false;
            seenMeanings.add(primary);
          }
          return true;
        })
        .sort((a, b) => b.score - a.score);

      const dedupMed = filteredMed.slice(0, 5);
      ragHits = dedupMed;
      deepContextHits = dedupMed;  // Use filtered hits for reranking, not noisy raw results

      if (dedupMed.length > 0) {
        const lines = dedupMed.map(({ item }) => {
          const reading = item.romaji;
          const meanings = (item.meanings ?? []).slice(0, 2).join(', ');
          return `- ${reading}: ${meanings}`;
        });
        glossaryStr = `\n\nMEDICAL GLOSSARY HINTS:\n${lines.join('\n')}`;
      }
    }

    // ── 4. Grammar & Morphological Hints ──────────────────────────────────
    // REMOVED: The LLM already understands Japanese grammar natively.
    // Injecting grammar/tense annotations was actively misleading the model
    // (e.g., たって as "no matter how" when it's 立って, こと as "should").
    // Grammar tags remain in the token trace for evaluation reporting only.

    // ── 5. Tone / pragmatic context ── single top-1 hit from full-sentence query
    // Captures hedging, urgency, or uncertainty cues orthogonal to medical vocab.
    // Labelled differently so the LLM knows it is context, not a term to translate.
    if (toneEmbed) {
      const medRomaji  = new Set(ragHits.map(h => h.item.romaji));
      const rawTone    = ragSearch(toneEmbed, preprocessedInput, 9);
      
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
      const reranked = rerankTrace(tokenTrace, medEmbed, getIndex(), 15);
      preprocessedInput = reranked.output;
      tokenTrace        = reranked.tokens;
    }
  }

  const prompt = direction === 'JAP→ENG'
    ? templateFn(preprocessedInput, glossaryStr, toneStr)
    : templateFn(preprocessedInput, glossaryStr);
  return { direction, prompt, preprocessedInput, ragHits, toneHits, tokenTrace, queryTokens: finalContentTokens };
}
