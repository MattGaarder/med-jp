import { deinflect, interpretReasonChains } from '../src/deinflect.js';
import * as wanakana from 'wanakana';

const input = 'たべられなかった';
const results = deinflect(input);

console.log(`Deinflect results for: ${input}`);
results.forEach(r => {
  console.log(`- Word: ${r.word}, Reasons: ${interpretReasonChains(r.reasonChains).join(' -> ')}, Type: ${r.type}`);
});
