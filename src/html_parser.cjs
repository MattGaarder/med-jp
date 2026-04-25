const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const wanakana = require('wanakana');

function extractDisplayText($, el) {
  const clone = $(el).clone();
  clone.find('.pareninheader').remove();
  clone.find('ruby').each((_, ruby) => {
    $(ruby).replaceWith($(ruby).contents().first().text());
  });
  return clone.text().replace(/[\n\r\t]+/g, ' ').trim();
}

function extractReadingAndText($, el) {
  const clone = $(el).clone();
  clone.find('ruby').each((_, ruby) => {
    const $ruby = $(ruby);
    const rt = $ruby.find('rt').text().trim();
    if (rt) {
      $ruby.replaceWith(rt);
    } else {
      $ruby.replaceWith($ruby.text());
    }
  });
  return clone.text().replace(/[\n\r\t]+/g, ' ').trim();
}

function normalizeToHiragana(text) {
  return wanakana.toHiragana(text);
}

function normalizeMatch(text) {
  return wanakana.toHiragana(text).replace(/\s+/g, '');
}

function isMostlyJapanese(text) {
  const jp = (text.match(/[ぁ-んァ-ン一-龯]/g) || []).length;
  return text.length > 0 && (jp / text.length) > 0.5;
}

function isMeta(text) {
  return (
    /^[0-9０-９]+）/.test(text) ||
    /Often|usually|such as|etc/i.test(text) ||
    /例句|sentence|phrase|慣用|意味/.test(text)
  );
}

function cleanExampleSpacing(text) {
  let clean = text.replace(/\s+/g, ' ').trim();
  clean = clean.replace(/([^\x00-\x7F])\s+(?=[^\x00-\x7F])/g, '$1');
  return clean;
}

function splitMeaning(text) {
  return text
    .split(/、|,|;|；|…|\.\.\./)
    .map(t => t.trim())
    .filter(Boolean);
}

function extractAnchorsAndRegex(title) {
  let base = title.replace(/[（\(].*?[）\)]/g, '');
  base = normalizeToHiragana(base);
  base = base.replace(/[^\p{L}\p{N}ぁ-んァ-ン一-龯・〜]/gu, '');

  let isOr = base.includes('・');
  let tokens = [];

  if (isOr) {
      tokens = base.split('・').map(t => t.replace(/〜/g, '').trim()).filter(Boolean);
      return { 
          anchors: tokens, 
          type: 'OR',
          regexBase: tokens.join('|')
      };
  } else {
      tokens = base.split('〜').map(t => t.trim()).filter(Boolean);
      return { 
          anchors: tokens, 
          type: 'AND',
          regexBase: tokens.join('.*')
      };
  }
}

function extractOptionalsFromTitle(title) {
  const match = title.match(/[（\(](.*?)[）\)]/);
  if (!match) return [];
  return match[1]
    .split(/[・、]/)
    .map(s => normalizeToHiragana(s.trim()))
    .filter(Boolean);
}

