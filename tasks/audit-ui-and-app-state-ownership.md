---
status: done
created: 2026-03-05
completed: 2026-03-05
assigned: subagent-audit-ui-app-state
---

# Audit UI/data dependencies and state ownership

Map the state and behaviors the UI currently depends on, and identify which concerns belong in app-level data state versus purely local UI state.

The goal is to make ownership explicit before we define the contract. In particular, this task should clarify where current workspace state ends and app-level concerns such as repo switching, recently visited repositories, and session state begin.

Must-haves:

- Inventory what the UI reads from the current data layer.
- Inventory what the UI currently asks the data layer to do.
- Identify which state should remain purely local to UI components.
- Identify which state and behaviors should move under an app-level data layer boundary.

Success will be validated by:

- This task file contains a concise written summary of the current boundary.
- The summary names the most important ownership problems in the current design.
- The summary is specific enough to drive the action protocol and state contract tasks.

## Audit summary

### Current UI -> data reads

`RepoView` currently reads this entire workspace surface from `useRepoData`:

- Session/auth: `hasSession`, `user`
- Repo capability/access: `canEdit`, `canRead`, `canSync`, `repoLinked`, `repoErrorType`, `manageUrl`, `defaultBranch`
- Workspace content: `activeFile`, `activePath`, `files`, `folders`
- Workspace process state: `autosync`, `syncing`, `statusMessage`
- Note sharing: `share`

### Current UI -> data actions

`RepoView` and its sidebar/editor currently ask the data layer to:

- Authenticate and repo-install: `signIn`, `signOut`, `openRepoAccess`
- Drive sync: `syncNow`, `setAutosync`
- Drive note selection/editing: `selectFile`, `saveFile`
- Create/move/delete notes and folders: `createNote`, `createFolder`, `renameFile`, `moveFile`, `deleteFile`, `renameFolder`, `moveFolder`, `deleteFolder`
- Import pasted assets: `importPastedAssets`
- Manage share links: `createShareLink`, `refreshShareLink`, `revokeShareLink`

### State that is purely local UI state

These concerns are presentational or view-local and should stay out of an app-level data contract:

- Header/sidebar/dialog visibility: `sidebarOpen`, `menuOpen`, `shareOpen`, `showSwitcher`
- Keyboard shortcut handling for opening the repo switcher
- File tree selection highlight and inline create-row state inside `FileSidebar`
- Folder expand/collapse state, even though it is persisted per repo as a view preference

### State and behaviors that belong under an app-level data boundary

The current codebase splits these app concerns across `App`, `RepoView`, `useRepoData`, `RepoSwitcher`, and `storage/local`:

- Session/user state and global auth actions
- Current repo target and repo-switching flow
- Recent repositories and their linked/unlinked metadata
- Repo access metadata (`read` vs `write`, install state, `manageUrl`, default branch)
- Route-backed note selection as navigation state, not as an internal side effect of the repo hook

### Current ownership problems

1. `useRepoData` mixes global app state with repo workspace state.
   It owns session/user state, repo access lookup, recent-repo recording, route updates, initial repo import, sync state, share state, and file CRUD in one hook. That makes the workspace contract too broad and hides where app state ends.

2. Repo switching and recents bypass the current data boundary.
   `App` owns the recents list, `RepoSwitcher` reads `listRecentRepos()` directly, `RepoSwitcher` also calls `repoExists()` directly, and `useRepoData` separately records recents in an effect. The switching flow already spans multiple owners before a new contract exists.

3. Active note selection is co-owned by the router and the repo hook.
   `useRepoData` derives the active file from `route.notePath` and saved local state, then mutates navigation back through `setActivePath`. The selected note path should have one owner at the app/navigation boundary, with the workspace layer resolving file content for that path.

4. Auth and repo-access behavior are scoped too low.
   Sign-in, sign-out, install/manage access, and repo capability checks are global concerns, but they currently live inside the repo workspace hook. That prevents non-workspace screens from consuming the same app state cleanly.

5. The writable/read-only repo modes are collapsed into one hook boundary.
   `useRepoData` switches between local writable storage and `useReadOnlyFiles`, but the UI only sees one merged surface. That is convenient short-term, but it hides an important app-level distinction: repo access mode is not workspace content state.

6. `statusMessage` is an overloaded feedback channel.
   Sync results, auth failures, and local validation errors all flow through one banner string owned by the data hook. That is a presentation concern mixed into domain actions, and it will make an explicit action protocol harder to define.

### Recommended ownership split for the next contract tasks

- App-level data layer: session/user, repo target, recent repos, repo switching/search, repo access metadata, install/manage actions, route note path
- Workspace data layer: file/folder snapshot, active file content for the selected path, note/folder mutations, autosync state, sync actions, share state, asset import
- Local UI components: toggles, menus, dialogs, tree selection, create-row drafts, collapsed folder preference
