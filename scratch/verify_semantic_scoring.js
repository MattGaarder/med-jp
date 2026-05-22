import { parseSemanticTags, collectSemanticTags, calculateCandidateScore } from '../src/config/linguistics.js';

const testEntries = [
  {
    id: 1,
    romaji: 'test1',
    domain: 'astronomy, medicine',
    mesh_domains: ['mesh_disease', 'mesh_biology']
  },
  {
    id: 2,
    romaji: 'test2',
    domain: 'astronomy, physics, mathematics',
    mesh_domains: ['mesh_anatomy', 'mesh_drug']
  },
  {
    id: 3,
    romaji: 'test3',
    domain: 'medicine',
    mesh_domains: 'mesh_disease, mesh_procedure'
  },
  {
    id: 4,
    romaji: 'test4',
    domain: ['medicine', 'pharmacology'],
    mesh_domains: ['mesh_disease', 'mesh_drug']
  }
];

console.log('--- Testing parseSemanticTags ---');
console.log('Array with comma-separated string:', parseSemanticTags(['astronomy, medicine']));
console.log('Raw comma-separated string:', parseSemanticTags('astronomy, medicine'));
console.log('Mixed array:', parseSemanticTags(['astronomy', 'medicine, biology']));

console.log('\n--- Testing collectSemanticTags ---');
testEntries.forEach(entry => {
  console.log(`Entry ${entry.id} tags:`, Array.from(collectSemanticTags(entry)));
});

console.log('\n--- Testing calculateCandidateScore ---');
testEntries.forEach(entry => {
  const score = calculateCandidateScore(entry, { type: 'exact' });
  console.log(`Entry ${entry.id} (${entry.romaji}):`);
  console.log(`  Total: ${score.total}`);
  console.log(`  Semantic Breakdown:`, score.components.semantic);
  console.log(`  Full Breakdown: ${score.breakdown}`);
});

// Test non-stacking vs small bonus
const entryMultifaceted = {
  id: 5,
  romaji: 'multi',
  domain: 'medicine, pharmacology',
  mesh_domains: ['mesh_disease', 'mesh_drug']
};
const scoreMulti = calculateCandidateScore(entryMultifaceted, { type: 'exact' });
console.log(`\nEntry 5 (multi):`);
console.log(`  Semantic: ${scoreMulti.components.semantic}`);
console.log(`  Weights used: mesh_disease (100) is max. + bonus for others.`);
// pharmacology (80), medicine (60), mesh_drug (90)
// max is 100 (mesh_disease). 
// count is 4 tags. bonus = (4-1) * 5 = 15.
// total semantic = 100 + 15 = 115.
