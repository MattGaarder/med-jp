# med-jp — Local Medical Interpreter

A real-time, fully local medical interpreter that translates between broken English medical notes and formal Japanese clinical sentences — and vice versa — using [Ollama](https://ollama.com) and Node.js. No cloud APIs. No network latency. No data leaves your machine.

---

## Table of Contents

1. [What It Does](#what-it-does)
2. [How to Run](#how-to-run)
3. [Architecture Overview](#architecture-overview)
4. [Module Breakdown](#module-breakdown)
   - [index.js](#indexjs)
   - [interpreter.js](#interpreterjs)
   - [promptBuilder.js](#promptbuilderjs)
   - [preprocessor.js](#preprocessorjs)
   - [ollamaClient.js](#ollamaclientjs)
5. [Preprocessing Pipeline (Deep Dive)](#preprocessing-pipeline-deep-dive)
6. [Vocabulary System](#vocabulary-system)
7. [Model Setup](#model-setup)
8. [Configuration](#configuration)
9. [Testing the Preprocessor](#testing-the-preprocessor)
10. [Proposed Future Changes](#proposed-future-changes)

---

## What It Does

You type a prefixed line. It returns a clean medical sentence.

```
> ENG: patient chest pain
患者は胸痛（きょうつう）を訴えています。

> JAP: zutsu hidoi
The patient has a severe headache.

> ENG: leg stiff wednesday taking persription
足がこわばっており、水曜日から処方された薬を服用しています。

> JAP: ahsi itai
The patient reports pain in the foot.
```

**Two directions, one interface:**

| Prefix | Input | Output |
|--------|-------|--------|
| `ENG:` | Broken / abbreviated English notes | Formal clinical Japanese sentence |
| `JAP:` | Romaji (misspelled, abbreviated, mixed) | Professional English medical sentence |

The system silently corrects misspellings, infers intent, and uses formal medical phrasing — without ever explaining itself or outputting anything other than the translation.

---

## How to Run

### Requirements

- [Node.js](https://nodejs.org) v18 or later (native `fetch` required)
- [Ollama](https://ollama.com) installed and running locally
- `qwen3.5:latest` pulled: `ollama pull qwen3.5:latest`

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Build the custom Ollama model (only needed once, or after Modelfile changes)
npm run setup

# 3. Start the interactive interpreter
npm start
```

### Usage

```
> ENG: <broken English medical notes>
> JAP: <romaji, misspelled or incomplete>
> exit
```

---

## Architecture Overview

```
User Input
    │
    ▼
┌─────────────────────────────────┐
│           index.js              │  ← Async readline REPL
│      (interactive CLI)          │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│         interpreter.js          │  ← Orchestrates pipeline
└────────┬────────────────────────┘
         │
         ├─────────────────────────────────────────┐
         ▼                                         ▼
┌────────────────────────┐            ┌────────────────────────┐
│    promptBuilder.js     │            │    preprocessor.js      │
│  (prompt engineering)  │◄───────────│  (input normalisation)  │
└──────────┬─────────────┘            └────────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│        ollamaClient.js          │  ← REST call to Ollama
│   POST /api/generate            │
└──────────┬──────────────────────┘
           │
           ▼
┌─────────────────────────────────┐
│     Ollama (local, port 11434)  │
│     Model: med-interpreter      │
│     Base:  qwen3.5:latest       │
└─────────────────────────────────┘
           │
           ▼
      Clean output
```

---

## Module Breakdown

### `index.js`

The entry point. Runs an async `readline` REPL that:

- Displays a welcome banner
- Reads one line at a time from stdin
- Handles both **interactive TTY** (shows a `> ` prompt) and **piped stdin** (e.g. `echo "..." | node src/index.js`)
- Passes valid input to `interpret()`, prints results in green
- Catches and prints errors without crashing
- Exits cleanly on `exit`, `quit`, or EOF

The async-loop pattern (instead of recursive `readline.question()` callbacks) specifically prevents `ERR_USE_AFTER_CLOSE` errors when Ollama's async response completes after stdin has closed.

---

### `interpreter.js`

Thin orchestration layer. Receives raw prefixed input:

```
"ENG: patient chest pain"
```

Calls `buildPrompt()` (which also preprocesses the input), sends the resulting prompt to Ollama via `ollamaClient`, then strips any accidental `"Output: ..."` echo from the model response before returning the final string.

---

### `promptBuilder.js`

Handles **prefix routing** and **prompt construction**.

1. Detects `ENG:` or `JAP:` prefix (case-insensitive)
2. Strips prefix, passes raw content to `preprocessor.js`
3. Injects the cleaned input into the appropriate prompt template
4. Returns the full prompt string

**Each template contains:**
- A clear `TASK` definition
- Explicit `RULES` (output only, no explanation, formal phrasing, etc.)
- 5 few-shot `EXAMPLES` covering typical medical inputs
- A `/no_think` directive at the end — Qwen3's signal to disable its internal reasoning chain

The `/no_think` directive is critical. Without it, Qwen3 generates a long `<think>...</think>` block before the answer. With `num_predict: 512`, this would consume most of the token budget and the actual translation would be cut off or blank.

---

### `preprocessor.js`

The most sophisticated module. Corrects noisy romaji and English input **before** it reaches the LLM.

See the [deep dive below](#preprocessing-pipeline-deep-dive) for full detail.

**Exports:**

| Export | Description |
|--------|-------------|
| `preprocessJap(text)` | Default singleton backed by `data/vocab.json` |
| `preprocessEng(text)` | Lightweight regex-based English typo fixer |
| `createPreprocessor({ vocabulary })` | Factory — build a custom instance with injected vocab |
| `loadVocabularyFromFile(path)` | Async — load vocab from an external JSON file |

---

### `ollamaClient.js`

Minimal HTTP wrapper around Ollama's REST API.

- `POST /api/generate` with `stream: false`
- Reads `OLLAMA_BASE_URL` and `OLLAMA_MODEL` from `.env`
- **Strips all `<think>...</think>` blocks** from the response before returning

The think-block stripping is the primary fix for blank output when using Qwen3. The model outputs its reasoning between `<think>` tags — if `num_predict` is too low and the thinking fills the budget, the actual answer is never emitted. The client strips any residual tags so the output is always clean.

---

## Preprocessing Pipeline (Deep Dive)

For `JAP:` input, the pipeline is:

```
Raw input: "ahsi itai"
    │
    ▼  1. Lowercase + collapse whitespace
    │
    "ahsi itai"
    │
    ▼  2. Tokenise
    │
    ["ahsi", "itai"]
    │
    ▼  3. Per token: WanaKana round-trip (romaji → hiragana → romaji)
    │     Enforces standard Hepburn variants:
    │       "si"  → "shi"   "tu" → "tsu"   "ti" → "chi"
    │       "ahsi" → "ahshi"  (partial transformation)
    │
    ["ahshi", "itai"]
    │
    ▼  4. Per token: Fuse.js fuzzy search against vocabulary
    │     (skipped for tokens ≤ 3 chars — single-syllable WK expansions
    │      are already correct; Fuse would over-extend them)
    │
    │     "ahshi" → Fuse → "ashi" (score: 0.2 ✓ within threshold 0.3)
    │     "itai"  → Fuse → "itai" (exact match, score: 0.0 ✓)
    │
    ["ashi", "itai"]
    │
    ▼  5. Reconstruct
    │
    "ashi itai"
    │
    ▼  → sent to LLM prompt
```

**Why this ordering matters:**

WanaKana first expands romaji variants (`"ahsi"` → `"ahshi"`), which gives Fuse a better normalised string to compare against the vocabulary — `"ahshi"` is edit distance 1 from `"ashi"`, scoring 0.2. Without WanaKana pre-processing, `"ahsi"` scores 0.27 against `"mahi"` (a false positive at threshold 0.3), and only 0.5 against `"ashi"`.

**The short-token guard:**

After WanaKana, tokens ≤ 3 characters are returned immediately without Fuse. This prevents `"shi"` (from `"si"`) being over-extended to `"shinzou"` or similar longer vocab entries.

---

## Vocabulary System

The fuzzy correction is driven by an external, pluggable vocabulary. The default is `data/vocab.json` — a plain JSON array of romaji strings covering common medical terminology (body parts, symptoms, medications, descriptors).

**Swap or extend the vocabulary at runtime:**

```js
import { createPreprocessor, loadVocabularyFromFile } from './src/preprocessor.js';

// Option A — inject inline
const { preprocessJap } = createPreprocessor({
  vocabulary: ['ashi', 'zutsuu', 'onaka', 'mune', 'itai'],
});

// Option B — load from external JSON
const { preprocessJap } = await loadVocabularyFromFile('./data/my-vocab.json');
```

**Rules for vocabulary entries:**
- Must be strings
- Will be lowercased and WanaKana-normalised automatically during setup
- The Fuse.js index is built **once** from the full list — no per-token rebuilding

---

## Model Setup

The custom Ollama model is defined in `modelfile/Modelfile`:

```
FROM qwen3.5:latest

PARAMETER temperature 0
PARAMETER top_p 0.1
PARAMETER num_predict 512
PARAMETER repeat_penalty 1.1

SYSTEM "..."
```

**Key parameters:**

| Parameter | Value | Reason |
|-----------|-------|--------|
| `temperature` | `0` | Fully deterministic output |
| `top_p` | `0.1` | Narrow token distribution — no creative wandering |
| `num_predict` | `512` | Must be high enough to clear Qwen3's thinking block before the answer |
| `repeat_penalty` | `1.1` | Prevents repetition loops |

The system prompt in the Modelfile defines the role only — it keeps the model in character for all turns. All task-specific instructions, rules, and examples live in `promptBuilder.js` at runtime, keeping the Modelfile minimal and under 10 lines.

---

## Configuration

`.env` at the project root:

```env
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_MODEL=med-interpreter
```

Change `OLLAMA_MODEL` to point at any other Ollama model without touching source code.

---

## Testing the Preprocessor

```bash
node test-preprocessor.js
```

Runs 15 assertions across four groups:
1. Default singleton (`data/vocab.json`)
2. `createPreprocessor()` with injected vocabulary
3. Empty vocabulary graceful fallback
4. `loadVocabularyFromFile()` async loader

---

## Proposed Future Changes

### Near-term

**1. Streaming output**  
Switch `stream: true` in `ollamaClient.js` and parse the newline-delimited JSON chunks. Cuts perceived latency significantly — the user sees characters as they arrive rather than waiting for the full response.

**2. Larger medical vocabulary**  
Replace the placeholder `data/vocab.json` with a full romaji medical dictionary (e.g. derived from MEDIS or ICD-10 term lists in Japanese). The system is already structured to accept it with zero code changes.

**3. Confidence score logging**  
Expose the Fuse.js match score as a debug log (gated behind a `DEBUG=1` env flag) so you can audit which tokens were corrected and by how much. Useful for tuning the threshold.

**4. Multi-word phrase matching**  
Fuse currently operates on single tokens. A bigram or trigram pass could catch corrections like `"mune itai"` → `"kyoutsuu"` as a compound, rather than relying on the LLM to infer it.

---

### Medium-term

**5. Streaming voice input (Whisper)**  
Replace keyboard typing with microphone input transcribed by [Whisper](https://github.com/openai/whisper) (`whisper.cpp` locally). The romaji preprocessor already handles the noisy, abbreviated output that ASR produces.

**6. Structured output mode**  
Add an `--json` flag that wraps the translation in:
```json
{
  "direction": "JAP→ENG",
  "raw_input": "zutsu hidoi",
  "preprocessed": "zutsuu hidoi",
  "translation": "The patient has a severe headache."
}
```
Useful for integration with EMR (Electronic Medical Record) systems.

**7. Context window (session memory)**  
Keep a sliding window of the last N exchanges so the model can resolve pronouns and maintain consistency across a consultation (`"はい"` in response to a previous question means something different from `"はい"` cold).

**8. Direction auto-detection fallback**  
If the prefix is missing, use a lightweight heuristic (fraction of ASCII vs CJK characters, presence of known romaji particles like `wa`, `ga`, `de`) to guess direction and proceed, rather than erroring.

---

### Long-term

**9. Fine-tuned adapter**  
Fine-tune a LoRA adapter on a curated parallel corpus of medical (EN, JA) sentence pairs. The base model (Qwen3 or Llama) stays frozen; only the adapter weights change. Swap adapters per department (cardiology, oncology, paediatrics).

**10. Web / mobile front-end**  
Expose the interpreter as a local HTTP server (`/translate` endpoint). A minimal React Native or PWA interface could run on a tablet at a hospital bedside — camera for reading printed forms, mic for voice, display for output.

---

## Lexical Intelligence System

We have upgraded the vocabulary system into a production-grade linguistic and semantic engine. Rather than relying on a simplified dataset, the new pipeline extracts rich data directly from the JMdict XML.

### 1. Data Extraction Pipeline (`scripts/build-lexicon.js`)
This script processes the 58MB `data/JMdict_b.xml` file to seamlessly compile a localized `data/vocab-enhanced.jsonl` vector dictionary without exceeding limited Node memory parameters.
- **Parsing**: Streams the XML, bypassing entity limits by manually identifying DOCTYPE tags and matching native `<field>` and `<misc>` XML entities (e.g. `med` → `medicine`) using a robust built-in entity map based on the JMdict DTD.
- **Linguistic Data**: Extracts Kana, Kanji, Meanings, Part of Speech, and Priority tags.
- **Kana → Romaji**: Uses WanaKana to generate Romaji for reliable searching.
- **Frequency Calculation**: Derives a normalized frequency score (`0.0` to `1.0`) from `nfXX`, `ichi1`, and `news1` markers.
- **Embeddings**: Generates a `combinedText` string and calls `qwen3-embedding:latest` via Ollama REST API to compute vector embeddings.

**Usage:**
```bash
# Test with the first 10 entries
node scripts/build-lexicon.js --test

# Run full pipeline (Requires `qwen3-embedding:latest` pulled in Ollama)
node scripts/build-lexicon.js
```

### 2. Example Output Entry (`vocab-enhanced.jsonl`)
```jsonl
{
  "romaji": "bouken",
  "kana": "ぼうけん",
  "kanji": "剖検",
  "meanings": ["autopsy", "necropsy"],
  "pos": ["n", "vs"],
  "tags": ["medicine"],
  "priority": ["ichi1", "news1"],
  "frequency": 0.82,
  "combinedText": "bouken autopsy necropsy medicine",
  "embedding": [0.015, -0.022, 0.841, "..."]
}
```

### 3. Hybrid Search (`src/hybridSearch.js`)
The `hybridSearch(queryText, queryEmbedding, dataset)` function powers retrieval by blending three weighted factors:
1. **Fuzzy Search (40%)**: `fuse.js` over romaji, kana, kanji, and meanings.
2. **Semantic Search (40%)**: Cosine similarity against the localized Ollama vector embeddings.
3. **Frequency (20%)**: The extracted frequency usage score.

**Usage:**
```bash
# Tests a sample hybrid query against the enhanced vocab dataset
node test-hybrid.js
```
