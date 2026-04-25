#!/usr/bin/env node
/**
 * scripts/annotate-mesh.js
 * 
 * Main pipeline for MeSH annotation.
 */

import Database from 'better-sqlite3';
import { writeFile } from 'fs/promises';
import { resolve } from 'path';
import { parseMeSH } from '../../src/mesh_parser.js';
import { matchEntry } from '../../src/mesh_annotator.js';

const MESH_XML = 'data/desc2026.xml';
const VOCAB_DB = 'data/vocab.db';
const OUTPUT_FILE = 'data/mesh_annotations.json';
const QUARANTINE_FILE = 'data/quarantine_log.json';

async function main() {
  console.log('🚀 Starting MeSH Annotation Pipeline...');

  // 1. Load MeSH
  const { termIndex, descriptorIndex } = await parseMeSH(MESH_XML);

  // 2. Open DB
  const db = new Database(VOCAB_DB);
  console.log(`📡 Connected to ${VOCAB_DB}`);

  // 3. Prepare processing
  const results = [];
  const quarantine = [];
  let processedCount = 0;
  let matchCount = 0;

  // We read rows where mesh_domains is null OR we can just read all and let the filter handle it.
  // The user suggested processing entries but only writing to NULL rows.
  // Since we are creating a JSON, we'll collect matches for anything that currently lacks mesh_domains.
  
  // First, check if columns exist. If not, we still process.
  let columns = [];
  try {
    columns = db.pragma('table_info(vocab)').map(c => c.name);
  } catch (err) {
    console.error('❌ Could not read vocab table info.');
    process.exit(1);
  }

  const hasMeshCol = columns.includes('mesh_domains');
  const query = hasMeshCol 
    ? 'SELECT * FROM vocab WHERE mesh_domains IS NULL' 
    : 'SELECT * FROM vocab';

  const stmt = db.prepare(query);
  const rows = stmt.iterate();

  console.log('🧪 Processing vocabulary entries...');

  for (const row of rows) {
    processedCount++;
    
    const { matches, quarantine: qItems } = matchEntry(row, termIndex, descriptorIndex);
    
    if (matches && matches.length > 0) {
      // Pick the best match (highest confidence)
      const best = matches.sort((a, b) => b.confidence - a.confidence)[0];
      results.push(best);
      matchCount++;
    }

    if (qItems && qItems.length > 0) {
      for (const q of qItems) {
        quarantine.push({ entry_id: row.id, ...q });
      }
    }

    if (processedCount % 10000 === 0) {
      console.log(`   Processed ${processedCount} entries (${matchCount} matches)...`);
    }
  }

  // 4. Save results
  console.log(`💾 Saving ${results.length} results to ${OUTPUT_FILE}`);
  await writeFile(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf-8');

  if (quarantine.length > 0) {
    console.log(`⚠️  Saving ${quarantine.length} quarantine logs to ${QUARANTINE_FILE}`);
    await writeFile(QUARANTINE_FILE, JSON.stringify(quarantine, null, 2), 'utf-8');
  }

  console.log('✅ Pipeline Complete.');
  console.log(`   Total Processed: ${processedCount}`);
  console.log(`   Total Matches  : ${matchCount}`);
  console.log(`   Precision Guard: ${quarantine.length} ambiguous terms quarantined.`);
}

main().catch(err => {
  console.error('❌ Pipeline Error:', err);
  process.exit(1);
});
