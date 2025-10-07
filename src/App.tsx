import React, { useCallback, useEffect, useState } from 'react';
import { useRoute } from './ui/routing';
import { RepoView } from './ui/RepoView';
import { HomeView } from './ui/HomeView';
import { listRecentRepos, recordRecentRepo, type RecentRepo } from './storage/local';

export function App() {
  const { route, navigate } = useRoute();

  // Adjust page title based on route
  useEffect(() => {
    document.title = route.kind === 'repo' ? `${route.owner}/${route.repo}` : 'VibeNote';
  }, [route]);

  // redirects
  useEffect(() => {
    // if the route is /start, redirect to the most recent repo or /home
    if (route.kind === 'start') {
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
        navigate({ kind: 'new' }, { replace: true });
      }
    }
  }, [route]);

  // list of recent repos, kept in local storage and updated when navigating to a new repo
  // or updating information about an existing one
  const [recents, recordRecent] = useRecents();

  if (route.kind === 'home') {
    return <HomeView recents={recents} navigate={navigate} />;
  }

  if (route.kind === 'start') {
    // will redirect immediately
    return null;
  }

  if (route.kind === 'new') {
    return <RepoView slug="new" route={route} navigate={navigate} onRecordRecent={recordRecent} />;
  }

  if (route.kind === 'repo') {
    return (
      <RepoView
        slug={`${route.owner}/${route.repo}`}
        route={route}
        navigate={navigate}
        onRecordRecent={recordRecent}
      />
    );
  }

  return null;
}

function useRecents() {
  const [recents, setRecents] = useState<RecentRepo[]>(() => listRecentRepos());

  useEffect(() => {
    const onStorage = () => setRecents(listRecentRepos());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const recordRecent = useCallback(
    (entry: { slug: string; owner?: string; repo?: string; title?: string; connected?: boolean }) => {
      recordRecentRepo(entry);
      setRecents(listRecentRepos());
    },
    []
  );
  return [recents, recordRecent] as const;
}
