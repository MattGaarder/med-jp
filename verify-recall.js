import { createPreprocessor } from './src/preprocessor.js';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const DB_PATH = join(__dirname, 'data', 'vocab.db');

const db = new Database(DB_PATH, { readonly: true });
const allEntries = db.prepare('SELECT id, romaji, pos, tags, freq, primary_meaning, domain, mesh_annotations, mesh_domains, common_words FROM vocab').all();
const knownWords = new Map();

for (const entry of allEntries) {
  const norm = entry.romaji.toLowerCase();
  let entries = knownWords.get(norm);
  if (!entries) {
    entries = [];
    knownWords.set(norm, entries);
  }
  entries.push({
    id: entry.id,
    pos: entry.pos ? [entry.pos] : [],
    tags: entry.tags || '',
    freq: entry.freq || 0,
    meaning: entry.primary_meaning || '',
    domain: entry.domain || null,
    commonWords: entry.common_words || null
  });
}

const candidates = db.prepare('SELECT romaji FROM vocab WHERE domain IS NOT NULL OR freq > 0.1').all();
const preprocessor = createPreprocessor({ vocabulary: candidates, exactMatchIndex: knownWords });

const result = preprocessor.preprocessJapWithTrace("hisa");
console.log(JSON.stringify(result, null, 2));
