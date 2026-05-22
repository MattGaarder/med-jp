import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { XMLParser } from 'fast-xml-parser';
import * as wanakana from 'wanakana';
import { calculateCandidateScore } from '../../src/config/linguistics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const XML_PATH = path.join(__dirname, '../data/JMdict_b.xml');
const OUT_PATH = path.join(__dirname, '../data/vocab-v3.jsonl');


import 'dotenv/config';
const CONCURRENCY = 5;
const RETRIES = 3;
const RETRY_DELAY = 500; // ms
const TIMEOUT_MS = 10000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const entityMapping = {
  agric: "agriculture", anat: "anatomy", archeol: "archeology", archit: "architecture",
  art: "art, aesthetics", astron: "astronomy", audvid: "audiovisual", aviat: "aviation",
  baseb: "baseball", biochem: "biochemistry", biol: "biology", bot: "botany",
  boxing: "boxing", Buddh: "Buddhism", bus: "business", cards: "card games",
  chem: "chemistry", chmyth: "Chinese mythology", Christn: "Christianity", civeng: "civil engineering",
  cloth: "clothing", comp: "computing", cryst: "crystallography", dent: "dentistry",
  ecol: "ecology", econ: "economics", elec: "electricity, elec. eng.", electr: "electronics",
  embryo: "embryology", engr: "engineering", ent: "entomology", figskt: "figure skating",
  film: "film", finc: "finance", fish: "fishing", food: "food, cooking",
  gardn: "gardening, horticulture", genet: "genetics", geogr: "geography", geol: "geology",
  geom: "geometry", go: "go (game)", golf: "golf", gramm: "grammar",
  grmyth: "Greek mythology", hanaf: "hanafuda", horse: "horse racing", internet: "Internet",
  jpmyth: "Japanese mythology", kabuki: "kabuki", law: "law", ling: "linguistics",
  logic: "logic", MA: "martial arts", mahj: "mahjong", manga: "manga",
  math: "mathematics", mech: "mechanical engineering", med: "medicine", met: "meteorology",
  mil: "military", min: "mineralogy", mining: "mining", motor: "motorsport",
  music: "music", noh: "noh", ornith: "ornithology", paleo: "paleontology",
  pathol: "pathology", pharm: "pharmacology", phil: "philosophy", photo: "photography",
  physics: "physics", physiol: "physiology", politics: "politics", print: "printing",
  prowres: "professional wrestling", psy: "psychiatry", psyanal: "psychoanalysis", psych: "psychology",
  rail: "railway", rommyth: "Roman mythology", Shinto: "Shinto", shogi: "shogi",
  ski: "skiing", sports: "sports", stat: "statistics", stockm: "stock market",
  sumo: "sumo", surg: "surgery", telec: "telecommunications", tradem: "trademark",
  tv: "television", vet: "veterinary terms", vidg: "video games", zool: "zoology"
};

const posMapping = {
  n: "noun", n_pref: "prefix", n_suf: "suffix",
  v5k: "verb", v5g: "verb", v5s: "verb", v5t: "verb", v5n: "verb", v5m: "verb", v5h: "verb", v5r: "verb", v5u: "verb", v5z: "verb", v5aru: "verb",
  v1: "verb", v1s: "verb", vs: "verb", "vs-i": "verb", "vs-s": "verb", "vs-c": "verb", "vz": "verb",
  "adj-i": "adjective", "adj-na": "adjective", "adj-no": "adjective", "adj-pn": "adjective", "adj-t": "adjective", "adj-f": "adjective",
  vi: "intransitive verb", vt: "transitive verb",
  adv: "adverb", "adv-to": "adverb",
  prt: "particle", aux: "auxiliary", "aux-v": "auxiliary", "aux-adj": "auxiliary",
  conj: "conjunction", int: "interjection", pn: "pronoun", ctr: "counter",
  exp: "expression", cop: "copula", hum: "humble", hon: "honorific", pol: "polite"
};

function mapPos(pos) {
  if (!pos) return null;
  const p = pos.replace(/&([^;]+);/g, '$1');
  if (p === 'n') return 'noun';
  if (p.startsWith('v')) return p === 'vi' ? 'intransitive verb' : (p === 'vt' ? 'transitive verb' : 'verb');
  if (p.startsWith('adj')) return 'adjective';
  if (p.startsWith('adv')) return 'adverb';
  return posMapping[p] || p;
}

