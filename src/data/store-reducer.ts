import type { RepoDataEvent, RepoDataStoreState } from './types';

export const initialDataState: RepoDataStoreState = {
  sessionToken: null,
  user: null,
  canEdit: false,
  canRead: false,
  canSync: false,
  repoQueryStatus: 'idle',
  needsInstall: false,
  manageUrl: null,
  readOnlyLoading: false,
  readOnlyNotes: [],
  readOnlyDoc: null,
  activeId: null,
  autosync: false,
  syncing: false,
  statusMessage: null,
};

export function repoDataReducer(state: RepoDataStoreState, event: RepoDataEvent): RepoDataStoreState {
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
    case 'notes/readOnlyChanged': {
      const { notes, loading } = event.payload;
      if (state.readOnlyLoading === loading && state.readOnlyNotes === notes) return state;
      return { ...state, readOnlyNotes: notes, readOnlyLoading: loading };
    }
    case 'notes/readOnlyDocLoaded': {
      if (state.readOnlyDoc === event.payload.doc) return state;
      return { ...state, readOnlyDoc: event.payload.doc };
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
