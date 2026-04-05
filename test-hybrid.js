import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';
import { HybridSearchEngine } from './src/hybridSearch.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const OLLAMA_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const EMBED_MODEL = 'qwen3-embedding:latest';

async function getEmbedding(text) {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text })
    });
    if (!res.ok) throw new Error(`API error: ${res.status}`);
    const data = await res.json();
    return data.embedding;
  } catch (e) {
    console.error(`Embedding fail: ${e.message}`);
    return [];
  }
}

async function runTest() {
  const dataPath = path.join(__dirname, 'data/vocab-enhanced.jsonl');
  
  console.log("Loading Lexical Index into memory with Float32Array compression...");
  const dataset = [];
  const rl = readline.createInterface({ input: fs.createReadStream(dataPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim()) {
       const obj = JSON.parse(line);
       if (obj.embedding) obj.embedding = new Float32Array(obj.embedding);
       dataset.push(obj);
    }
  }
  
  const query = "autopsy procedure";
  console.log(`\nQuery: "${query}"`);
  console.log(`Loaded ${dataset.length} heavily compressed structures locally.`);
  console.log("Fetching query embedding...");
  
  const queryEmbed = await getEmbedding(query);
  
  console.log("Initializing Persistent In-Memory Search Engine...");
  const engine = new HybridSearchEngine(dataset);
  
  console.log("Running O(N) Semantic Search locally...");
  const t0 = performance.now();
  const results = engine.search(query, queryEmbed, 10);
  const t1 = performance.now();
  
  console.log(`\x1b[32m[Latency] Search executed natively in ${(t1 - t0).toFixed(2)}ms\x1b[0m`);
  
  results.forEach((res, i) => {
    const item = res.item;
    console.log(`\n--- Rank #${i + 1} (Score: ${res.score.toFixed(3)}) ---`);
    console.log(`Romaji: ${item.romaji}`);
    console.log(`Kanji: ${item.kanji || 'N/A'}`);
    console.log(`Meanings: ${item.meanings.join(', ')}`);
  });
}

runTest().catch(console.error);