function parseHTMLFile(filePath) {
  const html = fs.readFileSync(filePath, 'utf-8');
  const $ = cheerio.load(html);

  // 1. Extract title
  let title = extractDisplayText($, $('h1'));
  title = title.replace(/★.*/, '').replace(/〈.*?〉/g, '').trim();

  // 1.5. Handle Redirect Entries
  const hasMeaning = $('p.meaning').length > 0;
  const isRedirect = $('p.linked-header a').length > 0 && !hasMeaning;
  
  if (isRedirect) {
      let aliasTargetText = extractDisplayText($, $('p.linked-header a'));
      aliasTargetText = aliasTargetText.replace(/➡/g, '').replace(/★.*/, '').replace(/〈.*?〉/g, '').trim();
      const aliasTargetId = wanakana.toRomaji(aliasTargetText).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      const id = wanakana.toRomaji(title).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      return {
          id: id,
          title: title,
          alias_of: aliasTargetId || null
      };
  }

  // 2. Extract meanings
  const meanings_ja = [];
  const meanings_en = [];
  
  $('p.meaning').each((_, el) => {
    let text = extractDisplayText($, el);
    const parts = splitMeaning(text);
    
    parts.forEach(part => {
      const hasKana = /[ぁ-んァ-ン]/.test(part);
      const hasHangul = /[가-힣]/.test(part);
      const hasEnglish = /[a-zA-Z]/.test(part);
      
      if (hasHangul) return; 
      
      if (hasKana) {
         meanings_ja.push(part);
      } else if (hasEnglish && !/[一-龯]/.test(part)) {
         meanings_en.push(part);
      }
    });
  });

  // 3. Extract connection pattern
  let pattern_raw = '';
  const $connect = $('td.connect3');
  if ($connect.length > 0) {
    pattern_raw = extractDisplayText($, $connect);
  }

  // 4. Extract anchors & optionals from Title
  const anchorData = extractAnchorsAndRegex(title);
  const anchors = anchorData.anchors;
  const optionalArr = extractOptionalsFromTitle(title).sort();

  // 5. Extract examples
  const validExamples = [];

  $('dd.calibre11, p[class*="honbun"], p.sq3em1minus, p.ref1ine').each((_, el) => {
    let readingText = extractReadingAndText($, el);
    readingText = readingText.replace(/^[◆×❶❷❸❹❺❻❼❽❾❿\s]+/, '').trim();
    
    let displayText = extractDisplayText($, el);
    displayText = displayText.replace(/^[◆×❶❷❸❹❺❻❼❽❾❿\s]+/, '').trim();
    
    if (!displayText) return;
    if (isMeta(displayText)) return;
    if (!isMostlyJapanese(displayText)) return;
    if (!/[。！？]\s*$/.test(displayText)) return;
    if (/「.*?」/.test(displayText)) return;
    
    const exNorm = normalizeMatch(readingText);
    
    let matchedAnchor = false;
    if (anchors.length > 0) {
        if (anchorData.type === 'OR') {
            matchedAnchor = anchors.some(a => exNorm.includes(normalizeMatch(a)));
        } else {
            matchedAnchor = anchors.every(a => exNorm.includes(normalizeMatch(a)));
        }
    }
    
    if (matchedAnchor) {
        validExamples.push(displayText);
    }
  });

  // 9. Build regex dynamically
  let regex = anchorData.regexBase;
  if (optionalArr.length > 0 && regex) {
      if (anchorData.type === 'OR' && anchors.length > 1) {
          regex = `(${regex})(${optionalArr.join('|')})?`;
      } else {
          regex += `(${optionalArr.join('|')})?`;
      }
  }

  // 10. Clean examples
  const examplesCleaned = [...new Set(validExamples.map(cleanExampleSpacing))];

  // 11. Generate ID
  const id = wanakana.toRomaji(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');

  return {
    id: id,
    title: title,
    meanings_ja: meanings_ja,
    meanings_en: meanings_en,
    anchors: anchors,
    optional: optionalArr,
    pattern_raw: pattern_raw,
    regex: regex,
    examples: examplesCleaned
  };
}

const inputBaseDir = 'data/JapaneseExpression/text';
const outputBaseDir = 'data/JapaneseExpression/json';

if (!fs.existsSync(outputBaseDir)) {
  fs.mkdirSync(outputBaseDir, { recursive: true });
}

let successCount = 0;
for (let i = 1; i <= 1074; i++) {
  const num = String(i).padStart(4, '0');
  const inputPath = path.join(inputBaseDir, `part${num}.html`);
  const outputPath = path.join(outputBaseDir, `part${num}.json`);

  try {
    if (fs.existsSync(inputPath)) {
      const result = parseHTMLFile(inputPath);
      fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), 'utf-8');
      successCount++;
    }
  } catch (error) {
    console.error(`Failed to process part${num}.html:`, error.message);
  }
}
console.log(`Finished processing. successfully processed ${successCount} files.`);
