# Vibenote local Git model and one-click sync

## Summary

This document captures the design direction that emerged while thinking about how **Vibenote** should model a local repository and implement a single **Sync** button against GitHub.

The original question started from Git object identity: how GitHub computes blob SHAs, which led to the exact Git object formats for **blobs**, **trees**, and **commits**. From there, the design space became much clearer:

- Vibenote already uses GitHub APIs such as `/git/blobs`, `/git/trees`, `/git/commits`, `/git/refs`, and related endpoints for remote persistence.
- What is missing is not remote transport, but the **local Git-shaped model**:
  - represent the local repo state,
  - detect which paths are dirty,
  - construct correct trees and commits,
  - integrate remote updates,
  - and do all of that in a browser-friendly way.

The goal is therefore **not** to embed all of Git, packfiles, SSH, or the CLI. The goal is a browser-local model that is **Git-compatible at the object level** and supports a simple UX:

- the user edits notes locally,
- presses **Sync**,
- Vibenote automatically merges remote changes and pushes local changes,
- conflicts are handled automatically as a best effort.

Conflict resolution assumptions:

- **Markdown notes**: use the app’s custom three-way merge implementation.
- **Binary files**: use **theirs** semantics, meaning remote wins.
- **Other text files**: use a fallback strategy to be defined later.

A key requirement throughout is that all computed object SHAs must match Git exactly.

---

## Design goals

The local model should satisfy the following constraints:

1. **Git-shaped, but not Git-complete**
   - Model blobs, trees, commits, refs, and merge state.
   - Avoid unnecessary implementation of packfiles, hooks, filters, or transport protocols.

2. **Browser-friendly**
   - Store working files and metadata in browser storage.
   - Avoid dependencies on OS filesystem semantics.

3. **Deterministic and testable**
   - Blob/tree/commit identity must be byte-for-byte compatible with Git.
   - Sync behavior should be understandable as a composition of standard Git operations.

4. **Single-button UX**
   - The user gets a simple Sync button.
   - Sync should effectively behave like: fetch remote tip, merge, commit if needed, update ref, retry on races.

5. **Good support for future evolution**
   - The type model should leave room for local unpublished commits, richer merge bookkeeping, and later improvements to status handling.

---

## Conceptual model

The cleanest mental model uses three main snapshots:

- **BASE**: the last commit/tree that local state is known to be synced against.
- **REMOTE**: the latest fetched remote commit/tree for the branch.
- **LOCAL**: the current local working content, potentially materialized into a local commit during Sync.

These correspond closely to the three inputs of a standard three-way merge.

The local repository should therefore keep:

- a canonical snapshot of the last synced tree,
- the current working files,
- optional staged/index state,
- branch/ref information,
- merge bookkeeping,
- caches for computed blob hashes.

---

## Suggested TypeScript model for repo state

The following type-heavy snippets are intended as a good starting point. They are Git-shaped without being overly tied to implementation details.

### Core opaque types

```ts
export type GitSha = string & { readonly __brand: "GitSha" };
export type Path = string & { readonly __brand: "Path" };

export type FileMode = "100644" | "100755" | "120000" | "040000";
```

These brands help prevent accidental confusion between arbitrary strings and Git object IDs or paths.

---

### Canonical tree snapshot

```ts
export interface SnapshotEntry {
  mode: FileMode;
  sha: GitSha;
}

export interface TreeSnapshot {
  /** Root tree object id */
  rootTree: GitSha;

  /** Recursive flat map, like `git ls-tree -r` */
  entries: Map<Path, SnapshotEntry>;
}
```

A flat recursive map is often the easiest format for dirty detection, merges, and tree reconstruction.

---

### Base and remote snapshots

```ts
export interface BaseSnapshot extends TreeSnapshot {
  /** Last synced commit, used as merge base */
  baseCommit: GitSha | null;
}

export interface RemoteSnapshot extends TreeSnapshot {
  /** Most recently fetched remote branch tip */
  remoteCommit: GitSha | null;
}
```

`BASE` is the common ancestor from the local app’s point of view. `REMOTE` is the latest known server view.

---

### Working files

```ts
export interface WorkingFile {
  path: Path;
  mode: Exclude<FileMode, "040000">;
  content: Uint8Array;
  size: number;

  /** Logical modification timestamp, purely app-defined */
  mtime?: number;

  /** Cached blob sha for current content, if already computed */
  blobSha?: GitSha;
}
```

A browser app does not need a real OS `mtime`; it may store a logical timestamp or monotonic version number. It is only an optimization hint for avoiding unnecessary re-hashing.

---

### Index / staging area

A minimal app could skip an index at first, but keeping the type in mind is useful because it maps very naturally to merges.

