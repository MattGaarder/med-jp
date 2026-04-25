# med-jp — Technical Documentation

> **A local, real-time Japanese ↔ English medical interpreter.**
> You speak broken romaji → the system figures out what words you meant → an LLM translates it into natural English.

---

## Table of Contents

1. [How It Works (Plain English)](#1-how-it-works-plain-english)
2. [Technology Stack](#2-technology-stack)
3. [The Build Pipeline (How Data Gets Prepared)](#3-the-build-pipeline-how-data-gets-prepared)
4. [The Runtime Pipeline (How Translation Happens)](#4-the-runtime-pipeline-how-translation-happens)
5. [The Scoring System (How Candidates Get Ranked)](#5-the-scoring-system-how-candidates-get-ranked)
6. [RAG — Retrieval-Augmented Generation](#6-rag--retrieval-augmented-generation)
7. [MeSH Annotation (Clinical Ontology)](#7-mesh-annotation-clinical-ontology)
8. [Evaluation Harness](#8-evaluation-harness)
9. [Known Issues & Future Work](#9-known-issues--future-work)

---

## 1. How It Works (Plain English)

```
You type:  "JAP: kusuri wo kudasai"
           ↓
Step 1:    Convert romaji → hiragana: "くすりをください"
           ↓
Step 2:    Beam search tries every possible way to chop this into words:
           "くすり|を|ください" vs "くす|りを|ください" vs ...
           For each chunk, look up candidates in the dictionary.
           ↓
Step 3:    Score each candidate. "kusuri = medicine (1162 pts)" beats
           "kusari = chain (912 pts)" because medicine gets a +120 domain boost.
           ↓
Step 4:    Context check: look at ±3 neighboring words. If neighbors mention
           medical stuff, boost medical candidates further.
           ↓
Step 5:    RAG: embed the top candidates and search for similar medical terms
           in a vector database. Inject the best matches as glossary hints.
           ↓
Step 6:    Build a prompt with the romaji + glossary hints, send to the LLM.
           ↓
Output:    "Please give me the medicine."
```

---

## 2. Technology Stack

| Component | Library | What It Does |
|-----------|---------|-------------|
| Runtime | **Node.js** (ES Modules) | Runs everything |
| Romaji ↔ Kana | [**wanakana**](https://github.com/WaniKani/WanaKana) | Converts "kusuri" → "くすり" and back |
| Fuzzy Search | [**Fuse.js**](https://fusejs.io/) | Finds approximate dictionary matches when spelling is off |
| Dictionary DB | [**better-sqlite3**](https://github.com/WiseLibs/better-sqlite3) | Fast dictionary lookups (the single source of truth at runtime) |
| Vector Index | [**hnswlib-node**](https://github.com/yoshoku/hnswlib-node) | Finds semantically similar words (explained in [§6](#6-rag--retrieval-augmented-generation)) |
| XML Parsing | [**fast-xml-parser**](https://github.com/NaturalIntelligence/fast-xml-parser) | Reads JMDict and MeSH XML files during build |
| Env Config | [**dotenv**](https://github.com/motdotla/dotenv) | Loads `OLLAMA_BASE_URL` and `OLLAMA_MODEL` |
| LLM | [**Ollama**](https://ollama.ai/) (local) | Hosts the `qwen3.5` model as `med-interpreter` |
| Embeddings | **qwen3-embedding** (via Ollama) | Turns words into number-vectors for the vector search |

---

## 3. The Build Pipeline (How Data Gets Prepared)

Before the interpreter can run, dictionary data must be prepared. This happens **once** (or when updating the dictionary). Here's the actual build order:

```
  JMDict XML (data/JMdict_b.xml)
       │
       ▼
  ┌─────────────────────────────────┐
  │  build-lexicon.js               │  Step 1: Parse XML + generate embeddings
  │  Reads XML, extracts all entries│  Output: vocab-v3.jsonl
  │  Calls qwen3-embedding for each │  (one JSON object per line, ~18 GB)
  └──────────┬──────────────────────┘
             │
      ┌──────┴──────┐
      ▼              ▼
  ┌──────────┐  ┌──────────────┐
  │ build-   │  │ build-       │  Step 2a + 2b (can run in parallel)
  │ sqlite.js│  │ index.js     │
  │          │  │              │
  │ Output:  │  │ Output:      │
  │ vocab.db │  │ hnsw.index   │  The vector index (3.4 GB binary)
  │ (90 MB)  │  │ metadata.json│  Lightweight text data for each entry
  └────┬─────┘  └──────────────┘
       │
       ▼
  ┌─────────────────────────────────┐
  │  annotate-mesh.js               │  Step 3: Match entries against MeSH
  │  + import-mesh.js               │  Writes mesh_annotations + mesh_domains
  │                                 │  back into vocab.db
  └─────────────────────────────────┘
```

### What each step produces

#### Step 1: `build-lexicon.js` → `vocab-v3.jsonl`

**File**: [`scripts/build/build-lexicon.js`](scripts/build/build-lexicon.js)

Parses the full JMDict XML and for each dictionary entry:
1. Extracts: kanji, kana, romaji (via WanaKana), POS tags, domain tags, priority tags, meanings
2. Builds a text string for embedding: `"kusuri 薬 (くすり) type: noun domain: medicine meanings: medicine, pharmaceuticals"`
3. Calls qwen3-embedding (via Ollama) to turn that string into a 4096-dimensional number-vector
4. Writes one JSON line per entry to `vocab-v3.jsonl`

The embedding text string includes metadata like `type:` and `domain:` because embedding models use these labels to understand what kind of word it is. This makes similar medical terms cluster together in vector space.

**The `freq` column**: `build-lexicon.js` calls `calculateScore()` from `linguistics.js` to compute a frequency score and stores it in the JSONL. However, **this stored `freq` value is largely a legacy artifact** — at runtime, `calculateScore()` is called fresh on every lookup by reading the `tags` column directly. The `freq` column is only used for tie-breaking in some SQL `ORDER BY` clauses.

#### Step 2a: `build-sqlite.js` → `vocab.db`

**File**: [`scripts/build/build-sqlite.js`](scripts/build/build-sqlite.js)

Reads the JSONL and inserts everything into a SQLite database. This is **the single source of truth** at runtime — the preprocessor loads all entries from here at boot.

**Schema** (`vocab` table):
| Column | What's in it |
|--------|-------------|
| `id` | Integer primary key (matches HNSW entry ID) |
| `romaji` | Romanized reading (e.g., "kusuri") |
| `kanji` | Kanji writing (e.g., "薬") |
| `kana` | Kana reading (e.g., "くすり") |
| `primary_meaning` | First English meaning |
| `secondary_meanings` | Other meanings (CSV) |
| `pos` | Part-of-speech tags (e.g., "n, vs, vt") |
| `domain` | JMDict field tag (e.g., "medicine", "anatomy") |
| `tags` | Priority tags (e.g., "ichi1, news1, nf04") — **this is what drives scoring** |
| `freq` | Pre-computed frequency score (legacy; scoring uses `tags` directly) |
| `mesh_annotations` | JSON array of MeSH clinical annotations (added by Step 3) |
| `mesh_domains` | JSON array — e.g., `["mesh_disease"]` (added by Step 3) |

**SQLite indexes** (idx_romaji, idx_domain, idx_freq): These are standard database performance optimizations — they make `WHERE romaji = ?` lookups fast (O(log n) instead of O(n)). They have nothing to do with the HNSW vector index.

#### Step 2b: `build-index.js` → `hnsw.index` + `metadata.json`

**File**: [`scripts/build/build-index.js`](scripts/build/build-index.js)

Reads the JSONL and builds the vector index for RAG search:
1. Strips the embedding vector from each entry
2. Inserts it into an HNSW index (a data structure optimized for "find the nearest neighbors")
3. Saves the remaining text metadata in a JSON map

#### Step 3: `annotate-mesh.js` + `import-mesh.js` → Updates `vocab.db`

**Files**: [`scripts/build/annotate-mesh.js`](scripts/build/annotate-mesh.js), [`scripts/build/import-mesh.js`](scripts/build/import-mesh.js)

Matches dictionary entries against the MeSH medical ontology (30,000+ medical descriptors). Writes `mesh_annotations` and `mesh_domains` columns back into `vocab.db`. See [§7](#7-mesh-annotation-clinical-ontology) for details.

---

## 4. The Runtime Pipeline (How Translation Happens)

### 4.1 Entry & Dispatch

**Files**: [`src/index.js`](src/index.js), [`src/interpreter.js`](src/interpreter.js)

A CLI REPL that accepts prefixed input (`JAP: ...` or `ENG: ...`). Calls `buildPrompt()` → `generate()` → streams output.

### 4.2 The Preprocessor — Token Disambiguation

**File**: [`src/preprocessor.js`](src/preprocessor.js)

At boot, the preprocessor loads **all entries from vocab.db** into a `Map<romaji, entry[]>` called `knownWords`. This is the in-memory dictionary used for all lookups.

For each romaji token, the preprocessor generates candidates through three passes:

#### Pass 1: Exact Match
Look up the token directly in `knownWords`. If "kusuri" exists as a key, all entries under that key become candidates tagged `exact`.

#### Pass 2: Fuzzy Match
Use Fuse.js (threshold 0.3) to find approximate matches. "kusari" might fuzzy-match "kusuri" with a small distance. Tagged `fuzzy`.

#### Pass 3: Deinflection
Convert to hiragana, run through the [deinflection engine](src/deinflect.js) (38 inflection rules for Japanese verb/adjective forms), look up the root form. Tagged `deinflect`.

All three passes also run on **variant forms** of the input:
- **Repair variants**: If WanaKana can't convert part of the input, try inserting vowels (e.g., `btsu` → `butsu`, `betsu`, `bitsu`)
- **Doubling variants**: Try doubling consonants (e.g., `tabako` → `tabbako`)
- **WK-normalized**: Round-trip through WanaKana (romaji→hiragana→romaji)

Each candidate is scored using `calculateSegmentScore()` — see [§5](#5-the-scoring-system-how-candidates-get-ranked).

### 4.3 Beam Search — Finding Word Boundaries

**File**: [`src/preprocessor.js`](src/preprocessor.js), `segmentAndProcess()`

Japanese has no spaces. "kitsueninshu" could be one word or three. The beam search finds the best way to split it:

1. Convert the entire input chunk to hiragana
2. Try every possible split point (prefixes up to 15 characters long)
3. For each prefix, run the full candidate generation (exact/fuzzy/deinflect)
4. Keep the top 3 lowest-cost paths (beam width = 3)
5. The path with the lowest total cost wins

**Cost formula**: `cost = 2500 - adjustedScore` (converts "higher is better" scoring to "lower is better" for Dijkstra-style minimization). Short segments (< 4 chars) get a penalty to discourage over-fragmentation.

### 4.4 Neighbor-Context Second Pass (±3 Window)

**File**: [`src/preprocessor.js`](src/preprocessor.js), after beam search

After the beam search picks winners, a **second pass** re-examines each token using ±3 neighboring tokens as context. This pass uses **English definition word overlap** — it is purely text-based, not vector-based.

#### How it works, step by step

Given the sentence `marifuana kokain krauku nado sesshushiteimasu ka`:

1. The beam search runs and picks initial winners purely by score:
   - `marifuana` → marijuana (exact match, ~1020 pts)
   - `kokain` → cocaine (exact match, ~1020 pts)  
   - `krauku` → **kiraku** (carefree, fuzzy:repair, ~889 pts) — ❌ WRONG. Should be `kurakku` (crack, ~855 pts)

2. The context pass now re-examines `krauku`'s candidates. It looks at ±3 neighbors and collects their English meanings:
   - Neighbor `marifuana`: meaning = "marijuana"
   - Neighbor `kokain`: meaning = "cocaine"
   - Neighbor `nado`: meaning = "et cetera"

3. It builds a context set: `{marijuana, cocaine, cetera, ...}`

4. It checks each candidate for `krauku`:
   - `kiraku` (carefree) → definition words: `{carefree, comfortable, ease, easygoing}` → **0 overlap** with `{marijuana, cocaine}`
   - `kurakku` (crack) → definition words: `{crack}` → **0 overlap** with `{marijuana, cocaine}` ← The word "crack" doesn't literally appear in the word "cocaine"

5. **Result: No flip occurs.** The context pass fails here because it relies on **exact English string matching**. The word "crack" doesn't contain the substring "cocaine" or "marijuana", so the system sees zero semantic connection between crack cocaine and cocaine — even though a human immediately sees they're related.

> **Key limitation**: The ±3 context pass is a crude text overlap engine. It cannot understand that "crack" and "cocaine" are in the same drug family. It only works when definitions share literal words (e.g., two candidates both mentioning "medicine" or "pain").

### 4.5 Prompt Construction & LLM

**Files**: [`src/promptBuilder.js`](src/promptBuilder.js), [`src/ollamaClient.js`](src/ollamaClient.js)

The prompt builder:
1. Runs the RAG pipeline (see [§6](#6-rag--retrieval-augmented-generation)) to find medical glossary hints
2. Constructs a prompt with the preprocessed romaji + glossary hints + tone hints
3. Sends it to Ollama (qwen3.5, temperature=0, top_p=0.1 for near-deterministic output)
4. Streams the response back

---

## 5. The Scoring System (How Candidates Get Ranked)

**File**: [`src/config/linguistics.js`](src/config/linguistics.js)

This is the **most important component** for translation quality. Two functions work together:

### 5.1 `calculateScore()` — "How important is this word?"

Computes a point-based importance score for any dictionary entry by reading its tags and domain:

| Factor | Points | Where it comes from |
|--------|--------|-------------------|
| **NF Frequency** | `max(0, 100 - nf×2)` | The `nfXX` tag (e.g., nf04 = 92 pts, nf48 = 4 pts) |
| **ichi1** (common word) | +40 | JMDict priority tag |
| **news1** (newspaper word) | +30 | JMDict priority tag |
| **spec1** (specialist word) | +50 | JMDict priority tag |
| **Medicine domain** | +120 | JMDict field tag (e.g., `domain: "medicine"`) |
| **Anatomy domain** | +80 | JMDict field tag |
| **Pharmacology domain** | +100 | JMDict field tag |
| **MeSH Disease** | +80 | From mesh_domains column (e.g., `["mesh_disease"]`) |
| **MeSH Drug** | +70 | From mesh_domains column |

**Example**: "kusuri" (medicine) has tags `ichi1, news1, nf04` + domain `medicine`:
```
nf04 → 92 + ichi1 → 40 + news1 → 30 + medicine → 120 = 282 points
```

This is called **at runtime on every lookup**, not from a pre-computed column. The `tags` column in vocab.db is the source of truth.

### 5.2 `calculateSegmentScore()` — "How confident is this match?"

Combines the importance score with match quality:

```
finalScore = BaseTier + Points - (TypoPenalty + LengthPenalty + UtilityPenalty)
```

#### Base Tier — How the candidate was found

| Match Type | Base Score | Meaning |
|-----------|-----------|---------|
| `exact` | 1000 | Direct dictionary hit |
| `normalized` | 950 | WanaKana round-trip normalization |
| `deinflect` | 900 | Rule-based morphological analysis found the root |
| `fuzzy` | 800 | Fuse.js approximate match |
| `aggressive` | 400 | Repair/doubling variant |

Sub-type adjustments: `exact:repair` → −50, `exact:doubling` → −100, `fuzzy` on non-original variant → −50

#### Penalties

**Typo penalty** (how far off the fuzzy match is):
```js
typoPenalty = Math.pow(distance, distance < 0.05 ? 0.8 : 1.2) * 150
```

**Length penalty** (input vs match length difference):
```js
lengthPenalty = |inputLen - matchLen| × 40
```

**Utility penalty** (common noise words like suru, aru, desu):
```js
utilityPenalty = 80 (or 160 for "suru")
```

#### Worked Example

"kusuri" exact match (medicine, ichi1 + news1 + nf04 + domain:medicine):
```
Base:    1000 (exact)
Points:  +282 (92 + 40 + 30 + 120)
Typo:    -0   (exact match, no distance)
Length:  -0   (same length)
───────────────────
Total:   1282 points
```

"kusari" fuzzy match (chain, no special tags):
```
Base:    800  (fuzzy)
Points:  +0   (no tags, no domain)
Typo:    -17  (fuse.js score ~0.15)
Length:  -0
───────────────────
Total:   783 points
```

kusuri wins by 499 points — clear medical term prioritization.

---

## 6. RAG — Retrieval-Augmented Generation

### What RAG does in this system

RAG serves **two separate purposes** in this pipeline:

1. **Glossary Hints for the LLM**: Inject medical vocabulary hints into the prompt so the LLM knows context (e.g., `MEDICAL GLOSSARY HINTS: - kusuri: medicine`)
2. **Vector Space Reranking**: Compare each preprocessor candidate's vector embedding against the sentence's meaning vector — if a candidate is semantically close to the overall sentence, boost its score

### The full RAG flow, step by step

#### Step 1: Build the Query Tokens

**File**: [`src/promptBuilder.js`](src/promptBuilder.js), lines 342–406

After the preprocessor has produced its token trace (with winners and losers for each position), the system extracts **query tokens** to represent "what is this sentence about?"

The extraction logic:
1. Walk through each token in the trace
2. Skip particles (`ha`, `ga`, `wo`), skipped tokens, and single-character tokens
3. For each remaining token, take the **top 2 candidates' romaji** (not just the winner)
4. Deduplicate across all tokens
5. Sort by clinical priority (medical domain words first)
6. POS-filter to remove grammatical words (adverbs, conjunctions, counters)
7. Take the top 10

**Example** (case-04, drug query sentence):
```
Input:    marifuana kokain krauku nado sesshushiteimasu ka
Winners:  marifuana, kokain, kiraku, nado, sesshushiteimasu, ka

Query tokens extracted: [marifuana, kokain, kokkai, kiraku, nando]
                                           ^^^^^   ^^^^^^
                                           These are LOSING candidates that got included
```

> ⚠️ **THE QUERY POLLUTION PROBLEM**
>
> Notice that `kokkai` (National Diet — a **losing** candidate for the `kokain` token position) 
> and `kiraku` (carefree — the **wrong** winner for the `krauku` position) are both included 
> in the query tokens. These words have nothing to do with drugs, but they're being sent to 
> the embedding model to represent "what this sentence is about."
>
> This creates a **negative feedback loop**:
> 1. The preprocessor picks some wrong winners (kiraku instead of kurakku)
> 2. Those wrong winners get fed into the RAG query tokens
> 3. The embedding model creates a vector that is a blend of drug words AND noise words
> 4. The resulting "sentence meaning" vector is diluted — it's less drug-like than it should be
> 5. When comparing candidates against this diluted vector, drug words like `kurakku` (crack) 
>    don't score high enough to flip the ranking
> 6. The wrong winners persist, potentially feeding into future context decisions
>
> **The top-2 candidate extraction was designed to mitigate this** — by including both the winner 
> AND the runner-up, the system hedges its bets. If `kokain` is the winner and `kokkai` is #2, 
> both go into the query. But this also means noise always leaks in alongside signal.

#### Step 2: Generate the Embedding

```js
const medEmbed = await getSentenceEmbedding("marifuana kokain kokkai kiraku nando");
```

This sends the query string to `qwen3-embedding` (via Ollama) and gets back a 4096-dimensional vector — a point in mathematical space that represents the "meaning" of this collection of words.

#### Step 3: ANN Search for Glossary Hints

The `medEmbed` vector is searched against the HNSW index (204,560 pre-embedded dictionary entries) to find the 20 nearest neighbors in vector space. These are filtered:

- Clinical domain hits: accepted if `semanticScore ≥ 0.40`
- Non-clinical common words (nf01-03): excluded unless `semanticScore ≥ 0.90`
- Non-clinical meanings mentioning "officer", "military", "entertainment": strictly excluded
- Everything else: needs `semanticScore ≥ 0.92` or `≥ 0.85` with anchor overlap

The top 5 surviving hits become `MEDICAL GLOSSARY HINTS` in the LLM prompt.

#### Step 4: Vector Space Reranking (`rerankTrace`)

**File**: [`src/preprocessor.js`](src/preprocessor.js), `rerankTrace()` function

This is the most sophisticated scoring pass. For **every candidate** of **every token** in the sentence, the system:

1. Looks up the candidate's pre-computed 4096-dimensional vector from the HNSW index using its database `id`
2. Calculates the **cosine similarity** between that candidate's vector and the sentence's `medEmbed` query vector
3. If similarity > 0.60, applies a progressive boost (up to 450 points at similarity 0.85+)

```
Boost curve:
  cosSim ≤ 0.60  →  0 points
  cosSim = 0.70  →  180 points  (40% of max)
  cosSim = 0.80  →  360 points  (80% of max)
  cosSim ≥ 0.85  →  450 points  (100% — max boost)
```

##### Exact Match Ceiling Protection

To prevent hallucinations from overriding correct exact matches:
- If the current winner is an `exact` match with ≥ 1000 base points
- AND the challenger is a `fuzzy` match with cosine similarity < 0.85
- → The challenger's boost is stripped. The exact match is protected.

This prevents the `sensei → sessei` bug where "taking care of one's health" (fuzzy hallucination) was stealing the spot from "teacher/doctor" (perfect exact match).

#### Detailed Flip Example

Here's what a successful flip would look like in an ideal scenario:

```
Sentence: "kanja no ketsueki kensa no kekka"
          (patient's blood test results)

Token being evaluated: "kensa" (examination)
  - Query vector represents: "patient, blood, test, results" → medical examination context

Candidate A: kensa (examination)
  Base score: 1020 (exact match)
  Vector: [0.12, -0.34, 0.78, ...] (4096 dims)
  Cosine with query: 0.72 → boost = 216 pts
  Final: 1020 + 216 = 1236

Candidate B: kensa (prefectural border) ← different kanji, same romaji
  Base score: 980 (exact match)
  Vector: [0.45, 0.11, -0.22, ...] (4096 dims)
  Cosine with query: 0.31 → boost = 0 pts (below 0.60 threshold)
  Final: 980 + 0 = 980

Result: Candidate A wins by 256 points. The vector space correctly identified
that "examination" is semantically closer to "patient blood test results" than
"prefectural border" is.
```

#### What a flip looks like in the console

When `includeTrace` is active (during evaluation), successful flips produce:

```
[RAG Vector Rerank pass] ⭐ FLIP TRIGGERED for token [けんさ]!
  Old Target: kensa (score: 980.0)
  New Target: kensa (Vector Cosine Similarity: 0.720)
  └─ Won by gaining 216 points mathematically mapping to query space!
```

### Current architectural limitation: Embedding Space Mismatch

> ⚠️ **IMPORTANT**: The vector space reranking is currently limited by an embedding format mismatch.
>
> **Dictionary entries** were embedded using rich metadata strings:
> ```
> "kokain 古加涅 (コカイン) type: noun meanings: cocaine"
> ```
>
> **Query strings** are embedded from bare romaji:
> ```
> "marifuana kokain kokkai kiraku nando"
> ```
>
> These live in different regions of the embedding space. A bare romaji query like "kokain" 
> has a cosine similarity of only ~0.58 against the dictionary entry for kokain (cocaine), 
> even though they represent the same word. This is because the embedding model treats the 
> rich metadata string very differently from a bare word.
>
> As a result, the 0.60 threshold is rarely crossed, and most vector boosts currently 
> evaluate to 0. Future work should either:
> 1. Re-embed dictionary entries using bare romaji + meaning (no kanji/kana metadata), or
> 2. Format the query string to match the dictionary embedding format, or
> 3. Lower the threshold (but risk false positives)

---

## 7. MeSH Annotation (Clinical Ontology)

**Files**: [`src/mesh_parser.js`](src/mesh_parser.js), [`src/mesh_annotator.js`](src/mesh_annotator.js)

MeSH (Medical Subject Headings) is a medical dictionary maintained by the US National Library of Medicine. It contains 30,000+ medical concepts organized in a tree structure:
- `C*` = Diseases (asthma, diabetes, pneumonia)
- `D*` = Drugs/Chemicals
- `A*` = Anatomy (liver, kidney, brain)
- `E*` = Procedures (surgery, biopsy)
- `F*` = Psychiatry/Psychology

### How matching works

For each dictionary entry, the annotator checks if its English meaning matches a MeSH term:

**Phase 1 — Exact matches (bypass all filtering)**:
If the entry's primary meaning exactly matches a MeSH preferred term or synonym, it's accepted directly. This is how "asthma" → MeSH Disease works.

**Phase 2 — Expansion matches (filtered by token importance)**:
If no exact match, the system checks individual tokens against MeSH. These are filtered by a scoring function that penalizes:
- Short tokens (< 3 chars)
- Highly ambiguous tokens (matching >25 MeSH descriptors)
- Abstract suffix patterns (-tion, -ness, -ment)

### Why secondary meanings are excluded

Only `primary_meaning` is used for MeSH matching. This prevents false positives like:
- "oshaburi" (primary: "teething ring") having secondary meaning "pacifier" → false match to MeSH "Pacifiers" (medical device)

### Confidence threshold

All matches must score ≥ 0.70 confidence. Factors:
- Base: 0.45
- Exact phrase match: +0.30
- Exact synonym: +0.15
- Multi-word descriptor: +0.20
- Katakana loanword: +0.15
- Descriptor specificity (≤3 tree numbers): +0.15

---

## 8. Evaluation Harness

**Script**: [`scripts/eval.js`](scripts/eval.js)  
**Test cases**: [`eval/cases.json`](eval/cases.json) — 15 medical interpretation scenarios

```bash
npm run eval         # Full run (preprocessor + RAG + LLM)
npm run eval:quick   # Preprocessor + RAG only (no LLM, much faster)
```

**Output**: Markdown + JSON reports in `eval/` with timestamps.

Each report shows per-case:
- Preprocessor token trace with all candidates, scores, and breakdowns
- RAG retrieval hits with semantic scores
- The exact prompt sent to Ollama
- LLM output (full run only)

---

## 9. Known Issues & Future Work

### Still outstanding

| Issue | Root Cause | Suggested Fix |
|-------|-----------|---------------|
| `tabako` → `tanako` (tobacco → tenant) | "tabako" doesn't exist as a romaji key in vocab.db (it's katakana タバコ) | Add katakana loanwords to the romaji index during build |
| `kitsueninshu` not segmented | Beam search can't find `kitsuen` + `inshu` split | May need compound word heuristics or explicit entries |
| `kokain` → `kokkai` (cocaine → National Diet) | `kokkai` has higher frequency (ichi1) than `kokain` | Needs domain boost for pharmacology terms, or explicit override |
| `kiraku` beats `kurakku` (carefree vs crack) | Context boost didn't fire because English definitions don't share words ("crack" ≠ "cocaine") | Vector space reranking should fix this once embedding mismatch is resolved |
| **Embedding space mismatch** | Dictionary vectors embedded from rich metadata; query vectors from bare romaji → cosine ~0.49-0.58 for same-word pairs | Re-embed entries with bare romaji + English meaning, OR reformat query strings to match entry format |
| **Query pollution** | Losing candidates (e.g., `kokkai`) leak into RAG query tokens, diluting the sentence vector | Only send winner tokens, or weight query tokens by confidence score |
| Vector reranking boosts are 0 | All cosine similarities below 0.60 threshold due to embedding mismatch above | Lower threshold to 0.40 (short-term), or fix embeddings (long-term) |

### Key tuning parameters

| Parameter | File | Current Value | Purpose |
|-----------|------|--------------|---------| 
| Medical domain boost | linguistics.js | +120 | Points for medicine-tagged entries |
| Anatomy domain boost | linguistics.js | +80 | Points for anatomy-tagged entries |
| Typo penalty weight | linguistics.js | ×150 | Multiplier for fuzzy distance penalty |
| Context window | preprocessor.js | ±3 tokens | Neighbor window for context scoring |
| Context boost | preprocessor.js | +200 per overlap | Points when candidate matches neighbor context |
| RAG retrieval depth | promptBuilder.js | 20 | Number of ANN neighbors fetched |
| Vector cosine threshold | preprocessor.js | 0.60 | Minimum cosine similarity for RAG boost to apply |
| Vector max boost | preprocessor.js | 450 pts | Max semantic boost at cosine >= 0.85 |
| Exact match ceiling | preprocessor.js | >= 1000 pts | Exact matches above this score are protected from fuzzy flips |
| MeSH confidence threshold | mesh_annotator.js | >= 0.70 | Minimum to accept a MeSH annotation |

---

*Last updated: 2026-04-24*

