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
  'medicine',
  'anatomy',
  'pharmacology',
  'physiology',
  'biochemistry',
  'dentistry',
  'genetics',
  'psychiatry',
  'surgery',
  'pathology',
  'biology',
  'embryology',
  'psychology',
  'veterinary terms'
]);

export const MESH_DOMAINS = {
  DISEASE: 'mesh_disease',
  DRUG: 'mesh_drug',
  PROCEDURE: 'mesh_procedure',
  ANATOMY: 'mesh_anatomy',
  BIOLOGY: 'mesh_biology'
};

export const MAX_BOOST = 100; // Reduced from 250

export const GRAM_POS = new Set([
  'prt', 'conj', 'cop', 'cop-da', 'aux', 'aux-v', 'aux-adj',
  'int', 'exp', 'adv', 'adv-to', 'pn', 'n-suf', 'n-pref', 'ctr'
]);

// ─────────────────────────────────────────────────────────────────
// Segmenter Constants (Base Tiers & Penalties)
// ─────────────────────────────────────────────────────────────────

export const SEGMENT_TIERS = {
  EXACT: 1000,
  GRAMMAR_PEEL: 980,    // Grammar suffix stripped, stem matched — very high confidence
  NORMALIZED: 950,
  DEINFLECT: 900,
  FUZZY: 800,
  AGGRESSIVE: 400
};

export const PENALTY_WEIGHTS = {
  TYPO: 250,  // Increased from 150 to prioritize phonetic accuracy
  LENGTH: 80   // Increased from 40 to penalize mismatched word lengths
};

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
    j1000: 100,
    step: 10  // Decrease per 1000-rank increase (j2000 = 90 - 10 = 80)
  },
  CLINICAL: {
    medicine: 80,
    pharmacology: 100,
    anatomy: 40,
    physiology: 30,
    genetics: 30,
    biochemistry: 30,
    surgery: 50,
    psychiatry: 50
  },
  MESH: {
    disease: 80,
    drug: 70
  }
};

// ─────────────────────────────────────────────────────────────────
// Domain Utilities
// ─────────────────────────────────────────────────────────────────

/**
 * Normalizes multi-domain strings or arrays into a clean list of domains.
 * Handles "medicine, biology" or ["medicine", "biology"].
 * 
 * @param {string|string[]} domain 
 * @returns {string[]}
 */
export function parseDomains(domain) {
  if (!domain) return [];
  if (Array.isArray(domain)) {
    return domain.map(d => d.toLowerCase().trim());
  }
  return String(domain)
    .toLowerCase()
    .split(',')
    .map(d => d.trim())
    .filter(Boolean);
}

/**
 * Checks if a domain string/array contains any canonical medical domains.
 * 
 * @param {string|string[]} domain 
 * @returns {boolean}
 */
export function isMedicalDomain(domain) {
  const domains = parseDomains(domain);
  return domains.some(d => MEDICAL_DOMAINS.has(d));
}

/**
 * Calculates a unified Confidence Score for a vocabulary entry.
 * Shared by both the Build Pipeline and the Preprocessor Runtime.
 * 
 * @param {Object} entry 
 * @returns {Object} - Detailed points breakdown { total, freq, priority, clinical, mesh }
 */
