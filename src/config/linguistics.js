/**
 * src/config/linguistics.js
 */

export const MEDICAL_TAGS = new Set([
  // Generic domains
  'medicine',
  'anatomy',
  'pharmacology',
  'biology',
  'psychiatry',
  // MeSH ontology tags
  'mesh_disease',
  'mesh_drug',
  'mesh_procedure',
  'mesh_anatomy',
  'mesh_psychiatric',
  'mesh_diagnostic',
  'mesh_biology'
]);

export const GRAM_POS = new Set([
  'prt', 'conj', 'cop', 'cop-da', 'aux', 'aux-v', 'aux-adj',
  'int', 'exp', 'adv', 'adv-to', 'pn', 'n-suf', 'n-pref', 'ctr'
]);

export const SEGMENT_TIERS = {
  EXACT: 1000,
  GRAMMAR_PEEL: 980,    // Grammar suffix stripped, stem matched — very high confidence
  NORMALIZED: 950,
  DEINFLECT: 950,       // Increased from 900 to compete better with 1-char exact repairs
  FUZZY: 800,
  AGGRESSIVE: 400
};

export const PENALTY_WEIGHTS = {
  TYPO: 250,  // Increased from 150 to prioritize phonetic accuracy
  LENGTH: 80   // Increased from 40 to penalize mismatched word lengths
};

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
  SEMANTIC: {
    medicine: 60,
    pharmacology: 80,
    anatomy: 40,
    mesh_disease: 100,
    mesh_drug: 90,
    mesh_procedure: 70,
    mesh_psychiatric: 80,
    mesh_diagnostic: 75
  }
};

// ─────────────────────────────────────────────────────────────────
// Domain Utilities
// ─────────────────────────────────────────────────────────────────

/**
 * Normalizes multi-domain strings or arrays into a clean list of semantic tags.
 * Handles "medicine, biology", ["medicine", "biology"], or ["medicine, biology"].
 * 
 * @param {string|string[]} tags 
 * @returns {string[]}
 */
export function parseSemanticTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) {
    return tags
      .flatMap(tag => String(tag).split(','))
      .map(tag => tag.toLowerCase().trim())
      .filter(Boolean);
  }
  return String(tags)
    .toLowerCase()
    .split(',')
    .map(tag => tag.trim())
    .filter(Boolean);
}

/**
 * Unified collector for an entry's semantic evidence.
 * 
 * @param {Object} entry 
 * @returns {Set<string>}
 */
export function collectSemanticTags(entry) {
  return new Set([
    ...parseSemanticTags(entry.domain),
    ...parseSemanticTags(entry.mesh_domains || entry.meshDomains)
  ]);
}

/**
 * Checks if a tag/array contains any canonical medical signals.
 * 
 * @param {string|string[]} tags 
 * @returns {boolean}
 */
export function isMedicalDomain(tags) {
  const parsed = parseSemanticTags(tags);
  return parsed.some(t => MEDICAL_TAGS.has(t));
}

/**
 * Calculates a unified Lexical Desirability Score for a vocabulary entry.
 * Returns a detailed breakdown of semantic desirability components.
 *
 * @param {Object} entry
 * @returns {Object} - { total, freq, priority, clinical, mesh }
 */
