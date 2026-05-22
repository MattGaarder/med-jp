/**
 * index.js
 * 
 * This file is the ENTRY POINT
 * This is where everything starts when you run:
 * 
 *    node src/index.js
 * 
 *    package.json -> 
 * 
 *   "main": "src/index.js",
 *      "scripts": {
 *      "start": "node --max-old-space-size=6144 src/index.js",
 * 
 * It creates a command-line interface (CLI) where the user can type input,
 * and it sends that input into your interpreter pipeline.
 */

// Load environment variables (like API URLs) from a .env file
import 'dotenv/config';

// Built-in Node.js module for reading user input from the terminal
import readline from 'readline';

// It takes input → processes it → returns a streamed response
import { interpret } from './interpreter.js';


const RESET  = '\x1b[0m';  // Reset color back to normal
const CYAN   = '\x1b[36m'; // Cyan text
const GREEN  = '\x1b[32m'; // Green text
const YELLOW = '\x1b[33m'; // Yellow text
const RED    = '\x1b[31m'; // Red text
const DIM    = '\x1b[2m';  // Dim/faded text


import { clearLogs, enableGlobalIntercept } from './logger.js';

// ─────────────────────────────────────────────
// Print startup banner
// ─────────────────────────────────────────────
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


// ─────────────────────────────────────────────
// MAIN FUNCTION - Program start
// ─────────────────────────────────────────────
async function main() {
  // Clear any existing logs and capture all pipeline output to pipeline.log
  clearLogs();
  enableGlobalIntercept();

  // Show banner when program starts
  banner();

  // Create a "readline interface"
  // This lets us read input from the terminal (like a chat prompt)
  const rl = readline.createInterface({
    input:    process.stdin,   // where input comes from 
    output:   process.stdout,  // where output goes
    terminal: process.stdin.isTTY, // whether interactive terminal
  });


  // ───────────────────────────────────────────
  // Helper function: ask user for input
  // Returns a Promise that resolves with what user typed
  // ───────────────────────────────────────────
  const ask = () =>
    new Promise((resolve) => {

      // If NOT interactive (e.g. piping input from a file)
      if (!process.stdin.isTTY) {
        // Listen for a single line of input
        rl.once('line', resolve);

      } else {
        // Interactive mode → show prompt ">"
        rl.question(`${CYAN}> ${RESET}`, resolve);
      }
    });


  // ───────────────────────────────────────────
  // Main loop: keeps running forever until user exits
  // ───────────────────────────────────────────
  while (true) {

    let rawInput;
    try {
      // Wait for user to type something
      rawInput = await ask();
    } catch {
      // If input stream is closed → exit loop
      break;
    }

    // If nothing was received → exit
    if (rawInput === undefined) break;

    // Remove extra spaces from input
    const input = rawInput.trim();

    // If empty input → skip and ask again
    if (!input) continue;


    // ─────────────────────────────────────────
    // Exit conditions
    // ─────────────────────────────────────────
    if (input.toLowerCase() === 'exit' || input.toLowerCase() === 'quit') {
      console.log(`${DIM}Goodbye.${RESET}`);
      break;
    }


    // ─────────────────────────────────────────
    // Handle shortcut prefixes
    // ─────────────────────────────────────────

    let finalInput = input;

    // "!" → treat as English input
    if (finalInput.startsWith('!')) {
      finalInput = 'ENG: ' + finalInput.substring(1).trim();

    // "±" → treat as Japanese input
    } else if (finalInput.startsWith('±')) {
      finalInput = 'JAP: ' + finalInput.substring(1).trim();
    }


    // ─────────────────────────────────────────
    // Send input into your interpreter pipeline
    // ─────────────────────────────────────────
    try {

      // Show "Thinking..." while waiting (only in interactive terminal)
      if (process.stdin.isTTY) {
        process.stdout.write(`${DIM}Thinking...${RESET}`);
      }

      // Call your pipeline → returns an async stream of text chunks
      const stream = interpret(finalInput);

      let startedStreaming = false;

      // Loop over chunks as they arrive (streaming output)
      for await (const chunk of stream) {

        // First chunk → clear "Thinking..." and switch to green text
        if (!startedStreaming && process.stdin.isTTY) {
          process.stdout.clearLine(0);
          process.stdout.cursorTo(0);
          process.stdout.write(GREEN);
          startedStreaming = true;
        }

        // Print each chunk to terminal
        process.stdout.write(chunk);
      }

      // If nothing was streamed, still clear the "Thinking..." line
      if (!startedStreaming && process.stdin.isTTY) {
        process.stdout.clearLine(0);
        process.stdout.cursorTo(0);
      }

      // Reset color and move to next line
      process.stdout.write(`${RESET}\n\n`);

    } catch (err) {

      // If error happens → clear line and show error message
      if (process.stdin.isTTY) {
        process.stdout.clearLine?.(0);
        process.stdout.cursorTo?.(0);
      }

      console.error(`${RED}Error:${RESET} ${err.message}\n`);
    }
  }


  // Close the readline interface when loop ends
  rl.close();
}


// ─────────────────────────────────────────────
// Start the program
// ─────────────────────────────────────────────

// Call main() and catch any fatal errors
main().catch((err) => {
  console.error(`${RED}Fatal:${RESET}`, err.message);
  process.exit(1); // exit program with error code
});