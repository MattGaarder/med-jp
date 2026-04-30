
import * as wanakana from 'wanakana';
import { deinflect, WordType } from '../src/deinflect.js';

const inputs = ["おごいてますか", "きtづかれましたか"];
inputs.forEach(input => {
  const results = deinflect(input);
  console.log(`\nDeinflect results for ${input}:`);
  results.forEach(r => {
    console.log(`Word: ${r.word} (${wanakana.toRomaji(r.word)}), Type: ${r.type}, Reason: ${JSON.stringify(r.reasonChains)}`);
  });
});
