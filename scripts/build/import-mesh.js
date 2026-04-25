import fs from 'fs/promises';
import Database from 'better-sqlite3';

const DB_PATH = 'data/vocab.db';
const ANNOTATIONS_PATH = 'data/mesh_annotations.json';

async function main() {
  console.log('🚀 Loading annotations...');
  const data = await fs.readFile(ANNOTATIONS_PATH, 'utf-8');
  const annotations = JSON.parse(data);

  console.log(`📦 Grouping ${annotations.length} annotations...`);
  const grouped = new Map();

  for (const row of annotations) {
    if (!grouped.has(row.entry_id)) {
      grouped.set(row.entry_id, []);
    }
    grouped.get(row.entry_id).push({
      matched_term: row.matched_term,
      mesh_descriptor: row.mesh_descriptor,
      tree_numbers: row.tree_numbers,
      domains: row.mesh_domains, // In our JSON it was mesh_domains
      match_type: row.match_type,
      confidence: row.confidence
    });
  }

  console.log(`💾 Connecting to database: ${DB_PATH}`);
  const db = new Database(DB_PATH);
  
  // Prepare statements
  const updateStmt = db.prepare(`
    UPDATE vocab 
    SET mesh_annotations = ?, 
        mesh_domains = ? 
    WHERE id = ?
  `);

  console.log('⚡ Starting transaction...');
  const transaction = db.transaction((groups) => {
    let count = 0;
    for (const [entryId, entryAnnotations] of groups.entries()) {
      const domains = Array.from(new Set(entryAnnotations.flatMap(a => a.domains)));
      
      updateStmt.run(
        JSON.stringify(entryAnnotations),
        JSON.stringify(domains),
        entryId
      );
      count++;
    }
    return count;
  });

  const updatedCount = transaction(grouped);
  
  console.log(`✅ Update Complete. ${updatedCount} rows updated.`);
  db.close();
}

main().catch(err => {
  console.error('❌ Error during import:', err);
  process.exit(1);
});
