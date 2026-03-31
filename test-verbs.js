import { createPreprocessor } from './src/preprocessor.js';
import { readFileSync } from 'fs';

const vocabClean = JSON.parse(readFileSync('./data/vocab-clean.json'));
const medicalVocab = vocabClean.filter(e => e.type === 'medical').map(e => ({ romaji: e.romaji, freq: e.freq }));
const allRomaji = new Set(vocabClean.map(e => e.romaji));

const preprocessor = createPreprocessor({
  vocabulary: medicalVocab,
  knownWords: allRomaji
});

const testWords = ['tabenai', 'tabemasu', 'taberarenai', 'nomimasen', 'ugokenai', 'nemurenai', 'kaeritai', 'naite', 'taoresou'];
console.log('--- Testing Conjugated Verbs ---');
for (const w of testWords) {
  const result = preprocessor.preprocessJap(w);
  console.log(`${w} -> ${result} ${w !== result ? '(MODIFIED!)' : '(SAFE)'}`);
}