async function getEmbedding(text, attempt = 1) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: text }),
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Ollama API error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    return data.embedding;
  } catch (e) {
    clearTimeout(timeoutId);
    
    // Retry Logic
    if (attempt < RETRIES) {
      console.warn(`[RETRY ${attempt}/${RETRIES}] Embedding failed for "${text.substring(0, 20)}...": ${e.message}`);
      await delay(RETRY_DELAY);
      return getEmbedding(text, attempt + 1);
    }
    
    console.error(`\x1b[31m[FAILED] Embedding permanently failed after ${RETRIES} attempts for "${text.substring(0, 20)}..."\x1b[0m`);
    return null; // Don't return blank arrays to prevent poisoning
  }
}

// calculateFrequency replaced by centralized calculateScore in Linguistics Engine.

async function main() {
  const testFlag = process.argv.find(arg => arg.startsWith('--test'));
  const isTest = !!testFlag;
  const testCount = (testFlag && testFlag.includes('=')) ? parseInt(testFlag.split('=')[1], 10) : 10;

  const options = {
    ignoreAttributes: false,
    isArray: (name, jpath, isLeafNode, isAttribute) => {
      const arrayPaths = [
        "JMdict.entry",
        "JMdict.entry.k_ele",
        "JMdict.entry.k_ele.ke_pri",
        "JMdict.entry.r_ele",
        "JMdict.entry.r_ele.re_pri",
        "JMdict.entry.sense",
        "JMdict.entry.sense.gloss",
        "JMdict.entry.sense.pos",
        "JMdict.entry.sense.field",
        "JMdict.entry.sense.misc"
      ];
      return arrayPaths.includes(jpath);
    }
  };

  const parser = new XMLParser(options);
  console.log(`Reading XML from ${XML_PATH}...`);
  let xmlData = fs.readFileSync(XML_PATH, 'utf-8');
  console.log("Removing DOCTYPE to prevent entity parser limits...");
  const startIndex = xmlData.indexOf('<!DOCTYPE');
  if (startIndex !== -1) {
    const endIndex = xmlData.indexOf(']>', startIndex);
    if (endIndex !== -1) {
      xmlData = xmlData.substring(0, startIndex) + xmlData.substring(endIndex + 2);
    }
  }
  
  console.log("Parsing XML...");
  const parsed = parser.parse(xmlData);
  
  const entries = parsed.JMdict.entry;
  console.log(`Found ${entries.length} entries in XML.`);
  
  const processedIds = new Set();
  
  // Resumption functionality: Pull active cache mapping sequentially using readline
  // to prevent string length/memory overflow limits on 1GB+ buffers
  if (fs.existsSync(OUT_PATH)) {
    console.log(`JSONL cache detected at ${OUT_PATH}. Resuming...`);
    const fileStream = fs.createReadStream(OUT_PATH);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity
    });
    
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        processedIds.add(obj.entryId);
      } catch (err) {}
    }
    console.log(`Loaded ${processedIds.size} existing entry IDs from log.`);
  }

  // File appending stream out. Keeps RAM O(1).
  const stream = fs.createWriteStream(OUT_PATH, { flags: 'a' });

  const pending = [];
  let totalProcessed = 0;
  let totalGenerated = 0;
  let totalSkipped = 0;

  async function processEntry(entry, index) {
    try {
      if (!entry) return;
      
      const rEleList = entry.r_ele || [];
      const kEleList = entry.k_ele || [];
      
      // First preferred kanji
      const kanjiRaw = kEleList.length > 0 ? kEleList[0].keb : null;
      const kanji = typeof kanjiRaw === 'string' ? kanjiRaw : (kanjiRaw?.['#text'] || kanjiRaw);
      
      // Kana
      let kanaRaw = rEleList.length > 0 ? rEleList[0].reb : '';
      let kana = typeof kanaRaw === 'string' ? kanaRaw : (kanaRaw?.['#text'] || kanaRaw);
      
      if (!kana) {
        totalSkipped++;
        return;
      }
      
      const romaji = wanakana.toRomaji(kana);
      
      let meanings = [];
      let posSet = new Set();
      let prioritySet = new Set();
      let tagsSet = new Set();
      
      for (const r of rEleList) {
        if (r.re_pri) r.re_pri.forEach(p => prioritySet.add(p));
      }
      for (const k of kEleList) {
        if (k.ke_pri) k.ke_pri.forEach(p => prioritySet.add(p));
      }
      
      const senseList = entry.sense || [];
      const domainSet = new Set();
      for (const sense of senseList) {
        if (sense.gloss) {
          sense.gloss.forEach(g => {
            const m = typeof g === 'string' ? g : (g['#text'] || '');
            if (m) meanings.push(m);
          });
        }
        if (sense.pos) sense.pos.forEach(p => posSet.add(p));
        if (sense.field) {
          sense.field.forEach(f => {
            const short = f.replace(/&([^;]+);/g, '$1');
            const full = entityMapping[short] || short;
            domainSet.add(full);
          });
        }
        if (sense.misc) {
          sense.misc.forEach(m => {
            const cleanM = m.replace(/&([^;]+);/g, '$1');
            tagsSet.add(cleanM);
          });
        }
      }
      
      const scoreObj = calculateCandidateScore({ 
        tags: Array.from(prioritySet),
        domain: fullDomainStr
      });
      const freqScore = scoreObj.lexical;
      
      // Clean meanings: strip punctuation like () but keep the content inside them.
      const cleanMeanings = meanings
        .map(m => m.replace(/&[a-zA-Z0-9_-]+;/g, '').replace(/[()]/g, '').replace(/\s+/g, ' ').trim())
        .filter(m => m.length > 0);
      
      const cleanPos = Array.from(posSet).map(p => p.replace(/&([^;]+);/g, '$1'));
      const semanticPosLabels = Array.from(posSet).map(mapPos).filter(Boolean);
      const uniqueSemanticPos = Array.from(new Set(semanticPosLabels));

      const fullDomainStr = Array.from(domainSet).join(', ');
      
      // Construct a highly descriptive semantic string for embeddings.
      // Format: [romaji] [kanji] ([kana]) type: [pos] domain: [domain] meanings: [m1], [m2], [m3]
      const japaneseSection = kanji 
        ? `${kanji}${kana && kana !== kanji ? ` (${kana})` : ''}` 
        : (kana || '');
      
      const posLabelSection = uniqueSemanticPos.length > 0 ? `type: ${uniqueSemanticPos.join(', ')}` : '';
      const domainSection = fullDomainStr ? `domain: ${fullDomainStr}` : '';
      const meaningsSection = `meanings: ${cleanMeanings.slice(0, 4).join(', ')}`;
      
      const combinedText = `${romaji} ${japaneseSection} ${posLabelSection} ${domainSection} ${meaningsSection}`
        .trim().replace(/\s+/g, ' ');
      
      const embedding = await getEmbedding(combinedText);
      
      if (!embedding || embedding.length === 0) {
         console.warn(`[WARNING] Skipping index ${index}. Embedding failure for: ${romaji}`);
         totalSkipped++;
         return;
      }
      
      totalGenerated++;

      // Unify all metadata (Usage, Priority, Frequency) into a single tags array
      const allTagsSet = new Set([...prioritySet, ...tagsSet]);

      const outObj = {
        entryId: index,
        romaji,
        kana,
        kanji: kanji || undefined,
        meanings: cleanMeanings,
        pos: cleanPos,
        domain: fullDomainStr,
        tags: Array.from(allTagsSet),
        frequency: freqScore,
        combinedText,
        embedding
      };
      
      stream.write(JSON.stringify(outObj) + '\n');
      
    } catch (err) {
      console.error(`[ERROR] Unhandled exception processing entry index ${index}:`, err);
      totalSkipped++;
    }
  }

  for (let i = 0; i < entries.length; i++) {
    if (processedIds.has(i)) {
      continue; // Silently bypass already logically resolved maps
    }
    
    // Push the explicit promise
    pending.push(processEntry(entries[i], i).catch(e => console.error(e)));
    totalProcessed++;
    
    // Flow control queue
    if (pending.length >= CONCURRENCY) {
      await Promise.all(pending);
      pending.length = 0;
      
      // Periodically sync progress safely without array aggregation
      if (totalProcessed % 500 < CONCURRENCY) {
        console.log(`[Progress] Attempted: ${totalProcessed} | Streamed: ${totalGenerated} | Skipped/Failed: ${totalSkipped}`);
      }
      
      if (isTest && totalGenerated >= testCount) {
        break;
      }
    }
  }

  // Clear arbitrary left-overs
  if (pending.length > 0) {
    await Promise.all(pending);
  }
  
  stream.end();
  
  console.log(`\n\x1b[32m--- Final Streaming Summary ---\x1b[0m`);
  console.log(`Newly Compiled     : ${totalGenerated}`);
  console.log(`Skipped / Failed   : ${totalSkipped}`);
  console.log(`Existing in JSONL  : ${processedIds.size}`);
  console.log(`\x1b[32mFile closed securely at ${OUT_PATH}\x1b[0m`);
}

main().catch(console.error);
