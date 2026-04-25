import { createPreprocessor } from './src/preprocessor.js';
import Database      from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DB_PATH    = join(__dirname, 'data', 'vocab.db');

const db = new Database(DB_PATH, { readonly: true });
const allEntries = db.prepare('SELECT romaji, pos, tags, freq FROM vocab').all();
const knownWords = new Map();

for (const entry of allEntries) {
  const norm = entry.romaji.toLowerCase();
  let data = knownWords.get(norm);
  if (!data) {
    data = { pos: [], tagsSet: new Set(), freq: 0 };
    knownWords.set(norm, data);
  }
  if (entry.pos) data.pos.push(entry.pos);
  if (entry.tags) {
    entry.tags.split(',').forEach(t => data.tagsSet.add(t.trim()));
  }
  data.freq = Math.max(data.freq, entry.freq || 0);
}

for (const [norm, data] of knownWords.entries()) {
  data.tags = Array.from(data.tagsSet).join(', ');
}

const candidates = db.prepare(`
  SELECT romaji FROM vocab 
  WHERE domain IS NOT NULL OR freq > 0.1
`).all();

const pre = createPreprocessor({
  vocabulary: candidates,
  knownWords
});

const res = pre.preprocessJapWithTrace("konichi");
console.log(JSON.stringify(res, null, 2));

const res2 = pre.preprocessJapWithTrace("konnichi");
console.log(JSON.stringify(res2, null, 2));
