// Tests for src/git/objects.ts — verifies that blobSha, treeSha, buildTree,
// and commitSha produce byte-for-byte identical results to the real `git` CLI.
// The git CLI is treated as the oracle: we compute objects with git, then
// compare against our implementation.

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { blobSha, buildTree, commitSha, treeSha } from "./objects.ts";
import type { FileMode, GitSha, Path, Signature, TreeEntry } from "./types.ts";

// ---------------------------------------------------------------------------
// Git oracle helpers
// ---------------------------------------------------------------------------

// Shared temp git repo — initialised once and reused for all tests
let gitDir: string;

beforeAll(() => {
  gitDir = mkdtempSync(join(tmpdir(), "vibenote-git-test-"));
  execSync("git init", { cwd: gitDir });
  execSync('git config user.email "oracle@example.com"', { cwd: gitDir });
  execSync('git config user.name "Oracle"', { cwd: gitDir });
});

afterAll(() => {
  rmSync(gitDir, { recursive: true, force: true });
});

// Compute a blob SHA using `git hash-object` (writes content to a temp file
// to correctly handle null bytes and arbitrary binary data)
function oracleHashBlob(content: Uint8Array): string {
  const tmpFile = join(gitDir, ".tmp-blob");
  writeFileSync(tmpFile, content);
  return execSync(`git hash-object "${tmpFile}"`, { cwd: gitDir })
    .toString()
    .trim();
}

type MkTreeEntry = {
  mode: string; // "100644" | "100755" | "120000" | "040000"
  type: "blob" | "tree" | "commit";
  sha: string;
  name: string;
};

// Compute a tree SHA using `git mktree` (reads ls-tree-format lines from stdin).
// Uses --missing so blobs/trees don't need to exist in the object store.
function oracleMkTree(entries: MkTreeEntry[]): string {
  // git mktree expects: <mode> SP <type> SP <sha> TAB <name>
  const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join("\n");
  return execSync("git mktree --missing", { input, cwd: gitDir }).toString().trim();
}

// Format a Signature into the git date string expected by GIT_*_DATE env vars
function formatGitDate(sig: Signature): string {
  const sign = sig.timezoneOffsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(sig.timezoneOffsetMinutes);
  const hh = Math.floor(abs / 60)
    .toString()
    .padStart(2, "0");
  const mm = (abs % 60).toString().padStart(2, "0");
  return `${sig.timestamp} ${sign}${hh}${mm}`;
}

// Compute a commit SHA using `git commit-tree` with deterministic env vars
function oracleCommitTree(
  treeShaHex: string,
  parents: string[],
  author: Signature,
  committer: Signature,
  message: string,
): string {
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_AUTHOR_DATE: formatGitDate(author),
    GIT_COMMITTER_NAME: committer.name,
    GIT_COMMITTER_EMAIL: committer.email,
    GIT_COMMITTER_DATE: formatGitDate(committer),
  };

  // Write message to a temp file to avoid shell-escaping issues.
  // Normalize to have a trailing newline — same as our commitSha implementation.
  const msgFile = join(gitDir, ".tmp-commit-msg");
  const msgNormalized = message.endsWith("\n") ? message : message + "\n";
  writeFileSync(msgFile, msgNormalized, "utf8");

  const parentArgs = parents.map((p) => `-p ${p}`).join(" ");
  const cmd = `git commit-tree ${treeShaHex} ${parentArgs} -F "${msgFile}"`.trim();
  return execSync(cmd, { cwd: gitDir, env }).toString().trim();
}

// ---------------------------------------------------------------------------
// Blob SHA tests
// ---------------------------------------------------------------------------

describe("blobSha", () => {
  it("empty blob", async () => {
    const content = new Uint8Array(0);
    expect(await blobSha(content)).toBe(oracleHashBlob(content));
  });

  it("simple ASCII content", async () => {
    const content = new TextEncoder().encode("hello world\n");
    expect(await blobSha(content)).toBe(oracleHashBlob(content));
  });

  it("UTF-8 content", async () => {
    const content = new TextEncoder().encode("こんにちは 🌸\n");
    expect(await blobSha(content)).toBe(oracleHashBlob(content));
  });

  it("multi-line markdown note", async () => {
    const text = "# My Note\n\nSome content with **bold** and _italic_.\n";
    const content = new TextEncoder().encode(text);
    expect(await blobSha(content)).toBe(oracleHashBlob(content));
  });

  it("content with null bytes", async () => {
    const content = new Uint8Array([0x00, 0x01, 0x02, 0x00, 0xff]);
    expect(await blobSha(content)).toBe(oracleHashBlob(content));
  });

  it("content with only a newline", async () => {
    const content = new TextEncoder().encode("\n");
    expect(await blobSha(content)).toBe(oracleHashBlob(content));
  });

  it("large content", async () => {
    // 100 KB of repeated bytes
    const content = new Uint8Array(100_000).fill(65); // 'A'
    expect(await blobSha(content)).toBe(oracleHashBlob(content));
  });

  it("known SHA-1 constant: empty blob", async () => {
    // git's empty blob is a well-known constant
    const sha = await blobSha(new Uint8Array(0));
    expect(sha).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });
});

