#!/usr/bin/env node
/**
 * scripts/parse-jmdict.js
 *
 * One-time data cleaning script. Parses a JMDict XML file and produces
 * a clean, pre-processed JSON vocabulary file for the interpreter.
 *
 * OUTPUT FORMAT:
 *   [
 *     { "romaji": "zutsuu",  "en": "headache", "type": "medical", "freq": 1 },
 *     { "romaji": "gakkou",  "en": "school",   "type": "general", "freq": 2 },
 *     ...
 *   ]
 *
 * freq score: 1 = very common (ichi1/news1/spec1/nf01-08)
 *             2 = moderately common
 *             3 = infrequent
 *             4 = rare or untagged
 * Run this ONCE. The output file is loaded at runtime by the preprocessor.
 * No XML parsing or WanaKana conversion happens during interpreter use.
 *
 * USAGE:
 *   node scripts/parse-jmdict.js [input.xml] [output.json] [options]
 *
 *   Defaults:
 *     input  → data/JMdict_b.xml
 *     output → data/vocab-clean.json
 *
 * OPTIONS:
 *   --min-len <n>   Minimum romaji token length to include (default: 2)
 *   --max-len <n>   Maximum romaji token length to include (default: 30)
 *
 * EXAMPLES:
 *   node scripts/parse-jmdict.js
 *   node scripts/parse-jmdict.js data/JMdict_b.xml data/vocab-clean.json
 *   node scripts/parse-jmdict.js data/JMdict_b.xml data/vocab-clean.json --min-len 3
 */

import { createReadStream, writeFileSync } from 'fs';
import { createInterface }                 from 'readline';
import { resolve }                         from 'path';
import * as wanakana                       from 'wanakana';

// ─────────────────────────────────────────────────────────────────
// CLI args
// ─────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags      = process.argv.slice(2).filter(a => a.startsWith('--'));
const inputFile  = args[0] ?? 'data/JMdict_b.xml';
const outputFile = args[1] ?? 'data/vocab-clean.json';
const minLen     = parseInt(process.argv[process.argv.indexOf('--min-len')  + 1] ?? '2')  || 2;
const maxLen     = parseInt(process.argv[process.argv.indexOf('--max-len')  + 1] ?? '30') || 30;

// ─────────────────────────────────────────────────────────────────
// Medical keyword list — used to assign type: "medical" | "general"
// ─────────────────────────────────────────────────────────────────

const MEDICAL_KEYWORDS = new Set([
  'pain','ache','aching','sore','hurt','headache','stomachache',
  'fever','nausea','vomit','vomiting','diarrhea','diarrhoea','constipation',
  'symptom','symptoms','disease','illness','disorder','condition','syndrome',
  'injury','wound','fracture','inflammation','infection','abscess',
  'cancer','tumour','tumor','carcinoma','metastasis','malignant','benign',
  'surgery','operation','transplant','graft','implant','resection','incision',
  'medication','medicine','drug','prescription','dosage','dose','tablet',
  'injection','intravenous','subcutaneous','anesthesia','anaesthesia',
  'treatment','therapy','diagnosis','prognosis','examination','checkup',
  'test','scan','x-ray','mri','ct','ultrasound','biopsy','endoscopy',
  'hospital','clinic','ward','emergency','icu','intensive','outpatient',
  'patient','doctor','physician','nurse','surgeon','specialist',
  'organ','heart','lung','liver','kidney','stomach','intestine','colon',
  'bowel','bladder','pancreas','spleen','thyroid','adrenal','ovary','uterus',
  'brain','nerve','spinal','muscle','bone','joint','tendon','ligament',
  'artery','vein','vessel','blood','plasma','lymph','marrow',
  'blood pressure','pulse','respiration','breathing','breath',
  'cough','sneeze','wheeze','phlegm','mucus','discharge','bleed','bleeding',
  'swelling','bruise','rash','ulcer','sore','lesion','abscess',
  'allergy','allergic','asthma','diabetes','hypertension','pneumonia',
  'stroke','paralysis','numbness','tingling','tremor','seizure','convulsion',
  'dizzy','dizziness','faint','unconscious','coma',
  'dead','death','deceased','die','passed away','terminal','palliative',
  'mental','psychiatric','anxiety','depression','psychosis','suicidal',
  'fracture','sprain','dislocation','rupture','tear','contusion',
  'transplant','dialysis','chemotherapy','radiotherapy','immunotherapy',
  'vaccine','vaccination','antibiotic','antiviral','analgesic','sedative',
]);

