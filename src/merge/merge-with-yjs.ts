/**
 * This module coordinates a three-way text merge by staging the common ancestor
 * in a Yjs document, replaying incoming edits in two passes, and reconciling
 * conflicts with structural awareness. The first pass reuses diff-match-patch
 * to apply the remote variant directly. The second pass replays the local
 * variant through relative positions that survive earlier mutations, allowing
 * replacements to fall back to the remote choice when spans overlap. The diff
 * helper prefers line-oriented splits before dropping to character diffs so
 * structural edits remain stable while word-level tweaks still reconcile.
 */

import * as Y from 'yjs';
import DiffMatchPatch from 'diff-match-patch';

export { type MergeInputs, mergeWithYjs };

type MergeInputs = {
  base: string;
  ours: string;
  theirs: string;
};

/** Merge local and remote variants against a shared ancestor using Yjs. */
function mergeWithYjs({ base, ours, theirs }: MergeInputs): string {
  if (ours === theirs) return ours;
  let doc = new Y.Doc();
  let text = doc.getText('t');
  text.insert(0, base);

  // Compute diffs for both variants against the base
  let theirDiffs = diffStructured(base, theirs);
  let ourDiffs = diffStructured(base, ours);

  // Plan our edits relative to base using relative positions anchored in `text`
  let ourOps = diffsToOps(text, ourDiffs);

  // Apply "theirs" directly to the shared doc using the precomputed diff
  applyDiffsToYText(text, theirDiffs);

  // Then apply "ours" using relative positions (which survive prior edits)
  let theirRanges = collectChangedRanges(theirDiffs);
  applyOurOpsAfterTheirs(text, ourOps, theirRanges);

  return text.toString();
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

type Op = InsertOp | DeleteOp;
type Range = { start: number; end: number };

type DMPDiff = [number, string];

/**
 * Precompute local edits as relative positions that survive subsequent mutations
 * so they can be replayed after remote changes while tracking replaced spans.
 */
function diffsToOps(ytext: Y.Text, diffs: DMPDiff[]): Op[] {
  let ops: Op[] = [];
  let pos = 0;
  for (let i = 0; i < diffs.length; i++) {
    let [op, text] = diffs[i]!;
    if (op === 0) {
      pos += text.length;
      continue;
    }
    // Detect a replacement where a delete is immediately followed by an insert.
    let next = diffs[i + 1];
    if (op === -1 && next && next[0] === 1) {
      let insertText = next[1];
      let delLen = text.length;
      // Anchor at the right edge to keep the cursor stable after remote edits.
      let rel = Y.createRelativePositionFromTypeIndex(ytext, pos + delLen, 1);
      ops.push({ kind: 'insert', rel, text: insertText, replaceStart: pos, replaceLen: delLen });
      // Skip the paired insert and advance past the deleted base span.
      i += 1;
      pos += delLen;
      continue;
    }
    if (op === -1) {
      let start = Y.createRelativePositionFromTypeIndex(ytext, pos, 1);
      let end = Y.createRelativePositionFromTypeIndex(ytext, pos + text.length, 1);
      // Keep deletions as start/end anchors so the eventual span stays bounded.
      ops.push({ kind: 'delete', start, end });
      pos += text.length;
      continue;
    }
    // Standalone insertions anchor at the current base offset.
    let rel = Y.createRelativePositionFromTypeIndex(ytext, pos, 1);
    ops.push({ kind: 'insert', rel, text, replaceStart: pos, replaceLen: 0 });
  }
  return ops;
}

/** Replay local operations after remote edits, skipping conflicts when spans overlap. */
function applyOurOpsAfterTheirs(merged: Y.Text, ops: Op[], theirRanges: Range[]): void {
  let doc = merged.doc;
  if (!doc) throw Error('Y.Text is not attached to a Y.Doc');
  for (let op of ops) {
    if (op.kind === 'insert') {
      // If this insert is part of a replacement and the replaced base span intersects
      // a span changed by "theirs", prefer "theirs" and skip our insert.
      if (op.replaceLen > 0) {
        let range = { start: op.replaceStart, end: op.replaceStart + op.replaceLen };
        let conflict = theirRanges.some((r) => rangesOverlap(range, r));
        if (conflict) continue;
      }
      let abs = Y.createAbsolutePositionFromRelativePosition(op.rel, doc);
      if (!abs || abs.type !== merged) continue;
      let insertIndex = Math.max(0, Math.min(abs.index, merged.length));
      if (op.replaceLen > 0) {
        // Delete whatever survived inside the target span before re-inserting ours.
        let from = Math.max(0, insertIndex - op.replaceLen);
        let available = Math.max(0, Math.min(op.replaceLen, merged.length - from));
        if (available > 0) merged.delete(from, available);
        insertIndex = from;
      }
      merged.insert(insertIndex, op.text);
      continue;
    }
    let a = Y.createAbsolutePositionFromRelativePosition(op.start, doc);
    let b = Y.createAbsolutePositionFromRelativePosition(op.end, doc);
    if (!a || !b || a.type !== merged || b.type !== merged) continue;
    let from = Math.min(a.index, b.index);
    let to = Math.max(a.index, b.index);
    let len = Math.max(0, to - from);
    if (len) merged.delete(from, len);
  }
}

/** Collect base ranges that were deleted when applying a diff. */
function collectChangedRanges(diffs: DMPDiff[]): Range[] {
  let ranges: Range[] = [];
  let pos = 0;
  for (let diff of diffs) {
    let [op, text] = diff;
    if (op === 0) {
      pos += text.length;
      continue;
    }
    if (op === -1) {
      let len = text.length;
      if (len) ranges.push({ start: pos, end: pos + len });
      pos += len;
      continue;
    }
    // insert: no base advancement
  }
  return ranges;
}

/** Check whether two ranges overlap. */
function rangesOverlap(range1: Range, range2: Range): boolean {
  return Math.max(range2.start, range1.start) < Math.min(range2.end, range1.end);
}

/** Apply precomputed diff tuples to a Yjs text instance. */
function applyDiffsToYText(ytext: Y.Text, diffs: DMPDiff[]): void {
  let pos = 0;
  for (let diff of diffs) {
    let [op, text] = diff;
    if (op === 0) {
      pos += text.length;
      continue;
    }
    if (op === -1) {
      ytext.delete(pos, text.length);
      continue;
    }
    ytext.insert(pos, text);
    pos += text.length;
  }
}

/** Generate a structured diff that prefers line chunks before char-level diffs. */
function diffStructured(base: string, variant: string, inputDmp?: DiffMatchPatch): DMPDiff[] {
  let dmp = inputDmp ?? new DiffMatchPatch();
  return diffStructuredInternal(dmp, base, variant, 0);
}

/** Internal recursive diff that escalates from line to character granularity. */
function diffStructuredInternal(
  dmp: DiffMatchPatch,
  base: string,
  variant: string,
  depth: number
): DMPDiff[] {
  // Base cases ensure empty strings collapse quickly without further recursion.
  if (base === variant) return base.length ? [[0, base]] : [];
  if (!base.length) return variant.length ? [[1, variant]] : [];
  if (!variant.length) return base.length ? [[-1, base]] : [];
  if (depth > 8) {
    let diffs = dmp.diff_main(base, variant);
    dmp.diff_cleanupSemantic(diffs);
    let limited: DMPDiff[] = [];
    for (let i = 0; i < diffs.length; i++) {
      let [op, text] = diffs[i]!;
      pushDiff(limited, op, text);
    }
    return limited;
  }

  let useLineMode = hasMultipleLogicalLines(base) || hasMultipleLogicalLines(variant);
  if (useLineMode) {
    let { chars1, chars2, lineArray } = dmp.diff_linesToChars_(base, variant);
    let diffs = dmp.diff_main(chars1, chars2, false);
    dmp.diff_charsToLines_(diffs, lineArray);
    let result: DMPDiff[] = [];
    for (let i = 0; i < diffs.length; i++) {
      let [op, text] = diffs[i]!;
      if (op === -1 && i + 1 < diffs.length && diffs[i + 1]![0] === 1) {
        let next = diffs[i + 1]!;
        let nextText = next[1];
        // Re-run the diff on matching delete/insert pairs to detect granular edits.
        let nested = diffStructuredInternal(dmp, text, nextText, depth + 1);
        if (
          nested.length === 2 &&
          nested[0]![0] === -1 &&
          nested[1]![0] === 1 &&
          nested[0]![1] === text &&
          nested[1]![1] === nextText
        ) {
          pushDiff(result, -1, text);
          pushDiff(result, 1, nextText);
          i += 1;
          continue;
        }
        for (let j = 0; j < nested.length; j++) {
          let [nestedOp, nestedText] = nested[j]!;
          pushDiff(result, nestedOp, nestedText);
        }
        i += 1;
        continue;
      }
      pushDiff(result, op, text);
    }
    return result;
  }

  let diffs = dmp.diff_main(base, variant);
  dmp.diff_cleanupSemantic(diffs);
  let merged: DMPDiff[] = [];
  for (let i = 0; i < diffs.length; i++) {
    let [op, text] = diffs[i]!;
    pushDiff(merged, op, text);
  }
  return merged;
}

/** Check whether a string spans multiple logical lines after trimming. */
function hasMultipleLogicalLines(text: string): boolean {
  if (!text.includes('\n')) return false;
  let trimmed = text.replace(/\n+$/, '');
  return trimmed.includes('\n');
}

/** Push a diff tuple, coalescing adjacent operations of the same type. */
function pushDiff(acc: DMPDiff[], op: number, text: string): void {
  if (text.length === 0) return;
  let last = acc[acc.length - 1];
  if (last && last[0] === op) {
    last[1] += text;
  } else {
    acc.push([op, text]);
  }
}