// ---------------------------------------------------------------------------
// Tree SHA tests
// ---------------------------------------------------------------------------

describe("treeSha", () => {
  it("empty tree (zero entries)", async () => {
    // /dev/null is an empty file — git treats it as an empty tree object
    const gitEmpty = execSync("git hash-object -t tree /dev/null", { cwd: gitDir })
      .toString()
      .trim();
    expect(await treeSha([])).toBe(gitEmpty);
  });

  it("known SHA-1 constant: empty tree", async () => {
    // git's empty tree is a well-known constant
    expect(await treeSha([])).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });

  it("single regular file", async () => {
    const content = new TextEncoder().encode("hello\n");
    const sha = oracleHashBlob(content) as GitSha;

    const entries: TreeEntry[] = [{ mode: "100644", name: "hello.txt", sha }];
    const oracleSha = oracleMkTree([{ mode: "100644", type: "blob", sha, name: "hello.txt" }]);
    expect(await treeSha(entries)).toBe(oracleSha);
  });

  it("executable file", async () => {
    const content = new TextEncoder().encode("#!/bin/sh\necho hi\n");
    const sha = oracleHashBlob(content) as GitSha;

    const entries: TreeEntry[] = [{ mode: "100755", name: "run.sh", sha }];
    const oracleSha = oracleMkTree([{ mode: "100755", type: "blob", sha, name: "run.sh" }]);
    expect(await treeSha(entries)).toBe(oracleSha);
  });

  it("symlink", async () => {
    const content = new TextEncoder().encode("target.txt");
    const sha = oracleHashBlob(content) as GitSha;

    const entries: TreeEntry[] = [{ mode: "120000", name: "link.txt", sha }];
    const oracleSha = oracleMkTree([{ mode: "120000", type: "blob", sha, name: "link.txt" }]);
    expect(await treeSha(entries)).toBe(oracleSha);
  });

  it("multiple files — our sort order matches git", async () => {
    const files = [
      { name: "zebra.md", text: "z\n" },
      { name: "apple.md", text: "a\n" },
      { name: "mango.md", text: "m\n" },
    ];
    const oracleEntries: MkTreeEntry[] = [];
    const ourEntries: TreeEntry[] = [];

    for (const f of files) {
      const content = new TextEncoder().encode(f.text);
      const sha = oracleHashBlob(content) as GitSha;
      oracleEntries.push({ mode: "100644", type: "blob", sha, name: f.name });
      ourEntries.push({ mode: "100644", name: f.name, sha });
    }

    expect(await treeSha(ourEntries)).toBe(oracleMkTree(oracleEntries));
  });

  it("file vs directory with same name prefix — canonical ordering", async () => {
    // "notes.md" should sort before "notes/" (directory) because '.' < '/'
    const fileSha = oracleHashBlob(new TextEncoder().encode("note content\n")) as GitSha;
    const subFileSha = oracleHashBlob(new TextEncoder().encode("sub content\n")) as GitSha;

    // Build the sub-tree for "notes/" first
    const subTreeShaHex = oracleMkTree([
      { mode: "100644", type: "blob", sha: subFileSha, name: "readme.md" },
    ]);
    const subTreeSha = subTreeShaHex as GitSha;

    const ourEntries: TreeEntry[] = [
      { mode: "100644", name: "notes.md", sha: fileSha },
      { mode: "040000", name: "notes", sha: subTreeSha },
    ];
    const oracleEntries: MkTreeEntry[] = [
      { mode: "100644", type: "blob", sha: fileSha, name: "notes.md" },
      { mode: "040000", type: "tree", sha: subTreeSha, name: "notes" },
    ];

    expect(await treeSha(ourEntries)).toBe(oracleMkTree(oracleEntries));
  });

  it("filename with spaces", async () => {
    const content = new TextEncoder().encode("space content\n");
    const sha = oracleHashBlob(content) as GitSha;

    const entries: TreeEntry[] = [{ mode: "100644", name: "my note.md", sha }];
    const oracleSha = oracleMkTree([{ mode: "100644", type: "blob", sha, name: "my note.md" }]);
    expect(await treeSha(entries)).toBe(oracleSha);
  });

  it("unicode filename", async () => {
    const content = new TextEncoder().encode("unicode content\n");
    const sha = oracleHashBlob(content) as GitSha;

    const entries: TreeEntry[] = [{ mode: "100644", name: "日記.md", sha }];
    const oracleSha = oracleMkTree([{ mode: "100644", type: "blob", sha, name: "日記.md" }]);
    expect(await treeSha(entries)).toBe(oracleSha);
  });

  it("sub-directory entry", async () => {
    const fileSha = oracleHashBlob(new TextEncoder().encode("inner\n")) as GitSha;
    const subTreeShaHex = oracleMkTree([
      { mode: "100644", type: "blob", sha: fileSha, name: "inner.md" },
    ]);
    const subTreeSha = subTreeShaHex as GitSha;

    const ourEntries: TreeEntry[] = [{ mode: "040000", name: "subdir", sha: subTreeSha }];
    const oracleSha = oracleMkTree([{ mode: "040000", type: "tree", sha: subTreeSha, name: "subdir" }]);
    expect(await treeSha(ourEntries)).toBe(oracleSha);
  });
});

