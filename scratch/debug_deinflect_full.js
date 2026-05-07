
import { deinflect, WordType, Reason } from '../src/deinflect.js';
import * as wanakana from 'wanakana';

const input = 'ogoitemasuka';
const hira = wanakana.toHiragana(input);
const results = deinflect(hira);

console.log(`Deinflect results for ${input}:`);
results.forEach(r => {
    console.log(`- Word: ${r.word}, Type: ${r.type}, Reasons: ${JSON.stringify(r.reasonChains)}`);
});
