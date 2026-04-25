
import Fuse from 'fuse.js';

const list = [
  { romaji: 'hisan' },
  { romaji: 'hiza' }
];

const fuse = new Fuse(list, { 
  keys: ['romaji'],
  includeScore: true, 
  threshold: 0.5, 
  distance: 50 
});
const res = fuse.search('hisa');

console.log(JSON.stringify(res, null, 2));
