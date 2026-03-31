/**
 * index.js
 * CLI entry point — interactive REPL for the medical interpreter.
 *
 * Usage:
 *   node src/index.js
 *
 * Prefixes:
 *   ENG: <text>  →  English → Japanese
 *   JAP: <text>  →  Japanese/romaji → English
 */

import 'dotenv/config';
import readline from 'readline';
import { interpret } from './interpreter.js';

const RESET  = '\x1b[0m';
const CYAN   = '\x1b[36m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED    = '\x1b[31m';
const DIM    = '\x1b[2m';

function banner() {
  console.log(`
${CYAN}╔══════════════════════════════════════════╗
║   🏥  Medical Interpreter  (Ollama)      ║
║   ENG: <text>  →  Japanese               ║
║   JAP: <text>  →  English                ║
║   Shortcuts: "!" = ENG:, "±" = JAP:      ║
║   Type "exit" to quit                    ║
╚══════════════════════════════════════════╝${RESET}
`);
}

async function main() {
  banner();

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: process.stdin.isTTY,
  });

  // Helper to ask a single question and return the answer
  const ask = () =>
    new Promise((resolve) => {
      if (!process.stdin.isTTY) {
        // Non-interactive mode: read lines via 'line' event instead of question()
        rl.once('line', resolve);
      } else {
        rl.question(`${CYAN}> ${RESET}`, resolve);
      }
    });

  while (true) {
    let rawInput;
    try {
      rawInput = await ask();
    } catch {
      break; // stdin closed
    }

    if (rawInput === undefined) break;

    const input = rawInput.trim();
    if (!input) continue;

    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log(`${DIM}Goodbye.${RESET}`);
      break;
    }

    let finalInput = input;
    if (finalInput.startsWith('!')) {
      finalInput = 'ENG: ' + finalInput.substring(1).trim();
    } else if (finalInput.startsWith('±')) {
      finalInput = 'JAP: ' + finalInput.substring(1).trim();
    }

    try {
      if (process.stdin.isTTY) process.stdout.write(`${DIM}Thinking...${RESET}\r`);
      
      const stream = interpret(finalInput);
      let startedStreaming = false;

      for await (const chunk of stream) {
        if (!startedStreaming && process.stdin.isTTY) {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(GREEN); // switch to output color once stream starts
          startedStreaming = true;
        }
        process.stdout.write(chunk);
      }
      
      if (!startedStreaming && process.stdin.isTTY) {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
      }
      process.stdout.write(`${RESET}\n\n`);
    } catch (err) {
      if (process.stdin.isTTY) {
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
      }
      console.error(`${RED}Error:${RESET} ${err.message}\n`);
    }
  }

  rl.close();
}

main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err.message);
  process.exit(1);
});

