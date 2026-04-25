import { matchEntry } from './src/mesh_annotator.js';

const mockTermIndex = new Map([
  ['colorado', new Set(['D01', 'D02', 'D03'])], 
  ['fever', new Set(['D01'])],
  ['immunoglobulin', new Set(['D10'])],
  ['constant', new Set(['D10', 'D11', 'D12'])],
  ['crack', new Set(['D100'])]
]);

const mockDescriptorIndex = new Map([
  ['D01', { ui: 'D01', name: 'Colorado Tick Fever', preferredTerm: 'colorado tick fever', preferredTokens: ['colorado', 'tick', 'fever'], treeNumbers: ['C01'], terms: ['colorado tick fever'] }],
  ['D02', { ui: 'D02', name: 'Other Disease 2', preferredTerm: 'other disease 2', preferredTokens: ['other'], treeNumbers: ['C01'], terms: [] }],
  ['D03', { ui: 'D03', name: 'Other Disease 3', preferredTerm: 'other disease 3', preferredTokens: ['other'], treeNumbers: ['C01'], terms: [] }],
  ['D10', { ui: 'D10', name: 'Immunoglobulin Constant Regions', preferredTerm: 'immunoglobulin constant regions', preferredTokens: ['immunoglobulin', 'constant', 'regions'], treeNumbers: ['G12'], terms: ['immunoglobulin constant regions'] }],
  ['D11', { ui: 'D11', name: 'Structural Constant 1', preferredTerm: 'structural', preferredTokens: ['structural'], treeNumbers: ['G12'], terms: [] }],
  ['D12', { ui: 'D12', name: 'Structural Constant 2', preferredTerm: 'structural', preferredTokens: ['structural'], treeNumbers: ['G12'], terms: [] }],
  ['D100', { ui: 'D100', name: 'Crack Cocaine', preferredTerm: 'crack cocaine', preferredTokens: ['crack', 'cocaine'], treeNumbers: ['D03'], terms: ['crack cocaine'] }]
]);

function test(label, entry) {
  console.log(`\n--- ${label} ---`);
  const result = matchEntry(entry, mockTermIndex, mockDescriptorIndex);
  console.log(JSON.stringify(result, null, 2));
}

// 1. Weak Token Rejection (Geographic)
test('RESOLVED: "colorado" vs "Colorado Tick Fever" (Should be REJECTED via Importance < 0.30)', {
  id: 4570, romaji: 'kororado', kana: 'コロラド', primary_meaning: 'colorado', secondary_meanings: ''
});

// 2. Headword Persistence
test('VALID: "fever" vs "Colorado Tick Fever" (Should be ACCEPTED because fever is high-importance)', {
  id: 4571, romaji: 'netsu', kana: 'ねつ', primary_meaning: 'fever', secondary_meanings: ''
});

// 3. Structural Word Rejection
test('RESOLVED: "constant" vs "Immunoglobulin Constant Regions" (Should be REJECTED)', {
  id: 999, romaji: 'konsutanto', kana: 'コンスタント', primary_meaning: 'constant', secondary_meanings: ''
});

// 4. Elite Expansion persistence
test('VALID: "crack" (katakana, low ambiguity) -> "Crack Cocaine" (Should still expand)', {
  id: 3881, romaji: 'kurakku', kana: 'クラック', primary_meaning: 'crack', secondary_meanings: ''
});
