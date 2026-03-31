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
export async function* interpret(rawInput) {
  console.log(`\x1b[90m[interpreter] Building prompt...\x1b[0m`);
  const { direction, prompt } = buildPrompt(rawInput);
  
  // Extract just the Input line from the prompt template to show the user the preprocessed romaji
  const preprocessedMatch = prompt.match(/NOW TRANSLATE:\nInput: (.*?)\nOutput/s);
  if (preprocessedMatch) {
    console.log(`\x1b[90m[interpreter] Preprocessed as: ${preprocessedMatch[1]}\x1b[0m`);
  }

  console.log(`\x1b[90m[interpreter] Requesting generation stream...\x1b[0m`);
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

