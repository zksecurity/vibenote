// Top-level application component. Instantiates the data layer once and
// provides a thin routing adapter that syncs URL ↔ data state.
import React, { useEffect, useRef } from 'react';
import { useRoute, parseRoute } from './ui/routing';
import { RepoView } from './ui/RepoView';
import { HomeView } from './ui/HomeView';
import { useAppData } from './data';
import { listRecentRepos } from './storage/local';

export function App() {
  // Data layer: instantiated once at the app level.
  // The initial route is read from the URL synchronously so the first render
  // already reflects the correct slug/path without waiting for a dispatch.
  const { state, dispatch } = useAppData(parseRoute(window.location.pathname));

  // URL routing: parse/navigate the browser history.
  const { route, navigate } = useRoute();

  // URL → data: inform the data layer whenever the browser route changes.
  useEffect(() => {
    dispatch({ type: 'route-changed', route });
  }, [route]);

  // Data → URL: when the data layer sets a pendingNavigation (e.g. after a
  // rename or sync), reflect it in the URL via navigate().
  let lastNavRef = useRef(state.pendingNavigation);
  useEffect(() => {
    let nav = state.pendingNavigation;
    // Skip if no pending nav, or if we already processed this exact object.
    if (!nav || nav === lastNavRef.current) return;
    lastNavRef.current = nav;

    // Build the target route from the current active route + new path.
    let activeRoute = state.activeRoute;
    if (activeRoute.kind === 'repo') {
      navigate({ ...activeRoute, notePath: nav.path }, { replace: nav.replace });
    } else if (activeRoute.kind === 'new') {
      navigate({ kind: 'new', notePath: nav.path }, { replace: nav.replace });
    }
  }, [state.pendingNavigation]);

  // Adjust page title based on active route.
  useEffect(() => {
    let r = state.activeRoute;
    document.title = r.kind === 'repo' ? `${r.owner}/${r.repo}` : 'VibeNote';
  }, [state.activeRoute]);

  // Redirects based on the URL route (not the data layer route).
  useEffect(() => {
    // if the route is /start, redirect to the most recent repo or /home
    if (route.kind === 'start') {
      let recents = state.recents;
      let candidate = recents.find((entry) => entry.owner !== undefined && entry.repo !== undefined);

      if (candidate !== undefined) {
        navigate({ kind: 'repo', owner: candidate.owner!, repo: candidate.repo! }, { replace: true });
        return;
      }
      navigate({ kind: 'home' }, { replace: true });
    }

    // if the route is /home and there are no recent repos, redirect to /new for the onboarding flow
    if (route.kind === 'home') {
      if (listRecentRepos().length === 0) {
        navigate({ kind: 'new', notePath: 'README.md' }, { replace: true });
      }
    }
  }, [route]);

  if (route.kind === 'home') {
    return <HomeView recents={state.recents} navigate={navigate} />;
  }

  if (route.kind === 'start') {
    // will redirect immediately
    return null;
  }

  if (route.kind === 'new' || route.kind === 'repo') {
    return <RepoView state={state} dispatch={dispatch} navigate={navigate} />;
  }

  return null;
}
