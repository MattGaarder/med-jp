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
import { preprocessJap, preprocessJapWithTrace, preprocessEng, CONTENT_DECISIONS } from './preprocessor.js';
import { loadIndex, searchANN } from './load-index.js';
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
    const id  = item.entryId ?? item.id;
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
  'dentistry', 'genetics', 'orthopaedics', 'psychiatry', 'surgery', 
  'pathology', 'biology', 'embryology', 'psychiatry', 'psychology',
  'med', 'anat', 'pharm', 'dent', 'surg', 'pathol', 'physiol',
  'biochem', 'biol', 'embryo', 'psy',
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

NOW TRANSLATE:${glossaryStr}
Input: ${input}
Output: /no_think`;

const JP_TO_ENG_TEMPLATE = (input, glossaryStr = '', toneStr = '', grammarStr = '', verbStr = '') => `\
TASK: Translate the following Japanese romaji into natural English. The speaker is a Japanese patient or person talking directly. You are their voice.

RULES:
- Translate LITERALLY and EXACTLY — do not summarise, do not infer diagnosis.
- ALWAYS write in the FIRST PERSON: "I have...", "I feel...", "I can't...", "Hello, I..."
- NEVER use third-person: NEVER write "The patient...", "They report...", "The speaker..."
- Handle ALL language — greetings, everyday phrases, and medical symptoms equally.
- CRITICAL: The input Japanese may be highly fragmented, ungrammatical, or missing particles (e.g. "tsukare ga kanji" => "I feel tired"). Reconstruct the natural meaning using standard Japanese grammar.
- Correct romaji misspellings silently (e.g. "zutsu" → headache, "atmaa" → atama = head).
- If unclear, translate conservatively. NEVER invent medical symptoms, medications, or meanings that are not explicitly present in the input. If a word looks like a symptom but doesn't make sense in context, treat it as general speech.
- Output ONLY the English translation — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no known allergies.

Input: zutsuu hidoi
Output: My headache is really bad.

Input: ahsi ga zutsuu de atama mo itai
Output: My leg hurts and my head hurts too.

Input: zutsuu ga hidoi sugite ugokenai
Output: My headache is so bad I can't move.

Input: konnichiwa genki sou de naniyori desu ne
Output: Hello, you look well, I'm glad to see that.

Input: shinbun wo yondari miru koto shuuchuu dekimasen
Output: I can't concentrate when reading the newspaper or watching things.

Input: hiza wo mageyou to suru toki ni kowabari wo kanjimasu ka
Output: Do you feel stiffness when you try to bend your knee?

Input: hayai dankai de mitsukatta
Output: It was found at an early stage.

