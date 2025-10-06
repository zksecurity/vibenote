import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getSessionToken as getAppSessionToken, getSessionUser as getAppSessionUser } from '../auth/app-auth';
import type { RepoDataEvent, RepoDataIntent, RepoDataStoreState, RepoStateReducer } from './types';
import { initialDataState, repoDataReducer } from './store-reducer';

export {
  getRepoDataStore,
  useRepoDataStore,
  useRepoDataSnapshot,
  useRepoIntentStream,
  dispatchRepoEvent,
  dispatchRepoIntent,
  resetRepoDataStore,
};

type Listener = () => void;
type IntentHandler = (intent: RepoDataIntent) => void;

const storeCache = new Map<string, RepoDataStore>();

class RepoDataStore {
  private listeners = new Set<Listener>();
  private intentHandlers = new Set<IntentHandler>();
  private state: RepoDataStoreState;
  private reducer: RepoStateReducer;

  constructor(initialState: RepoDataStoreState, reducer: RepoStateReducer) {
    this.state = initialState;
    this.reducer = reducer;
  }

  getState(): RepoDataStoreState {
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

  dispatchIntent(intent: RepoDataIntent) {
    for (const handler of this.intentHandlers) handler(intent);
  }

  subscribeToIntents(handler: IntentHandler) {
    this.intentHandlers.add(handler);
    return () => {
      this.intentHandlers.delete(handler);
    };
  }
}

function getRepoDataStore(slug: string): RepoDataStore {
  let store = storeCache.get(slug);
  if (!store) {
    const hydratedState: RepoDataStoreState = {
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

function useRepoDataSnapshot(slug: string): RepoDataStoreState {
  const store = useRepoDataStore(slug);
  return useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getState(),
    () => store.getState()
  );
}

function useRepoIntentStream(slug: string, handler: IntentHandler | null) {
  const store = useRepoDataStore(slug);
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    if (!handlerRef.current) return undefined;
    return store.subscribeToIntents((intent) => {
      const current = handlerRef.current;
      if (!current) return;
      current(intent);
    });
  }, [store]);
}

function dispatchRepoEvent(slug: string, event: RepoDataEvent) {
  const store = getRepoDataStore(slug);
  store.dispatch(event);
}

function dispatchRepoIntent(slug: string, intent: RepoDataIntent) {
  const store = getRepoDataStore(slug);
  store.dispatchIntent(intent);
}

function resetRepoDataStore(slug: string) {
  const store = storeCache.get(slug);
  if (!store) return;
  storeCache.delete(slug);
}
