import { useCallback, useEffect, useState } from 'react';

export type Route = { kind: 'home' } | { kind: 'new' } | { kind: 'repo'; owner: string; repo: string };

type NavigateOptions = {
  replace?: boolean;
};

const HOME_ROUTE: Route = { kind: 'home' };
const NEW_ROUTE: Route = { kind: 'new' };

function stripTrailingSlash(path: string): string {
  if (path.length <= 1) return '/';
  return path.replace(/\/+$/, '') || '/';
}

export function parseRoute(pathname: string): Route {
  let clean = stripTrailingSlash(pathname.split('?')[0]?.split('#')[0] ?? '/');
  if (clean === '/' || clean === '') return HOME_ROUTE;
  if (clean === '/new') return NEW_ROUTE;
  let segments = clean.replace(/^\//, '').split('/');
  if (segments.length >= 2) {
    let owner = decodeURIComponent(segments[0] ?? '');
    let repo = decodeURIComponent(segments[1] ?? '');
    if (owner && repo) {
      return { kind: 'repo', owner, repo };
    }
  }
  return HOME_ROUTE;
}

export function routeToPath(route: Route): string {
  if (route.kind === 'home') return '/';
  if (route.kind === 'new') return '/new';
  return `/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}`;
}

export function useRoute() {
  let [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    let onPop = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  let navigate = useCallback((next: Route, options: NavigateOptions = {}) => {
    let path = routeToPath(next);
    let current = stripTrailingSlash(window.location.pathname);
    let target = stripTrailingSlash(path);
    if (options.replace) {
      window.history.replaceState(null, '', target);
    } else if (current !== target) {
      window.history.pushState(null, '', target);
    } else if (!options.replace) {
      // same path, no navigation needed
    }
    setRoute(parseRoute(target));
  }, []);

  return { route, navigate };
}