NOW TRANSLATE:${grammarStr}${verbStr}${glossaryStr}${toneStr}
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
  const ready = await ensureANN();

  if (ready && preprocessedInput.length > 0) {
    // ── 1. Build POS-filtered medical token query ──────────────────────────
    let medQueryText = preprocessedInput;
    let finalContentTokens = [];
    if (direction === 'JAP→ENG' && tokenTrace.length > 0) {
      // Step A: Initial pass to score each token by clinical relevance
      const trackedTokens = tokenTrace
        .filter(t => (CONTENT_DECISIONS.has(t.decision) || t.decision.startsWith('deinflect:')) && t.output.length > 1)
        .map((t, idx) => {
          const romaji = t.decision.startsWith('deinflect:') ? t.decision.split(':')[1] : t.output;
          // Sub-query: Does this token have a medical domain?
          const row = db.prepare("SELECT domain, tags FROM vocab WHERE romaji = ? ORDER BY freq DESC LIMIT 1").get(romaji);
          let priority = 3; // Default: low
          
          // Specific non-medical common word blacklist
          const BLACKLIST = new Set(['sensei', 'shonichi', 'genki', 'aru', 'koto', 'demo', 'to', 'go', 'kyou', 'ima', 'yokunaru', 'naru', 'taberu', 'omoimasu', 'omou', 'omoidasu']);

          if (row && !BLACKLIST.has(romaji)) {
            if (row.domain && MEDICAL_DOMAINS.has(row.domain)) priority = 1; // High: Specialist term
            else if (row.tags && (row.tags.includes('spec1') || row.tags.includes('spec2'))) priority = 1;
            else priority = 2; // Medium: Regular content word (noun/verb/adj)
          }
          return { romaji, priority, originalIndex: idx };
        });

      // Step B: Sort by Priority 1-3, then by original position
      trackedTokens.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.originalIndex - b.originalIndex;
      });

      // Step C: POS filter and take top 10
      const contentTokens = filterContentTokensByPos(trackedTokens.map(c => c.romaji));
      finalContentTokens = contentTokens.slice(0, 10);
      
      console.log(`\x1b[90m[RAG] Priority-sorted query tokens: [${finalContentTokens.join(', ')}]\x1b[0m`);
      if (finalContentTokens.length > 0) medQueryText = finalContentTokens.join(' ');
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
      const rawMed = ragSearch(medEmbed, medQueryText, 12, anchorSet); // Over-search for diversification

      // P2.1 & P2.2 — Thresholding & Meaning-Based Diversity
      const seenMeanings = new Set();
      const filteredMed = rawMed
        .filter(h => {
          const isClinical = h.item.domain && MEDICAL_DOMAINS.has(h.item.domain);
          const overlap = finalContentTokens.length > 0 ? getContentOverlap(h.item, finalContentTokens) : 0;
          
          // Lower thresholds to ensure common symptoms like "memai" make the cut
          if (isClinical) return h.semanticScore >= 0.65; 
          return h.semanticScore >= 0.75 && overlap > 0;
        })
        .filter(({ item }) => {
          // Meaning Diversification: If we already have a hit for this primary core meaning, skip.
          // Maps "medicine", "medication", "pill" to common stem for pruning
          const primary = (item.meanings?.[0] ?? '').toLowerCase().trim();
          if (!primary) return true;
          
          // Simple stem matching for common overlaps
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

      const dedupMed = filteredMed.slice(0, 3);
      ragHits = dedupMed;

      if (dedupMed.length > 0) {
        const lines = dedupMed.map(({ item }) => {
          const term    = item.kanji ? item.kanji : item.romaji;
          const reading = item.kanji ? `${item.kana} / ${item.romaji}` : item.romaji;
          const meanings = (item.meanings ?? []).slice(0, 4).join(', ');
          const domain  = item.domain ? ` [${item.domain}]` : '';
          const pos     = item.pos && item.pos.length > 0 ? item.pos.join(', ') : 'none';
          const tags    = item.tags && item.tags.length > 0 ? item.tags.join(', ') : 'none';
          return `- term: ${term}${domain}\n  reading: ${reading}\n  meaning: ${meanings}\n  type: ${pos}\n  tags: ${tags}`;
        });
        glossaryStr = `\n\nMEDICAL GLOSSARY HINTS:\n${lines.join('\n\n')}`;
      }
    }

    // ── 4. Grammatical Structure & Key Verbs (P1.1, P1.2) ──────────────────
    let grammarLines = [];
    let verbLines    = [];

    if (direction === 'JAP→ENG' && tokenTrace.length > 0) {
      // Collect grammar annotations
      const seenParticles = new Set();
      for (const tok of tokenTrace) {
        if (tok.decision === 'skipped (too short)' && PARTICLE_GLOSS[tok.input]) {
          if (!seenParticles.has(tok.input)) {
            grammarLines.push(`- ${tok.input}: ${PARTICLE_GLOSS[tok.input]}`);
            seenParticles.add(tok.input);
          }
        }
      }

      // Collect verb roots
      // Collect verb roots — romaji = ? and pos LIKE 'v%'
      const stmt = db.prepare("SELECT primary_meaning FROM vocab WHERE romaji = ? AND pos LIKE 'v%' LIMIT 1");

      const seenVerbs = new Set();
      for (const tok of tokenTrace) {
        if (tok.decision && tok.decision.startsWith('conjugation:')) {
          const root = tok.decision.split(':')[1];
          if (!seenVerbs.has(root)) {
            const row = stmt.get(root);
            if (row) {
              verbLines.push(`- ${tok.input} → dictionary form: ${root} (${row.primary_meaning})`);
              seenVerbs.add(root);
            }
          }
        }
      }
    }

    grammarStr = grammarLines.length > 0 ? `\n\nGRAMMATICAL PARTICLES DETECTED:\n${grammarLines.join('\n')}` : '';
    verbStr    = verbLines.length    > 0 ? `\n\nKEY VERBS DETECTED (root forms for reference):\n${verbLines.join('\n')}` : '';

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
        toneStr = `\n\nSPEECH PATTERN CONTEXT (pragmatic cue — use to capture tone, not as a term to translate):\n` +
          `- pattern: ${term}  (${reading})\n  nuance: ${meanings}`;
      }
    }
  }

  const prompt = direction === 'JAP→ENG'
    ? templateFn(preprocessedInput, glossaryStr, toneStr, grammarStr, verbStr)
    : templateFn(preprocessedInput, glossaryStr);
  return { direction, prompt, preprocessedInput, ragHits, toneHits, tokenTrace };
}
