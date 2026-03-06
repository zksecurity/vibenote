// Pure Git object type definitions used across the local Git model.
// These branded types prevent accidental mixing of arbitrary strings with Git
// object identifiers and repo-relative paths at compile time.

// Branded Git SHA-1 hex string (40 lowercase hex chars)
export type GitSha = string & { readonly __brand: "GitSha" };

// Branded POSIX-style repo-relative file path (e.g. "src/notes/foo.md")
export type Path = string & { readonly __brand: "Path" };

// Git file modes that appear in tree entries
export type FileMode = "100644" | "100755" | "120000" | "040000";

// A single entry in a Git tree object (file, symlink, or sub-tree)
export type TreeEntry = {
  mode: FileMode;
  name: string; // bare filename or directory name — not a full path
  sha: GitSha;
};

// Author or committer identity with a point-in-time timestamp
export type Signature = {
  name: string;
  email: string;
  timestamp: number; // Unix seconds (UTC)
  timezoneOffsetMinutes: number; // minutes east of UTC; negative = west
};

// All fields needed to construct and hash a Git commit object
export type PendingCommit = {
  tree: GitSha;
  parents: GitSha[];
  author: Signature;
  committer: Signature;
  message: string;
};
