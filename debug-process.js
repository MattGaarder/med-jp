import { createPreprocessor, vocabIndex } from './src/preprocessor.js';
import fs from 'fs';

const vocabClean = JSON.parse(fs.readFileSync('./data/vocab-clean.json', 'utf8'));
const medicalVocab = vocabClean
  .filter(e => e.type === 'medical')
  .map(e => ({ romaji: e.romaji, freq: e.freq }));
const corrections = new Map([['ahsi', 'ashi']]); // dummy
const allRomaji = new Set(vocabClean.map(e => e.romaji));
// we don't need all common conjugations, just what processClause uses to test.
allRomaji.add('desu');
allRomaji.add('kaidan');
allRomaji.add('kara');

const pp = createPreprocessor({
  vocabulary: medicalVocab,
  corrections: corrections,
  knownWords: allRomaji
});

console.log("=== Testing 'ochite' ===");
const out = pp.preprocessJap("kaidan kara ochite, ashi wo dashimashita. hareteimasu.");
console.log("Output Sent to LLM:", out);
