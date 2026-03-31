/**
 * ollamaClient.js
 * Low-level HTTP client for the Ollama /api/generate endpoint.
 */

import 'dotenv/config';

const BASE_URL = process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434';
const MODEL    = process.env.OLLAMA_MODEL    ?? 'med-interpreter';

export async function* generate(prompt) {
  console.log(`\x1b[90m[ollamaClient] Sending prompt to ${MODEL} with stream: true...\x1b[0m`);
  const response = await fetch(`${BASE_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      prompt,
      stream: true,
      think: false,       // Ollama native: disable Qwen3 thinking mode entirely
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`\x1b[31m[ollamaClient Error] ${response.status}: ${errorText}\x1b[0m`);
    throw new Error(`Ollama API error ${response.status}: ${errorText}`);
  }

  // Depending on the Node version, fetch returns a Web Stream. We use getReader:
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    
    buffer += decoder.decode(value, { stream: true });
    
    // Process JSON lines continuously
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete remainder in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed.response) {
          yield parsed.response;
        }
      } catch (err) {
        console.error(`\x1b[31m[ollamaClient Error] Failed to parse stream JSON: ${err.message}\x1b[0m`);
      }
    }
  }
}


