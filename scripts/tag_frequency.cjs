const Database = require('better-sqlite3');
const XLSX = require('xlsx');
const wanakana = require('wanakana');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../data/vocab.db');
const db = new Database(dbPath);

// Add column if not exists
try {
  db.prepare(`ALTER TABLE vocab ADD COLUMN common_words TEXT`).run();
} catch (e) {
  // column likely exists
}

// Load Excel
const excelPath = path.join(__dirname, '../data/j1000.xlsx');
const workbook = XLSX.readFile(excelPath);

const sheets = ['j1000', 'j2000', 'j3000', 'j4000', 'j5000', 'j6000'];

// ===== GLOBAL STATS =====
let totalProcessed = 0;
let matched = 0;
let unmatched = 0;
let ambiguous = 0;

// Debug tracking
const unmatchedList = [];
const ambiguousList = [];

// ===== HELPERS =====

function normalize(str) {
  return (str || '')
    .toString()
    .trim()
    .toLowerCase();
}

/**
 * Normalizes katakana by removing/standardizing trailing long vowels
 */
function normalizeKatakana(str) {
  if (!str) return str;
  // Remove trailing 'ー' for matching purposes
  return str.replace(/ー$/, '');
}

/**
 * Simple stemming for common Japanese inflections
 */
function stem(str) {
  if (!str) return [str];
  const stems = [str];
  
  // Strip 'する'
  if (str.endsWith('する')) {
    stems.push(str.slice(0, -2));
  }
  
  // Handle 'ている' -> 'る'
  if (str.endsWith('ている')) {
    stems.push(str.slice(0, -3) + 'る');
  }

  // Handle '〜さん', '〜くん'
  if (str.endsWith('さん') || str.endsWith('くん')) {
      stems.push(str.slice(0, -2));
  }
  
  return [...new Set(stems)];
}

function getMeaningKeywords(meaningStr) {
  return (meaningStr || '')
    .toLowerCase()
    .replace(/[()]/g, '')
    .split(/[\s,/;]+/)
    .map(w => w.trim())
    .filter(w => w.length > 2); // filter out short noise words
}

function hasCommonTag(tagStr) {
    if (!tagStr) return false;
    const common = ['ichi1', 'news1', 'spec1', 'gai1', 'nf', 'P'];
    return common.some(t => tagStr.includes(t));
}

function scoreMatch(row, candidate) {
  let score = 0;

  // Exact matches
  if (row.kanji && candidate.kanji === row.kanji) score += 5;
  if (row.kana && candidate.kana === row.kana) score += 5;

  const rowRomaji = wanakana.toRomaji(row.kana || '');
  if (rowRomaji && candidate.romaji === rowRomaji) score += 2;

  // Meaning overlap
  if (row.meaning && candidate.primary_meaning) {
    const rowKeywords = getMeaningKeywords(row.meaning);
    const candidateKeywords = getMeaningKeywords(candidate.primary_meaning + ' ' + (candidate.secondary_meanings || ''));
    
    const overlap = rowKeywords.filter(kw => candidateKeywords.includes(kw));
    if (overlap.length > 0) {
      score += Math.min(overlap.length, 3); // cap meaning boost
    }
  }

  // Tie-breaking with existing DB tags (popularity)
  if (hasCommonTag(candidate.tags)) {
      score += 1;
  }

  return score;
}

function updateTag(id, tag) {
  const row = db.prepare(`SELECT common_words FROM vocab WHERE id = ?`).get(id);

  if (!row) return;

  let existingTags = row.common_words || '';
  
  // Only update if the tag is not already there
  if (!existingTags.includes(tag)) {
    const newTags = existingTags ? `${existingTags},${tag}` : tag;
    db.prepare(`UPDATE vocab SET common_words = ? WHERE id = ?`).run(newTags, id);
  }
}

// ===== MAIN LOOP =====

