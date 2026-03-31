import { vocabIndex } from './src/preprocessor.js';

const medicalMap = new Map();
for (const entry of vocabIndex) {
  if (entry.type === 'medical') {
    medicalMap.set(entry.romaji, entry.en);
  }
}

console.log('ochiru:', medicalMap.get('ochiru'));
console.log('dashu:', medicalMap.get('dashu'));
console.log('dasu:', medicalMap.get('dasu'));
console.log('hareru:', medicalMap.get('hareru'));

