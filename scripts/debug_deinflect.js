import * as wanakana from 'wanakana';
import Database from 'better-sqlite3';
import Fuse from 'fuse.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { deinflect, WordType } from '../src/deinflect.js';
import { calculateCandidateScore } from '../src/config/linguistics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'vocab.db');
const db = new Database(DB_PATH, { readonly: true });

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

function toRomajiSafe(hiragana) {
  try { return wanakana.toRomaji(hiragana); } catch { return hiragana; }
}

const allEntries = db.prepare('SELECT id, romaji, pos, tags, freq, primary_meaning, domain, common_words FROM vocab').all();
const exactMatchIndex = new Map();
const vocabulary = [];
for (const entry of allEntries) {
  const norm = entry.romaji.toLowerCase();
  let entries = exactMatchIndex.get(norm);
  if (!entries) { entries = []; exactMatchIndex.set(norm, entries); }
  const obj = {
    id: entry.id, pos: entry.pos ? [entry.pos] : [], tags: entry.tags || '',
    freq: entry.freq || 0, romaji: entry.romaji, meaning: entry.primary_meaning || '',
    domain: entry.domain || null, commonWords: entry.common_words || null,
  };
  entries.push(obj);
  vocabulary.push(obj);
}

const FUSE_OPTIONS = {
  includeScore: true, threshold: 0.3, distance: 50,
  minMatchCharLength: 2, shouldSort: true,
};
const romajiList = vocabulary.map(v => v.romaji);
const fuse = new Fuse(romajiList, FUSE_OPTIONS);

// --- Simulate detectStrongVerbMatch with FIXED deinfType ---
const testWords = ['taberarenakatta', 'taberarenakute'];

for (const rawChunk of testWords) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Simulating detectStrongVerbMatch("${rawChunk}") [FIXED]`);
  console.log(`${'='.repeat(60)}\n`);

  const variants = new Map([[rawChunk, { isOriginal: true }]]);

  for (const [variant, vMeta] of variants.entries()) {
    const hira = wanakana.toHiragana(variant);
    const deinfResults = deinflect(hira);
    
    let candidates = [];
    
    for (const c of deinfResults) {
      const rootRomaji = toRomajiSafe(c.word);
      let stemMatches = [];
      
      const exactStemEntries = exactMatchIndex.get(rootRomaji);
      if (exactStemEntries) {
        stemMatches = exactStemEntries.map(e => ({
          entry: e, type: 'deinflect', dist: 0  // FIXED: was 'verb_gate'
        }));
      } else if (rootRomaji.length >= 2 && c.reasonChains.length > 0) {
        const fuzzyRoots = fuse.search(rootRomaji).slice(0, 15);
        for (const f of fuzzyRoots) {
          const fEntries = exactMatchIndex.get(f.item);
          if (fEntries) {
            stemMatches.push(...fEntries.map(e => ({
              entry: e, type: 'deinflect:fuzzy_stem', dist: f.score  // FIXED
            })));
          }
        }
      }
      
      for (const { entry: wordData, type: mType, dist } of stemMatches) {
        const posMask = mapPosToVerbClass(wordData.pos);
        const isMatch = (posMask & c.type) !== 0;
        if (!isMatch) continue;
        
        const steps = (c.reasonChains?.[0]?.length) || 1;
        const totalDist = 0.02 + (steps * 0.02) + (dist * 0.5);
        
        const scoreObj = calculateCandidateScore(wordData, {
          type: mType, distance: totalDist, inputLen: variant.length,
          matchLen: rootRomaji.length, isOriginal: vMeta.isOriginal || false
        });

        candidates.push({
          id: wordData.id, root: wordData.romaji, item: variant,
          type: mType, adjustedScore: scoreObj.total, meaning: wordData.meaning,
          meta: {
            reasons: c.reasonChains, type: c.type, ruleWeight: c.ruleWeight || 1.0,
            grammar: {
              isValidClassMatch: true, ruleWeight: c.ruleWeight || 1.0,
              steps, fuzzyStemDistance: dist, stemExists: true
            }
          }
        });
      }
    }
    
    if (!candidates.length) { console.log(`  NO candidates!`); continue; }
    
    const sorted = candidates.sort((a, b) => b.adjustedScore - a.adjustedScore);
    const winner = sorted[0];
    
    console.log(`Top 5 candidates:`);
    sorted.slice(0, 5).forEach((c, i) => {
      console.log(`  ${i+1}. id=${c.id} root="${c.root}" score=${c.adjustedScore.toFixed(2)} steps=${c.meta.grammar.steps} fuzzyDist=${c.meta.grammar.fuzzyStemDistance.toFixed(3)} "${c.meaning}"`);
    });
    
    const grammar = winner.meta.grammar;
    const isStrong =
      grammar.isValidClassMatch &&
      grammar.ruleWeight >= 0.8 &&
      grammar.steps <= 3 &&
      grammar.fuzzyStemDistance <= 0.12;
    
    console.log(`\n  GATE CHECK:`);
    console.log(`    steps=${grammar.steps} (<=3? ${grammar.steps <= 3})`);
    console.log(`    ruleWeight=${grammar.ruleWeight} (>=0.8? ${grammar.ruleWeight >= 0.8})`);
    console.log(`    fuzzyStemDist=${grammar.fuzzyStemDistance} (<=0.12? ${grammar.fuzzyStemDistance <= 0.12})`);
    console.log(`    => isStrong: ${isStrong}`);
    console.log(isStrong 
      ? `\n  ✅ VERB GATE TRIGGERS: "${rawChunk}" -> "${winner.root}"`
      : `\n  ❌ VERB GATE WOULD NOT TRIGGER`);
  }
}
