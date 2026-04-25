/**
 * src/mesh_annotator.js
 * 
 * Core logic for matching vocabulary entries against indexed MeSH data.
 * Level 4: Clinical Semantic Ranking & Graded Token Importance.
 */

const ALLOWED_EXPANSION_ROOTS = new Set(['C', 'D']); // Diseases, Drugs
const ALLOWED_DOMAIN_ROOTS = new Set(['A', 'C', 'D', 'E', 'F', 'G']); // Core Medical/Bio roots

const DEBUG = false; // Toggleable debug logger

const LOW_INFO = new Set([
  'very', 'well', 'much', 'many', 'good', 'bad', 
  'cold', 'hot', 'high', 'low', 'stiff', 'soft',
  'hard', 'mild', 'severe', 'acute', 'chronic',
  'part', 'parts', 'type', 'types', 'form', 'forms'
]);

const TREE_DOMAIN_MAP = {
  'A01': 'mesh_anatomy', 'A02': 'mesh_anatomy', 'A03': 'mesh_anatomy', 
  'A04': 'mesh_anatomy', 'A05': 'mesh_anatomy', 'A06': 'mesh_anatomy', 
  'A07': 'mesh_anatomy', 'A08': 'mesh_anatomy',
  'B01': 'mesh_microbiology', 'B02': 'mesh_microbiology', 'B03': 'mesh_microbiology', 
  'B04': 'mesh_microbiology',
  'E01': 'mesh_diagnostic',
  'E02': 'mesh_procedure', 'E03': 'mesh_procedure', 'E04': 'mesh_procedure', 'E05': 'mesh_procedure',
  'N01': 'mesh_health_care', 'N02': 'mesh_health_care', 'N03': 'mesh_health_care',
};

const ROOT_CHAR_MAP = {
  'A': 'mesh_anatomy',
  'B': 'mesh_microbiology',
  'C': 'mesh_disease',
  'D': 'mesh_drug',
  'E': 'mesh_procedure',
  'F': 'mesh_psychiatric',
  'G': 'mesh_biology',
  'H': 'mesh_physical_sciences',
  'I': 'mesh_social_sciences',
  'J': 'mesh_technology',
  'K': 'mesh_humanities',
  'L': 'mesh_information_science',
  'M': 'mesh_named_groups',
  'N': 'mesh_health_care',
  'V': 'mesh_publication',
  'Z': 'mesh_geography'
};

function getDomain(treeNum) {
  const threeChar = treeNum.substring(0, 3);
  if (TREE_DOMAIN_MAP[threeChar]) return TREE_DOMAIN_MAP[threeChar];
  
  const root = treeNum[0];
  if (root === 'C') return 'mesh_disease';
  if (root === 'D') return 'mesh_drug';
  
  return ROOT_CHAR_MAP[root] || 'mesh_unknown';
}

function isKatakana(str) {
  if (!str) return false;
  return /^[\u30A0-\u30FFー・]+$/.test(str);
}

