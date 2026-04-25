import { parseMeSH } from './src/mesh_parser.js';
import { matchEntry } from './src/mesh_annotator.js';

const MESH_XML = 'data/desc2026.xml';

async function debug() {
  const { termIndex, descriptorIndex } = await parseMeSH(MESH_XML);
  
  const token = 'crack';
  const hits = termIndex.get(token);
  console.log(`\n🔍 termIndex.get('${token}') size:`, hits ? hits.size : 'MISS');
  
  if (hits) {
    for (const ui of hits) {
      const desc = descriptorIndex.get(ui);
      console.log(`   - ${ui}: ${desc.name} | tree: ${desc.treeNumbers}`);
    }
  }

  const entry = {
    id: 3881,
    romaji: 'kurakku',
    kana: 'クラック',
    primary_meaning: 'crack',
    secondary_meanings: ''
  };

  console.log('\n--- Running matchEntry ---');
  const result = matchEntry(entry, termIndex, descriptorIndex);
  console.log(JSON.stringify(result, null, 2));
}

debug();
