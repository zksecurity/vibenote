// Pure merge logic for three-way Markdown/text merges.
// No GitHub or storage dependencies. Browser-friendly.
import DiffMatchPatch from 'diff-match-patch';

// For debugging: in devtools, access __lastMerge to see the last merge inputs/outputs.

export type MergeResult = {
  base: string;
  ours: string;
  theirs: string;
  result: string;
};

export function mergeMarkdown(base: string, ours: string, theirs: string): string {
  const bBlocks = splitIntoBlocks(base);
  const oBlocks = splitIntoBlocks(ours);
  const tBlocks = splitIntoBlocks(theirs);
  let result: string;
  if (bBlocks.length === oBlocks.length && bBlocks.length === tBlocks.length) {
    let out: string[] = [];
    for (let i = 0; i < bBlocks.length; i++) {
      out.push(mergeBlock(bBlocks[i]!.content, oBlocks[i]!.content, tBlocks[i]!.content));
    }
    result = out.join('\n');
  } else {
    result = mergeBlock(base, ours, theirs);
  }
  const last: MergeResult = { base, ours, theirs, result };
  try {
    (globalThis as any).__lastMerge = last;
  } catch {}
  return result;
}

function splitIntoBlocks(input: string): { type: 'code' | 'text'; content: string }[] {
  const lines = input.split(/\r?\n/);
  const out: { type: 'code' | 'text'; content: string }[] = [];
  let inFence = false;
  let buf: string[] = [];
  let bufType: 'code' | 'text' = 'text';
  for (const ln of lines) {
    const isFence = /^```/.test(ln);
    if (isFence) {
      if (!inFence) {
        if (buf.length) out.push({ type: bufType, content: buf.join('\n') });
        buf = [ln];
        bufType = 'code';
        inFence = true;
      } else {
        buf.push(ln);
        out.push({ type: 'code', content: buf.join('\n') });
        buf = [];
        bufType = 'text';
        inFence = false;
      }
      continue;
    }
    buf.push(ln);
  }
  if (buf.length) out.push({ type: bufType, content: buf.join('\n') });
  return out;
}

function mergeBlock(base: string, ours: string, theirs: string): string {
  const dmp = new DiffMatchPatch();
  // Apply patches for base->theirs onto ours
  const patches = dmp.patch_make(base, theirs);
  let [result, applied] = dmp.patch_apply(patches, ours);
  if (applied.some((ok: boolean) => !ok)) {
    // Conservative union: keep ours, append any lines present in theirs but not in ours
    const oursLines = new Set(ours.split(/\r?\n/));
    const extras: string[] = [];
    for (const l of theirs.split(/\r?\n/)) {
      if (!oursLines.has(l)) extras.push(l);
    }
    return [ours, extras.length ? extras.join('\n') : ''].filter(Boolean).join('\n');
  }
  // If patches applied cleanly, trust the patch result to preserve locality
  return result;
}

export const __test = { splitIntoBlocks, mergeBlock };
