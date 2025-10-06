import type { AppUser } from '../auth/app-auth';
import type { NoteDoc, NoteMeta } from '../storage/local';
import type { RepoMetadata } from '../lib/backend';
import type { Route } from '../ui/routing';
import type { SyncSummary } from '../sync/git-sync';

export type ReadOnlyNote = {
  id: string;
  path: string;
  title: string;
  dir: string;
  sha?: string;
};

export type RepoNoteListItem = NoteMeta | ReadOnlyNote;

export type RepoDataInputs = {
  slug: string;
  route: Route;
  onRecordRecent: (entry: {
    slug: string;
    owner?: string;
    repo?: string;
    title?: string;
    connected?: boolean;
  }) => void;
};

export type RepoQueryStatus = 'idle' | 'checking' | 'ready' | 'rate-limited' | 'error';
export type RepoAccessLevel = 'none' | 'read' | 'write';

export type RepoAccessState = {
  level: RepoAccessLevel;
  status: RepoQueryStatus;
  metadata: RepoMetadata | null;
  defaultBranch: string | null;
  error: string | null;
  rateLimited: boolean;
  needsInstall: boolean;
  manageUrl: string | null;
  isPrivate: boolean | null;
};

export type RepoDataStoreState = {
  sessionToken: string | null;
  user: AppUser | null;
  canEdit: boolean;
  canRead: boolean;
  canSync: boolean;
  repoQueryStatus: RepoQueryStatus;
  needsInstall: boolean;
  manageUrl: string | null;
  readOnlyLoading: boolean;
  readOnlyNotes: ReadOnlyNote[];
  readOnlyDoc: NoteDoc | null;
  activeId: string | null;
  autosync: boolean;
  syncing: boolean;
  statusMessage: string | null;
};

export type RepoDataState = {
  sessionToken: string | null;
  user: AppUser | null;
  canEdit: boolean;
  canRead: boolean;
  canSync: boolean;
  repoQueryStatus: RepoQueryStatus;
  needsInstall: boolean;
  manageUrl: string | null;
  readOnlyLoading: boolean;
  doc: NoteDoc | null;
  activeId: string | null;
  activeNotes: RepoNoteListItem[];
  activeFolders: string[];
  autosync: boolean;
  syncing: boolean;
  statusMessage: string | null;
};

export type RepoDataActions = {
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  openRepoAccess: () => Promise<void>;
  syncNow: () => Promise<void>;
  setAutosync: (enabled: boolean) => void;
  selectNote: (id: string | null) => Promise<void>;
  createNote: (dir: string, name: string) => string | null;
  createFolder: (parentDir: string, name: string) => void;
  renameNote: (id: string, title: string) => void;
  deleteNote: (id: string) => void;
  renameFolder: (dir: string, newName: string) => void;
  deleteFolder: (dir: string) => void;
  updateNoteText: (id: string, text: string) => void;
};

export type RepoDataEvent =
  | { type: 'auth/sessionUpdated'; payload: { token: string | null; user: AppUser | null } }
  | { type: 'repo/accessChanged'; payload: RepoAccessState }
  | { type: 'notes/localChanged'; payload: { notes: NoteMeta[]; folders: string[] } }
  | { type: 'notes/readOnlyChanged'; payload: { notes: ReadOnlyNote[]; loading: boolean } }
  | { type: 'notes/readOnlyDocLoaded'; payload: { doc: NoteDoc | null } }
  | { type: 'notes/activeChanged'; payload: { id: string | null } }
  | { type: 'sync/statusChanged'; payload: { syncing: boolean; summary?: SyncSummary | null } }
  | { type: 'status/message'; payload: { message: string | null } }
  | { type: 'state/merge'; payload: Partial<RepoDataStoreState> };

export type RepoStateReducer = (state: RepoDataStoreState, event: RepoDataEvent) => RepoDataStoreState;

export type RepoDataIntent =
  | { type: 'app/signOut' }
  | { type: 'notes/readOnly/request'; payload: { branch: string | null } }
  | { type: 'notes/readOnly/select'; payload: { id: string | null } }
  | { type: 'notes/readOnly/clear' };
