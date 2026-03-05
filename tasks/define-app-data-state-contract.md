---
status: done
created: 2026-03-05
completed: 2026-03-05
assigned: subagent-define-action-protocol
---

# Define the app-level data state contract

Define the state surface the UI should consume from the app-level data layer.

This task should decide what state belongs in the contract and what should stay outside it as ephemeral UI state. The contract should include the concerns that matter across repositories, not only the currently open workspace.

Must-haves:

- Cover the state the UI needs for the active workspace.
- Cover the state the UI needs for app-level concerns such as repo switching, recent repositories, and session-driven availability.
- Keep purely visual and ephemeral state out of the contract unless there is a strong reason to include it.
- Keep the contract compatible with both the current implementation and a future rewritten implementation.

Success will be validated by:

- This task file contains a concise design note for the proposed state contract.
- The note clearly separates app-level state, workspace data state, and UI-only ephemeral state.
- The resulting contract is concrete enough to drive the adaptation task.

## Design note

### Proposed contract

The UI should consume one app-scoped state object with a strict split between app concerns and the active workspace:

```ts
type AppDataState = {
  session: AppSessionState;
  navigation: AppNavigationState;
  repos: RepoCatalogState;
  workspace?: WorkspaceState;
};
```

```ts
type AppSessionState = {
  status: 'signed-out' | 'signed-in';
  user?: {
    login: string;
    name?: string;
    avatarUrl?: string;
    avatarDataUrl?: string;
  };
};

type AppNavigationState = {
  screen: 'resolving' | 'home' | 'workspace';
  target?: {
    repo: { kind: 'new'; slug: 'new' } | { kind: 'github'; slug: string; owner: string; repo: string };
    notePath?: string;
  };
};

type RepoCatalogState = {
  recents: Array<{
    slug: string;
    owner?: string;
    repo?: string;
    connected?: boolean;
    lastOpenedAt: number;
  }>;
};

type WorkspaceState = {
  target: { kind: 'new'; slug: 'new' } | { kind: 'github'; slug: string; owner: string; repo: string };
  access: {
    status: 'unknown' | 'ready' | 'error';
    level: 'none' | 'read' | 'write';
    canRead: boolean;
    canEdit: boolean;
    canSync: boolean;
    linked: boolean;
    manageUrl?: string;
    defaultBranch?: string;
    errorType?: 'auth' | 'not-found' | 'forbidden' | 'network' | 'rate-limited' | 'unknown';
  };
  tree: {
    files: Array<{
      id: string;
      path: string;
      updatedAt: number;
      kind: 'markdown' | 'binary' | 'asset-url' | 'text';
    }>;
    folders: string[];
  };
  document: {
    activeFile?: {
      id: string;
      path: string;
      updatedAt: number;
      kind: 'markdown' | 'binary' | 'asset-url' | 'text';
      content: string;
    };
  };
  sync: {
    autosync: boolean;
    syncing: boolean;
  };
  share: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    link?: {
      url: string;
    };
    error?: string;
  };
};
```

### Ownership split

App-level state:

- `session` is global and should be readable from any screen.
- `navigation` is the single owner of which screen is showing, which repo is targeted, and which note path is selected.
- `repos.recents` is app-scoped shared data for both `HomeView` and `RepoSwitcher`.

Workspace state:

- `workspace.target` identifies the active workspace independently from the router implementation.
- `workspace.access` carries repo availability/capabilities and install-management metadata.
- `workspace.tree`, `workspace.document`, `workspace.sync`, and `workspace.share` carry the actual workspace snapshot for the current target.

UI-only ephemeral state that should stay out of the contract:

- header, sidebar, switcher, share-dialog, and account-menu open/closed flags
- switcher input text, highlighted suggestion, and local “checking…” spinner state
- file-tree highlight, inline create/rename drafts, and cut/paste clipboard fallback
- expanded/collapsed folders, even if persisted locally as a view preference
- generic banner text like `statusMessage`

### Important contract decisions

- Do not expose the raw router `Route` as the contract. The UI should consume normalized navigation state, not own URL parsing rules.
- Do not put current implementation internals such as `lastRemoteSha`, `lastSyncedHash`, or share `shareId` into the UI contract. The UI does not need them.
- `navigation.target.notePath` replaces current `activePath` as the canonical selected-note location. `workspace.document.activeFile` is the resolved content for that selection.
- `screen: 'resolving'` covers current `/start` redirect behavior without forcing `App` to keep special-case routing logic outside the data layer.
- `statusMessage` should not survive into the stable contract. Feedback should come from domain state (`access.errorType`, `share.error`) or action results from the protocol task.

### Current state mapping

- `hasSession` and `user` -> `session`
- `App` route plus `RepoView` note-path wiring -> `navigation`
- `App` recents state and `RepoSwitcher` recents reads -> `repos.recents`
- `canRead`, `canEdit`, `canSync`, `repoLinked`, `repoErrorType`, `manageUrl`, `defaultBranch`, `repoQueryStatus` -> `workspace.access`
- `files` and `folders` -> `workspace.tree`
- `activeFile` -> `workspace.document.activeFile`
- `activePath` -> `navigation.target.notePath`
- `autosync` and `syncing` -> `workspace.sync`
- `share` -> `workspace.share`
- `statusMessage` is intentionally dropped from the stable state contract