export function calculateScore(entry) {
  // Normalize tags
  const tags = Array.isArray(entry.tags)
    ? entry.tags
    : (entry.tags?.split(',').map(t => t.trim()) || []);

  const points = {
    total: 0,
    freq: 0,
    priority: 0,
    clinical: 0,
    mesh: 0
  };

  // 1. Frequency (Non-Stacking Priority)
  const commonWords = entry.commonWords || entry.common_words;
  if (commonWords) {
    const match = commonWords.match(/j(\d+)/);
    if (match) {
      const tier = parseInt(match[1], 10);
      const rank = Math.min(6, Math.max(1, Math.floor(tier / 1000)));
      points.freq = SCORING_WEIGHTS.FREQUENCY.j1000 - (rank - 1) * SCORING_WEIGHTS.FREQUENCY.step;
    }
  } else {
    const nfTag = tags.find(t => typeof t === 'string' && t.startsWith('nf'));
    if (nfTag) {
      const nf = parseInt(nfTag.slice(2), 10);
      if (!isNaN(nf)) {
        points.freq = Math.max(0, 100 - nf * 2);
      }
    }
  }

  // 2. JMdict Priority Labels
  if (tags.includes('ichi1')) points.priority += SCORING_WEIGHTS.PRIORITY.ichi1;
  if (tags.includes('news1')) points.priority += SCORING_WEIGHTS.PRIORITY.news1;
  if (tags.includes('spec1')) points.priority += SCORING_WEIGHTS.PRIORITY.spec1;

  // 3. Domain Boosts (The "Medical Common Sense")
  const entryDomains = parseDomains(entry.domain);
  if (isMedicalDomain(entryDomains)) {
    // Apply specific boosts from SCORING_WEIGHTS.CLINICAL
    for (const [dom, weight] of Object.entries(SCORING_WEIGHTS.CLINICAL)) {
      if (entryDomains.includes(dom)) {
        points.clinical += weight;
      }
    }
  }

  // 4. MeSH Annotations (The specific clinical anchors)
  const meshDomains = Array.isArray(entry.meshDomains || entry.mesh_domains)
    ? (entry.meshDomains || entry.mesh_domains)
    : [];
  if (meshDomains.includes(MESH_DOMAINS.DISEASE)) points.mesh += SCORING_WEIGHTS.MESH.disease;
  if (meshDomains.includes(MESH_DOMAINS.DRUG)) points.mesh += SCORING_WEIGHTS.MESH.drug;

  points.total = points.freq + points.priority + points.clinical + points.mesh;
  return points;
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
  if (type.startsWith('exact')) base = SEGMENT_TIERS.EXACT;
  else if (type.startsWith('grammar_peel')) base = SEGMENT_TIERS.GRAMMAR_PEEL;
  else if (type.startsWith('deinflect')) {
    // SECURITY: Fuzzy stem matches are downgraded to the FUZZY tier to prevent 
    // hallucinated deinflections from outranking real dictionary words.
    base = type.includes('fuzzy_stem') ? SEGMENT_TIERS.FUZZY : SEGMENT_TIERS.DEINFLECT;
  }
  else if (type.startsWith('normalized')) base = SEGMENT_TIERS.NORMALIZED;
  else if (type.startsWith('fuzzy')) base = SEGMENT_TIERS.FUZZY;
  else if (type.startsWith('aggressive')) base = SEGMENT_TIERS.AGGRESSIVE;

  // Exact Match variation adjustments
  if (type === 'exact:repair') base -= 50;
  if (type === 'exact:phonetic') base -= 100;
  if (type === 'exact:doubling') base -= 100;

  // Fuzzy variation adjustment
  if (type === 'fuzzy' && !isOriginal) base -= 50;

  // 2. Add Linguistic Context points
  const distanceDecay = Math.max(0, 1 - Math.pow(distance * 3, 2));
  const points = calculateScore(entry);
  const adjustedTotal = points.total * distanceDecay;

  // 3. Calculate Penalties
  const typoPenalty = distance * distance * PENALTY_WEIGHTS.TYPO * 5;

  let lengthPenalty = Math.abs(inputLen - matchLen) * PENALTY_WEIGHTS.LENGTH;
  if (type.includes('deinflect')) {
    lengthPenalty = 0;
  }

  // 4. Final Aggregation
  const finalScore = base + adjustedTotal - (typoPenalty + lengthPenalty);

  // 6. Build Intelligible Breakdown
  const parts = [];
  parts.push(`[${label}: ${base}]`);

  if (points.total > 0) {
    const subParts = [];
    if (points.freq > 0) subParts.push(`f${points.freq}`);
    if (points.priority > 0) subParts.push(`p${points.priority}`);
    if (points.clinical > 0) subParts.push(`c${points.clinical}`);
    if (points.mesh > 0) subParts.push(`m${points.mesh}`);

    let pointStr = `+${adjustedTotal.toFixed(0)}`;
    if (subParts.length > 0) pointStr += ` (${subParts.join('+')})`;
    if (distanceDecay < 1.0) pointStr += ` * ${distanceDecay.toFixed(2)}decay`;

    parts.push(`[Points: ${pointStr}]`);
  }

  if (typoPenalty > 0) parts.push(`[Typo: -${typoPenalty.toFixed(0)}]`);
  if (lengthPenalty > 0) parts.push(`[Len: -${lengthPenalty}]`);

  return {
    score: finalScore,
    breakdown: parts.join(' ')
  };
}
