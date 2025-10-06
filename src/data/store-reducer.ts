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
    case 'auth/sessionUpdated': {
      if (state.sessionToken === event.payload.token && state.user === event.payload.user) {
        return state;
      }
      return { ...state, sessionToken: event.payload.token, user: event.payload.user };
    }
    case 'sync/statusChanged': {
      if (state.syncing === event.payload.syncing) return state;
      return { ...state, syncing: event.payload.syncing };
    }
    case 'status/message': {
      if (state.statusMessage === event.payload.message) return state;
      return { ...state, statusMessage: event.payload.message };
    }
    case 'state/merge':
      return { ...state, ...event.payload };
    default:
      return state;
  }
}
