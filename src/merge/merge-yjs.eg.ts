import * as Y from 'yjs';

// Small Yjs demo: merge non-overlapping edits from two peers.
// Matches the 3rd test in merge.test.ts ("merges non-overlapping line edits").

// Example from the test
let base = 'line1\nline2\nline3';
let expected = 'line1 remote\nline2 local\nline3';

// 1) Create a base doc and put the base text into a shared Y.Text
let baseDoc = new Y.Doc();
let baseText = baseDoc.getText('t');
baseText.insert(0, base);
let baseUpdate = Y.encodeStateAsUpdate(baseDoc);

// 2) Create two peers from the same base state
let oursDoc = new Y.Doc();
let theirsDoc = new Y.Doc();
Y.applyUpdate(oursDoc, baseUpdate);
Y.applyUpdate(theirsDoc, baseUpdate);

// 3) Apply their respective local edits against their own docs
// ours: insert " local" after "line2"
let oursText = oursDoc.getText('t');
let posLine2 = base.indexOf('line2') + 'line2'.length;
oursText.insert(posLine2, ' local');

// theirs: insert " remote" after "line1"
let theirsText = theirsDoc.getText('t');
let posLine1 = base.indexOf('line1') + 'line1'.length;
theirsText.insert(posLine1, ' remote');

// 4) Merge: apply both peers' updates into a third doc
let mergedDoc = new Y.Doc();
// Starting empty is fine — updates are idempotent and include base
let updateOurs = Y.encodeStateAsUpdate(oursDoc);
let updateTheirs = Y.encodeStateAsUpdate(theirsDoc);
Y.applyUpdate(mergedDoc, updateOurs);
Y.applyUpdate(mergedDoc, updateTheirs);

let merged = mergedDoc.getText('t').toString();
console.log('[yjs-merge] merged =', JSON.stringify(merged));

if (merged !== expected) {
  throw new Error(`Yjs demo mismatch: expected ${JSON.stringify(expected)} got ${JSON.stringify(merged)}`);
}

console.log(merged);
// End of simple demo script