// ---------------------------------------------------------------------------
// buildTree tests
// ---------------------------------------------------------------------------

describe("buildTree", () => {
  // Helper: build tree oracle recursively (mirrors buildTree's logic using git CLI)
  function oracleBuildTree(
    files: Map<string, { mode: FileMode; sha: GitSha }>,
  ): string {
    const topEntries: MkTreeEntry[] = [];
    const subdirs = new Map<string, Map<string, { mode: FileMode; sha: GitSha }>>();

    for (const [path, entry] of files) {
      const slashIdx = path.indexOf("/");
      if (slashIdx === -1) {
        const type = entry.mode === "040000" ? "tree" : "blob";
        topEntries.push({ mode: entry.mode, type, sha: entry.sha, name: path });
      } else {
        const dirName = path.slice(0, slashIdx);
        const rest = path.slice(slashIdx + 1);
        let sub = subdirs.get(dirName);
        if (sub === undefined) {
          sub = new Map();
          subdirs.set(dirName, sub);
        }
        sub.set(rest, entry);
      }
    }

    for (const [dirName, subFiles] of subdirs) {
      const subSha = oracleBuildTree(subFiles);
      topEntries.push({ mode: "040000", type: "tree", sha: subSha, name: dirName });
    }

    return oracleMkTree(topEntries);
  }

  it("single file at root", async () => {
    const sha = oracleHashBlob(new TextEncoder().encode("single\n")) as GitSha;
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>([
      ["single.md" as Path, { mode: "100644", sha }],
    ]);
    expect(await buildTree(files)).toBe(oracleBuildTree(new Map([["single.md", { mode: "100644", sha }]])));
  });

  it("multiple files at root", async () => {
    const shaA = oracleHashBlob(new TextEncoder().encode("aaa\n")) as GitSha;
    const shaB = oracleHashBlob(new TextEncoder().encode("bbb\n")) as GitSha;
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>([
      ["a.md" as Path, { mode: "100644", sha: shaA }],
      ["b.md" as Path, { mode: "100644", sha: shaB }],
    ]);
    const plain = new Map([
      ["a.md", { mode: "100644" as FileMode, sha: shaA }],
      ["b.md", { mode: "100644" as FileMode, sha: shaB }],
    ]);
    expect(await buildTree(files)).toBe(oracleBuildTree(plain));
  });

  it("one level of nesting", async () => {
    const rootSha = oracleHashBlob(new TextEncoder().encode("readme\n")) as GitSha;
    const subSha = oracleHashBlob(new TextEncoder().encode("note\n")) as GitSha;
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>([
      ["README.md" as Path, { mode: "100644", sha: rootSha }],
      ["notes/hello.md" as Path, { mode: "100644", sha: subSha }],
    ]);
    const plain = new Map([
      ["README.md", { mode: "100644" as FileMode, sha: rootSha }],
      ["notes/hello.md", { mode: "100644" as FileMode, sha: subSha }],
    ]);
    expect(await buildTree(files)).toBe(oracleBuildTree(plain));
  });

  it("deep nesting (three levels)", async () => {
    const sha = oracleHashBlob(new TextEncoder().encode("deep\n")) as GitSha;
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>([
      ["a/b/c/deep.md" as Path, { mode: "100644", sha }],
    ]);
    const plain = new Map([["a/b/c/deep.md", { mode: "100644" as FileMode, sha }]]);
    expect(await buildTree(files)).toBe(oracleBuildTree(plain));
  });

  it("multiple sub-directories", async () => {
    const sha1 = oracleHashBlob(new TextEncoder().encode("one\n")) as GitSha;
    const sha2 = oracleHashBlob(new TextEncoder().encode("two\n")) as GitSha;
    const sha3 = oracleHashBlob(new TextEncoder().encode("three\n")) as GitSha;
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>([
      ["docs/one.md" as Path, { mode: "100644", sha: sha1 }],
      ["src/two.ts" as Path, { mode: "100644", sha: sha2 }],
      ["src/three.ts" as Path, { mode: "100644", sha: sha3 }],
    ]);
    const plain = new Map([
      ["docs/one.md", { mode: "100644" as FileMode, sha: sha1 }],
      ["src/two.ts", { mode: "100644" as FileMode, sha: sha2 }],
      ["src/three.ts", { mode: "100644" as FileMode, sha: sha3 }],
    ]);
    expect(await buildTree(files)).toBe(oracleBuildTree(plain));
  });

  it("executable file in sub-directory", async () => {
    const sha = oracleHashBlob(new TextEncoder().encode("#!/bin/sh\n")) as GitSha;
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>([
      ["scripts/run.sh" as Path, { mode: "100755", sha }],
    ]);
    const plain = new Map([["scripts/run.sh", { mode: "100755" as FileMode, sha }]]);
    expect(await buildTree(files)).toBe(oracleBuildTree(plain));
  });

  it("filename with spaces in nested path", async () => {
    const sha = oracleHashBlob(new TextEncoder().encode("content\n")) as GitSha;
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>([
      ["my notes/hello world.md" as Path, { mode: "100644", sha }],
    ]);
    const plain = new Map([["my notes/hello world.md", { mode: "100644" as FileMode, sha }]]);
    expect(await buildTree(files)).toBe(oracleBuildTree(plain));
  });

  it("empty flat map produces empty tree", async () => {
    const files = new Map<Path, { mode: FileMode; sha: GitSha }>();
    expect(await buildTree(files)).toBe("4b825dc642cb6eb9a060e54bf8d69288fbee4904");
  });
});

