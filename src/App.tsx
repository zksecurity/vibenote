import React, { useEffect } from 'react';
import { repoRouteToSlug, useAppShellData, useWorkspaceAppData, type AppNavigationState } from './data';
import { useRoute, type Route } from './ui/routing';
import { RepoView } from './ui/RepoView';
import { HomeView } from './ui/HomeView';

export function App() {
  const { route, navigate } = useRoute();
  let app = useAppShellData({ route });

  // Adjust page title based on route
  useEffect(() => {
    let target = app.state.navigation.target;
    document.title =
      target !== undefined && target.kind === 'repo' ? `${target.owner}/${target.repo}` : 'VibeNote';
  }, [app.state.navigation.target]);

  // Keep the browser URL in sync with the app-level navigation contract.
  useEffect(() => {
    let nextRoute = routeFromNavigation(app.state.navigation);
    if (nextRoute === undefined) return;
    if (routesEqual(route, nextRoute)) return;
    navigate(nextRoute, { replace: app.state.navigation.replace === true });
  }, [route, navigate, app.state.navigation]);

  // Home is rendered directly from app-level state, without mounting any repo workspace.
  if (app.state.navigation.screen === 'home') {
    return <HomeView recents={app.state.repos.recents} dispatch={app.dispatch} />;
  }

  // Mount repo state behind a slug key so repo-local hooks can assume owner/repo stay fixed.
  if (app.state.navigation.screen === 'workspace' && app.state.navigation.target !== undefined) {
    let target = app.state.navigation.target;
    return <RepoWorkspaceScreen key={repoRouteToSlug(target)} route={target} app={app} />;
  }

  return null;
}

function RepoWorkspaceScreen({
  route,
  app,
}: {
  route: NonNullable<AppNavigationState['target']>;
  app: ReturnType<typeof useAppShellData>;
}) {
  // Combine app-level shell state with the repo-scoped workspace data for RepoView.
  let data = useWorkspaceAppData({ app, route });
  return <RepoView state={data.state} dispatch={data.dispatch} helpers={data.helpers} />;
}

function routeFromNavigation(navigation: AppNavigationState): Route | undefined {
  if (navigation.screen === 'home') return { kind: 'home' } as const;
  if (navigation.screen !== 'workspace' || navigation.target === undefined) return undefined;
  if (navigation.target.kind === 'new') {
    return { kind: 'new', filePath: navigation.target.filePath } as const;
  }
  return {
    kind: 'repo',
    owner: navigation.target.owner,
    repo: navigation.target.repo,
    filePath: navigation.target.filePath,
  } as const;
}

function routesEqual(a: Route | undefined, b: Route | undefined) {
  if (a === undefined || b === undefined) return a === b;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'home' && b.kind === 'home') return true;
  if (a.kind === 'new' && b.kind === 'new') return a.filePath === b.filePath;
  if (a.kind === 'repo' && b.kind === 'repo') {
    return a.owner === b.owner && a.repo === b.repo && a.filePath === b.filePath;
  }
  return false;
}