function buildLexicalScore(entry) {
  const tags = Array.isArray(entry.tags)
    ? entry.tags
    : (entry.tags?.split(',').map(t => t.trim()) || []);

  const points = {
    total: 0,
    freq: 0,
    priority: 0,
    semantic: 0
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

  // 3. Unified Semantic Scoring (The "Medical Common Sense")
  const semanticTags = collectSemanticTags(entry);
  const matchedWeights = [];

  for (const tag of semanticTags) {
    if (SCORING_WEIGHTS.SEMANTIC[tag]) {
      matchedWeights.push(SCORING_WEIGHTS.SEMANTIC[tag]);
    }
  }

  if (matchedWeights.length > 0) {
    // Determine the strongest applicable semantic weight (prevent runaway inflation)
    points.semantic = Math.max(...matchedWeights);
    
    // Apply small secondary bonus for multifaceted evidence (+5 per additional tag)
    if (matchedWeights.length > 1) {
      points.semantic += (matchedWeights.length - 1) * 5;
    }
  }

  points.total = points.freq + points.priority + points.semantic;
  return points;
}

/**
 * Calculates the final canonical ranking score for a candidate.
 * Unifies Lexical Desirability, Match Reliability, and Segmentation Fitness.
 *
 * @param {Object} entry    - The dictionary data
 * @param {Object} metrics  - { type, distance, inputLen, matchLen, isOriginal, stability, isBeamContext }
 * @returns {Object}        - Detailed scoring object
 */
export function calculateCandidateScore(entry, metrics = {}) {
  const {
    type = 'unknown',
    distance = 0,
    inputLen = 0,
    matchLen = 0,
    isOriginal = true,
    stability = 1.0,
    isBeamContext = false
  } = metrics;

  // 0. Canonical Flags
  const flags = {
    isExact: type.startsWith('exact'),
    isDeinflect: type.includes('deinflect'),
    isFuzzy: type.includes('fuzzy'),
    isNormalized: type.startsWith('normalized'),
    isGrammar: type.startsWith('grammar_peel'),
    isAggressive: type.startsWith('aggressive'),
    isRepair: type.includes('repair'),
    isPhonetic: type.includes('phonetic'),
    isDoubling: type.includes('doubling')
  };

  // --- STAGE 1: Lexical Desirability ---
  const lexical = buildLexicalScore(entry);

  // --- STAGE 2: Match Reliability ---
  let tier = 0;
  if (flags.isExact) tier = SEGMENT_TIERS.EXACT;
  else if (flags.isGrammar) tier = SEGMENT_TIERS.GRAMMAR_PEEL;
  else if (flags.isDeinflect) {
    tier = type.includes('fuzzy_stem') ? SEGMENT_TIERS.FUZZY : SEGMENT_TIERS.DEINFLECT;
  }
  else if (flags.isNormalized) tier = SEGMENT_TIERS.NORMALIZED;
  else if (flags.isFuzzy) tier = SEGMENT_TIERS.FUZZY;
  else if (flags.isAggressive) tier = SEGMENT_TIERS.AGGRESSIVE;

  // Phonetic/Repair Adjustments
  if (flags.isRepair) {
    tier -= 50;
    // Extra penalty for very short repairs (e.g. "t" -> "te")
    if (matchLen <= 2) tier -= 100;
  }
  if (flags.isPhonetic) tier -= 100;
  if (flags.isDoubling) tier -= 100;
  if (flags.isFuzzy && !isOriginal) tier -= 50;

  // Match Decay & Penalties
  const decay = Math.max(0, 1 - Math.pow(distance * 3, 2));
  const typoPenalty = distance * distance * PENALTY_WEIGHTS.TYPO * 5;
  const lengthPenalty = flags.isDeinflect ? 0 : Math.abs(inputLen - matchLen) * PENALTY_WEIGHTS.LENGTH;

  const confidenceTotal = (tier + (lexical.total * decay)) - (typoPenalty + lengthPenalty);

  // --- STAGE 3: Segmentation Fitness (Optional) ---
  const segmentation = {
    exactBonus: 0,
    wholeWordBonus: 0,
    stabilityBonus: 0,
    fragmentPenalty: 0,
    total: 0
  };

  if (isBeamContext) {
    // 1. Exact Match Preference
    if (flags.isExact) {
      segmentation.exactBonus = 400 + (matchLen * 50);
    } else {
      segmentation.exactBonus = -(200 + (300 / Math.max(matchLen, 1)));
    }

    // 2. Whole Word / Anti-fragmentation (Logarithmic shaping)
    if (confidenceTotal > 1100 || flags.isExact) {
      segmentation.wholeWordBonus = Math.log2(matchLen + 1) * 150;
    }

    // 3. Stability Bonus
    segmentation.stabilityBonus = (stability - 0.75) * 400; // Boost for high-margin winners

    // 4. Tiny Fragment Suppression
    if (matchLen <= 1 && !flags.isExact) {
      segmentation.fragmentPenalty = 500;
    }
  }

  segmentation.total = segmentation.exactBonus + segmentation.wholeWordBonus + segmentation.stabilityBonus - segmentation.fragmentPenalty;

  // --- FINAL AGGREGATION ---
  const total = confidenceTotal + segmentation.total;

  // --- Breakdown Formatting ---
  const parts = [`[${type}: ${tier}]`];
  if (lexical.total > 0) {
    parts.push(`[Lex: +${(lexical.total * decay).toFixed(0)} (${decay.toFixed(2)}d)]`);
  }
  if (typoPenalty > 0) parts.push(`[Typo: -${typoPenalty.toFixed(0)}]`);
  if (lengthPenalty > 0) parts.push(`[Len: -${lengthPenalty}]`);
  if (isBeamContext && segmentation.total !== 0) {
    parts.push(`[Seg: ${segmentation.total > 0 ? '+' : ''}${segmentation.total.toFixed(0)}]`);
  }

  return {
    total,
    lexical: lexical.total,
    confidence: confidenceTotal,
    segmentation: segmentation.total,
    components: {
      frequency: lexical.freq,
      priority: lexical.priority,
      semantic: lexical.semantic,
      tier,
      decay,
      typoPenalty,
      lengthPenalty,
      exactBonus: segmentation.exactBonus,
      wholeWordBonus: segmentation.wholeWordBonus,
      stabilityBonus: segmentation.stabilityBonus,
      fragmentPenalty: segmentation.fragmentPenalty
    },
    breakdown: parts.join(' ')
  };
}
