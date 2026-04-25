import fs from 'fs/promises';
import Database from 'better-sqlite3';

const DB_PATH = 'data/vocab.db';
const ANNOTATIONS_PATH = 'data/mesh_annotations.json';

async function main() {
  console.log('🔍 Starting MeSH Integration Audit...');
  
  // 1. Source Data Stats
  const data = await fs.readFile(ANNOTATIONS_PATH, 'utf-8');
  const annotations = JSON.parse(data);
  const uniqueSourceIds = new Set(annotations.map(a => a.entry_id)).size;
  console.log(`📡 Source JSON: ${uniqueSourceIds} unique entries.`);

  // 2. Database Stats
  const db = new Database(DB_PATH);
  
  const dbResult = db.prepare(`
    SELECT COUNT(DISTINCT id) as count 
    FROM vocab 
    WHERE mesh_annotations IS NOT NULL
  `).get();
  const dbCount = dbResult.count;
  console.log(`💾 Database: ${dbCount} entries populated.`);

  // 3. Parity Check
  if (dbCount === uniqueSourceIds) {
    console.log('✅ Parity Check: SUCCESS (Counts match).');
  } else {
    console.warn(`⚠️  Parity Check: MISMATCH (Source: ${uniqueSourceIds}, DB: ${dbCount}).`);
  }

  // 4. JSON Validity Check
  const invalidResult = db.prepare(`
    SELECT COUNT(*) as invalidCount 
    FROM vocab 
    WHERE mesh_annotations IS NOT NULL 
    AND json_valid(mesh_annotations) = 0
  `).get();
  
  if (invalidResult.invalidCount === 0) {
    console.log('✅ JSON Integrity: SUCCESS (All 100% valid).');
  } else {
    console.error(`❌ JSON Integrity: FAILED (${invalidResult.invalidCount} invalid rows found).`);
  }

  // 5. Index Verification
  const indexResult = db.prepare(`
    SELECT name FROM sqlite_master 
    WHERE type='index' AND name IN ('idx_vocab_mesh_domains', 'idx_vocab_mesh_annotations_not_null')
  `).all();
  
  if (indexResult.length === 2) {
    console.log('✅ Performance Indexes: SUCCESS (Found both).');
  } else {
    console.warn(`⚠️  Performance Indexes: INCOMPLETE (Found ${indexResult.length}/2).`);
  }

  // 6. Sample Integrity
  const sample = db.prepare(`
    SELECT kana, primary_meaning, mesh_domains, mesh_annotations 
    FROM vocab 
    WHERE mesh_annotations IS NOT NULL 
    LIMIT 1
  `).get();
  
  if (sample) {
    console.log('✅ Sample Data Verification:');
    console.log(`   - Term: ${sample.kana} (${sample.primary_meaning})`);
    console.log(`   - Domains: ${sample.mesh_domains}`);
  }

  db.close();
  console.log('\n🏁 Audit Finished.');
}

main().catch(err => {
  console.error('❌ Audit Error:', err);
  process.exit(1);
});
