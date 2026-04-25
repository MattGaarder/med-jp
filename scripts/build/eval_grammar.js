import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildPrompt } from '../../src/promptBuilder.js';
import * as wanakana from 'wanakana';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TEST_CASES = [
  {
     input: "JAP: iwaretayouni", 
     expected: "as I was told"
  },
  {
     input: "JAP: mune ga itakute, onaka mo itai desu",
     expected: "My chest hurts, and my stomach hurts too."
  },
  {
     input: "JAP: ano kusuri wo nomanaide kudasai",
     expected: "Please do not take that medicine."
  },
  {
     input: "JAP: tabeteiru",
     expected: "I am eating"
  },
  {
     input: "JAP: kanojo wa zutsuu no tameni byouin ni ikimashita",
     expected: "She went to the hospital because of a headache."
  },
  {
     input: "JAP: kusuri o nomaserareta",
     expected: "I was made to take the medicine."
  },
  {
     input: "JAP: kanjaha memaiokutsueniutteiru", // squashed "kanja ha memai o kutsu ni utteiru" -> kanja ha memai wo ... wait. Let's do a realistic medical squashed string
     expected: "The patient is complaining of dizziness"
  } // I'll modify #7 to be realistic:
];

TEST_CASES[6] = {
   input: "JAP: geningawakaranaihidoizutsuuganengantsuzuiteirunodekusurionomitaidesu",
   expected: "I have had a severe headache of unknown cause for years, so I want to take medicine."
};

async function runEval() {
  let mdOut = `# Grammar Pipeline Evaluation Report\n\n`;
  let passCount = 0;
  let failCount = 0;
  let failureAnalysis = [];

  for (const tc of TEST_CASES) {
     const rawInput = tc.input.replace('JAP: ', '');
     const hiragana = wanakana.toHiragana(rawInput);
     mdOut += `## TEST CASE: ${rawInput}\n\n`;
     mdOut += `**INPUT**\n`;
     mdOut += `- Raw: \`${rawInput}\`\n`;
     mdOut += `- Normalized: \`${hiragana}\`\n\n`;

     try {
       const res = await buildPrompt(tc.input);
       
       mdOut += `**SEGMENTATION & DEINFLECTION**\n`;
       let tags = [];
       res.tokenTrace.forEach((t, i) => {
          if (t.type === 'grammar') {
             const gid = t.meta?.grammar_obj?.grammar_id || 'UNKNOWN';
             const meaning = t.meaning || '';
             mdOut += `${i + 1}. \`${t.surface}\` (grammar): [${gid}] -> "${meaning}"\n`;
          } else {
             const base = t.base || t.surface;
             const m = t.meaning || '';
             const tgs = (t.grammar_tags || []).join(', ');
             const dist = t.meta?.winner?.adjustedScore?.toFixed(2) || '0.00';
             mdOut += `${i + 1}. \`${t.surface}\` (text):\n`;
             mdOut += `   - Base: \`${base}\` -> "${m}"\n`;
             if (tgs) mdOut += `   - Transformations: ${tgs}\n`;
             mdOut += `   - Vocab Match Score (lower is better): ${dist}\n`;
          }
       });

       mdOut += `\n**FINAL STRUCTURED OUTPUT (Prompt Payload)**\n`;
       mdOut += "```markdown\n" + res.prompt + "\n```\n\n";

       mdOut += `**EXPECTED MEANING**\n`;
       mdOut += `> ${tc.expected}\n\n`;

       // We simulate MODEL OUTPUT to keep the test deterministic and standalone.
       // The RAG prompt itself shows exactly what the LLM receives.
       mdOut += `**ANALYSIS**\n`;
       // Simple heuristic analysis for reporting (Mocked manual analysis template)
       let failed = false;
       let failureTags = [];
       
       if (res.tokenTrace.some(t => t.type === 'text' && t.surface.length > 5 && !t.meaning)) {
          failed = true;
          failureTags.push("VOCAB_MISS");
       }
       if (rawInput.includes('youni') && !res.tokenTrace.some(t => t.surface === 'ように' && t.type === 'grammar')) {
          failed = true;
          failureTags.push("GRAMMAR_MISS");
          failureTags.push("BAD_SEGMENT_BOUNDARY");
       }
       
       if (failed) {
          failCount++;
          mdOut += `❌ **FAILED**\n`;
          mdOut += `FAILURE_TAGS:\n${failureTags.map(f => '- ' + f).join('\n')}\n\n`;
          failureAnalysis.push({ input: rawInput, tags: failureTags });
       } else {
          passCount++;
          mdOut += `✅ **PASSED** (Structural parsing looks correct)\n\n`;
       }
       
     } catch (e) {
       failCount++;
       mdOut += `❌ **CRITICAL FAILURE**\n`;
       mdOut += "```\n" + e.message + "\n```\n\n";
       failureAnalysis.push({ input: rawInput, tags: ["PIPELINE_CRASH"] });
     }
  }

  mdOut += `## SUMMARY\n`;
  mdOut += `- **Total Cases:** ${TEST_CASES.length}\n`;
  mdOut += `- **Pass Count:** ${passCount}\n`;
  mdOut += `- **Fail Count:** ${failCount}\n`;
  if (failureAnalysis.length > 0) {
      mdOut += `\n**Failure Breakdown**\n`;
      failureAnalysis.forEach(f => {
         mdOut += `- \`${f.input}\`: ${f.tags.join(', ')}\n`;
      });
  } else {
      mdOut += `\n*No structural failures detected in the test suite.*\n`;
  }

  fs.writeFileSync(path.join(__dirname, '../eval/grammar-report.md'), mdOut);
  console.log('Evaluation complete. Report generated at eval/grammar-report.md');
}

runEval();
