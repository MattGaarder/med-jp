import { getRoots, vocabIndex } from './src/preprocessor.js';

const knownWords = new Set(vocabIndex.map(e => e.romaji));

console.log('ochite roots:', getRoots('ochite'));
const roots = getRoots('ochite');
for (let r of roots) {
  console.log(`knownWords.has('${r}'): ${knownWords.has(r)}`);
}

console.log('taishita roots:', getRoots('taishita'));
console.log('dashimashita roots:', getRoots('dashimashita'));
