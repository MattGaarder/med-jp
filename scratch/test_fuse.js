
import Fuse from 'fuse.js';

const vocabulary = ['ugoku', 'omoitsuku', 'ogoku', 'ogou', 'ugoi'];
const options = {
    includeScore: true,
    threshold: 0.4,
    keys: ['romaji']
};

const fuse = new Fuse(vocabulary.map(v => ({ romaji: v })), options);

console.log('Search for "ogoku":');
console.log(JSON.stringify(fuse.search('ogoku'), null, 2));

console.log('Search for "ogoite":');
console.log(JSON.stringify(fuse.search('ogoite'), null, 2));