function isMedical(glosses) {
  const combined = glosses.join(' ').toLowerCase();
  for (const kw of MEDICAL_KEYWORDS) {
    if (combined.includes(kw)) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────
// Frequency scoring — converts re_pri tags to a numeric weight.
// Lower = more common = preferred during Fuse reranking.
// ─────────────────────────────────────────────────────────────────

/**
 * Convert an array of JMDict re_pri tags to a frequency score (1–4).
 *   1 = very common  (ichi1, news1, spec1, nf01–nf08)
 *   2 = common       (ichi2, news2, spec2, nf09–nf24)
 *   3 = infrequent   (nf25–nf48)
 *   4 = rare/unrated (no priority tags)
 * @param {string[]} pris
 * @returns {number}
 */
function priToFreq(pris) {
  if (pris.length === 0) return 4;
  let best = 4;
  for (const p of pris) {
    if (p === 'ichi1' || p === 'news1' || p === 'spec1') { best = Math.min(best, 1); continue; }
    if (p === 'ichi2' || p === 'news2' || p === 'spec2') { best = Math.min(best, 2); continue; }
    const nf = p.match(/^nf(\d+)$/);
    if (nf) {
      const n = parseInt(nf[1]);
      if (n <= 8)  { best = Math.min(best, 1); continue; }
      if (n <= 24) { best = Math.min(best, 2); continue; }
      best = Math.min(best, 3);
    }
  }
  return best;
}

// ─────────────────────────────────────────────────────────────────
// WanaKana helpers
// ─────────────────────────────────────────────────────────────────

const KANA_RE = /^[\u3040-\u30ff\u31f0-\u31ff\uff65-\uff9f]+$/;

function kanaToRomaji(reading) {
  try {
    if (!KANA_RE.test(reading)) return null;         // skip mixed/latin
    const romaji = wanakana.toRomaji(reading).toLowerCase().trim();
    if (/[^a-z\s']/.test(romaji)) return null;      // dashes, dots, etc. → skip
    if (romaji.length < minLen || romaji.length > maxLen) return null;
    return romaji;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Manual overrides — medical homophones where JMDict picks the
// wrong sense first (e.g. 全速 "full speed" vs 喘息 "asthma")
// Format: romaji → { en, type }
// ─────────────────────────────────────────────────────────────────

const OVERRIDES = new Map([
  // freq=1 so overrides are always treated as maximally common
  ['zensoku',    { en: 'asthma',              type: 'medical', freq: 1 }],
  ['ishoku',     { en: 'transplant',           type: 'medical', freq: 1 }],
  ['ashi',       { en: 'leg / foot',           type: 'medical', freq: 1 }],
  ['netsu',      { en: 'fever',                type: 'medical', freq: 1 }],
  ['ki',         { en: 'spirit / energy',      type: 'general', freq: 1 }],
  ['hana',       { en: 'nose / flower',        type: 'general', freq: 1 }],
  ['me',         { en: 'eye',                  type: 'medical', freq: 1 }],
  ['ha',         { en: 'tooth',                type: 'medical', freq: 1 }],
  ['kuchi',      { en: 'mouth',                type: 'medical', freq: 1 }],
  ['mimi',       { en: 'ear',                  type: 'medical', freq: 1 }],
  ['kata',       { en: 'shoulder',             type: 'medical', freq: 1 }],
  ['koshi',      { en: 'lower back / waist',   type: 'medical', freq: 1 }],
  ['hiji',       { en: 'elbow',                type: 'medical', freq: 1 }],
  ['hiza',       { en: 'knee',                 type: 'medical', freq: 1 }],
  ['mune',       { en: 'chest',                type: 'medical', freq: 1 }],
  ['nodo',       { en: 'throat',               type: 'medical', freq: 1 }],
  ['atama',      { en: 'head',                 type: 'medical', freq: 1 }],
  ['onaka',      { en: 'stomach / abdomen',    type: 'medical', freq: 1 }],
  ['senaka',     { en: 'back (body)',           type: 'medical', freq: 1 }],
]);

// ─────────────────────────────────────────────────────────────────
// Parser — stream line-by-line, build an in-memory Map
// ─────────────────────────────────────────────────────────────────
//
// Map<romaji, { en: string, type: 'medical'|'general' }>
//
// Dedup strategy: if a romaji is seen again with type "medical" and
// current stored type is "general", upgrade to medical.
// Otherwise, keep the first (most common) English gloss.
//

const vocab = new Map();

let currentRebs   = [];   // array of { reading: string, pris: string[] }
let currentGloss  = [];
let totalEntries  = 0;
let skipped       = 0;

// Track which reb is currently being parsed (for attaching re_pri tags)
let _currentReb   = null;

function flushEntry() {
  totalEntries++;

  if (currentRebs.length === 0 || currentGloss.length === 0) {
    skipped++;
    currentRebs  = [];
    currentGloss = [];
    _currentReb  = null;
    return;
  }

  const type = isMedical(currentGloss) ? 'medical' : 'general';
  const en   = currentGloss[0];

  for (const { reading, pris } of currentRebs) {
    const romaji = kanaToRomaji(reading);
    if (!romaji) continue;

    // Manual overrides always win
    if (OVERRIDES.has(romaji)) {
      vocab.set(romaji, OVERRIDES.get(romaji));
      continue;
    }

    const freq = priToFreq(pris);

    if (!vocab.has(romaji)) {
      vocab.set(romaji, { en, type, freq });
    } else {
      const existing = vocab.get(romaji);
      // Prefer the entry with better (lower) frequency score
      if (freq < existing.freq) {
        vocab.set(romaji, { en, type, freq });
      } else if (freq === existing.freq && type === 'medical' && existing.type === 'general') {
        // Same frequency but medical classification is more useful
        vocab.set(romaji, { en, type: 'medical', freq });
      }
    }
  }

  currentRebs  = [];
  currentGloss = [];
  _currentReb  = null;
}

// ─────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────

const absInput = resolve(inputFile);
console.error(`📖  Input  : ${absInput}`);
console.error(`📦  Output : ${resolve(outputFile)}`);
console.error(`📐  Length : ${minLen}–${maxLen} chars`);
console.error(`⏳  Parsing...\n`);

const rl = createInterface({
  input: createReadStream(absInput, { encoding: 'utf-8' }),
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  const t = line.trim();

  if (t === '</entry>') { flushEntry(); return; }

  // <r_ele> opens a new reading element — reset reb tracking
  if (t === '<r_ele>') { _currentReb = null; return; }

  // <reb>ほうせい</reb>
  const rebMatch = t.match(/^<reb[^>]*>(.*?)<\/reb>/);
  if (rebMatch) {
    _currentReb = { reading: rebMatch[1], pris: [] };
    currentRebs.push(_currentReb);
    return;
  }

  // <re_pri>ichi1</re_pri> — attach to the most recently seen reb
  const priMatch = t.match(/^<re_pri>(.*?)<\/re_pri>/);
  if (priMatch && _currentReb) {
    _currentReb.pris.push(priMatch[1]);
    return;
  }

  // <gloss> — exclude non-English entries
  const gloss = t.match(/^<gloss(?![^>]*xml:lang)(?:[^>]*)>(.*?)<\/gloss>/);
  if (gloss) { currentGloss.push(gloss[1]); return; }
});

rl.on('close', () => {
  // Build sorted output array — sort by romaji, secondarily by freq
  const result = [...vocab.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([romaji, { en, type, freq }]) => ({ romaji, en, type, freq }));

  writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf-8');

  const medical  = result.filter(r => r.type === 'medical').length;
  const general  = result.length - medical;
  const freq1    = result.filter(r => r.freq === 1).length;
  const freq4    = result.filter(r => r.freq === 4).length;

  console.error(`✅  Done`);
  console.error(`   Entries processed : ${totalEntries.toLocaleString()}`);
  console.error(`   Entries skipped   : ${skipped.toLocaleString()} (no reading or gloss)`);
  console.error(`   Unique romaji     : ${result.length.toLocaleString()}`);
  console.error(`     → medical       : ${medical.toLocaleString()}`);
  console.error(`     → general       : ${general.toLocaleString()}`);
  console.error(`     → freq 1 (common): ${freq1.toLocaleString()}`);
  console.error(`     → freq 4 (rare)  : ${freq4.toLocaleString()}`);
  console.error(`   Written to        : ${resolve(outputFile)}`);
});

rl.on('error', (err) => {
  console.error(`❌  Error: ${err.message}`);
  process.exit(1);
});
