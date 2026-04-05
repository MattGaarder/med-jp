import fs from 'fs';

/**
 * Calculates cosine similarity between two numeric arrays.
 * Returns a value between -1 and 1. (Usually 0 to 1 for text embeddings)
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length === 0 || vecB.length === 0) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Hybrid Search Engine (In-Memory RAG Version)
 * 
 * Heavily optimized to accept `Float32Array` compressed datasets.
 * Drops Fuse.js entirely to avoid 6GB OOM cloning faults. O(N) iteration in RAM takes <50ms.
 */
export class HybridSearchEngine {
  constructor(dataset, weights = { semantic: 0.8, freq: 0.2 }) {
    this.dataset = dataset;
    this.weights = weights;
  }

  /**
   * Executes a blistering fast O(N) synchronous semantic search across the heavily-compressed Node RAM dataset.
   * 
   * @param {string} queryText - The text to search (unused directly here but kept for API compat)
   * @param {number[]} queryEmbedding - The embedding vector of the query text
   * @param {number} topK - Number of results to return
   * @returns {Array} - The top K best matched entries
   */
  search(queryText, queryEmbedding, topK = 3) {
    const results = [];
    
    for (const item of this.dataset) {
      if (!item.embedding) continue;
      
      let semanticScore = cosineSimilarity(queryEmbedding, item.embedding);
      const freqScore = item.frequency ?? 0.1;
      
      const finalScore = (this.weights.semantic * semanticScore) + (this.weights.freq * freqScore);
      
      if (results.length < topK) {
        results.push({ item, score: finalScore });
        results.sort((a,b) => b.score - a.score);
      } else if (finalScore > results[topK - 1].score) {
        results[topK - 1] = { item, score: finalScore };
        results.sort((a,b) => b.score - a.score);
      }
    }
    
    return results;
  }
}
