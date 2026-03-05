---
status: done
created: 2026-03-05
completed: 2026-03-06
assigned: subagent-define-action-protocol
---

# Define the action-as-data protocol for the UI boundary

Define how the UI expresses intents to the data layer using typed action data rather than a bespoke set of callback methods.

The point is to make the boundary stable and swappable. The protocol should reflect what the UI means, not how the current implementation happens to perform the work internally.

Must-haves:

- The protocol covers the real actions the UI needs to express today.
- The protocol is suitable for app-level concerns as well as workspace-level concerns.
- The protocol remains understandable and ergonomic for UI code.
- The protocol does not unnecessarily encode current storage/git implementation details.

Success will be validated by:

- This task file contains a concise design note describing the proposed action protocol.
- The design makes it clear how current callback-style actions map into action data.
- The design is specific enough that an implementation task can adopt it without guessing the intent.

## Design note

### Proposed boundary

Replace the current callback bag with a single typed dispatcher:

```ts
dispatch(action: AppDataAction): void
```

The UI should read app/workspace state from the contract, and express all data-layer intents as action objects. The data layer, not the UI, should own the side effects that currently leak through helper props and direct imports:

- route-backed note selection
- repo switching and recent-repo recording
- repo availability checks for the switcher
- GitHub access/install flow

Pure UI state stays local and does not become protocol actions: dialog visibility, switcher open state, switcher input text, tree row highlight, inline create/rename drafts, and folder collapse state.

Actions are intents only. The UI should not depend on dispatch return payloads for success, failure, canonical paths, or async completion. Those outcomes belong in state.

### Action shape

```ts
type AppDataAction =
  | { type: 'session.sign-in' }
  | { type: 'session.sign-out' }
  | { type: 'repo.activate'; repo: { kind: 'new' } | { kind: 'github'; owner: string; repo: string }; notePath?: string }
  | { type: 'repo.probe'; owner: string; repo: string }
  | { type: 'repo.request-access'; owner: string; repo: string }
  | { type: 'note.open'; path?: string }
  | { type: 'note.create'; parentDir: string; name: string }
  | { type: 'file.save'; path: string; contents: string }
  | { type: 'file.rename'; path: string; name: string }
  | { type: 'file.move'; path: string; targetDir: string }
  | { type: 'file.delete'; path: string }
  | { type: 'folder.create'; parentDir: string; name: string }
  | { type: 'folder.rename'; path: string; name: string }
  | { type: 'folder.move'; path: string; targetDir: string }
  | { type: 'folder.delete'; path: string }
  | { type: 'assets.import'; notePath: string; files: File[] }
  | { type: 'sync.run'; source: 'user' | 'auto' }
  | { type: 'sync.set-autosync'; enabled: boolean }
  | { type: 'share.create'; notePath: string }
  | { type: 'share.refresh'; notePath: string }
  | { type: 'share.revoke'; notePath: string };
```

Design constraints:

- Action names reflect UI intent, not storage/git mechanics.
- `note.open` stays explicit even if note selection is stored in app/navigation state.
- `repo.activate` covers both recent-repo opening and the `/new` workspace entry point.
- Payloads should stay JSON-shaped where possible. `assets.import` is the only intentional exception because browser `File` objects are the user input.

### Outcome model

Do not introduce a general async `ActionResult` envelope for the whole boundary. The stable contract is:

- actions describe intent
- state is the source of truth for async progress, success, and failure

That means:

- auth and repo-access actions update `session`, `navigation`, and `workspace.access`
- repo/note navigation and file/folder mutations update `navigation.target.notePath`, `workspace.tree`, and `workspace.document`
- sync actions update `workspace.sync`
- share actions update `workspace.share`
- if `repo.probe` remains in scope, its pending/result state belongs next to app-level repo state, not in a dispatch return value

This also removes the need for actions like `createNote`, `moveFile`, or `moveFolder` to return canonical paths. UI that currently depends on those return values should instead follow the updated contract state after dispatch.

If one workflow later proves it genuinely needs request/response behavior, add a narrow API for that workflow instead of reintroducing a broad `ActionResult` model across every action.

### Current callback mapping

- `signIn()` -> `dispatch({ type: 'session.sign-in' })`
- `signOut()` -> `dispatch({ type: 'session.sign-out' })`
- `openRepoAccess()` -> `dispatch({ type: 'repo.request-access', owner, repo })`
- `syncNow()` -> `dispatch({ type: 'sync.run', source: 'user' })`
- `setAutosync(enabled)` -> `dispatch({ type: 'sync.set-autosync', enabled })`
- `selectFile(path)` -> `dispatch({ type: 'note.open', path })`
- `createNote(dir, name)` -> `dispatch({ type: 'note.create', parentDir: dir, name })`
- `saveFile(path, text)` -> `dispatch({ type: 'file.save', path, contents: text })`
- `renameFile(path, name)` -> `dispatch({ type: 'file.rename', path, name })`
- `moveFile(path, targetDir)` -> `dispatch({ type: 'file.move', path, targetDir })`
- `deleteFile(path)` -> `dispatch({ type: 'file.delete', path })`
- `createFolder(parentDir, name)` -> `dispatch({ type: 'folder.create', parentDir, name })`
- `renameFolder(dir, newName)` -> `dispatch({ type: 'folder.rename', path: dir, name: newName })`
- `moveFolder(dir, targetDir)` -> `dispatch({ type: 'folder.move', path: dir, targetDir })`
- `deleteFolder(dir)` -> `dispatch({ type: 'folder.delete', path: dir })`
- `importPastedAssets({ notePath, files })` -> `dispatch({ type: 'assets.import', notePath, files })`
- `createShareLink()` -> `dispatch({ type: 'share.create', notePath: activePath })`
- `refreshShareLink()` -> `dispatch({ type: 'share.refresh', notePath: activePath })`
- `revokeShareLink()` -> `dispatch({ type: 'share.revoke', notePath: activePath })`

The mapping is intent translation only. Callers stop depending on returned data and instead observe the resulting state changes.

The current direct UI bypasses should move behind the same boundary:

- `navigate({ kind: 'repo', owner, repo })` and recent-repo opening -> `dispatch({ type: 'repo.activate', repo: { kind: 'github', owner, repo } })`
- `navigate({ kind: 'new' })` -> `dispatch({ type: 'repo.activate', repo: { kind: 'new' } })`
- `repoExists(owner, repo)` -> `dispatch({ type: 'repo.probe', owner, repo })`
- `listRecentRepos()` and `recordRecent()` stop being UI imports and become data-layer state/effects
