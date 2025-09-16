import * as Y from 'yjs';
import DiffMatchPatch from 'diff-match-patch';

export type MergeInputs = {
  base: string;
  ours: string;
  theirs: string;
};

// Apply a diff (base -> variant) to ytext directly based on base indices.
function applyVariantDirect(ytext: Y.Text, base: string, variant: string): void {
  let dmp = new DiffMatchPatch();
  let diffs = dmp.diff_main(base, variant);
  dmp.diff_cleanupSemantic(diffs);
  let pos = 0;
  for (let i = 0; i < diffs.length; i++) {
    let [op, text] = diffs[i]!;
    if (op === 0) {
      pos += text.length;
    } else if (op === -1) {
      ytext.delete(pos, text.length);
    } else {
      ytext.insert(pos, text);
      pos += text.length;
    }
  }
}

type InsertOp = {
  kind: 'insert';
  rel: Y.RelativePosition;
  text: string;
  replaceStart: number;
  replaceLen: number;
};

type DeleteOp = {
  kind: 'delete';
  start: Y.RelativePosition;
  end: Y.RelativePosition;
};

type OurOp = InsertOp | DeleteOp;
type Range = { start: number; end: number };

function computeChangedRanges(base: string, theirs: string): Range[] {
  let dmp = new DiffMatchPatch();
  let diffs = dmp.diff_main(base, theirs);
  dmp.diff_cleanupSemantic(diffs);
  let ranges: Range[] = [];
  let pos = 0;
  for (let i = 0; i < diffs.length; i++) {
    let [op, text] = diffs[i]!;
    if (op === 0) {
      pos += text.length;
      continue;
    }
    if (op === -1) {
      let len = text.length;
      if (len) ranges.push({ start: pos, end: pos + len });
      continue;
    }
    // insert: no base advancement
  }
  return ranges;
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
      pos += text.length;
      continue;
    }
    // Detect replacement: delete immediately followed by insert
    if (op === -1 && diffs[i + 1] && diffs[i + 1]![0] === 1) {
      let insertText = diffs[i + 1]![1] as string;
      let delLen = (text as string).length;
      // Anchor at the right edge; also record base span for conflict checks
      let rel = Y.createRelativePositionFromTypeIndex(ytext, pos + delLen, 1);
      ops.push({ kind: 'insert', rel, text: insertText, replaceStart: pos, replaceLen: delLen });
      // Skip the paired insert; do not advance pos (relative to base)
      i += 1;
      continue;
    }
    if (op === -1) {
      let start = Y.createRelativePositionFromTypeIndex(ytext, pos, 1);
      let end = Y.createRelativePositionFromTypeIndex(ytext, pos + text.length, 1);
      ops.push({ kind: 'delete', start, end });
      continue;
    }
    // INSERT (standalone)
    let rel = Y.createRelativePositionFromTypeIndex(ytext, pos, 1);
    ops.push({ kind: 'insert', rel, text, replaceStart: pos, replaceLen: 0 });
  }
  return ops;
}

function applyOurOpsAfterTheirs(merged: Y.Text, ops: OurOp[], theirsRanges: Range[]): void {
  for (let i = 0; i < ops.length; i++) {
    let op = ops[i]!;
    if (op.kind === 'insert') {
      // If this insert is part of a replacement and the replaced base span intersects
      // a span changed by "theirs", prefer "theirs" and skip our insert.
      if (op.replaceLen > 0) {
        let a = op.replaceStart, b = op.replaceStart + op.replaceLen;
        let conflict = theirsRanges.some(r => Math.max(r.start, a) < Math.min(r.end, b));
        if (conflict) continue;
      }
      let abs = Y.createAbsolutePositionFromRelativePosition(op.rel, merged.doc!);
      if (!abs || abs.type !== merged) continue;
      merged.insert(Math.max(0, Math.min(abs.index, merged.length)), op.text);
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
  if (ours === theirs) return ours;
  let doc = new Y.Doc();
  let text = doc.getText('t');
  text.insert(0, base);
  // Identify conflict regions based on "theirs" changes over base
  let theirsRanges = computeChangedRanges(base, theirs);
  // Plan our edits relative to base using relative positions anchored in `text`
  let ourOps = computeOurOps(text, base, ours);
  // Apply "theirs" directly to the shared doc
  applyVariantDirect(text, base, theirs);
  // Then apply "ours" using relative positions (which survive prior edits)
  applyOurOpsAfterTheirs(text, ourOps, theirsRanges);
  return text.toString();
}

export const __test = { applyVariantDirect, computeChangedRanges, computeOurOps, applyOurOpsAfterTheirs };