```ts
export type IndexStage = 0 | 1 | 2 | 3;

export interface IndexEntry {
  path: Path;
  mode: FileMode;
  stage: IndexStage;
  sha: GitSha;
}

export interface IndexState {
  entries: Map<Path, IndexEntry[]>;
}
```

Meaning of stages:

- `0`: normal staged content
- `1`: merge base
- `2`: ours
- `3`: theirs

Even if the first implementation does not expose explicit staging to the user, this structure is still useful internally when a sync performs a merge.

---

### Status model

```ts
export type FileStatus =
  | "unmodified"
  | "modified"
  | "added"
  | "deleted"
  | "untracked"
  | "conflicted";

export interface StatusEntry {
  path: Path;
  status: FileStatus;
  mode?: FileMode;
  headSha?: GitSha;
  indexSha?: GitSha;
  worktreeSha?: GitSha;
}
```

For Vibenote, status is primarily an internal implementation detail that supports Sync and diagnostics, but the model is still useful to keep explicit.

---

### Merge bookkeeping

```ts
export interface ConflictPayload {
  base?: Uint8Array;
  ours?: Uint8Array;
  theirs?: Uint8Array;
}

export interface MergeState {
  inProgress: boolean;
  targetCommit?: GitSha;
  conflictedPaths: Set<Path>;
  conflicts?: Map<Path, ConflictPayload>;
}
```

Even though the UX resolves conflicts automatically, an explicit merge state is still valuable for debugging, retries, telemetry, or a future “show what happened” feature.

---

### Refs and remote configuration

```ts
export interface Ref {
  name: `refs/heads/${string}` | `refs/tags/${string}`;
  sha: GitSha | null;
}

export interface RemoteRef {
  name: `refs/remotes/${string}/${string}`;
  sha: GitSha | null;
}

export interface RemoteConfig {
  name: string;
  url: string;
}

export interface BranchState {
  head: Ref;
  upstream?: RemoteRef;
}
```

This is enough structure for a branch-oriented browser app without attempting to mirror every detail of Git config.

---

### Commit envelope

```ts
export interface Signature {
  name: string;
  email: string;
  timestamp: number; // Unix seconds
  timezoneOffsetMinutes: number;
}

export interface PendingCommit {
  tree: GitSha;
  parents: GitSha[];
  author: Signature;
  committer: Signature;
  message: string;
}
```

It is useful to model the commit payload explicitly before it is turned into a real commit object and sent to GitHub.

---

### Caches and config

```ts
export interface HashCache {
  entries: Map<string, GitSha>;
}

export interface IgnoreRules {
  patterns: string[];
}

export interface RepoConfig {
  eol?: "lf" | "crlf" | "as-is";
  caseSensitive?: boolean;
  enableRenameDetect?: boolean;
}
```

The hash cache may be keyed by a stable serialization of `(path, size, mtime)` or a similar tuple.

---

### Whole repo state

```ts
export interface RepoState {
  repoId: string;

  remote: RemoteConfig;
  branch: BranchState;

  base: BaseSnapshot;
  remoteSnapshot: RemoteSnapshot;

  workingFiles: Map<Path, WorkingFile>;
  index: IndexState;
  status: Map<Path, StatusEntry>;
  merge: MergeState;

  ignore: IgnoreRules;
  config: RepoConfig;
  hashCache: HashCache;

  version: number;
  locks?: {
    sync: boolean;
    index: boolean;
  };
}
```

This is intentionally compact. The important part is that it cleanly separates:

- authoritative last-synced state (`base`),
- latest fetched remote state (`remoteSnapshot`),
- current local working content (`workingFiles`),
- intermediate merge/index details.

---

## Notes on why this structure is useful

### Flat tree maps are easier than nested trees

Git trees are hierarchical objects, but most application logic becomes easier when the local state uses a flat map of:

- `path -> { mode, sha }`

This simplifies:

- dirty detection,
- delete detection,
- merge comparisons,
- tree reconstruction,
- conflict reporting.

Nested tree objects can be reconstructed later when building Git tree objects.

### Why keep both BASE and REMOTE?

Because Sync is effectively a repeated three-way merge process.

- `BASE` is what local edits were made against.
- `REMOTE` is what the server currently has.
- `LOCAL` is what the user currently wants.

Without explicit `BASE`, conflict handling and merge decisions become fragile.

### Why keep an index if the user only has Sync?

Even with a single Sync button, the index model is still useful because merges naturally want a staging area-like structure.

It is perfectly reasonable to hide staging from the user while still using Git’s conceptual separation internally.

---

## Design of the Sync flow

The Sync button should conceptually behave like:

1. fetch remote branch tip,
2. compute local changes,
3. merge remote and local changes using a three-way merge,
4. create a commit if needed,
5. update the branch ref optimistically,
6. retry if another writer moved the branch in the meantime.

This can be described in lower-level Git terms as follows.

