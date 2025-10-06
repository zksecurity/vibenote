import { useMemo, useSyncExternalStore } from 'react';
import type { RepoDataEvent, RepoDataInputs, RepoDataState, RepoStateReducer } from './types';
import { initialDataState, repoDataReducer } from './store-reducer';

const storeCache = new Map<string, RepoDataStore>();

type Listener = () => void;

export class RepoDataStore {
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
    return () => this.listeners.delete(listener);
  }
}

export function getRepoDataStore(inputs: RepoDataInputs): RepoDataStore {
  const slug = inputs.slug;
  let store = storeCache.get(slug);
  if (!store) {
    store = new RepoDataStore(initialDataState, repoDataReducer);
    storeCache.set(slug, store);
  }
  return store;
}

export function useRepoDataStore(inputs: RepoDataInputs) {
  return useMemo(() => getRepoDataStore(inputs), [inputs.slug]);
}

export function useRepoDataSnapshot(inputs: RepoDataInputs) {
  const store = useRepoDataStore(inputs);
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState()
  );
}
