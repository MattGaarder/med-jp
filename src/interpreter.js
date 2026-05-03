/**
 * interpreter.js
 * Orchestrates the full interpretation pipeline:
 *   rawInput → preprocess → buildPrompt → generate → cleanedOutput
 */

import { buildPrompt } from './promptBuilder.js';
import { generate }     from './ollamaClient.js';

/**
 * Interpret a prefixed medical input string and stream the response.
 * @param {string} rawInput - e.g. "ENG: patient chest pain"
 * @returns {AsyncGenerator<string>} - Yields output text chunks.
 */

function formatTokenDebug(t, i) {
  const winner = t.meta?.candidates?.[0];
  let line = `[${i}] "${t.output}"`;
  line += ` | decision=${t.decision}`;
  if (winner) {
    line += `\n       → WINNER: ${winner.item}`;
    line += ` (${winner.type}, score=${winner.adjustedScore?.toFixed(1)})`;
  }
  if (t.meta?.candidates?.length) {
    const top = t.meta.candidates.slice(0, 3)
      .map(c => `${c.item}(${c.adjustedScore?.toFixed(0)})`)
      .join(', ');
    line += `\n       → TOP: ${top}`;
  }
  return line;
}

// function* is the syntax used to define a generator function.
// Unlike regular functions that run to completion once called,
// generator functions can pause their execution and resume later,
// maintaining their internal state (variable bindings) between each entrance
// Async generator: input → process (network) → stream MANY results over time

export async function* interpret(rawInput) {
  console.log(`\x1b[90m[interpreter] Building Sequence (RAG + Prompt)...\x1b[0m`);
  /**
   * Call buildPrompt(), which does:
   *   - preprocessing (tokenization, Viterbi-style segmentation)
   *   - scoring + candidate selection
   *   - RAG (embedding + ANN search + SQLite lookup)
   *   - prompt template assembly
   *
   * It returns an object like:
   * {
   *   direction: 'JAP→ENG',
   *   prompt: 'FULL PROMPT STRING SENT TO MODEL'
   * }
   */
  const {
    direction,
    prompt,
    preprocessedInput,
    ragHits,
    toneHits,
    tokenTrace,
    queryTokens,
    timings
  } = await buildPrompt(rawInput);

  console.log(`\n\x1b[36m[Direction]\x1b[0m ${direction}`);
  console.log(`\x1b[36m[Raw Input]\x1b[0m ${rawInput}`);
  console.log(`\x1b[36m[Preprocessed]\x1b[0m ${preprocessedInput}`);

  // Token Trace
  // ─────────────────────────────────────────────

  console.log(`\n\x1b[35m[Token Trace]\x1b[0m`);
  tokenTrace.forEach((t, i) => {
    console.log(formatTokenDebug(t, i));
  });

  // ─────────────────────────────────────────────
  // Query Tokens (used for embedding search)
  // ─────────────────────────────────────────────

  console.log(`\n\x1b[34m[Query Tokens]\x1b[0m [${queryTokens.join(', ')}]`);

  // ─────────────────────────────────────────────
  // RAG Hits (medical glossary)
  // ─────────────────────────────────────────────

  console.log(`\n\x1b[32m[RAG Hits]\x1b[0m`);
  ragHits.forEach((h, i) => {
    console.log(
      `  [${i}] ${h.item.romaji} → ${h.item.meanings?.join(', ')} ` +
      `(score=${h.score.toFixed(3)}, semantic=${h.semanticScore.toFixed(3)})`
    );
  });

  // ─────────────────────────────────────────────
  // Tone Hits (contextual hints)
  // ─────────────────────────────────────────────

  if (toneHits?.length) {
    console.log(`\n\x1b[33m[Tone Hits]\x1b[0m`);
    toneHits.forEach((h, i) => {
      console.log(
        `  [${i}] ${h.item.romaji} → ${h.item.meanings?.join(', ')}`
      );
    });
  }

  // ─────────────────────────────────────────────
  // Timings
  // ─────────────────────────────────────────────

  console.log(`\n\x1b[90m[Timings]\x1b[0m`);
  Object.entries(timings).forEach(([key, val]) => {
    console.log(`  ${key}: ${val.toFixed(2)}ms`);
  });


  console.log(`\n\x1b[90m[interpreter] Requesting generation stream...\x1b[0m`);
  const stream = generate(prompt);

  // Strip any accidental prefix echoing in the very first yielded chunk
  let firstChunk = true;
  for await (const chunk of stream) {
    if (firstChunk) {
      let clean = chunk.replace(/^(output|translation)\s*:\s*/i, '');
      yield clean;
      firstChunk = false;
    } else {
      yield chunk;
    }
  }
}