### Inputs to Sync

At the beginning of Sync, the app has:

- `BASE.commit` and `BASE.tree`
- current `workingFiles`
- branch name / ref
- GitHub remote endpoints

### Step 1: fetch current remote tip

Query the current branch ref and its commit/tree.

Conceptually:

- read `refs/heads/<branch>` to get `R_tip`
- read the commit object at `R_tip`
- read the root tree recursively to form `REMOTE`

At this point the app has:

- `BASE`
- `REMOTE`
- current local working state

### Step 2: determine local changes against BASE

Compute the working delta relative to `BASE.entries`.

For each relevant path:

- if present in both and blob SHA differs: `modified`
- if present in local only: `added` or `untracked`
- if present in BASE only: `deleted`
- otherwise: unchanged

Blob SHAs should be cached aggressively, but correctness should not depend on the cache.

### Step 3: materialize LOCAL as a tree

Build the local intended tree from current working content.

Conceptually this means:

- create blob objects for new or changed files,
- construct a new tree using `BASE.tree` as the base tree,
- reuse existing object IDs where content did not change.

If there are no local changes, then `LOCAL` is effectively equal to `BASE`.

### Step 4: classify the sync case

There are three main cases.

#### Case A: no local changes, no remote changes

If `REMOTE.commit == BASE.commit` and there are no local changes:

- do nothing,
- maybe refresh cached remote metadata,
- finish.

#### Case B: local changes only

If `REMOTE.commit == BASE.commit` and local changes exist:

- create a commit from the local tree with parent `BASE.commit`,
- attempt to fast-forward the branch ref to that commit,
- if the ref update succeeds, Sync is done,
- if the ref update fails because someone raced the update, fetch again and continue into the merge case.

This is the cleanest case.

#### Case C: remote moved since BASE

If `REMOTE.commit != BASE.commit`, a merge is required.

The merge inputs are:

- `BASE` = last synced state
- `OURS` = local materialized tree
- `THEIRS` = current remote tree

These are exactly the standard inputs to a three-way merge.

### Step 5: perform path-wise three-way merge

For each path in the union of all three trees, apply the app’s merge policy.

#### Markdown notes

Use the custom note-aware three-way merge.

This is the highest-value path because notes are the primary domain object of the app.

#### Binary files

Use **theirs** semantics.

In other words:

- if remote changed the binary file, remote wins,
- local binary edits are discarded in favor of remote when there is divergence.

This is a deliberate product choice and should be documented clearly.

#### Other text files

Use a fallback strategy.

The final policy is still open, but the design should assume there is always some best-effort path that produces output rather than surfacing manual conflicts to the user.

### Step 6: build merged tree

Once merged content is available per path:

- create blob objects for merged content as needed,
- construct the merged tree object,
- compute its root tree SHA.

### Step 7: create the resulting commit

There are two sensible commit shapes.

#### If remote did not move

When only local changes existed, create a normal commit:

- parent list: `[BASE.commit]`

#### If a merge happened

Create a merge commit:

- parent list: `[REMOTE.commit, LOCAL.commit]`

That reflects the fact that Sync combined two histories.

This is a clean Git-native representation and preserves the causal structure correctly.

### Step 8: update the branch ref optimistically

Attempt to move the branch ref to the resulting commit using a non-force update.

If this succeeds:

- the sync is complete,
- update `BASE` to the new commit/tree,
- refresh local snapshots,
- clear merge state.

If this fails:

- another actor updated the remote branch after the app fetched it,
- fetch the new remote tip,
- rerun the merge using the same local intent against the new remote state,
- retry until success or a bounded retry limit is reached.

### Step 9: finalize local state

After a successful sync:

- `BASE` becomes the new synced commit/tree,
- `REMOTE` is updated accordingly,
- status becomes clean,
- transient merge/index data can be cleared.

---

## High-level Git interpretation of Sync

A useful way to think about Sync is:

- build a local commit from current working content,
- if remote has not moved, push that commit,
- otherwise, perform an automatic three-way merge,
- create a merge commit,
- push that merge commit,
- retry if the push races with another writer.

That means Sync is not a magical proprietary operation. It is a constrained composition of standard Git concepts:

- tree construction,
- commit construction,
- ref update,
- three-way merge,
- optimistic concurrency with retries.

This is a strong property because it keeps the system understandable and testable.

---

## Object identity and Git hashes

One of the key insights that motivated this design is that Git object identity is extremely structured.

Git does not hash just the file contents. It hashes:

- an object-type header,
- the object length in bytes,
- a null byte,
- the canonical content bytes of the object.

Conceptually:

- blob SHA = hash of `"blob <len>\0<content>"`
- tree SHA = hash of `"tree <len>\0<binary tree entries>"`
- commit SHA = hash of `"commit <len>\0<canonical commit text>"`

