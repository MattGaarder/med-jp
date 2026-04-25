/**
 * src/config/linguistics.js
 * 
 * The single source of truth for all word frequency scoring, 
 * domain boosts, and grammatical filtering.
 */

// ─────────────────────────────────────────────────────────────────
// Domain Definitions
// ─────────────────────────────────────────────────────────────────

export const MEDICAL_DOMAINS = new Set([
  'medicine', 'anatomy', 'pharmacology', 'physiology', 'biochemistry', 
  'dentistry', 'genetics', 'orthopaedics', 'psychiatry', 'surgery', 
  'pathology', 'biology', 'embryology', 'psychology',
  'med', 'anat', 'pharm', 'dent', 'surg', 'pathol', 'physiol',
  'biochem', 'biol', 'embryo', 'psy'
]);

export const MESH_DOMAINS = {
  DISEASE:  'mesh_disease',
  DRUG:     'mesh_drug',
  PROCEDURE: 'mesh_procedure',
  ANATOMY:   'mesh_anatomy',
  BIOLOGY:   'mesh_biology'
};

export const GRAM_POS = new Set([
  'prt','conj','cop','cop-da','aux','aux-v','aux-adj',
  'int','exp','adv','adv-to','pn','n-suf','n-pref','ctr'
]);

// ─────────────────────────────────────────────────────────────────
// Segmenter Constants (Base Tiers & Penalties)
// ─────────────────────────────────────────────────────────────────

export const SEGMENT_TIERS = {
  EXACT:      1000,
  NORMALIZED: 950,
  DEINFLECT:  900,
  FUZZY:      800,
  AGGRESSIVE: 400
};

export const PENALTY_WEIGHTS = {
  TYPO:   150,  // Reduced from original 400 per user request
  LENGTH: 40,   // Penalty per character length mismatch
  UTILITY: 80   // Penalty for common noise/utility words
};

export const UTILITY_WORDS = new Set([
    'suru', 'aru', 'naru', 'desu', 'da', 'koto', 'mono', 'hito', 
    'kore', 'sore', 'are', 'demo', 'motto', 'omoimasu', 'omou'
]);

// ─────────────────────────────────────────────────────────────────
// Scoring Engine (The Balanced Model)
// ─────────────────────────────────────────────────────────────────

export const SCORING_WEIGHTS = {
  PRIORITY: {
    ichi1: 40,
    news1: 30,
    spec1: 50
  },
  CLINICAL: {
    medicine:     120,   // Was 50 — too low, medical terms lost to dictionary noise
    anatomy:       80,   // Was 40
    pharmacology: 100,   // New — drug-related JMDict entries
  },
  MESH: {
    disease: 80,
    drug:    70
  }
};

/**
 * Calculates a unified Confidence Score for a vocabulary entry.
 * Shared by both the Build Pipeline and the Preprocessor Runtime.
 * 
 * @param {Object} entry 
 * @returns {number} - A point-based score (higher is better)
 */
export function calculateScore(entry) {
  // Normalize tags
  const tags = Array.isArray(entry.tags) 
    ? entry.tags 
    : (entry.tags?.split(',').map(t => t.trim()) || []);

  let score = 0;

  // 1. Frequency (Linguistic Rank)
  const nfTag = tags.find(t => typeof t === 'string' && t.startsWith('nf'));
  if (nfTag) {
    const nf = parseInt(nfTag.slice(2), 10);
    if (!isNaN(nf)) {
      score += Math.max(0, 100 - nf * 2); // 100 down to 4 (nf48)
    }
  }

  // 2. JMdict Priority Labels
  if (tags.includes('ichi1')) score += SCORING_WEIGHTS.PRIORITY.ichi1;
  if (tags.includes('news1')) score += SCORING_WEIGHTS.PRIORITY.news1;
  if (tags.includes('spec1')) score += SCORING_WEIGHTS.PRIORITY.spec1;

  // 3. Domain Boosts (The "Medical Common Sense")
  const domain = (entry.domain || '').toLowerCase();
  if (domain.includes('medicine'))      score += SCORING_WEIGHTS.CLINICAL.medicine;
  if (domain.includes('anatomy'))       score += SCORING_WEIGHTS.CLINICAL.anatomy;
  if (domain.includes('pharmacology'))  score += SCORING_WEIGHTS.CLINICAL.pharmacology;

  // 4. MeSH Annotations (The specific clinical anchors)
  const meshDomains = entry.meshDomains || entry.mesh_domains || [];
  if (meshDomains.includes(MESH_DOMAINS.DISEASE)) score += SCORING_WEIGHTS.MESH.disease;
  if (meshDomains.includes(MESH_DOMAINS.DRUG))    score += SCORING_WEIGHTS.MESH.drug;

  return score;
}

/**
 * Calculates the final ranking score for a candidate word during segmenting.
 * Combines Base Tier + Linguistic Points - Penalties.
 * 
 * @param {Object} entry    - The dictionary data from vocab.db
 * @param {Object} metrics  - { type, distance, inputLen, matchLen, isOriginal }
 * @returns {Object}        - { score, breakdown }
 */
export function calculateSegmentScore(entry, metrics) {
  const { type, distance = 0, inputLen = 0, matchLen = 0, isOriginal = true } = metrics;
  
  let base = 0;
  let label = type;

  // 1. Determine Base Tier
  if (type.startsWith('exact'))      base = SEGMENT_TIERS.EXACT;
  else if (type.startsWith('deinflect')) base = SEGMENT_TIERS.DEINFLECT;
  else if (type.startsWith('normalized')) base = SEGMENT_TIERS.NORMALIZED;
  else if (type.startsWith('fuzzy'))      base = SEGMENT_TIERS.FUZZY;
  else if (type.startsWith('aggressive')) base = SEGMENT_TIERS.AGGRESSIVE;

  // Exact Match variation adjustments
  if (type === 'exact:repair')    base -= 50;
  if (type === 'exact:doubling')  base -= 100;
  
  // Fuzzy variation adjustment
  if (type === 'fuzzy' && !isOriginal) base -= 50;

  // 2. Add Linguistic Context points
  const points = calculateScore(entry);

  // 3. Calculate Penalties
  // Typo (Distance) Penalty
  const distanceFactor = distance < 0.05 ? 0.8 : 1.2;
  const typoPenalty = Math.pow(distance, distanceFactor) * PENALTY_WEIGHTS.TYPO;

  // Length Mismatch Penalty
  const lengthPenalty = Math.abs(inputLen - matchLen) * PENALTY_WEIGHTS.LENGTH;

  // Utility/Noise Penalty
  let utilityPenalty = 0;
  const word = entry.romaji || '';
  if (UTILITY_WORDS.has(word)) {
    utilityPenalty = entry.meaning?.toLowerCase().includes('to do') 
      ? PENALTY_WEIGHTS.UTILITY * 2 
      : PENALTY_WEIGHTS.UTILITY;
  }

  // 4. Final Aggregation
  const finalScore = base + points - (typoPenalty + lengthPenalty + utilityPenalty);

  // 5. Build Intelligible Breakdown
  const parts = [];
  parts.push(`[${label}: ${base}]`);
  if (points > 0) parts.push(`[Points: +${points}]`);
  if (typoPenalty > 0)  parts.push(`[Typo: -${typoPenalty.toFixed(1)}]`);
  if (lengthPenalty > 0) parts.push(`[Len: -${lengthPenalty}]`);
  if (utilityPenalty > 0) parts.push(`[Utility: -${utilityPenalty}]`);

  return {
    score: finalScore,
    breakdown: parts.join(' ')
  };
}
