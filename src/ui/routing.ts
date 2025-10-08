// SPA routing helpers for parsing and updating the current location
import { useCallback, useEffect, useState } from 'react';

export type { Route, RepoRoute };
export { useRoute };

type Route =
  | { kind: 'home' }
  | { kind: 'new' }
  | { kind: 'start' }
  | { kind: 'repo'; owner: string; repo: string; notePath?: string };

type RepoRoute = { kind: 'new' } | { kind: 'repo'; owner: string; repo: string; notePath?: string };

const HOME_ROUTE: Route = { kind: 'home' };
const NEW_ROUTE: Route = { kind: 'new' };
const START_ROUTE: Route = { kind: 'start' };

function stripTrailingSlash(path: string): string {
  if (path.length <= 1) return '/';
  return path.replace(/\/+$/, '') || '/';
}

function parseRoute(pathname: string): Route {
  let clean = stripTrailingSlash(pathname.split('?')[0]?.split('#')[0] ?? '/');
  if (clean === '/' || clean === '') return HOME_ROUTE;
  if (clean === '/start') return START_ROUTE;
  if (clean === '/new') return NEW_ROUTE;
  let segments = clean.replace(/^\//, '').split('/');
  if (segments.length >= 2) {
    let owner = decodeURIComponent(segments[0] ?? '');
    let repo = decodeURIComponent(segments[1] ?? '');
    if (owner && repo) {
      let noteSegments = segments.slice(2).map((segment) => decodeURIComponent(segment ?? ''));
      let notePath = noteSegments.length > 0 ? noteSegments.join('/') : undefined;
      return { kind: 'repo', owner, repo, notePath };
    }
  }
  return HOME_ROUTE;
}

function routeToPath(route: Route): string {
  if (route.kind === 'home') return '/';
  if (route.kind === 'new') return '/new';
  if (route.kind === 'start') return '/start';
  let owner = encodeURIComponent(route.owner);
  let repo = encodeURIComponent(route.repo);
  if (!route.notePath) {
    return `/${owner}/${repo}`;
  }
  let segments = route.notePath
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment));
  if (segments.length === 0) {
    return `/${owner}/${repo}`;
  }
  return `/${owner}/${repo}/${segments.join('/')}`;
}

function useRoute() {
  let [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    let onPop = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  let navigate = useCallback((next: Route, { replace = false } = {}) => {
    let path = routeToPath(next);
    let current = stripTrailingSlash(window.location.pathname);
    let target = stripTrailingSlash(path);
    if (replace) {
      window.history.replaceState(null, '', target);
    } else if (current !== target) {
      window.history.pushState(null, '', target);
    } else if (!replace) {
      // same path, no navigation needed
    }
    setRoute(parseRoute(target));
  }, []);

  return { route, navigate };
}
