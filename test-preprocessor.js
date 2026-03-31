/**
 * test-preprocessor.js
 * Quick verification suite for the WanaKana + Fuse.js preprocessor.
 * Run with: node test-preprocessor.js
 */

import { createPreprocessor, loadVocabularyFromFile, preprocessJap } from './src/preprocessor.js';

const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';
const DIM    = '\x1b[2m';

let passed = 0;
let failed = 0;

function test(label, got, expected) {
  const ok = got === expected;
  if (ok) {
    console.log(`${GREEN}✓${RESET} ${label}`);
    console.log(`  ${DIM}got: "${got}"${RESET}`);
    passed++;
  } else {
    console.log(`${RED}✗${RESET} ${label}`);
    console.log(`  ${YELLOW}expected: "${expected}"${RESET}`);
    console.log(`  ${RED}got:      "${got}"${RESET}`);
    failed++;
  }
}

// ─────────────────────────────────────────────────────────────────
// 1. Default singleton (loads data/vocab.json automatically)
// ─────────────────────────────────────────────────────────────────

console.log(`\n${CYAN}── Default singleton (data/vocab.json) ──────────────────────${RESET}`);

test('transposition fix: "ahsi itai" → "ashi itai"',
  preprocessJap('ahsi itai'), 'ashi itai');

test('long-vowel fix: "zutsu hidoi" → "zutsuu hidoi"',
  preprocessJap('zutsu hidoi'), 'zutsuu hidoi');

test('extra vowel fix: "onakaa itai" → "onaka itai"',
  preprocessJap('onakaa itai'), 'onaka itai');

test('WanaKana round-trip: "si" → "shi"',
  preprocessJap('si'), 'shi');

test('WanaKana round-trip: "tu" → "tsu"',
  preprocessJap('tu'), 'tsu');

test('WanaKana round-trip: "ti" → "chi"',
  preprocessJap('ti'), 'chi');

test('clean pass-through (already correct)',
  preprocessJap('mune itai'), 'mune itai');

test('case normalisation',
  preprocessJap('ATAMA ITAI'), 'atama itai');

test('extra spaces collapsed',
  preprocessJap('  onaka   itai  '), 'onaka itai');

// ─────────────────────────────────────────────────────────────────
// 2. createPreprocessor() with injected vocabulary
// ─────────────────────────────────────────────────────────────────

console.log(`\n${CYAN}── createPreprocessor() with custom vocabulary ──────────────${RESET}`);

const { preprocessJap: pp } = createPreprocessor({
  vocabulary: ['ashi', 'atama', 'zutsuu', 'onaka', 'itai', 'mune', 'nodo', 'hidoi'],
});

test('custom vocab: "ahsi itai" → "ashi itai"',
  pp('ahsi itai'), 'ashi itai');

test('custom vocab: "zutsu hidoi" → "zutsuu hidoi"',
  pp('zutsu hidoi'), 'zutsuu hidoi');

test('no false correction: unknown word preserved',
  pp('xyz123 itai'), 'xyz123 itai');

// ─────────────────────────────────────────────────────────────────
// 3. Empty vocabulary graceful fallback
// ─────────────────────────────────────────────────────────────────

console.log(`\n${CYAN}── Empty vocabulary graceful fallback ───────────────────────${RESET}`);

const { preprocessJap: ppEmpty } = createPreprocessor({ vocabulary: [] });

test('empty vocab: WanaKana still runs, no crash',
  ppEmpty('si itai'), 'shi itai');

// ─────────────────────────────────────────────────────────────────
// 4. loadVocabularyFromFile()
// ─────────────────────────────────────────────────────────────────

console.log(`\n${CYAN}── loadVocabularyFromFile() ──────────────────────────────────${RESET}`);

const { preprocessJap: ppFile } = await loadVocabularyFromFile('./data/vocab.json');

test('file loader: "ahsi itai" → "ashi itai"',
  ppFile('ahsi itai'), 'ashi itai');

test('file loader: "zutsu hidoi" → "zutsuu hidoi"',
  ppFile('zutsu hidoi'), 'zutsuu hidoi');

// ─────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────

console.log(`\n${CYAN}─────────────────────────────────────────────────────────────${RESET}`);
console.log(`${GREEN}Passed: ${passed}${RESET}  ${failed > 0 ? RED : ''}Failed: ${failed}${RESET}\n`);
if (failed > 0) process.exit(1);
