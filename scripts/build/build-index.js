import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import hnswlib from 'hnswlib-node';
const { HierarchicalNSW } = hnswlib;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_PATH = path.join(__dirname, '../data/vocab-v3.jsonl');
const HNSW_INDEX_PATH = path.join(__dirname, '../data/hnsw.index');
const METADATA_PATH = path.join(__dirname, '../data/metadata.json');

async function buildIndex() {
  console.log('Starting index build...');
  
  if (!fs.existsSync(INPUT_PATH)) {
    console.error(`Input file not found: ${INPUT_PATH}`);
    process.exit(1);
  }

  const fileStream = fs.createReadStream(INPUT_PATH);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let index;
  let metadataMap = {}; // Maps ID to text metadata
  let currentId = 0;
  
  // We don't know the dataset max size precisely, but we can set a high enough max elements.
  // 300_000 is enough for the ~200k dataset. We can resize it if needed, or just set it high since it's pre-allocated memory.
  const MAX_ELEMENTS = 300000; 

  console.log('Streaming JSONL to compile index...');
  let t0 = Date.now();

  for await (const line of rl) {
    if (!line.trim()) continue;

    try {
      const obj = JSON.parse(line);
      
      const embedding = obj.embedding;
      if (!embedding || !Array.isArray(embedding) || embedding.length === 0) {
        continue; // Skip invalid records
      }

      // Initialize the index on the very first valid record to capture accurate dimensions.
      if (!index) {
        const dimensions = embedding.length;
        console.log(`Initialized HNSW index with cosine similarity and ${dimensions} dimensions.`);
        index = new HierarchicalNSW('cosine', dimensions);
        index.initIndex(MAX_ELEMENTS);
      }

      // Insert embedding into the ANN index
      // Using `currentId` sequentially so we have dense IDs starting from 0.
      index.addPoint(embedding, currentId);

      // Remove the vast embedding payload and cache rest to dict
      delete obj.embedding;
      metadataMap[currentId] = obj;
      
      currentId++;

      if (currentId % 10000 === 0) {
         console.log(`Indexed ${currentId} elements...`);
      }

    } catch (err) {
      console.error(`Error parsing line at index ${currentId}:`, err);
    }
  }

  let duration = ((Date.now() - t0) / 1000).toFixed(2);
  console.log(`Stream complete. Indexed ${currentId} records in ${duration} seconds.`);
  
  console.log(`Writing HNSW index to disk at ${HNSW_INDEX_PATH}...`);
  index.writeIndexSync(HNSW_INDEX_PATH);
  
  // We must save the metrics parameter for load-time. hnswlib requires dimensions when reading.
  const spaceInfo = {
    space: 'cosine',
    dimensions: index.getNumDimensions(),
    maxElements: MAX_ELEMENTS,
    totalIndexed: currentId
  };

  const metadataWrapper = {
    indexConfig: spaceInfo,
    entries: metadataMap
  };

  console.log(`Writing metadata lookup map to disk at ${METADATA_PATH}...`);
  fs.writeFileSync(METADATA_PATH, JSON.stringify(metadataWrapper));
  
  console.log('\x1b[32mIndex built successfully!\x1b[0m');
}

buildIndex().catch(console.error);
