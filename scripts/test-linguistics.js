/**
 * scripts/test-linguistics.js
 * 
 * A sandbox to test the new Centralized Linguistic Engine.
 * Usage: node scripts/test-linguistics.js [word]
 */

import { calculateScore, SCORING_WEIGHTS } from '../src/config/linguistics.js';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '../data/vocab.db');

function logScore(word, entry) {
  const score = calculateScore(entry);
  console.log(`\n\x1b[36m--- ${word.toUpperCase()} ---\x1b[0m`);
  console.log(`Tags   : ${entry.tags}`);
  console.log(`Domain : ${entry.domain || 'none'}`);
  console.log(`MeSH   : ${entry.meshDomains?.join(', ') || 'none'}`);
  console.log(`\x1b[1mScore  : ${score} points\x1b[0m`);
  
  // Breakdown explanation
  console.log(`\x1b[90mBreakdown:`);
  const tags = Array.isArray(entry.tags) ? entry.tags : (entry.tags?.split(',') || []);
  const nf = tags.find(t => t.startsWith('nf'));
  if (nf) console.log(`  - NF Rank (${nf})    : +${Math.max(0, 100 - parseInt(nf.slice(2), 10) * 2)}`);
  if (tags.includes('ichi1')) console.log(`  - Priority (ichi1) : +${SCORING_WEIGHTS.PRIORITY.ichi1}`);
  if (tags.includes('news1')) console.log(`  - Priority (news1) : +${SCORING_WEIGHTS.PRIORITY.news1}`);
  if (tags.includes('spec1')) console.log(`  - Priority (spec1) : +${SCORING_WEIGHTS.PRIORITY.spec1}`);
  const domain = (entry.domain || '').toLowerCase();
  if (domain.includes('medicine')) console.log(`  - Domain Medicine  : +${SCORING_WEIGHTS.CLINICAL.medicine}`);
  if (domain.includes('anatomy'))  console.log(`  - Domain Anatomy   : +${SCORING_WEIGHTS.CLINICAL.anatomy}`);
  if (entry.meshDomains?.includes('mesh_disease')) console.log(`  - MeSH Disease     : +${SCORING_WEIGHTS.MESH.disease}`);
  if (entry.meshDomains?.includes('mesh_drug'))    console.log(`  - MeSH Drug        : +${SCORING_WEIGHTS.MESH.drug}`);
  console.log(`\x1b[0m`);
}

async function main() {
  const word = process.argv[2];

  if (!word) {
    console.log("Usage: node scripts/test-linguistics.js <romaji>");
    console.log("Example: node scripts/test-linguistics.js zensoku");
    process.exit(0);
  }

  try {
    const db = new Database(DB_PATH, { readonly: true });
    const entries = db.prepare('SELECT romaji, tags, domain, mesh_domains FROM vocab WHERE romaji = ?').all(word);

    if (entries.length === 0) {
      console.log(`\x1b[31mWord "${word}" not found in vocab.db\x1b[0m`);
      console.log("Test with mock data? (y/n)");
      // For automated script we'll just show some mocks anyway
      logScore("mock_zensoku_medical", { 
        tags: 'nf01, ichi1', 
        domain: 'medicine', 
        meshDomains: ['mesh_disease'] 
      });
      logScore("mock_zensoku_general", { 
        tags: 'nf01, ichi1', 
        domain: 'general', 
        meshDomains: [] 
      });
    } else {
      for (const row of entries) {
        logScore(row.romaji, {
          tags: row.tags,
          domain: row.domain,
          meshDomains: row.mesh_domains ? JSON.parse(row.mesh_domains) : []
        });
      }
    }
    db.close();
  } catch (err) {
    console.error(`Error: ${err.message}`);
    // If DB doesn't exist yet, show mocks
    logScore("mock_medical", { tags: 'nf01, ichi1', domain: 'medicine', meshDomains: ['mesh_disease'] });
  }
}

main();
