
import { createPreprocessor } from '../src/preprocessor.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, '..', 'data', 'vocab.db');

const db = new Database(DB_PATH);

// Load some vocab to test
const vocabulary = db.prepare('SELECT id, romaji, primary_meaning as meaning, pos, tags, common_words, domain, mesh_domains FROM vocab LIMIT 50000').all().map(v => ({
    ...v,
    pos: v.pos ? v.pos.split(',').map(t => t.trim()) : [],
    commonWords: v.common_words,
    meshDomains: v.mesh_domains ? JSON.parse(v.mesh_domains) : []
}));

const knownWords = new Map();
for (const v of vocabulary) {
    if (!knownWords.has(v.romaji)) knownWords.set(v.romaji, []);
    knownWords.get(v.romaji).push(v);
}

const preprocessor = createPreprocessor({ vocabulary, exactMatchIndex: knownWords });

const testInputs = [
    'kitdukaremashitaka',
    'ogoitemasuka'
];

for (const input of testInputs) {
    console.log(`\nTesting: ${input}`);
    const result = preprocessor.preprocessJapWithTrace(input);
    // Trace is printed to console by preprocessJapWithTrace
}