for (const sheetName of sheets) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    console.log(`\n=== Skipping ${sheetName} (not found in workbook) ===`);
    continue;
  }

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const tag = sheetName;

  console.log(`\n=== Processing ${sheetName} ===`);

  let sheetProcessed = 0;
  let sheetMatched = 0;
  let sheetUnmatched = 0;
  let sheetAmbiguous = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];

    const kanjiStr = normalize(row[1]);
    const kanaStr = normalize(row[2] || '');
    const meaning = normalize(row[3] || '');

    if (!kanjiStr && !kanaStr) continue;

    totalProcessed++;
    sheetProcessed++;

    // Generate search variants
    const kanjiVariants = stem(kanjiStr);
    const kanaVariants = stem(kanaStr);
    
    // Add Katakana variants for all kana
    const katakanaVariants = [...kanaVariants, ...kanjiVariants].map(v => wanakana.toKatakana(v));
    const allSearchTokens = [...new Set([...kanjiVariants, ...kanaVariants, ...katakanaVariants])].filter(Boolean);
    
    // Also include romaji search
    const romajiToken = wanakana.toRomaji(kanaStr || kanjiStr || '');

    // Search query
    const placeholders = allSearchTokens.map(() => '?').join(',');
    let candidates = db.prepare(`
      SELECT id, kanji, kana, romaji, primary_meaning, secondary_meanings, tags
      FROM vocab
      WHERE kanji IN (${placeholders})
         OR kana IN (${placeholders})
         OR romaji = ?
    `).all(...allSearchTokens, ...allSearchTokens, romajiToken);

    if (candidates.length === 0) {
      unmatched++;
      sheetUnmatched++;
      unmatchedList.push({ sheet: sheetName, kanji: kanjiStr, kana: kanaStr, meaning });
      continue;
    }

    if (candidates.length === 1) {
      updateTag(candidates[0].id, tag);
      matched++;
      sheetMatched++;
      continue;
    }

    // Multiple matches → score
    let best = null;
    let bestScore = -1;
    let tie = false;

    for (const candidate of candidates) {
      const s = scoreMatch({ kanji: kanjiStr, kana: kanaStr, meaning }, candidate);

      if (s > bestScore) {
        bestScore = s;
        best = candidate;
        tie = false;
      } else if (s === bestScore) {
        tie = true;
      }
    }

    // Acceptance threshold
    // If we have a clear winner or a high enough score even with a tie (though we handle ties with tags now)
    if (best && bestScore >= 5 && !tie) {
      updateTag(best.id, tag);
      matched++;
      sheetMatched++;
    } else if (best && bestScore >= 10) { 
        // extremely high score (e.g. perfect kanji + kana match) wins even if there's a tie on something else
        updateTag(best.id, tag);
        matched++;
        sheetMatched++;
    } else {
      ambiguous++;
      sheetAmbiguous++;
      ambiguousList.push({
        sheet: sheetName,
        kanji: kanjiStr,
        kana: kanaStr,
        meaning,
        candidates: candidates.map(c => ({
          kanji: c.kanji,
          kana: c.kana,
          romaji: c.romaji,
          primary_meaning: c.primary_meaning,
          tags: c.tags,
          score: scoreMatch({ kanji: kanjiStr, kana: kanaStr, meaning }, c)
        })).sort((a,b) => b.score - a.score)
      });
    }

    if (sheetProcessed % 200 === 0) {
      console.log(
        `[${sheetName}] Processed: ${sheetProcessed} | Matched: ${sheetMatched} | Unmatched: ${sheetUnmatched} | Ambiguous: ${sheetAmbiguous}`
      );
    }
  }

  console.log(`\n--- ${sheetName} Summary ---`);
  console.log(`Processed: ${sheetProcessed}`);
  console.log(`Matched: ${sheetMatched}`);
  console.log(`Unmatched: ${sheetUnmatched}`);
  console.log(`Ambiguous: ${sheetAmbiguous}`);
}

console.log(`\n================ FINAL SUMMARY ================`);
console.log(`Total Processed: ${totalProcessed}`);
console.log(`Matched: ${matched}`);
console.log(`Unmatched: ${unmatched}`);
console.log(`Ambiguous: ${ambiguous}`);

fs.writeFileSync(path.join(__dirname, 'debug_unmatched.json'), JSON.stringify(unmatchedList, null, 2));
fs.writeFileSync(path.join(__dirname, 'debug_ambiguous.json'), JSON.stringify(ambiguousList, null, 2));
console.log('\nWrote debug_unmatched.json and debug_ambiguous.json');
