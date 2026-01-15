import JSS from './diff/jss/index.js';

const alice = { $ID: 'USER_alice', name: 'Alice' };
const bob = { $ID: 'USER_bob', name: 'Bob' };
const post = {
  $ID: 'POST_1',
  title: 'Hello',
  author: alice,
  mentions: [alice, bob]
};

const snapshot = {
  version: 2,
  documents: {
    'USER_alice': alice,
    'USER_bob': bob,
    'POST_1': post
  }
};

console.log('Original:');
console.log('- post.author === alice:', post.author === alice);
console.log('- post.mentions[0] === alice:', post.mentions[0] === alice);

const encoded = JSS.stringify(snapshot);
console.log('\nEncoded:', encoded);

const decoded = JSS.parse(encoded);
console.log('\nDecoded:');
console.log('- post.author === alice:', decoded.documents.POST_1.author === decoded.documents.USER_alice);
console.log('- post.mentions[0] === alice:', decoded.documents.POST_1.mentions[0] === decoded.documents.USER_alice);
console.log('- post.mentions[1] === bob:', decoded.documents.POST_1.mentions[1] === decoded.documents.USER_bob);
console.log('- post.author:', decoded.documents.POST_1.author);