// ---------------------------------------------------------------------------
// Commit SHA tests
// ---------------------------------------------------------------------------

describe("commitSha", () => {
  // A stable tree SHA to use in commit tests (empty tree — always available)
  const emptyTreeSha = "4b825dc642cb6eb9a060e54bf8d69288fbee4904" as GitSha;

  const alice: Signature = {
    name: "Alice Smith",
    email: "alice@example.com",
    timestamp: 1_000_000_000,
    timezoneOffsetMinutes: 0,
  };

  it("root commit — no parents", async () => {
    const oracle = oracleCommitTree(emptyTreeSha, [], alice, alice, "Initial commit");
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: alice,
      committer: alice,
      message: "Initial commit",
    });
    expect(sha).toBe(oracle);
  });

  it("commit with one parent", async () => {
    // Create a real parent commit in the git repo first
    const parentSha = oracleCommitTree(emptyTreeSha, [], alice, alice, "Parent commit");

    const oracle = oracleCommitTree(emptyTreeSha, [parentSha], alice, alice, "Child commit");
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [parentSha as GitSha],
      author: alice,
      committer: alice,
      message: "Child commit",
    });
    expect(sha).toBe(oracle);
  });

  it("merge commit — two parents", async () => {
    const parent1 = oracleCommitTree(emptyTreeSha, [], alice, alice, "Branch A");
    const parent2 = oracleCommitTree(emptyTreeSha, [], alice, alice, "Branch B");

    const oracle = oracleCommitTree(
      emptyTreeSha,
      [parent1, parent2],
      alice,
      alice,
      "Merge commit",
    );
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [parent1 as GitSha, parent2 as GitSha],
      author: alice,
      committer: alice,
      message: "Merge commit",
    });
    expect(sha).toBe(oracle);
  });

  it("different author and committer", async () => {
    const committer: Signature = {
      name: "Bob Jones",
      email: "bob@example.com",
      timestamp: 1_000_001_000,
      timezoneOffsetMinutes: 0,
    };

    const oracle = oracleCommitTree(emptyTreeSha, [], alice, committer, "Committed by Bob");
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: alice,
      committer,
      message: "Committed by Bob",
    });
    expect(sha).toBe(oracle);
  });

  it("positive timezone offset (+0530 India)", async () => {
    const india: Signature = {
      ...alice,
      timezoneOffsetMinutes: 330, // UTC+5:30
    };
    const oracle = oracleCommitTree(emptyTreeSha, [], india, india, "India timezone");
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: india,
      committer: india,
      message: "India timezone",
    });
    expect(sha).toBe(oracle);
  });

  it("negative timezone offset (-0700 PDT)", async () => {
    const pdt: Signature = {
      ...alice,
      timezoneOffsetMinutes: -420, // UTC-7
    };
    const oracle = oracleCommitTree(emptyTreeSha, [], pdt, pdt, "PDT timezone");
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: pdt,
      committer: pdt,
      message: "PDT timezone",
    });
    expect(sha).toBe(oracle);
  });

  it("non-whole-hour offset (+0545 Nepal)", async () => {
    const nepal: Signature = {
      ...alice,
      timezoneOffsetMinutes: 345, // UTC+5:45
    };
    const oracle = oracleCommitTree(emptyTreeSha, [], nepal, nepal, "Nepal timezone");
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: nepal,
      committer: nepal,
      message: "Nepal timezone",
    });
    expect(sha).toBe(oracle);
  });

  it("multi-line commit message", async () => {
    const message = "First line\n\nParagraph body.\nMore body.\n";
    const oracle = oracleCommitTree(emptyTreeSha, [], alice, alice, message);
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: alice,
      committer: alice,
      message,
    });
    expect(sha).toBe(oracle);
  });

  it("message without trailing newline is normalised to match message with trailing newline", async () => {
    // Both oracle helper and commitSha normalise the message to end with \n,
    // so "foo" and "foo\n" should produce the same SHA.
    const msgNoNewline = "No trailing newline";
    const msgWithNewline = "No trailing newline\n";

    const oracleNoNl = oracleCommitTree(emptyTreeSha, [], alice, alice, msgNoNewline);
    const oracleNl = oracleCommitTree(emptyTreeSha, [], alice, alice, msgWithNewline);

    // Both oracle calls normalise to \n, so they must match
    expect(oracleNoNl).toBe(oracleNl);

    const shaNoNl = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: alice,
      committer: alice,
      message: msgNoNewline,
    });
    const shaNl = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: alice,
      committer: alice,
      message: msgWithNewline,
    });

    expect(shaNoNl).toBe(oracleNoNl);
    expect(shaNl).toBe(oracleNl);
  });

  it("commit with actual file content tree", async () => {
    // Build a real tree with file content and use it in a commit
    const content = new TextEncoder().encode("# Hello\n\nThis is a note.\n");
    const fileSha = oracleHashBlob(content) as GitSha;
    const treeShaHex = oracleMkTree([
      { mode: "100644", type: "blob", sha: fileSha, name: "hello.md" },
    ]) as GitSha;

    const oracle = oracleCommitTree(treeShaHex, [], alice, alice, "Add hello.md");
    const sha = await commitSha({
      tree: treeShaHex,
      parents: [],
      author: alice,
      committer: alice,
      message: "Add hello.md",
    });
    expect(sha).toBe(oracle);
  });

  it("commit with name containing special characters", async () => {
    const special: Signature = {
      name: "Ángel García",
      email: "angel@example.com",
      timestamp: 1_700_000_000,
      timezoneOffsetMinutes: 60,
    };
    const oracle = oracleCommitTree(emptyTreeSha, [], special, special, "UTF-8 name");
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [],
      author: special,
      committer: special,
      message: "UTF-8 name",
    });
    expect(sha).toBe(oracle);
  });

  it("three parents (octopus merge)", async () => {
    const p1 = oracleCommitTree(emptyTreeSha, [], alice, alice, "P1");
    const p2 = oracleCommitTree(emptyTreeSha, [], alice, alice, "P2");
    const p3 = oracleCommitTree(emptyTreeSha, [], alice, alice, "P3");

    const oracle = oracleCommitTree(
      emptyTreeSha,
      [p1, p2, p3],
      alice,
      alice,
      "Octopus merge",
    );
    const sha = await commitSha({
      tree: emptyTreeSha,
      parents: [p1 as GitSha, p2 as GitSha, p3 as GitSha],
      author: alice,
      committer: alice,
      message: "Octopus merge",
    });
    expect(sha).toBe(oracle);
  });
});
