/**
 * scripts/build-sqlite.js  (v2 — new schema)
 *
 * Migrates data/vocab-enhanced.jsonl → data/vocab.db (SQLite)
 *
 * New schema vs v2:
 *   romaji        TEXT   — Renamed from term
 *   kanji         TEXT   — Extracted directly
 *   secondary_meanings TEXT - meanings.slice(1) CSV
 *   pos           TEXT   — All pos tags CSV
 *   domain        TEXT   — <field> tags CSV
 *   tags          TEXT   — Priority tags CSV (renamed from priority)
 *   freq          REAL   — Renamed from frequency
 *
 * Architecture contract (unchanged):
 *   - entryId from JSONL preserved exactly as id (HNSW-stable)
 *   - Embeddings never stored here
 *   - Batched inserts inside single transaction per BATCH_SIZE rows
 *   - File streamed line-by-line — no full load into RAM
 */

import fs       from 'fs';
import path     from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Paths ────────────────────────────────────────────────────────────────────

const JSONL_PATH = path.join(__dirname, '../data/vocab-v3.jsonl');
const DB_PATH    = path.join(__dirname, '../data/vocab.db');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const GREEN  = (s) => `\x1b[32m${s}\x1b[0m`;
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`;
const RED    = (s) => `\x1b[31m${s}\x1b[0m`;
const CYAN   = (s) => `\x1b[36m${s}\x1b[0m`;

const LOG_INTERVAL = 10_000;

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {

  // ── 1. Drop existing DB and start fresh ────────────────────────────────────
  //    (schema changed — INSERT OR IGNORE on the old table would miss new columns)

  if (fs.existsSync(DB_PATH)) {
    console.log(YELLOW(`[DB] Removing existing database at ${DB_PATH}`));
    fs.unlinkSync(DB_PATH);
  }

  console.log(CYAN(`[DB] Creating SQLite database at ${DB_PATH}`));
  const db = new Database(DB_PATH);

  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size   = -65536'); // 64 MB page cache — speeds up bulk insert

  db.exec(`
    CREATE TABLE vocab (
      id                 INTEGER PRIMARY KEY,
      romaji             TEXT NOT NULL,
      kanji              TEXT,
      kana               TEXT,
      primary_meaning    TEXT,
      secondary_meanings TEXT,
      pos                TEXT,
      domain             TEXT,
      tags               TEXT,
      freq               REAL DEFAULT 0.1,
      combined_text      TEXT,
      metadata           TEXT
    );
  `);

  console.log(CYAN('[DB] Schema v3 created.'));

  // ── 3. Prepared insert ─────────────────────────────────────────────────────

  const insert = db.prepare(`
    INSERT INTO vocab
      (id, romaji, kanji, kana, primary_meaning, secondary_meanings, 
       pos, domain, tags, freq, combined_text, metadata)
    VALUES
      (@id, @romaji, @kanji, @kana, @primary_meaning, @secondary_meanings,
       @pos, @domain, @tags, @freq, @combined_text, @metadata)
  `);

  // ── 4. Stream JSONL ────────────────────────────────────────────────────────

  if (!fs.existsSync(JSONL_PATH)) {
    console.error(RED(`[ERROR] Input file not found: ${JSONL_PATH}`));
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: fs.createReadStream(JSONL_PATH),
    crlfDelay: Infinity,
  });

  let lineNumber    = 0;
  let totalParsed   = 0;
  let totalInserted = 0;
  let totalSkipped  = 0;
  let domainCount   = 0; // rows with a non-null domain tag

  const BATCH_SIZE = 1000;
  let batch = [];

  const flushBatch = db.transaction((rows) => {
    for (const row of rows) insert.run(row);
    return rows.length;
  });

  const t0 = Date.now();

  for await (const line of rl) {
    lineNumber++;
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (err) {
      console.warn(YELLOW(`[SKIP] Line ${lineNumber}: malformed JSON — ${err.message}`));
      totalSkipped++;
      continue;
    }

    if (obj.entryId === undefined || obj.entryId === null) {
      totalSkipped++;
      continue;
    }
    if (!obj.romaji) {
      totalSkipped++;
      continue;
    }

    totalParsed++;

    // ── Field extraction ──────────────────────────────────────────────────────

    const {
      entryId,
      romaji,
      combinedText,
      domain,
      tags,        // Unified tags array (fields, misc, priority)
      embedding,   // discarded — already in HNSW
      kana,
      meanings,
      pos,
      frequency,
      ...rest      // kanji, etc
    } = obj;

    if (domain) domainCount++;

    const primary_meaning = Array.isArray(meanings) && meanings.length > 0
      ? meanings[0]
      : null;

    const secondary_meanings = Array.isArray(meanings) && meanings.length > 1
      ? meanings.slice(1).join(', ')
      : null;

    batch.push({
      id:                 entryId,
      romaji:             romaji,
      kanji:              obj.kanji || null,
      kana:               kana || null,
      primary_meaning,
      secondary_meanings,
      pos:                Array.isArray(pos) ? pos.join(', ') : null,
      domain:             domain || null,
      tags:               Array.isArray(tags) ? tags.join(', ') : null,
      freq:               frequency ?? 0.1,
      combined_text:      combinedText ?? null,
      metadata:           JSON.stringify({ ...rest, kana, meanings, pos, tags }),
    });

    if (batch.length >= BATCH_SIZE) {
      totalInserted += flushBatch(batch);
      batch = [];

      if (totalInserted % LOG_INTERVAL < BATCH_SIZE) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        process.stdout.write(
          `\r[Progress] ${totalInserted.toLocaleString()} rows | ${elapsed}s`
        );
      }
    }
  }

  if (batch.length > 0) {
    totalInserted += flushBatch(batch);
    batch = [];
  }

  process.stdout.write('\n');

  // ── 5. Indexes ─────────────────────────────────────────────────────────────

  console.log(CYAN('\n[DB] Building indexes…'));
  db.exec(`CREATE INDEX idx_romaji   ON vocab(romaji);`);
  db.exec(`CREATE INDEX idx_domain   ON vocab(domain);`);
  db.exec(`CREATE INDEX idx_freq     ON vocab(freq);`);
  console.log(CYAN('[DB] Indexes created: idx_romaji, idx_domain, idx_freq'));

  // ── 6. Validation ──────────────────────────────────────────────────────────

  const { count: dbCount }    = db.prepare('SELECT COUNT(*) AS count FROM vocab').get();
  const { count: domCount }   = db.prepare('SELECT COUNT(*) AS count FROM vocab WHERE domain IS NOT NULL').get();
  const { count: medCount }   = db.prepare(`SELECT COUNT(*) AS count FROM vocab WHERE domain IN ('medicine','anatomy','pharmacology','physiology','biochemistry','dentistry','genetics','orthopaedics','psychiatry','surgery','pathology','biology','embryology','psychiatry','psychology')`).get();

  const { count: topFreqCount } = db.prepare(`SELECT COUNT(*) AS count FROM vocab WHERE freq > 0.5`).get();

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n' + CYAN('─'.repeat(56)));
  console.log(CYAN('  Validation'));
  console.log(CYAN('─'.repeat(56)));
  console.log(`  JSONL lines parsed           : ${totalParsed.toLocaleString()}`);
  console.log(`  Rows inserted into SQLite    : ${totalInserted.toLocaleString()}`);
  console.log(`  Total rows in DB (COUNT(*))  : ${dbCount.toLocaleString()}`);
  console.log(`  Rows with a domain tag       : ${domCount.toLocaleString()}`);
  console.log(`  Clinical domain rows (RAG↑)  : ${medCount.toLocaleString()}`);
  console.log(`  High-frequency rows (>0.5)   : ${topFreqCount.toLocaleString()}`);
  console.log(`  Skipped / malformed lines    : ${totalSkipped.toLocaleString()}`);
  console.log(`  Total time                   : ${elapsed}s`);

  if (dbCount === totalParsed) {
    console.log(GREEN('\n  ✓ Row counts match — migration is consistent.'));
  } else {
    const delta = Math.abs(dbCount - totalParsed);
    console.log(YELLOW(`\n  ⚠ Count mismatch of ${delta} rows.`));
  }

  db.close();
  console.log(CYAN('─'.repeat(56)));
  console.log(GREEN('\n  SQLite migration v2 complete'));
  console.log(`  Database : ${DB_PATH}\n`);
}

main().catch((err) => {
  console.error(RED(`[FATAL] ${err.message}`));
  process.exit(1);
});
