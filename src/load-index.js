import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import hnswlib from 'hnswlib-node';
const { HierarchicalNSW } = hnswlib;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HNSW_INDEX_PATH = path.join(__dirname, '../data/hnsw.index');
const METADATA_PATH   = path.join(__dirname, '../data/metadata.json');

// Reusable state singleton for the runtime server
let index = null;
let metadataMap = null;
let indexConfig = null;

/**
 * Loads the HNSW index and the lightweight metadata map from disk.
 * Must be called once on boot before searching.
 */
export function getIndex() {
  return index;
}

export function loadIndex() {
  if (index !== null) return;
  
  console.log('Loading HNSW metadata...');
  
  if (!fs.existsSync(METADATA_PATH) || !fs.existsSync(HNSW_INDEX_PATH)) {
    throw new Error(`Index files missing. Please run scripts/build-index.js first.`);
  }

  const rawMeta = fs.readFileSync(METADATA_PATH, 'utf-8');
  const parsed = JSON.parse(rawMeta);
  indexConfig = parsed.indexConfig;
  metadataMap = parsed.entries;

  console.log(`Loading HNSW native binary (${indexConfig.dimensions} dims)...`);
  index = new HierarchicalNSW(indexConfig.space, indexConfig.dimensions);
  
  // Read index block entirely from disk
  index.readIndexSync(HNSW_INDEX_PATH);
  
  console.log(`Successfully mapped ${indexConfig.totalIndexed} entries into active RAG memory via ANN.`);
}

/**
 * Performs blazing fast approximate nearest neighbor semantic search.
 * Mimics original hybrid search signature.
 * 
 * @param {string} queryText - Optional text query for hybrid matching
 * @param {number[]} queryEmbedding - The embedding array for spatial matching
 * @param {number} topK - Return limits
 * @returns {Array} - The top K results matching { item, score } contract.
 */
// JMdict specialist domain tags — expanded to full English words in v3 schema.
const MEDICAL_DOMAINS = new Set([
  'medicine', 'anatomy', 'pharmacology', 'physiology', 'biochemistry', 
  'dentistry', 'genetics', 'orthopaedics', 'psychiatry', 'surgery', 
  'pathology', 'biology', 'embryology', 'psychiatry', 'psychology',
  'med', 'anat', 'pharm', 'dent', 'surg', 'pathol', 'physiol',
  'biochem', 'biol', 'embryo', 'psy',
]);


/**
 * Performs approximate nearest-neighbour search with frequency + domain reranking.
 *
 * @param {string}   queryText      - for logging only
 * @param {number[]} queryEmbedding - embedding vector
 * @param {number}   topK           - number of results to return
 * @param {Set}      [anchorTokens] - romaji tokens from the query; hits whose
 *                                    romaji matches an anchor token get a bonus
 * @returns {Array<{item, score}>}
 */
export function searchANN(queryText, queryEmbedding, topK = 3, anchorTokens = new Set()) {
  if (!index) throw new Error('Index not loaded. Call loadIndex() first.');

  const fetchSize = Math.min(topK * 4, indexConfig.totalIndexed);
  const hnswResults = index.searchKnn(queryEmbedding, fetchSize);

  const results = [];
  for (let i = 0; i < hnswResults.neighbors.length; i++) {
    const id       = hnswResults.neighbors[i];
    const distance = hnswResults.distances[i];
    const item     = metadataMap[id];

    const semanticScore = 1 - (distance / 2);            // [0, 1]
    const freqScore     = item.frequency ?? 0.1;          // [0.1, 1.0]

    // Anchor boost: if the hit's romaji is one of the tokens the user actually
    // said, push it to the top. This ensures memai (dizziness) is always
    // retrieved when the user typed memai, regardless of other cosine competition.
    const anchorBoost  = anchorTokens.has(item.romaji) ? 0.20 : 0;

    // Field boost: JMdict specialist clinical terminology gets a smaller bonus.
    const isMedDomain  = (Array.isArray(item.tags) && item.tags.some(t => MEDICAL_DOMAINS.has(t))) ||
                         (item.domain && MEDICAL_DOMAINS.has(item.domain));
    const domainBoost  = isMedDomain ? 0.10 : 0;


    // Scores can exceed 1.0 intentionally — we only use them for ranking.
    const finalScore = (0.8 * semanticScore) + (0.2 * freqScore) + anchorBoost + domainBoost;
    results.push({ item, score: finalScore, semanticScore }); // expose raw for threshold filtering
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