function normalize(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(str) {
  if (!str) return [];
  const normalized = normalize(str);
  return normalized.split(/\s+/)
    .filter(t => t.length > 2);
}

function sharesStem(token, descriptorTokens) {
  if (!token || !descriptorTokens) return false;
  return descriptorTokens.some(word => 
    word.startsWith(token) || token.startsWith(word)
  );
}

/**
 * Detects if a token is likely to be a weak anchor (geographic or abstract modifier).
 */
function isWeakToken(token, descriptors) {
  if (!token) return true;
  
  // Abstract noun patterns
  if (token.endsWith('tion') || token.endsWith('ness') || token.endsWith('ment')) {
    return true;
  }
  
  // High ambiguity heuristic (tunable)
  if (descriptors && descriptors.size > 25) {
    return true;
  }

  return false;
}

/**
 * Computes a graded importance score for a token match.
 */
function computeTokenImportance(token, descriptors, context = {}) {
  let score = 0;
  const signals = {};

  // 1. Length Signal (Weight: 0.15)
  const lengthScore = Math.min(token.length / 10, 1) * 0.15;
  score += lengthScore;
  signals.length = lengthScore;

  // 2. Ambiguity Signal (Weight: 0.35)
  let ambiguityScore = 0;
  if (descriptors && descriptors.size > 0) {
    ambiguityScore = Math.min(1 / descriptors.size, 1) * 0.35;
    score += ambiguityScore;
  }
  signals.ambiguity = ambiguityScore;

  // 3. Katakana Signal (Weight: 0.30)
  const katakanaScore = context.katakana ? 0.30 : 0;
  score += katakanaScore;
  signals.katakana = katakanaScore;

  // 4. Multi-token Coherence Signal (Weight: 0.10)
  const multiTokenScore = context.multiToken ? 0.10 : 0;
  score += multiTokenScore;
  signals.multi_token = multiTokenScore;

  // 5. Weak Token / Low Info Penalty (Weight: -0.30)
  const isWeak = isWeakToken(token, descriptors) || LOW_INFO.has(token) || token.length <= 3;
  const weakPenalty = isWeak ? -0.30 : 0;
  score += weakPenalty;
  signals.weak_penalty = weakPenalty;

  // Clamp 0-1
  score = parseFloat(Math.max(0, Math.min(1, score)).toFixed(2));
  return { score, signals };
}

/**
 * Rewards specific medical concepts over generic ones.
 */
function descriptorSpecificity(desc) {
  if (!desc.treeNumbers) return 0;
  return desc.treeNumbers.length <= 3 ? 0.15 : 0;
}

function debugLog(entryId, token, importance, decision, extra = {}) {
  if (!DEBUG) return;
  console.log(JSON.stringify({
    entry_id: entryId,
    token,
    importance: importance.score,
    signals: importance.signals,
    decision,
    ...extra
  }));
}

/**
 * Selects best matches from a Map categorized by Descriptor UI.
 */
function finalizeMatches(matchMap) {
  const finalResults = [];
  for (const [ui, matches] of matchMap.entries()) {
    if (matches.length > 0) {
      const bestMatch = matches.sort((a, b) => {
        const priority = { exact_phrase: 4, exact_synonym: 3, expansion: 2, token_match: 1 };
        return priority[b.match_type] - priority[a.match_type];
      })[0];
      finalResults.push(bestMatch);
    }
  }
  return finalResults;
}

/**
 * Main matching function.
 */
export function matchEntry(entry, termIndex, descriptorIndex) {
  const { id, romaji, kana, primary_meaning, secondary_meanings } = entry;
  
  // Only use primary_meaning for MeSH matching.
  // Secondary meanings are too noisy — e.g. "oshaburi" has secondary "pacifier"
  // which false-matches MeSH "Pacifiers" (medical device E07.490.500).
  const meanings = [primary_meaning];

  const katakanaSignal = isKatakana(kana);
  const descriptorMatches = new Map(); // UI -> Array of match objects
  const quarantine = [];

  for (const meaning of meanings) {
    if (!meaning) continue;
    
    const entryTokens = tokenize(meaning);
    if (entryTokens.length === 0) continue;
    
    const normalizedFull = normalize(meaning);
    const tokenDescriptorHits = new Map();

    for (const token of entryTokens) {
      const descriptors = termIndex.get(token);
      if (!descriptors) continue;
      
      const hitsForToken = new Set();

      // --- PHASE 1: EXACT MATCHES (bypass importance filtering) ---
      // If the full meaning IS a MeSH preferred term or synonym, accept it directly.
      // This prevents "asthma" from being rejected because its token has high ambiguity.
      for (const ui of descriptors) {
        const desc = descriptorIndex.get(ui);
        
        if (desc.preferredTerm === normalizedFull) {
          // Full meaning exactly matches MeSH preferred term — always accept
          const importance = { score: 1.0, signals: { exact_phrase_bypass: true } };
          addMatch(descriptorMatches, formatMatch(entry, desc, token, 'exact_phrase', importance, katakanaSignal));
          hitsForToken.add(ui);
        } else if (desc.terms.includes(normalizedFull)) {
          // Full meaning matches a MeSH synonym
          if (entryTokens.length === 1 && !sharesStem(token, desc.preferredTokens)) {
            continue;
          }
          const importance = { score: 0.9, signals: { exact_synonym_bypass: true } };
          addMatch(descriptorMatches, formatMatch(entry, desc, token, 'exact_synonym', importance, katakanaSignal));
          hitsForToken.add(ui);
        }
      }

      // --- PHASE 2: EXPANSION MATCHES (require importance filtering) ---
      // Only check expansion if no exact match was found for this token
      if (hitsForToken.size === 0) {
        const importance = computeTokenImportance(token, descriptors, {
          katakana: katakanaSignal,
          multiToken: entryTokens.length >= 2
        });

        // TIER 1: HARD REJECTION for expansion matches only
        if (importance.score < 0.30) {
          debugLog(id, token, importance, 'REJECT_LOW_IMPORTANCE');
          quarantine.push({ entry_id: id, reason: 'low_importance', token, detail: importance.signals });
        } else {
          const allowExpansion = importance.score >= 0.50;
          
          if (allowExpansion) {
            for (const ui of descriptors) {
              if (hitsForToken.has(ui)) continue; // Skip already matched
              const desc = descriptorIndex.get(ui);
              
              if (desc.preferredTokens.includes(token)) {
                const hasValidExpansionRoot = desc.treeNumbers.some(tn => 
                  ALLOWED_EXPANSION_ROOTS.has(tn[0])
                );
                const matchType = hasValidExpansionRoot ? 'expansion' : 'token_match';
                addMatch(descriptorMatches, formatMatch(entry, desc, token, matchType, importance, katakanaSignal));
                hitsForToken.add(ui);
              }
            }
          }
        }
      }
      
      tokenDescriptorHits.set(token, hitsForToken);
    }

    // --- LEVEL 3: MULTI-TOKEN COHERENCE ---
    if (entryTokens.length >= 2) {
      for (const [ui, matches] of descriptorMatches.entries()) {
        const matchingTokens = entryTokens.filter(t => 
          tokenDescriptorHits.get(t)?.has(ui)
        );
        if (matchingTokens.length < 2) {
          const hasPhraseMatch = matches.some(m => m.match_type === 'exact_phrase');
          if (!hasPhraseMatch) {
            descriptorMatches.delete(ui);
          }
        }
      }
    }
  }

  const candidates = finalizeMatches(descriptorMatches);
  if (candidates.length === 0) return { matches: [], quarantine };

  // Select best match (highest confidence)
  const scored = candidates.map(m => {
    let baseScore = 0.45; // Base confidence
    
    // Multi-word bonus (stronger anchor)
    if (m.mesh_descriptor.includes(' ')) baseScore += 0.20;
    
    // Specificity bonus (Level 4)
    const desc = descriptorIndex.get(m.ui);
    if (desc) {
      baseScore += descriptorSpecificity(desc);
    }

    // Katakana loanword signal
    if (m.katakana) {
      baseScore += 0.15;
      const hasDiseaseDrugRoot = m.tree_numbers.some(tn => tn[0] === 'C' || tn[0] === 'D');
      if (!hasDiseaseDrugRoot) baseScore -= 0.1;
    }
    
    // Match type logic — exact_phrase needs +0.30 so single-word matches
    // like "asthma" (0.45 + 0.30 = 0.75) clear the 0.70 threshold.
    if (m.match_type === 'exact_phrase') baseScore += 0.30;
    else if (m.match_type === 'exact_synonym') baseScore += 0.15;

    // Final clamp based on Importance
    let confidence = parseFloat(baseScore.toFixed(2));
    
    // Expansion cap
    if (m.match_type === 'expansion' || m.match_type === 'token_match') {
      confidence = Math.min(0.85, confidence);
    } else {
      confidence = Math.min(1.0, confidence);
    }

    return { ...m, confidence };
  }).filter(m => m.confidence >= 0.7);

  return { matches: scored, quarantine };
}

function addMatch(map, match) {
  if (!match) return;
  const ui = match.ui;
  if (!map.has(ui)) map.set(ui, []);
  map.get(ui).push(match);
}

function formatMatch(entry, descriptor, sourceTerm, type, importance, katakana) {
  const validTreeNumbers = descriptor.treeNumbers.filter(tn => ALLOWED_DOMAIN_ROOTS.has(tn[0]));
  if (validTreeNumbers.length === 0) return null;

  const domains = Array.from(new Set(validTreeNumbers.map(getDomain)));
  
  return {
    ui: descriptor.ui || descriptor.DescriptorUI || descriptor.DescriptorName.String,
    entry_id: entry.id,
    mesh_descriptor: descriptor.name,
    matched_term: sourceTerm,
    tree_numbers: descriptor.treeNumbers,
    root_categories: Array.from(new Set(descriptor.treeNumbers.map(tn => tn.split('.')[0]))),
    mesh_domains: domains,
    match_type: type,
    token_importance: importance.score,
    katakana: katakana
  };
}
