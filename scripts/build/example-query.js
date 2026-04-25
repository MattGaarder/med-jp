import { loadIndex, searchANN } from '../../src/load-index.js';

async function runExample() {
  console.log('--- ANN Search Quick Start ---');
  
  // 1. Instantly load the index into memory
  try {
    const t0 = Date.now();
    loadIndex();
    console.log(`Index loaded in ${Date.now() - t0}ms\n`);
  } catch (err) {
    console.error('Failed to load index. Did you run `node scripts/build-index.js` first?');
    console.error(err);
    process.exit(1);
  }

  // 2. We mock a 4096-dimensional random query embedding simulating `qwen3-embedding`
  // Real usage uses: await getEmbedding("patient chest pain")
  console.log('Mocking embedding vector for "chest pain"...');
  const d = 4096; // typical Qwen dimensionality
  const mockQuery = new Array(d).fill(0).map(() => (Math.random() - 0.5) * 0.1);
  
  // 3. Search and benchmark!
  console.log('Running searchANN() query...');
  const searchT0 = Date.now();
  
  // topK = 3
  const results = searchANN("chest pain", mockQuery, 3);
  
  const queryMs = Date.now() - searchT0;
  console.log(`\nSearch query returned in ${queryMs}ms!`);

  console.log('\n--- MATCHES ---\n');
  if (results.length === 0) {
    console.log('No matches found. (Index might be empty?)');
  }

  results.forEach((res, i) => {
    console.log(`#${i + 1} | Score: ${res.score.toFixed(4)}`);
    console.log(` Romaji:   ${res.item.romaji}`);
    console.log(` Kana:     ${res.item.kana}`);
    console.log(` Meanings: ${res.item.meanings.join(', ')}`);
    console.log(` Tags:     ${res.item.tags.join(', ')}`);
    console.log('------------------------------');
  });
}

runExample().catch(console.error);
