
import Fuse from 'fuse.js';

const vocabulary = ['ugoku', 'omoitsuku', 'ogoku', 'ogou', 'ugoi'];
const options = {
    includeScore: true,
    threshold: 0.4,
    keys: ['romaji']
};

const fuse = new Fuse(vocabulary.map(v => ({ romaji: v })), options);

console.log('Search for "ogoitemasuka":');
console.log(JSON.stringify(fuse.search('ogoitemasuka'), null, 2));
