import React, { useEffect } from 'react';
import { useAppData, type AppNavigationState } from './data';
import { useRoute, type Route } from './ui/routing';
import { RepoView } from './ui/RepoView';
import { HomeView } from './ui/HomeView';

export function App() {
  const { route, navigate } = useRoute();
  let { state, dispatch, helpers } = useAppData({ route });

  // Adjust page title based on route
  useEffect(() => {
    let target = state.workspace?.target;
    document.title =
      target !== undefined && target.kind === 'repo' ? `${target.owner}/${target.repo}` : 'VibeNote';
  }, [state.workspace?.target]);

  useEffect(() => {
    let nextRoute = routeFromNavigation(state.navigation);
    if (nextRoute === undefined) return;
    if (routesEqual(route, nextRoute)) return;
    navigate(nextRoute, { replace: state.navigation.replace === true });
  }, [route, navigate, state.navigation]);

  if (state.navigation.screen === 'home') {
    return <HomeView recents={state.repos.recents} dispatch={dispatch} />;
  }

  if (state.navigation.screen === 'workspace' && state.workspace !== undefined) {
    return <RepoView state={state} dispatch={dispatch} helpers={helpers} />;
  }

  return null;
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
