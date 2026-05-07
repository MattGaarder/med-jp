import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import hnswlib from 'hnswlib-node';
const { HierarchicalNSW } = hnswlib;
import { calculateScore } from './config/linguistics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const HNSW_INDEX_PATH = path.join(__dirname, '../data/hnsw.index');
const METADATA_PATH   = path.join(__dirname, '../data/metadata.json');

let hnswIndex = null;
let metadataMap = null;
let indexConfig = null;

/**
 * Loads the HNSW index and the lightweight metadata map from disk.
 * Must be called once on boot before searching.
 */
export function getIndex() {
  return hnswIndex;
}

export function loadIndex() {
  if (hnswIndex !== null) return;
  
  console.log('Loading HNSW metadata...');
  
  if (!fs.existsSync(METADATA_PATH) || !fs.existsSync(HNSW_INDEX_PATH)) {
    throw new Error(`Index files missing. Please run scripts/build-index.js first.`);
  }

  const rawMeta = fs.readFileSync(METADATA_PATH, 'utf-8');
  const parsed = JSON.parse(rawMeta);
  indexConfig = parsed.indexConfig;
  metadataMap = parsed.entries;

  console.log(`Loading HNSW native binary (${indexConfig.dimensions} dims)...`);
  hnswIndex = new HierarchicalNSW(indexConfig.space, indexConfig.dimensions);
  
  // Read index block entirely from disk
  hnswIndex.readIndexSync(HNSW_INDEX_PATH);
  
  console.log(`Successfully mapped ${indexConfig.totalIndexed} entries into active RAG memory via ANN.`);
}

/**
 * Performs blazing fast approximate nearest neighbor search with hybrid reranking.
 * 
 * @param {number[]} queryEmbedding - The embedding vector for spatial matching.
 * @param {number}   topK           - Number of results to return.
 * @param {Set}      [anchorTokens] - Romaji tokens from the query used for anchor boosting.
 * @returns {Array<{id, item, score, semanticScore}>} - The ranked and scored results.
 */
export function searchANN(queryEmbedding, topK = 3, anchorTokens = new Set()) {
  if (!hnswIndex) throw new Error('Index not loaded. Call loadIndex() first.');

  const hnswResults = hnswIndex.searchKnn(queryEmbedding, topK);

  const results = [];
  for (let i = 0; i < hnswResults.neighbors.length; i++) {
    const id       = hnswResults.neighbors[i];
    const distance = hnswResults.distances[i];
    const item     = metadataMap[id];

    const semanticScore = 1 - (distance / 2);            // [0, 1]
    
    // 1. Unified Linguistic Confidence (Dictionary Priority + Frequency + Domain)
    const linguisticPoints = calculateScore(item);
    const dictConfidence = linguisticPoints.total / 1000; // Normalized boost [0, 0.4+]

    // 2. Anchor boost (Runtime match to user input)
    const anchorBoost  = anchorTokens.has(item.romaji) ? 0.20 : 0;

    // 3. Final Aggregation
    // Semantic similarity is primary (70%), Dictionary confidence is the tie-breaker (30%).
    const finalScore = (0.7 * semanticScore) + (0.3 * dictConfidence) + anchorBoost;
    results.push({ id, item, score: finalScore, semanticScore }); 
  }
  results.sort((a, b) => b.score - a.score);
  return results.slice(0, topK);
}
