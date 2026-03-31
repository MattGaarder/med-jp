/**
 * promptBuilder.js
 * Constructs direction-specific prompts from raw prefixed input.
 * Applies preprocessing and adds /no_think directive for Qwen3.
 *
 * Supported prefixes:
 *   ENG:  → Translate broken English to formal clinical Japanese
 *   JAP:  → Translate broken Japanese / romaji to professional English
 */

import { preprocessJap, preprocessEng, vocabIndex, getRoots } from './preprocessor.js';

// Build a fast lookup map for medical definitions
const medicalMap = new Map();
for (const entry of vocabIndex) {
  if (entry.type === 'medical') {
    medicalMap.set(entry.romaji, entry.en);
  }
}

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

const ENG_TO_JP_TEMPLATE = (input) => `\
TASK: Translate the following English medical input into one formal clinical Japanese sentence.

RULES:
- Silently correct grammar and fill in implied meaning.
- Use natural, formal clinical Japanese.
- Add readings in parentheses (ふりがな) only for rare or difficult kanji.
- Output ONLY the Japanese sentence — no labels, no explanation, no English.

EXAMPLES:
Input: patient chest pain
Output: 患者は胸痛（きょうつう）を訴えています。

Input: no allergy
Output: 既知のアレルギーはありません。

Input: tumour small no spread
Output: 腫瘍（しゅよう）は小さく、転移（てんい）は認められません。

Input: high fever three days
Output: 3日間の高熱が続いています。

Input: leg stiff wednesday taking prescription
Output: 水曜日から処方された薬を服用しており、足がこわばっています。

NOW TRANSLATE:
Input: ${input}
Output: /no_think`;

const JP_TO_ENG_TEMPLATE = (input, glossaryStr = '') => `\
TASK: Translate the following Japanese romaji into natural English. The speaker is a Japanese patient or person talking directly. You are their voice.

RULES:
- Translate LITERALLY and EXACTLY — do not summarise, do not infer diagnosis.
- ALWAYS write in the FIRST PERSON: "I have...", "I feel...", "I can't...", "Hello, I..."
- NEVER use third-person: NEVER write "The patient...", "They report...", "The speaker..."
- Handle ALL language — greetings, everyday phrases, and medical symptoms equally.
- CRITICAL: The input Japanese may be highly fragmented, ungrammatical, or missing particles (e.g. "tsukare ga kanji" => "I feel tired"). Reconstruct the natural meaning using standard Japanese grammar.
- Correct romaji misspellings silently (e.g. "zutsu" → headache, "atmaa" → atama = head).
- If unclear, translate conservatively. NEVER invent medical symptoms, medications, or meanings that are not explicitly present in the input. If a word looks like a symptom but doesn't make sense in context, treat it as general speech.
- Output ONLY the English translation — no labels, no explanation, no Japanese.

EXAMPLES:
Input: mune itai
Output: I have chest pain.

Input: arerugi nai
Output: I have no known allergies.

Input: zutsuu hidoi
Output: My headache is really bad.

Input: ahsi ga zutsuu de atama mo itai
Output: My leg hurts and my head hurts too.

Input: zutsuu ga hidoi sugite ugokenai
Output: My headache is so bad I can't move.

Input: konnichiwa genki sou de naniyori desu ne
Output: Hello, you look well, I'm glad to see that.

Input: shinbun wo yondari miru koto shuuchuu dekimasen
Output: I can't concentrate when reading the newspaper or watching things.

Input: hiza wo mageyou to suru toki ni kowabari wo kanjimasu ka
Output: Do you feel stiffness when you try to bend your knee?

Input: hayai dankai de mitsukatta
Output: It was found at an early stage.

NOW TRANSLATE:${glossaryStr}
Input: ${input}
Output: /no_think`;

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Parse the input prefix, preprocess the content, and build the prompt.
 * @param {string} rawInput - e.g. "ENG: patient chest pain"
 * @returns {{ direction: string, prompt: string }}
 * @throws {Error} if the prefix is missing or unrecognised.
 */
export function buildPrompt(rawInput) {
  const trimmed = rawInput.trim();

  if (/^ENG:/i.test(trimmed)) {
    const raw   = trimmed.replace(/^ENG:\s*/i, '').trim();
    const input = preprocessEng(raw);
    return { direction: 'ENG→JP', prompt: ENG_TO_JP_TEMPLATE(input) };
  }

  if (/^JAP:/i.test(trimmed)) {
    const raw   = trimmed.replace(/^JAP:\s*/i, '').trim();
    const input = preprocessJap(raw);

    // Extract hints against the medical dictionary to anchor the LLM
    const tokenSet = new Set(input.toLowerCase().split(/[^a-z]+/));
    const hints = [];
    
    // Homophones that are too common in general speech to safely provide medical hints for
    const HOMOPHONE_BLOCKLIST = new Set(['kinou', 'kanji', 'ki', 'shite', 'nai', 'tai', 'kara', 'taishita', 'dashu', 'dashimashita']);

    for (const tok of tokenSet) {
      if (!tok || HOMOPHONE_BLOCKLIST.has(tok)) continue;

      if (medicalMap.has(tok)) {
        hints.push(`${tok}: ${medicalMap.get(tok)}`);
      } else {
        // Step further: deconjugate verbs and inject glossary definitions for the root word!
        const possibleRoots = getRoots(tok);
        for (const root of possibleRoots) {
          if (medicalMap.has(root) && !HOMOPHONE_BLOCKLIST.has(root)) {
            hints.push(`${tok} (from ${root}): ${medicalMap.get(root)}`);
            break; // Stop at first valid medical root to avoid duplicates
          }
        }
      }
    }

    let glossaryStr = '';
    if (hints.length > 0) {
      glossaryStr = `\n\nMEDICAL GLOSSARY HINTS (Warning: Japanese contains homophones. E.g. 'kinou' can mean 'yesterday' or 'function'. ONLY use these definitions if they make sense in the context of the sentence!):\n${hints.map(h => `- ${h}`).join('\n')}`;
    }

    return { direction: 'JAP→ENG', prompt: JP_TO_ENG_TEMPLATE(input, glossaryStr) };
  }

  throw new Error(
    'Unknown prefix. Use "ENG: <text>" for English→Japanese or "JAP: <text>" for Japanese→English.'
  );
}
