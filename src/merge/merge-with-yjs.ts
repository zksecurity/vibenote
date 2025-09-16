import * as Y from 'yjs';
import DiffMatchPatch from 'diff-match-patch';

export type MergeInputs = {
  base: string;
  ours: string;
  theirs: string;
};

type InsertOp = {
  kind: 'insert';
  rel: Y.RelativePosition;
  text: string;
};

type DeleteOp = {
  kind: 'delete';
  start: Y.RelativePosition;
  end: Y.RelativePosition;
};

type OurOp = InsertOp | DeleteOp;

// Apply a diff (base -> variant) to ytext directly. Assumes ytext currently
// holds exactly `base`. Simple linear scan using the diff tuples.
function applyVariantDirect(ytext: Y.Text, base: string, variant: string): void {
  let dmp = new DiffMatchPatch();
  let diffs = dmp.diff_main(base, variant);
  dmp.diff_cleanupSemantic(diffs);
  let pos = 0;
  for (let i = 0; i < diffs.length; i++) {
    let [op, text] = diffs[i]!;
    if (op === 0) {
      // EQUAL
      pos += text.length;
    } else if (op === -1) {
      // DELETE
      ytext.delete(pos, text.length);
      // pos unchanged
    } else {
      // INSERT
      ytext.insert(pos, text);
      pos += text.length;
    }
  }
}

// Precompute "ours" ops against the base text as RelativePositions so that
// we can apply them after applying "theirs" edits, while preserving intent.
function computeOurOps(ytext: Y.Text, base: string, ours: string): OurOp[] {
  let dmp = new DiffMatchPatch();
  let diffs = dmp.diff_main(base, ours);
  dmp.diff_cleanupSemantic(diffs);
  let ops: OurOp[] = [];
  let pos = 0;
  for (let i = 0; i < diffs.length; i++) {
    let [op, text] = diffs[i]!;
    if (op === 0) {
      // EQUAL
      pos += text.length;
    } else if (op === -1) {
      // DELETE: record a range in base coordinates
      let start = Y.createRelativePositionFromTypeIndex(ytext, pos, 1);
      let end = Y.createRelativePositionFromTypeIndex(ytext, pos + text.length, 1);
      ops.push({ kind: 'delete', start, end });
      // pos unchanged
    } else {
      // INSERT: record position right after the base character at `pos`
      // assoc=1 biases to insert after concurrent inserts at the same spot,
      // letting "theirs" appear first when applied earlier.
      let rel = Y.createRelativePositionFromTypeIndex(ytext, pos, 1);
      ops.push({ kind: 'insert', rel, text });
      // do not advance pos on insert (relative to base)
    }
  }
  return ops;
}

function applyOurOpsAfterTheirs(merged: Y.Text, ops: OurOp[]): void {
  for (let i = 0; i < ops.length; i++) {
    let op = ops[i]!;
    if (op.kind === 'insert') {
      let abs = Y.createAbsolutePositionFromRelativePosition(op.rel, merged.doc!);
      if (!abs || abs.type !== merged) continue;
      merged.insert(abs.index, op.text);
    } else {
      let a = Y.createAbsolutePositionFromRelativePosition(op.start, merged.doc!);
      let b = Y.createAbsolutePositionFromRelativePosition(op.end, merged.doc!);
      if (!a || !b || a.type !== merged || b.type !== merged) continue;
      let from = Math.min(a.index, b.index);
      let to = Math.max(a.index, b.index);
      let len = Math.max(0, to - from);
      if (len) merged.delete(from, len);
    }
  }
}

export function mergeWithYjs({ base, ours, theirs }: MergeInputs): string {
  // Seed merged doc with base
  let doc = new Y.Doc();
  let text = doc.getText('t');
  text.insert(0, base);

  // Plan our edits relative to base using relative positions anchored in `text`
  let ourOps = computeOurOps(text, base, ours);

  // Apply "theirs" directly to the shared doc
  applyVariantDirect(text, base, theirs);

  // Then apply "ours" using relative positions (which survive prior edits)
  applyOurOpsAfterTheirs(text, ourOps);

  return text.toString();
}

export const __test = { applyVariantDirect, computeOurOps, applyOurOpsAfterTheirs };

