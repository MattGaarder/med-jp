import { preprocessJapWithTrace } from './src/preprocessor.js';

function test(sentence) {
  console.log(`\n--- Testing Sentence: "${sentence}" ---`);
  const trace = preprocessJapWithTrace(sentence);
  
  console.log('Result:', trace.output);
  console.log('\nToken Analysis:');
  trace.tokens.forEach(tok => {
    const winner = tok.meta?.candidates ? tok.meta.candidates[0] : null;
    const semantic = winner?.semantic;
    
    console.log(`- ${tok.surface} (as ${tok.base}):`);
    console.log(`  - Meaning: ${tok.meaning}`);
    if (semantic && semantic.boost > 0) {
      console.log(`  - 🔥 Semantic Boost: -${semantic.boost.toFixed(1)} (${semantic.descriptor}) | Depth: ${semantic.treeDepth}`);
    } else {
      console.log(`  - No semantic boost.`);
    }
    console.log(`  - Adjusted Score: ${winner?.adjustedScore?.toFixed(2) || 'N/A'}`);
  });
}

// 1. Technical Anchor Recovery
test('kororado ni wa kurakku ga arimasu');

// 2. Compound Segmentation
test('kororadonetsu ga arimasu');

// 3. Daily conversation (No bias regression)
test('ohayou gozaimasu');
