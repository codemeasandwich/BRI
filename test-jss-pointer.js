/**
 * @file Manual JSS stringify smoke script for shared-pointer documents (repo root).
 * Run with Node to print a canonical snapshot encoding; behaviour is asserted in **`tests/e2e/jss.test.js`**.
 */

import JSS from './src/utils/jss/index.js';

const alice = { $ID: 'USER_alice', name: 'Alice' };
const bob = { $ID: 'USER_bob', name: 'Bob' };
const post = {
  $ID: 'POST_1',
  title: 'Hello',
  author: alice,  // Same reference
  mentions: [alice, bob]  // Alice is same reference
};

const snapshot = {
  version: 2,
  documents: {
    'USER_alice': alice,
    'USER_bob': bob,
    'POST_1': post
  }
};

console.log('Stringify result:');
console.log(JSS.stringify(snapshot));
