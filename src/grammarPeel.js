/**
 * src/grammarPeel.js
 *
 * Grammar suffix peeling and multi-token collapse system.
 *
 * Phase 1 (Suffix Peel): Strips known grammar suffixes from token ends
 *   inside the beam search, allowing the stem to be matched against the
 *   dictionary/deinflector independently.
 *
 * Phase 2 (Collapse & Merge): Post-beam-search pass that detects
 *   multi-token grammar patterns spanning whitespace boundaries, and
 *   merges adjacent garbage tokens for re-evaluation.
 */

import * as wanakana from 'wanakana';

// ─────────────────────────────────────────────────────────────────
// Grammar Anchor Index
// ─────────────────────────────────────────────────────────────────

// Anchors indexed by hiragana suffix string → array of { grammarId, meanings, priority }
let grammarSuffixMap = null;
// Maximum suffix length we'll try to peel (avoids scanning the entire token)
let maxSuffixLen = 0;

// Single-character kana that are too ambiguous to peel as grammar suffixes.
// These overlap with particles, verb endings, and common word parts.
const UNSAFE_SINGLE_CHAR = new Set([
  'お', 'か', 'が', 'け', 'げ', 'ご', 'し', 'た', 'だ',
  'つ', 'て', 'で', 'と', 'な', 'に', 'は', 'ば', 'も', 'や', 'を'
]);

/**
 * Load grammar anchors from the vocab.db grammar_anchors table.
 * Builds a Map keyed by hiragana anchor string for O(1) suffix lookup.
 *
 * @param {Database} db - better-sqlite3 database connection
 */
export function loadGrammarAnchors(db) {
  if (grammarSuffixMap) return; // already loaded

  grammarSuffixMap = new Map();

  const rows = db.prepare(`
    SELECT ga.anchor_hiragana, ga.grammar_id, ga.priority, g.meanings_en, g.title
    FROM grammar_anchors ga
    JOIN grammar g ON ga.grammar_id = g.grammar_id
    WHERE g.alias_of IS NULL
    ORDER BY length(ga.anchor_hiragana) DESC
  `).all();

  for (const row of rows) {
    const hira = row.anchor_hiragana.trim();
    if (!hira) continue;

    // Skip single-char anchors that are too ambiguous
    if (hira.length === 1 && UNSAFE_SINGLE_CHAR.has(hira)) continue;
    // Skip anchors containing spaces or special formatting
    if (/[\s＋・〜〔〕]/.test(hira)) continue;

    let meanings = [];
    try {
      meanings = JSON.parse(row.meanings_en || '[]');
    } catch { /* ignore parse errors */ }

    if (!grammarSuffixMap.has(hira)) {
      grammarSuffixMap.set(hira, []);
    }
    grammarSuffixMap.get(hira).push({
      grammarId: row.grammar_id,
      title: row.title,
      meanings,
      priority: row.priority || 0,
    });

    if (hira.length > maxSuffixLen) maxSuffixLen = hira.length;
  }

  console.log(`[grammarPeel] Loaded ${grammarSuffixMap.size} unique grammar suffixes (max len: ${maxSuffixLen})`);
}

// ─────────────────────────────────────────────────────────────────
// Phase 1: Suffix Peel (inside beam search)
// ─────────────────────────────────────────────────────────────────

/**
 * Attempt to peel known grammar suffixes from the end of a hiragana token.
 * Returns an array of possible peels, ordered by suffix length (longest first).
 *
 * Each peel contains the stem (both hiragana and romaji) and the grammar info.
 *
 * @param {string} hiraPrefix - The hiragana token to peel (e.g., "がっこうから")
 * @param {string} romajiPrefix - The romaji token (e.g., "gakkoukara")
 * @param {Map} exactMatchIndex - Dictionary for validation
 * @param {Fuse} fuse - Fuzzy search engine for stems
 * @returns {Array<{ stemHira: string, stemRomaji: string, grammarId: string,
 *                    grammarMeaning: string, grammarTitle: string, anchor: string,
 *                    priority: number, isFuzzy: boolean, distance: number }>}
 */
