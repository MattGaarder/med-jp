import { buildPrompt } from './src/promptBuilder.js';

const rawInput = "JAP: arigatougozaimasu. kono byouki watashi kazoku eikyou atemashita. konnnani tsurai to omoimashit. nihon chiryou hayaku owaretai. na uketeirunndakara. tomodachi  kono jyoutai wo omoidashitehoshikutnai";
const { prompt } = buildPrompt(rawInput);

const preprocessedMatch = prompt.match(/Input: (.*?)\nOutput/);
if (preprocessedMatch) {
  console.log(`[debug] preprocessed as: ${preprocessedMatch[1]}`);
} else {
  console.log('[debug] Regex failed to match.');
  console.log('Prompt was:\n', prompt);
}
