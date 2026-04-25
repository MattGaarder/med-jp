import fs from 'fs';
import { createInterface } from 'readline';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  ignoreAttributes: false,
});

/**
 * Normalizes a string by replacing punctuation with spaces and lowercasing.
 * Prevents token boundary collapse (e.g. "T-Ray" -> "t ray").
 */
function normalize(str) {
  if (!str) return '';
  return str.toLowerCase()
    .replace(/[.,/#!$%^&*;:{}=\-_`~()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Tokenizes a string for granular indexing.
 * Enforces word boundaries.
 */
function tokenize(str) {
  if (!str) return [];
  const normalized = normalize(str);
  return normalized.split(/\s+/)
    .filter(t => t.length > 2);
}

/**
 * Parses MeSH XML file and builds inverted indexes.
 * @param {string} filePath 
 * @returns {Promise<{termIndex: Map<string, Set<string>>, descriptorIndex: Map<string, object>}>}
 */
export async function parseMeSH(filePath) {
  const termIndex = new Map(); // normalized_term -> Set of Descriptor UIs
  const descriptorIndex = new Map(); // Descriptor UI -> { name, preferredTerm, preferredTokens, treeNumbers, terms }

  const fileStream = fs.createReadStream(filePath);
  const rl = createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let currentChunk = '';
  let inRecord = false;
  let recordCount = 0;

  console.error(`📖 Parsing MeSH XML: ${filePath}`);

  for await (const line of rl) {
    if (line.includes('<DescriptorRecord ')) {
      inRecord = true;
      currentChunk = line;
    } else if (line.includes('</DescriptorRecord>')) {
      currentChunk += line;
      processRecord(currentChunk, termIndex, descriptorIndex);
      currentChunk = '';
      inRecord = false;
      recordCount++;
      if (recordCount % 5000 === 0) {
        console.error(`   Processed ${recordCount} descriptors...`);
      }
    } else if (inRecord) {
      currentChunk += line;
    }
  }

  console.error(`✅ MeSH Parsing Complete. Found ${recordCount} descriptors.`);
  console.error(`   Term Index Size: ${termIndex.size} keys`);
  
  return { termIndex, descriptorIndex };
}

function processRecord(xmlChunk, termIndex, descriptorIndex) {
  try {
    const jsonObj = parser.parse(xmlChunk);
    const record = jsonObj.DescriptorRecord;

    const ui = record.DescriptorUI;
    const name = record.DescriptorName.String;
    
    // Level 3: Tokenize preferred term for elite anchoring matching
    const preferredTokens = tokenize(name);
    const preferredTermNormalized = normalize(name);
    
    // Extract Tree Numbers
    let treeNumbers = [];
    if (record.TreeNumberList) {
      const list = record.TreeNumberList.TreeNumber;
      treeNumbers = Array.isArray(list) ? list : [list];
    }

    // Extract all terms (synonyms)
    const entryTerms = new Set();
    entryTerms.add(preferredTermNormalized);

    if (record.ConceptList) {
      const concepts = Array.isArray(record.ConceptList.Concept) 
        ? record.ConceptList.Concept 
        : [record.ConceptList.Concept];

      for (const concept of concepts) {
        if (concept.TermList) {
          const tList = Array.isArray(concept.TermList.Term) 
            ? concept.TermList.Term 
            : [concept.TermList.Term];
          
          for (const t of tList) {
            const termStr = t.String;
            if (termStr) {
              const norm = normalize(termStr);
              entryTerms.add(norm);
            }
          }
        }
      }
    }

    // Update descriptor index
    descriptorIndex.set(ui, {
      ui,
      name,
      preferredTerm: preferredTermNormalized,
      preferredTokens,
      treeNumbers,
      terms: Array.from(entryTerms)
    });

    // Update inverted index
    for (const term of entryTerms) {
      // Full phrase index
      addToIndex(term, ui, termIndex);

      // Token-level index for expansion
      const tokens = tokenize(term);
      for (const token of tokens) {
        addToIndex(token, ui, termIndex);
      }
    }

  } catch (err) {
    // Silently skip malformed chunks
  }
}

function addToIndex(key, val, index) {
  if (!key || key.length < 2) return;
  if (!index.has(key)) {
    index.set(key, new Set());
  }
  index.get(key).add(val);
}