This matters because Vibenote is relying on GitHub’s Git object model. If its local SHA calculations are wrong, then everything built on top of them becomes unreliable.

### Important details for trees

Tree entries are especially easy to get subtly wrong.

Important rules include:

- each entry is encoded as `<mode> <name>\0<raw object id bytes>`
- the referenced object ID is binary, not hexadecimal text
- entries must be ordered canonically
- the exact byte representation matters

### Important details for commits

Commit objects are textual, but still highly structured.

Important rules include:

- one `tree` line
- zero or more `parent` lines
- exactly one `author` line
- exactly one `committer` line
- exactly one blank line separating headers from message
- timestamps and timezone formatting must be canonical

### Author vs committer

Git stores both an author and a committer.

- **Author** = who originally wrote the change
- **Committer** = who recorded this commit object into history

For Vibenote, using the same identity for both is often fine, but it is still helpful to keep the distinction in the data model.

---

## Testing strategy for hash correctness

The most important recommendation is:

**Treat real Git as the oracle.**

Even if the app never shells out to Git in production, tests should verify that the implementation produces exactly the same SHAs as Git for the same logical objects.

### Recommended test philosophy

The tests should compare the app’s computed object IDs against object IDs produced by the real `git` CLI.

This is especially important for:

- blobs,
- trees,
- commits,
- edge cases involving filenames, modes, and commit metadata.

### Blob tests

The app should be tested on blobs covering at least:

- empty files,
- small ASCII files,
- UTF-8 text,
- large files,
- unusual byte patterns.

The expected blob IDs should come from Git, not from a duplicated implementation.

### Tree tests

Tree tests should cover:

- ordinary files,
- executable files,
- symlinks,
- nested directories,
- tricky filenames,
- empty trees.

The canonical ordering of tree entries should be tested carefully.

### Commit tests

Commit tests should use fixed metadata so that expected IDs are deterministic.

In particular, the following must be fixed explicitly in test fixtures:

- tree SHA,
- parent SHAs,
- author name/email/timestamp/timezone,
- committer name/email/timestamp/timezone,
- commit message.

Merge commits with two parents should also be covered.

### Edge cases worth including

The test corpus should include at least:

- empty blob and empty tree,
- root commit with no parents,
- merge commit with multiple parents,
- filenames with spaces and Unicode,
- executable bit changes,
- symlinks,
- timezone offsets that are not whole hours,
- line ending normalization decisions.

### Cross-checking with a second implementation

As an optional extra safety net, the app’s object computations can also be compared to a second independent implementation such as a Git library.

That should not replace real-Git oracle tests, but it can help narrow down bugs when a mismatch is discovered.

---

## Practical implementation guidance

A few implementation choices seem especially good for Vibenote.

### Prefer a flat local map over nested structures

Store local working content and canonical snapshots as flat `path -> entry` maps. It matches the way diffs and merges want to operate.

### Cache aggressively, but never trust the cache for correctness

A cached blob SHA keyed by path and logical metadata is useful for performance, but it must always be safe to recompute from content.

### Keep merge semantics explicit

The product-specific merge policies are important enough to encode clearly:

- Markdown: custom three-way merge
- Binary: theirs wins
- Other text: best-effort fallback

That policy should not be buried in incidental code paths.

### Keep Sync retryable and idempotent

A sync attempt may race with another writer. The system should assume this is normal.

The right response is not to treat it as an exceptional disaster, but to:

- refetch,
- re-merge,
- retry.

### Preserve Git-native concepts even if the UI is simpler

The user only sees a single Sync button, but internally the implementation benefits from preserving Git-native concepts such as:

- base commit,
- tree snapshots,
- commit parents,
- merge commits,
- ref updates.

This gives a clean conceptual model and makes correctness reasoning much easier.

---

## Recommended first implementation scope

A reasonable first version would implement:

1. local working file model
2. base and remote snapshots
3. blob/tree/commit object construction
4. dirty detection against BASE
5. one-click Sync with automatic three-way merge
6. optimistic ref update with retry
7. Git-oracle test suite for object identity

And explicitly defer:

- advanced rename detection,
- `.gitattributes` and filters,
- LFS,
- complicated text merge heuristics for non-markdown files,
- full staging UX.

This keeps the system sharply focused on what Vibenote actually needs.

---

## Final perspective

The design here is intentionally narrow: not “implement Git in the browser”, but “implement the subset of Git’s object and merge model needed for a browser-native note app with a strong GitHub backend”.

That narrowness is a strength.

By staying close to Git’s real object model:

- object IDs remain compatible,
- commits and trees remain understandable,
- Sync remains a composition of standard Git operations,
- and correctness can be tested directly against Git itself.

For Vibenote, that is likely the right level of ambition.
