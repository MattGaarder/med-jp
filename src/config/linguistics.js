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

export const MAX_BOOST = 100; // Reduced from 250

export const GRAM_POS = new Set([
  'prt','conj','cop','cop-da','aux','aux-v','aux-adj',
  'int','exp','adv','adv-to','pn','n-suf','n-pref','ctr'
]);

// ─────────────────────────────────────────────────────────────────
// Segmenter Constants (Base Tiers & Penalties)
// ─────────────────────────────────────────────────────────────────

export const SEGMENT_TIERS = {
  EXACT:        1000,
  GRAMMAR_PEEL: 980,    // Grammar suffix stripped, stem matched — very high confidence
  NORMALIZED:   950,
  DEINFLECT:    900,
  FUZZY:        800,
  AGGRESSIVE:   400
};

export const PENALTY_WEIGHTS = {
  TYPO:   250,  // Increased from 150 to prioritize phonetic accuracy
  LENGTH: 80,  // Increased from 40 to penalize mismatched word lengths
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
  FREQUENCY: {
    j1000: 90,
    step:  10  // Decrease per 1000-rank increase (j2000 = 90 - 10 = 80)
  },
  CLINICAL: {
    medicine:     80,   // Was 50 — too low, medical terms lost to dictionary noise
    anatomy:       40,   // Was 40
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

  // 1. Frequency (Non-Stacking Priority)
  let freqScore = 0;
  const commonWords = entry.commonWords || entry.common_words;
  
  if (commonWords) {
    const match = commonWords.match(/j(\d+)/);
    if (match) {
      const tier = parseInt(match[1], 10);
      const rank = Math.min(6, Math.max(1, Math.floor(tier / 1000)));
      freqScore = SCORING_WEIGHTS.FREQUENCY.j1000 - (rank - 1) * SCORING_WEIGHTS.FREQUENCY.step;
    }
  } else {
    // Only check nf# tags if no j-tier tag is present
    const nfTag = tags.find(t => typeof t === 'string' && t.startsWith('nf'));
    if (nfTag) {
      const nf = parseInt(nfTag.slice(2), 10);
      if (!isNaN(nf)) {
        freqScore = Math.max(0, 100 - nf * 2); // 100 down to 4 (nf48)
      }
    }
  }
  score += freqScore;

  // 2. JMdict Priority Labels
  if (tags.includes('ichi1')) score += SCORING_WEIGHTS.PRIORITY.ichi1;
  if (tags.includes('news1')) score += SCORING_WEIGHTS.PRIORITY.news1;
  if (tags.includes('spec1')) score += SCORING_WEIGHTS.PRIORITY.spec1;

  // 3. Domain Boosts (The "Medical Common Sense")
  const domain = (entry.domain || '').toLowerCase();
  if (domain.includes('medicine'))      score += SCORING_WEIGHTS.CLINICAL.medicine;
  if (domain.includes('anatomy'))       score += SCORING_WEIGHTS.CLINICAL.anatomy;
  if (domain.includes('pharmacology'))  score += SCORING_WEIGHTS.CLINICAL.pharmacology;

  // 3.1 Loanword Resilience (Prioritize loanwords like 'marijuana', 'cocaine' over native noise)
  if (entry.romaji?.match(/[f-z]{6,}/) || (entry.tags && entry.tags.includes('loan'))) {
    score += 50; 
  }

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
  if (type.startsWith('exact'))          base = SEGMENT_TIERS.EXACT;
  else if (type.startsWith('grammar_peel')) base = SEGMENT_TIERS.GRAMMAR_PEEL;
  else if (type.startsWith('deinflect'))    base = SEGMENT_TIERS.DEINFLECT;
  else if (type.startsWith('normalized'))   base = SEGMENT_TIERS.NORMALIZED;
  else if (type.startsWith('fuzzy'))        base = SEGMENT_TIERS.FUZZY;
  else if (type.startsWith('aggressive'))   base = SEGMENT_TIERS.AGGRESSIVE;

  // Exact Match variation adjustments
  if (type === 'exact:repair')    base -= 50;
  if (type === 'exact:phonetic')  base -= 100;
  if (type === 'exact:doubling')  base -= 100;
  
  // Fuzzy variation adjustment
  if (type === 'fuzzy' && !isOriginal) base -= 50;

  // 2. Add Linguistic Context points
  // ── PHONETIC SAFETY GATE ──────────────────────────────────────
  // We use a smooth decay instead of a hard gate.
  // If the distance is 0.3 (30% typo), points are reduced by ~90%.
  const distanceDecay = Math.max(0, 1 - Math.pow(distance * 3, 2));
  const points = calculateScore(entry) * distanceDecay;

  // 3. Calculate Penalties
  // Typo (Distance) Penalty — Scales exponentially to punish "loose" matches
  const typoPenalty = distance * distance * PENALTY_WEIGHTS.TYPO * 5;

  // Length Mismatch Penalty
  let lengthPenalty = Math.abs(inputLen - matchLen) * PENALTY_WEIGHTS.LENGTH;
  if (type.includes('deinflect')) {
    // Morphological deinflection naturally changes string length;
    // we should not penalize the root match for the length of its suffixes.
    lengthPenalty = 0;
  }

  // Utility/Noise Penalty
  let utilityPenalty = 0;
  const word = entry.romaji || '';
  if (UTILITY_WORDS.has(word)) {
    utilityPenalty = entry.meaning?.toLowerCase().includes('to do') 
      ? PENALTY_WEIGHTS.UTILITY * 2 
      : PENALTY_WEIGHTS.UTILITY;
  }

  // 4. Togetherness Boost
  // Heavily reward tokens that successfully deinflect into valid grammar chains.
  // A +100 bonus offsets the BASE_SEGMENT_COST, making it much more likely 
  // that a long verb (distorted or not) is kept as one token.
  let togethernessBoost = 0;
  if (type.includes('deinflect')) {
    togethernessBoost = 250; // Increased from 100 to prioritize morphological whole-verb reconstructions
  }

  // 5. Final Aggregation
  const finalScore = base + points + togethernessBoost - (typoPenalty + lengthPenalty + utilityPenalty);

  // 6. Build Intelligible Breakdown
  const parts = [];
  parts.push(`[${label}: ${base}]`);
  if (points > 0) parts.push(`[Points: +${points.toFixed(0)}]`);
  if (togethernessBoost > 0) parts.push(`[Together: +${togethernessBoost}]`);
  if (typoPenalty > 0)  parts.push(`[Typo: -${typoPenalty.toFixed(0)}]`);
  if (lengthPenalty > 0) parts.push(`[Len: -${lengthPenalty}]`);
  if (utilityPenalty > 0) parts.push(`[Utility: -${utilityPenalty}]`);

  return {
    score: finalScore,
    breakdown: parts.join(' ')
  };
}
