import type { RepoDataEvent, RepoDataState } from './types';

export const initialDataState: RepoDataState = {
  sessionToken: null,
  user: null,
  canEdit: false,
  canRead: false,
  canSync: false,
  repoQueryStatus: 'idle',
  needsInstall: false,
  manageUrl: null,
  readOnlyLoading: false,
  doc: null,
  activeId: null,
  activeNotes: [],
  activeFolders: [],
  autosync: false,
  syncing: false,
  statusMessage: null,
};

export function repoDataReducer(state: RepoDataState, event: RepoDataEvent): RepoDataState {
  switch (event.type) {
    case 'state/merge':
      return { ...state, ...event.payload };
    default:
      return state;
  }
}
