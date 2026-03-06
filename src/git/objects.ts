// Pure functions for computing Git-compatible blob, tree, and commit SHA-1
// hashes. All results are byte-for-byte identical to what the real `git` CLI
// produces. No storage, no network, no React — only Web Crypto (crypto.subtle).

import type { FileMode, GitSha, Path, PendingCommit, Signature, TreeEntry } from "./types.ts";

export { blobSha, treeSha, buildTree, commitSha };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Compute the Git blob SHA-1 for raw file bytes.
// Git format: SHA-1("blob <byte-length>\0<content>")
async function blobSha(content: Uint8Array): Promise<GitSha> {
  const header = encodeText(`blob ${content.byteLength}\0`);
  const hex = await sha1(concat(header, content));
  return hex as GitSha;
}

// Compute the Git tree SHA-1 for a list of tree entries.
// Entries are sorted into Git's canonical order before hashing.
// Git format: SHA-1("tree <byte-length>\0" + sorted binary entries)
// Each binary entry: "<mode> <name>\0<20-raw-sha-bytes>"
async function treeSha(entries: TreeEntry[]): Promise<GitSha> {
  const sorted = [...entries].sort(compareTreeEntries);

  // Build the binary tree body by concatenating all entry buffers
  const parts: Uint8Array[] = [];
  for (const entry of sorted) {
    // Directories are stored as "40000" in the binary, not "040000"
    const modeStr = treeModeString(entry.mode);
    const entryHeader = encodeText(`${modeStr} ${entry.name}\0`);
    const shaBytes = hexToBytes(entry.sha); // 20 raw bytes, not hex text
    parts.push(entryHeader, shaBytes);
  }

  const body = concat(...parts);
  const header = encodeText(`tree ${body.byteLength}\0`);
  const hex = await sha1(concat(header, body));
  return hex as GitSha;
}

// Build a root Git tree SHA from a flat path→entry map (like `git ls-tree -r`).
// Recursively groups entries by directory, computes sub-tree SHAs bottom-up,
// then returns the root tree SHA.
async function buildTree(
  files: Map<Path, { mode: FileMode; sha: GitSha }>,
): Promise<GitSha> {
  // Convert the branded-Path map to a plain-string map for internal recursion
  const plain = new Map<string, { mode: FileMode; sha: GitSha }>();
  for (const [path, entry] of files) {
    plain.set(path, entry);
  }
  return buildTreeForDir(plain);
}

// Compute the Git commit SHA-1 for a fully-specified commit payload.
// Git format: SHA-1("commit <byte-length>\0<canonical-commit-text>")
async function commitSha(commit: PendingCommit): Promise<GitSha> {
  const lines: string[] = [];

  lines.push(`tree ${commit.tree}`);
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }
  lines.push(`author ${formatSignature(commit.author)}`);
  lines.push(`committer ${formatSignature(commit.committer)}`);
  lines.push(""); // blank line separating headers from message

  // Git always ends the commit message with a newline
  const message = commit.message.endsWith("\n")
    ? commit.message
    : commit.message + "\n";
  lines.push(message);

  // Join headers with \n; the final lines.join already has trailing \n from message
  const body = lines.join("\n");
  const bodyBytes = encodeText(body);
  const header = encodeText(`commit ${bodyBytes.byteLength}\0`);
  const hex = await sha1(concat(header, bodyBytes));
  return hex as GitSha;
}

// ---------------------------------------------------------------------------
// Internal helpers — tree ordering
// ---------------------------------------------------------------------------

// Git's canonical tree entry sort key: directories sort as if their name has
// a trailing "/" appended. This matches Git's base_name_compare() in tree.c.
function canonicalName(mode: FileMode, name: string): string {
  return mode === "040000" ? name + "/" : name;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = canonicalName(a.mode, a.name);
  const bKey = canonicalName(b.mode, b.name);
  // Byte-by-byte comparison (strings are UTF-16 in JS, but filenames stay ASCII-safe)
  if (aKey < bKey) return -1;
  if (aKey > bKey) return 1;
  return 0;
}

// Git stores directory mode as "40000" in the binary tree (printf %o of 040000),
// not "040000" with a leading zero. Files and symlinks are unchanged.
function treeModeString(mode: FileMode): string {
  return mode === "040000" ? "40000" : mode;
}

// ---------------------------------------------------------------------------
// Internal helpers — commit formatting
// ---------------------------------------------------------------------------

// Format a Signature as "Name <email> <unix-ts> <timezone>"
function formatSignature(sig: Signature): string {
  return `${sig.name} <${sig.email}> ${sig.timestamp} ${formatTimezone(sig.timezoneOffsetMinutes)}`;
}

// Format a timezone offset in minutes as "+HHMM" or "-HHMM"
function formatTimezone(offsetMinutes: number): string {
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60)
    .toString()
    .padStart(2, "0");
  const mins = (abs % 60).toString().padStart(2, "0");
  return `${sign}${hours}${mins}`;
}

// ---------------------------------------------------------------------------
// Internal helpers — recursive tree construction
// ---------------------------------------------------------------------------

// Recursively build the tree SHA for a directory represented as a flat map
// of relative paths (e.g. "src/foo.ts") to their { mode, sha } entries.
async function buildTreeForDir(
  files: Map<string, { mode: FileMode; sha: GitSha }>,
): Promise<GitSha> {
  const entries: TreeEntry[] = [];
  // Collect sub-directory names and their child files
  const subdirs = new Map<string, Map<string, { mode: FileMode; sha: GitSha }>>();

  for (const [path, entry] of files) {
    const slashIdx = path.indexOf("/");
    if (slashIdx === -1) {
      // Leaf file at this directory level
      entries.push({ mode: entry.mode, name: path, sha: entry.sha });
    } else {
      // Path descends into a sub-directory; group by the first component
      const dirName = path.slice(0, slashIdx);
      const rest = path.slice(slashIdx + 1);
      let subMap = subdirs.get(dirName);
      if (subMap === undefined) {
        subMap = new Map();
        subdirs.set(dirName, subMap);
      }
      subMap.set(rest, entry);
    }
  }

  // Recursively compute each sub-tree SHA and add it as a directory entry
  for (const [dirName, subFiles] of subdirs) {
    const subSha = await buildTreeForDir(subFiles);
    entries.push({ mode: "040000", name: dirName, sha: subSha });
  }

  return treeSha(entries);
}

// ---------------------------------------------------------------------------
// Internal helpers — low-level bytes / crypto
// ---------------------------------------------------------------------------

const _encoder = new TextEncoder();

function encodeText(text: string): Uint8Array {
  return _encoder.encode(text);
}

// Convert a 40-char hex string to 20 raw bytes
function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = parseInt(hex.slice(i, i + 2), 16);
    bytes[i / 2] = byte;
  }
  return bytes;
}

// Concatenate any number of Uint8Arrays into one
function concat(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const a of arrays) total += a.byteLength;
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.byteLength;
  }
  return result;
}

// Compute SHA-1 via the Web Crypto API (works in browsers and Node 19+)
async function sha1(data: Uint8Array): Promise<string> {
  // Copy into a fresh Uint8Array<ArrayBuffer> so the type satisfies BufferSource.
  // Uint8Array created from a TypedArray always uses a regular ArrayBuffer backing.
  const copy = new Uint8Array(data);
  const hashBuf = await crypto.subtle.digest("SHA-1", copy);
  const hashBytes = new Uint8Array(hashBuf);
  // Convert to 40-char lowercase hex
  return Array.from(hashBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
