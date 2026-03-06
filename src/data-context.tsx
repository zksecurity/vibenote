// React context bridge for the app-level and repo-level data hooks.
import { createContext, useContext, type ReactNode } from 'react';
import { useAppShellData, useWorkspaceAppData, type AppDataResult } from './data';
import type { Route, RepoRoute } from './ui/routing';

export { AppShellProvider, RepoDataProvider, useAppShellContext, useAppDataContext };

const AppShellContext = createContext<ReturnType<typeof useAppShellData> | undefined>(undefined);
const AppDataContext = createContext<AppDataResult | undefined>(undefined);

function AppShellProvider({ route, children }: { route: Route; children: ReactNode }) {
  // App-lifetime provider: route parsing, recents, session shell state, and repo probe state.
  let app = useAppShellData({ route });
  return <AppShellContext.Provider value={app}>{children}</AppShellContext.Provider>;
}

function useAppShellContext(): ReturnType<typeof useAppShellData> {
  let value = useContext(AppShellContext);
  if (value === undefined) {
    throw new Error('useAppShellContext must be used inside AppShellProvider');
  }
  return value;
}

function RepoDataProvider({ route, children }: { route: RepoRoute; children: ReactNode }) {
  // Repo-lifetime provider: mount this behind a repo key so repo-local hooks get a fresh lifetime.
  let app = useAppShellContext();
  let data = useWorkspaceAppData({ app, route });
  return <AppDataContext.Provider value={data}>{children}</AppDataContext.Provider>;
}

function useAppDataContext(): AppDataResult {
  let value = useContext(AppDataContext);
  if (value === undefined) {
    throw new Error('useAppDataContext must be used inside RepoDataProvider');
  }
  return value;
}
