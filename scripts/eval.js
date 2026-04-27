/**
 * scripts/eval.js
 *
 * Evaluation harness for the med-jp interpreter pipeline.
 *
 * For each case in eval/cases.json, runs the full pipeline and captures:
 *   - Preprocessor token-level decisions (WanaKana, Fuse, whitelist, skip)
 *   - RAG retrieval hits with HNSW score, frequency score, and final combined score
 *   - The exact glossary hint block injected into the LLM prompt
 *   - The full prompt string sent to Ollama
 *   - The LLM's final translated output
 *   - Per-case timing
 *
 * Output: eval/report-YYYY-MM-DDTHH-MM.md  (human-readable Markdown)
 *         eval/report-YYYY-MM-DDTHH-MM.json (machine-readable, for diff/automation)
 *
 * Usage:
 *   node scripts/eval.js                   # run all cases
 *   node scripts/eval.js --cases id1,id2   # run specific case IDs only
 *   node scripts/eval.js --no-llm          # skip Ollama, RAG + preprocessing only
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const XLSX = require('xlsx');

import { buildPrompt } from '../src/promptBuilder.js';
import { generate }    from '../src/ollamaClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const CASES_PATH = path.join(__dirname, '../eval/cases.json');
const EVAL_DIR   = path.join(__dirname, '../eval');

// ─── CLI flags ────────────────────────────────────────────────────────────────

const args       = process.argv.slice(2);
const skipLLM    = args.includes('--no-llm');
const filterArg  = args.find(a => a.startsWith('--cases='));
const filterIds  = filterArg ? new Set(filterArg.split('=')[1].split(',')) : null;

// ─── Timestamp for output filenames ──────────────────────────────────────────

const now       = new Date();
const ts        = now.toISOString().slice(0, 16).replace(':', '-'); // 2026-04-03T16-45
const mdPath    = path.join(EVAL_DIR, `report-${ts}.md`);
const jsonPath  = path.join(EVAL_DIR, `report-${ts}.json`);

// ─── Console capture ─────────────────────────────────────────────────────────
// We redirect console.log during each pipeline call to intercept the
// per-token [debug] lines emitted by preprocessor.js without modifying it.

let _captureLines = null;
const _origLog    = console.log.bind(console);

function startCapture() {
  _captureLines = [];
  console.log = (...args) => {
    // Still forward to terminal so the user sees live progress
    _origLog(...args);
    // Strip ANSI escape codes and store
    _captureLines.push(args.map(a => String(a).replace(/\x1b\[[0-9;]*m/g, '')).join(' '));
  };
}

function stopCapture() {
  console.log = _origLog;
  const lines = _captureLines ?? [];
  _captureLines = null;
  return lines;
}

// ─── Markdown helpers ─────────────────────────────────────────────────────────

function mdTable(headers, rows) {
  const sanitize = (val) => {
    if (val === undefined || val === null) return '—';
    return String(val)
      .replace(/\|/g, '\\|')      // Escape pipes
      .replace(/\n/g, '<br>');    // Replace newlines with <br>
  };
  
  const sep = headers.map(h => '-'.repeat(Math.max(h.length, 3)));
  const fmt = row => `| ${row.map(sanitize).join(' | ')} |`;
  return [fmt(headers), fmt(sep), ...rows.map(fmt)].join('\n');
}

function mdDetails(summary, body) {
  return `<details>\n<summary>${summary}</summary>\n\n\`\`\`\n${body}\n\`\`\`\n\n</details>`;
}

// ─── Run one eval case ────────────────────────────────────────────────────────

async function runCase(caseObj) {
  const { id, label, input } = caseObj;
  _origLog(`\n\x1b[36m[eval] Running case: ${id} — ${label}\x1b[0m`);

  const caseResult = {
    id,
    label,
    input,
    direction: null,
    preprocessedInput: null,
    tokens: [],
    ragHits: [],
    toneHits: [],
    glossaryInjected: '',
    prompt: null,
    llmOutput: null,
    durationMs: null,
    timings: {},
    error: null,
    queryTokens: [],
  };

  const t0 = Date.now();

  try {
    // ── Step 1: buildPrompt (captures preprocessor + RAG) ──────────────────
    startCapture();
    const tBuild0 = performance.now();
    const { direction, prompt, preprocessedInput, ragHits, toneHits, tokenTrace, queryTokens, timings } = await buildPrompt(input);
    caseResult.timings = timings || {};
    caseResult.timings.buildPromptTotal = performance.now() - tBuild0;
    stopCapture();

    caseResult.direction         = direction;
    caseResult.preprocessedInput = preprocessedInput;
    caseResult.queryTokens       = queryTokens || [];
    caseResult.prompt            = prompt;

    caseResult.tokens = (tokenTrace ?? []).map(t => ({
      type:         t.type,
      surface:      t.surface,
      input:        t.input || t.surface,
      output:       t.output,
      base:         t.base,
      meaning:      t.meaning,
      grammar_tags: t.grammar_tags,
      decision:     t.decision,
      meta:         t.meta,
    }));

    caseResult.ragHits = (ragHits ?? []).map(({ score, semanticScore, item }) => ({
      score:          +(score ?? 0).toFixed(4),
      semanticScore:  +(semanticScore ?? 0).toFixed(4),
      romaji:         item?.romaji   ?? '',
      kana:           item?.kana     ?? '',
      kanji:          item?.kanji    ?? '',
      domain:         item?.domain   ?? '',
      source:         item?.source   ?? 'semantic',
      meanings:       (item?.meanings ?? []).slice(0, 3),
      tags:           item?.tags     ?? [],
      frequency:      +(item?.frequency ?? 0).toFixed(3),
    }));

    caseResult.toneHits = (toneHits ?? []).map(({ score, item }) => ({
      score:    +(score ?? 0).toFixed(4),
      romaji:   item?.romaji   ?? '',
      kana:     item?.kana     ?? '',
      kanji:    item?.kanji    ?? '',
      meanings: (item?.meanings ?? []).slice(0, 3),
    }));

    // Extract the entire "hints" block actually injected into the prompt.
    // Template order: NOW TRANSLATE:\n\n<hints>\nInput: ...
    // The hints start with either "MEDICAL GLOSSARY" or "TONE HINT" and end at "Input:"
    const hintRegex = /((?:MEDICAL GLOSSARY HINTS:|TONE HINT:)[\s\S]+?)\nInput:/;
    const match = prompt.match(hintRegex);
    caseResult.glossaryInjected = match ? match[1].trim() : '(none — no hints injected)';

    // ── Step 2: LLM call ───────────────────────────────────────────────────
    if (!skipLLM) {
      const tLlm0 = performance.now();
      let output = '';
      for await (const chunk of generate(prompt)) {
        output += chunk;
        process.stdout.write(chunk);
      }
      process.stdout.write('\n');
      caseResult.llmOutput = output.trim();
      caseResult.timings.llmGeneration = performance.now() - tLlm0;
    } else {
      caseResult.llmOutput = '(skipped — --no-llm flag)';
    }

  } catch (err) {
    stopCapture();
    caseResult.error = err.message;
    _origLog(`\x1b[31m[eval] ERROR in case ${id}: ${err.message}\x1b[0m`);
  }

  caseResult.durationMs = Date.now() - t0;
  return caseResult;
}

// ─── Render Markdown report ───────────────────────────────────────────────────

// ─── Constants ────────────────────────────────────────────────────────────────

const DEINFLECT_REASONS = {
  0: 'PolitePastNegative', 1: 'PoliteNegative', 2: 'PoliteVolitional', 3: 'Chau', 4: 'Sugiru',
  5: 'PolitePast', 6: 'Tara', 7: 'Tari', 8: 'Causative', 9: 'PotentialOrPassive',
  10: 'Toku', 11: 'Sou', 12: 'Tai', 13: 'Polite', 14: 'Respectful',
  15: 'Humble', 16: 'Humble/Kansai', 17: 'Past', 18: 'Negative', 19: 'Passive',
  20: 'Ba', 21: 'Volitional', 22: 'Potential', 23: 'EruUru', 24: 'CausativePassive',
  25: 'Te', 26: 'Zu', 27: 'Imperative', 28: 'MasuStem', 29: 'Adv',
  30: 'Noun', 31: 'ImperativeNegative', 32: 'Continuous', 33: 'Ki', 34: 'SuruNoun',
  35: 'ZaruWoEnai', 36: 'NegativeTe', 37: 'Irregular'
};

// ─── Render Markdown report ───────────────────────────────────────────────────

function renderMarkdown(results, runMeta) {
  const lines = [];

  lines.push(`# med-jp Evaluation Report`);
  lines.push(`\n**Run:** \`${runMeta.timestamp}\`  `);
  lines.push(`**Cases:** ${results.length}  `);
  lines.push(`**LLM:** ${runMeta.skipLLM ? 'skipped (--no-llm)' : 'enabled'}  `);
  lines.push(`**Total time:** ${(runMeta.totalMs / 1000).toFixed(1)}s`);

  lines.push(`\n---\n`);

  // Summary table
  lines.push(`## Summary\n`);
  lines.push(mdTable(
    ['#', 'ID', 'Direction', 'Preprocessed Input', 'LLM Output', 'Time (ms)'],
    results.map((r, i) => [
      String(i + 1),
      `\`${r.id}\``,
      r.direction ?? 'ERR',
      r.preprocessedInput ? `\`${r.preprocessedInput.slice(0, 50)}${r.preprocessedInput.length > 50 ? '…' : ''}\`` : '—',
      r.error ? `❌ ${r.error}` : (r.llmOutput ?? '—').slice(0, 80),
      String(r.durationMs),
    ])
  ));

  // Per-case detail sections
  lines.push(`\n---\n`);
  lines.push(`## Case Details\n`);

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    lines.push(`### ${i + 1}. \`${r.id}\` — ${r.label}\n`);
    lines.push(`**Input:** \`${r.input}\`  `);
    lines.push(`**Direction:** ${r.direction ?? '—'}  `);
    lines.push(`**Preprocessed:** \`${r.preprocessedInput ?? '—'}\`  `);
    
    // ── RAG Query Tokens ──
    if (r.queryTokens && r.queryTokens.length > 0) {
       lines.push(`**RAG Query Tokens:** \`[${r.queryTokens.join(', ')}]\`  `);
    }

    // ── LLM output (Moved up per user request) ──
    lines.push(`#### LLM Output\n`);
    lines.push(`> ${r.llmOutput ?? '—'}\n`);
    
    lines.push(`**Duration:** ${r.durationMs}ms\n`);

    if (r.error) {
      lines.push(`> ❌ **Error:** ${r.error}\n`);
      continue;
    }

    // ── Preprocessor token table & Flips ──
    lines.push(`#### Preprocessor Token Trace\n`);
    if (r.tokens.length > 0) {
      
      // Look for flip events first
      r.tokens.forEach(t => {
         if (t.meta && t.meta.flipEvent) {
            const f = t.meta.flipEvent;
            lines.push(`> ⭐ **FLIP TRIGGERED** for token \`[${t.surface || f.oldItem}]\`!`);
            lines.push(`> - **Old Target:** \`${f.oldItem}\` *(score: ${f.oldScore.toFixed(1)}, cos: ${f.oldCos?.toFixed(3) || 'N/A'})*`);
            lines.push(`> - **New Target:** \`${f.newItem}\` *(cos: ${f.newCos.toFixed(3)}, boost: +${f.boost})*`);
            lines.push(`> - **Context:** ${f.contextDesc}\n`);
         }
      });

      lines.push(mdTable(
        ['Input token', 'Output token', 'Definition', 'Decision', 'Semantic Boost', 'Extra Info'],
        r.tokens.map(t => {
          if (t.type === 'grammar') {
              const metaId = t.meta?.grammar_obj?.grammar_id || '—';
              const meaning = t.meaning || '—';
              return [
                `\`${t.surface}\``,
                `\`${t.output}\``,
                meaning,
                `**🟢 GRAMMAR**`,
                '—',
                `ID: \`${metaId}\`<br>Tags: *${t.grammar_tags?.join(', ') || '—'}*`
              ];
          }

          const winner = t.meta?.winner || t.meta?.candidates?.[0];
          const meaning = t.meaning || winner?.meaning || '—';
          const semanticBoost = t.meta?.semanticBoost || 0;
          const contextStr = semanticBoost < 0 ? `⭐ **${semanticBoost}**` : '—';

          let extra = '';
          if (t.meta && t.meta.candidates && t.meta.candidates.length > 0) {
            extra = t.meta.candidates.slice(0, 10).map(c => {
                const typeLabel = c.type.startsWith('repair') ? `🛠️ ${c.type}` : c.type;
                const boostInfo = c.semanticBoost ? ` (boost: **${c.semanticBoost}**)` : '';
                const rootInfo = c.root ? ` (root: *${c.root}*)` : '';
                const freqVal  = (c.freqScore ?? 0).toFixed(1);
                const scoreVal = (c.adjustedScore ?? 0).toFixed(1);
                const breakdown = c.breakdown ? `<br>&nbsp;&nbsp;*Breakdown: ${c.breakdown}*` : '';
                const cMeaning = c.meaning ? ` *(${c.meaning})*` : '';
                
                return `• **${c.item || ''}**${rootInfo}${cMeaning} [${typeLabel}]<br>&nbsp;&nbsp;Score: **${scoreVal}**${boostInfo} | Points: ${freqVal}${breakdown}`;
            }).join('<br>');
          }

          // Winner's deinflection path
          if (t.meta && t.meta.reasons) {
              const chainStr = t.meta.reasons.map(chain => 
                  chain.map(rid => DEINFLECT_REASONS[rid] || rid).join(' → ')
              ).join(' | ');
              if (extra) extra += '<br>';
              extra += `*Rules: ${chainStr} (w:${t.meta.ruleWeight || 1.0})*`;
          }

          return [
            `\`${t.surface || t.input}\``,
            `\`${t.output}\``,
            meaning,
            `**${t.decision}**`,
            contextStr,
            extra || '—'
          ];
        })
      ));
    } else {
      lines.push('*(no debug tokens captured)*');
    }

    // ── RAG hits table ──
    lines.push(`\n#### RAG Retrieval — Medical Glossary Hints\n`);
    if (r.ragHits.length > 0) {
      lines.push(mdTable(
        ['Rank', 'Combined', 'Semantic', 'Source', 'Domain', 'Freq', 'Romaji', 'Kanji', 'Top meanings', 'Tags'],
        r.ragHits.map((h, ri) => [
          String(ri + 1),
          String(h.score),
          String(h.semanticScore),
          h.source === 'dictionary' ? '📖 **dict**' : '🧠 rag',
          h.domain || '—',
          String(h.frequency),
          `\`${h.romaji}\``,
          h.kanji || '—',
          h.meanings.join('; '),
          h.tags.slice(0, 3).join(', ') || '—',
        ])
      ));
      lines.push(`\n**Glossary block injected into prompt:**\n\n\`\`\`\n${r.glossaryInjected}\n\`\`\``);
    } else {
      lines.push('*(RAG disabled or no hits)*');
    }

    // ── Tone context hit ──
    lines.push(`\n#### Tone / Pragmatic Context Hint\n`);
    if (r.toneHits && r.toneHits.length > 0) {
      const t = r.toneHits[0];
      lines.push(mdTable(
        ['Score', 'Romaji', 'Kanji', 'Nuance'],
        [[String(t.score), `\`${t.romaji}\``, t.kanji || '—', t.meanings.join('; ')]]
      ));
    } else {
      lines.push('*(no tone hit — may be same as medical hit or query too short)*');
    }

    // ── Full prompt (collapsed) ──
    lines.push(`\n${mdDetails('Full prompt sent to Ollama (click to expand)', r.prompt ?? '—')}\n`);

    // ── Timing Breakdown ──
    lines.push(`#### Timing Breakdown\n`);
    const t = r.timings || {};
    const timingRows = [
      ['Total Case Time', `${r.durationMs}ms`],
      ['- LLM Generation', `${(t.llmGeneration ?? 0).toFixed(1)}ms`],
      ['- Build Prompt (Total)', `${(t.buildPromptTotal ?? 0).toFixed(1)}ms`],
      ['  - Ensure ANN', `${(t.ensureANN ?? 0).toFixed(1)}ms`],
      ['  - Preprocessing', `${(t.preprocess ?? 0).toFixed(1)}ms`],
      ['  - Embedding (API)', `${(t.embedding ?? 0).toFixed(1)}ms`],
      ['  - RAG Search', `${(t.ragSearch ?? 0).toFixed(1)}ms`],
      ['  - Reranking', `${(t.rerank ?? 0).toFixed(1)}ms`],
      ['  - Prompt Assembly', `${(t.promptAssembly ?? 0).toFixed(1)}ms`],
    ];
    lines.push(mdTable(['Step', 'Time'], timingRows));

    lines.push(`\n---\n`);
  }

  // Tuning notes section — left intentionally blank for the user to fill in
  lines.push(`## Tuning Notes\n`);
  lines.push(`*Add observations here after reviewing the report.*\n`);
  lines.push(`\n### Parameters to consider adjusting\n`);
  lines.push(`| Parameter | Current value | Proposed change | Rationale |`);
  lines.push(`|-----------|--------------|-----------------|-----------|`);
  lines.push(`| NF-Decay Scale | 100 - (nf * 2) | | |`);
  lines.push(`| Medical Boost | +50 | | |`);
  lines.push(`| MeSH Disease | +80 | | |`);
  lines.push(`| RAG topK | 9-50 | | |`);
  lines.push(`| Semantic Rerank | -15 | | |`);
  lines.push(`| Embedding Model | qwen3-embedding | | |`);

  return lines.join('\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf-8'));
  const toRun = filterIds ? cases.filter(c => filterIds.has(c.id)) : cases;

  if (toRun.length === 0) {
    _origLog('No matching cases found.');
    process.exit(1);
  }

  _origLog(`\x1b[36m[eval] Starting evaluation — ${toRun.length} case(s)\x1b[0m`);
  if (skipLLM) _origLog(`\x1b[33m[eval] --no-llm: Ollama calls skipped\x1b[0m`);

  const t0 = Date.now();
  const results = [];

  for (const caseObj of toRun) {
    results.push(await runCase(caseObj));
  }

  const totalMs = Date.now() - t0;
  const runMeta = { timestamp: now.toISOString(), skipLLM, totalMs };

  // ── Write JSON ──
  fs.writeFileSync(jsonPath, JSON.stringify({ meta: runMeta, results }, null, 2));
  _origLog(`\x1b[32m[eval] JSON report written → ${jsonPath}\x1b[0m`);

  // ── Write Markdown ──
  const md = renderMarkdown(results, runMeta);
  fs.writeFileSync(mdPath, md);
  _origLog(`\x1b[32m[eval] Markdown report written → ${mdPath}\x1b[0m`);

  // ── Write Excel (Append to reporting.xlsx) ──
  try {
    const excelPath = path.join(EVAL_DIR, 'reporting.xlsx');
    let wb;
    if (fs.existsSync(excelPath)) {
      wb = XLSX.readFile(excelPath);
    } else {
      wb = XLSX.utils.book_new();
    }

    const shortTs = ts.slice(5); // e.g. 04-25T13-56
    
    // 1. Run History (Accumulate)
    const historyRow = {
      Timestamp: runMeta.timestamp,
      Cases: results.length,
      Duration_s: +(runMeta.totalMs / 1000).toFixed(1),
      LLM_Enabled: !skipLLM,
      Avg_ms_per_case: +(runMeta.totalMs / results.length).toFixed(0),
      Pipeline_Version: "v3.1-phonetic-recall"
    };
    let historyWs = wb.Sheets['RunHistory'];
    if (!historyWs) {
      historyWs = XLSX.utils.json_to_sheet([historyRow]);
      XLSX.utils.book_append_sheet(wb, historyWs, 'RunHistory');
    } else {
      const existingHistory = XLSX.utils.sheet_to_json(historyWs);
      existingHistory.push(historyRow);
      const newHistoryWs = XLSX.utils.json_to_sheet(existingHistory);
      wb.Sheets['RunHistory'] = newHistoryWs;
    }

    // 2. Summary Sheet (Timestamped)
    const summaryData = results.map((r, i) => ({
      ID: r.id,
      Direction: r.direction,
      Input: r.input,
      Result: r.error ? `ERR: ${r.error}` : r.llmOutput,
      Time_ms: r.durationMs,
      Tokens: r.tokens.length,
      RAG_Hits: r.ragHits.length
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryData), `Sum_${shortTs}`);

    // 3. Token Details (Timestamped)
    const tokenData = [];
    results.forEach(r => {
      r.tokens.forEach(t => {
        const win = t.meta?.winner || t.meta?.candidates?.[0];
        const candidateList = (t.meta?.candidates || []).slice(0, 5).map(c => `${c.item}(${c.adjustedScore.toFixed(0)})`).join(', ');
        tokenData.push({
          Case: r.id,
          RAG_Query: r.queryTokens.join(', '),
          Token: t.surface || t.input,
          Type: t.type || '',
          Decision: t.decision,
          Winner: win?.item || '',
          Score: win?.adjustedScore || 0,
          Boost: t.meta?.semanticBoost || 0,
          Meaning: t.meaning || win?.meaning || '',
          Alternative_Candidates: candidateList
        });
      });
    });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(tokenData), `Tok_${shortTs}`);

    XLSX.writeFile(wb, excelPath);
    _origLog(`\x1b[32m[eval] Excel report updated → ${excelPath}\x1b[0m`);
  } catch (exErr) {
    _origLog(`\x1b[31m[eval] Failed to write Excel: ${exErr.message}\x1b[0m`);
  }

  _origLog(`\x1b[36m[eval] Done — ${results.length} cases in ${(totalMs / 1000).toFixed(1)}s\x1b[0m`);
}

main().catch(err => {
  console.error(`[eval] Fatal: ${err.message}`);
  process.exit(1);
});