export function peelGrammarSuffix(hiraPrefix, romajiPrefix, exactMatchIndex, fuse) {
  if (!grammarSuffixMap || hiraPrefix.length < 3) return [];

  const results = [];
  const maxLen = Math.min(maxSuffixLen, hiraPrefix.length - 2); // stem must be >= 2 chars

  for (let suffixLen = maxLen; suffixLen >= 2; suffixLen--) {
    const suffix = hiraPrefix.slice(-suffixLen);
    const entries = grammarSuffixMap.get(suffix);
    if (!entries) continue;

    const stemHira = hiraPrefix.slice(0, -suffixLen);
    if (stemHira.length < 2) continue; // stem too short

    // Convert stem back to romaji
    const stemRomaji = wanakana.toRomaji(stemHira).toLowerCase();
    
    // Check for exact stem match
    let stemMatches = [];
    const exactEntries = exactMatchIndex.get(stemRomaji);
    if (exactEntries) {
        stemMatches = exactEntries.map(e => ({ entry: e, distance: 0 }));
    } else if (stemRomaji.length >= 4 && fuse) {
        // FUZZY STEM REPAIR: If we have a strong grammar anchor but corrupted stem,
        // search for the stem in the dictionary. Skip for very short stems to avoid noise/latency.
        const fuzzy = fuse.search(stemRomaji).slice(0, 2);
        for (const f of fuzzy) {
            const fEntries = exactMatchIndex.get(f.item);
            if (fEntries) {
                stemMatches.push(...fEntries.map(e => ({ entry: e, distance: f.score })));
            }
        }
    }

    if (stemMatches.length === 0) continue;

    // Only use the first (highest priority) grammar match for this suffix
    const best = entries.reduce((a, b) => (b.priority > a.priority ? b : a), entries[0]);

    for (const match of stemMatches) {
        if (!match.entry) continue;
        results.push({
            id: match.entry.id,
            stemHira,
            stemRomaji: match.entry.romaji || stemRomaji,
            grammarId: best.grammarId,
            grammarMeaning: (best.meanings || []).join(', ') || best.title,
            grammarTitle: best.title,
            anchor: suffix,
            priority: best.priority,
            isFuzzy: match.distance > 0,
            distance: match.distance,
            entry: match.entry
        });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────
// Phase 2: Multi-Token Collapse & Orphan Merge
// ─────────────────────────────────────────────────────────────────

// Low-confidence decisions that indicate garbage output
const GARBAGE_DECISIONS = new Set([
  'passthrough', 'passthrough:low_confidence', 'skipped (too short)'
]);

function isLowConfidence(tok) {
  if (!tok) return false;
  if (GARBAGE_DECISIONS.has(tok.decision)) return true;
  // Fuzzy matches with very high distance are effectively garbage
  if (tok.decision && tok.decision.startsWith('fuzzy') && tok.meta?.candidates?.[0]?.distance > 0.2) return true;
  return false;
}

/**
 * Post-beam-search pass that:
 * 1. Detects multi-token grammar patterns across whitespace boundaries
 * 2. Merges adjacent garbage tokens and re-runs them through the beam search
 *
 * @param {Array} winningPath - The beam search's winning token sequence
 * @param {Function} processTextSegmentFn - The processTextSegment function for re-evaluation
 * @param {Function} segmentAndProcessFn - The full segmentAndProcess function for merged chunks
 * @returns {Array} - Modified winning path with grammar tokens and merged results
 */
export function collapseGrammarTokens(winningPath, processTextSegmentFn, segmentAndProcessFn) {
  if (!grammarSuffixMap || winningPath.length < 2) return winningPath;

  let result = [...winningPath];
  let changed = true;

  // ── Pass 1: Multi-Token Grammar Pattern Detection ──────────────
  // Slide a window across adjacent tokens and check if their concatenated
  // surfaces match a grammar anchor.
  changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < result.length - 1; i++) {
      // Try window sizes 4 down to 2
      for (let winSize = Math.min(4, result.length - i); winSize >= 2; winSize--) {
        const windowTokens = result.slice(i, i + winSize);

        // Prevent infinite loops: if we already collapsed part of this window into a grammar token, skip it
        if (windowTokens.some(t => t.type === 'grammar')) continue;

        // Build joined string ignoring spaces/punctuation so patterns match across them
        const joinedHira = windowTokens
          .filter(t => t.type !== 'punctuation')
          .map(t => t.surface || '')
          .join('');

        // Check if the joined surface STARTS WITH a grammar anchor
        // (the remainder after the anchor keeps its original parse)
        const maxCheck = Math.min(maxSuffixLen, joinedHira.length);
        for (let anchorLen = maxCheck; anchorLen >= 2; anchorLen--) {
          const candidate = joinedHira.slice(0, anchorLen);
          const entries = grammarSuffixMap.get(candidate);
          if (!entries) continue;

          // Found a grammar match — but only act on it if at least one token in
          // the window is low-confidence (avoid breaking already-correct parses)
          const hasGarbage = windowTokens.some(t => isLowConfidence(t));
          if (!hasGarbage) continue;

          const best = entries.reduce((a, b) => (b.priority > a.priority ? b : a), entries[0]);
          let meanings;
          try { meanings = (best.meanings || []).join(', '); } catch { meanings = best.title; }

          // Build the grammar token
          const grammarTok = {
            surface: candidate,
            output: wanakana.toRomaji(candidate),
            base: best.grammarId,
            meaning: meanings,
            grammar_tags: [best.grammarId],
            type: 'grammar',
            decision: `grammar:${best.grammarId}`,
            meta: { grammar_obj: best, type: 'grammar' }
          };

          // Handle any remainder after the grammar pattern
          const remainder = joinedHira.slice(anchorLen);
          const newTokens = [grammarTok];

          if (remainder.length >= 2) {
            const remRomaji = wanakana.toRomaji(remainder);
            const remEval = processTextSegmentFn(remRomaji, remainder);
            newTokens.push(remEval);
          } else if (remainder.length === 1) {
            // Single-char remainder — treat as particle or passthrough
            const remRomaji = wanakana.toRomaji(remainder);
            newTokens.push({
              surface: remainder,
              output: remRomaji,
              base: remRomaji,
              meaning: '',
              grammar_tags: [],
              type: 'text',
              decision: 'particle'
            });
          }
          
          console.log('PASS 1 REPLACED:', { window: windowTokens.map(t => t.surface), anchor: candidate, remainder, replacedWith: newTokens.map(t => t.surface) });

          // Replace the window with our new tokens
          result.splice(i, winSize, ...newTokens);
          changed = true;
          break;
        }
        if (changed) break;
      }
      if (changed) break;
    }
  }

  // ── Pass 2: Orphan Merge ───────────────────────────────────────
  // When a token is low-confidence, try merging with its neighbor and
  // re-running through the full segmenter.
  for (let i = 1; i < result.length; i++) {
    const curr = result[i];
    const prev = result[i - 1];

    if (!isLowConfidence(curr)) continue;

    // Don't merge particles or grammar tokens
    if (prev.decision === 'particle' || prev.type === 'grammar') continue;
    if (curr.decision === 'particle' || curr.type === 'grammar') continue;

    // Merge the romaji of both tokens and re-run through segmenter
    const mergedRomaji = (prev.output || prev.surface || '') + (curr.output || curr.surface || '');
    if (mergedRomaji.length < 4) continue; // too short to be meaningful

    const mergedSegments = segmentAndProcessFn(mergedRomaji, false);

    // Calculate total confidence of merged vs unmerged
    const unmergedScore = (prev.meta?.candidates?.[0]?.adjustedScore || 0)
                        + (curr.meta?.candidates?.[0]?.adjustedScore || 0);

    const mergedScore = mergedSegments.reduce((sum, s) => {
      return sum + (s.meta?.candidates?.[0]?.adjustedScore || 0);
    }, 0);

    // Only accept merge if it's meaningfully better
    // AND doesn't just return more garbage
    const mergedHasGarbage = mergedSegments.some(s => isLowConfidence(s));
    const mergedIsBetter = mergedScore > unmergedScore * 1.2; // 20% improvement threshold

    if (mergedIsBetter && !mergedHasGarbage) {
      console.log('MERGE ACCEPTED:', { prev: prev.surface, curr: curr.surface, new: mergedSegments.map(s => s.surface) });
      // Replace the two tokens with the merged result
      result.splice(i - 1, 2, ...mergedSegments);
      i = Math.max(0, i - 2); // step back to re-check
    } else {
      console.log('MERGE REJECTED:', { prev: prev.surface, curr: curr.surface, better: mergedIsBetter, garbage: mergedHasGarbage });
    }
  }

  return result;
}
