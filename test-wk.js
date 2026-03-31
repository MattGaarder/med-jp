import * as wanakana from 'wanakana';

function wkNormalize(token) {
  try {
    if (!wanakana.isRomaji(token)) return token; // not romaji — pass through
    const hiragana = wanakana.toHiragana(token, { passRomaji: false });
    return wanakana.toRomaji(hiragana);
  } catch {
    return token;
  }
}

const tok1 = 'arimasu';
const n1 = wkNormalize(tok1);
console.log(`wkNormalize('${tok1}') -> '${n1}'`);

const tok2 = 'shite,';
const n2 = wkNormalize(tok2);
console.log(`wkNormalize('${tok2}') -> '${n2}'`);
