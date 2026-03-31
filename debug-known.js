import { vocabIndex, getRoots } from './src/preprocessor.js';

const knownWords = new Set(vocabIndex.map(e => e.romaji));

console.log('ochite roots:', getRoots('ochite'));
console.log('Is ochiru in knownWords?', knownWords.has('ochiru'));

console.log('hareteimasu roots:', getRoots('hareteimasu'));
console.log('Is hareru in knownWords?', knownWords.has('hareru'));

