import { useMemo, useSyncExternalStore } from 'react';
import { getSessionToken as getAppSessionToken, getSessionUser as getAppSessionUser } from '../auth/app-auth';
import type { RepoDataEvent, RepoDataState, RepoStateReducer } from './types';
import { initialDataState, repoDataReducer } from './store-reducer';

export { getRepoDataStore, useRepoDataStore, useRepoDataSnapshot, dispatchRepoEvent, resetRepoDataStore };

type Listener = () => void;

const storeCache = new Map<string, RepoDataStore>();

class RepoDataStore {
  private listeners = new Set<Listener>();
  private state: RepoDataState;
  private reducer: RepoStateReducer;

  constructor(initialState: RepoDataState, reducer: RepoStateReducer) {
    this.state = initialState;
    this.reducer = reducer;
  }

  getState(): RepoDataState {
    return this.state;
  }

  dispatch(event: RepoDataEvent) {
    const next = this.reducer(this.state, event);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

function getRepoDataStore(slug: string): RepoDataStore {
  let store = storeCache.get(slug);
  if (!store) {
    const hydratedState: RepoDataState = {
      ...initialDataState,
      sessionToken: getAppSessionToken(),
      user: getAppSessionUser(),
    };
    store = new RepoDataStore(hydratedState, repoDataReducer);
    storeCache.set(slug, store);
  }
  return store;
}

function useRepoDataStore(slug: string) {
  return useMemo(() => getRepoDataStore(slug), [slug]);
}

function useRepoDataSnapshot(slug: string) {
  const store = useRepoDataStore(slug);
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState()
  );
}

function dispatchRepoEvent(slug: string, event: RepoDataEvent) {
  const store = getRepoDataStore(slug);
  store.dispatch(event);
}

function resetRepoDataStore(slug: string) {
  const store = storeCache.get(slug);
  if (!store) return;
  storeCache.delete(slug);
}
