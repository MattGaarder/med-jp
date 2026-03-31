import { vocabIndex } from './src/preprocessor.js';

const medicalVocab = vocabIndex.filter(v => v.type === 'medical').map(v => v.romaji);
const suffixRegex = /(?:masu|mashita|masen|mashou|desu|teiru|teimasu|nakatta|nakute|nai|tai|kute|rareru|saseru|sugiru)$/;

const conflicts = medicalVocab.filter(w => suffixRegex.test(w));
console.log('Medical words ending in common suffixes:', conflicts);
