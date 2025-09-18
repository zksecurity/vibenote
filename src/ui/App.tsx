import React, { useCallback, useEffect, useState } from 'react';
import { useRoute } from './routing';
import { RepoView } from './RepoView';
import { HomeView } from './HomeView';
import { listKnownRepoSlugs, listRecentRepos, recordRecentRepo, type RecentRepo } from '../storage/local';

export function App() {
  const { route, navigate } = useRoute();
  const [recents, setRecents] = useState<RecentRepo[]>(() => listRecentRepos());

  const recordVisit = useCallback(
    (entry: { slug: string; owner?: string; repo?: string; title?: string; connected?: boolean }) => {
      recordRecentRepo(entry);
      setRecents(listRecentRepos());
    },
    []
  );

  useEffect(() => {
    setRecents(listRecentRepos());
  }, [route]);

  useEffect(() => {
    const onStorage = () => setRecents(listRecentRepos());
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    if (route.kind === 'home') {
      const recentEntries = listRecentRepos();
      if (recentEntries.length === 0) {
        const fallback = listKnownRepoSlugs();
        if (fallback.length === 0) {
          navigate({ kind: 'new' }, { replace: true });
        }
      }
    }
  }, [route, navigate]);

  if (route.kind === 'home') {
    return <HomeView recents={recents} navigate={navigate} />;
  }

  if (route.kind === 'new') {
    return <RepoView slug="new" route={route} navigate={navigate} onRecordRecent={recordVisit} />;
  }

  if (route.kind === 'repo') {
    return (
      <RepoView
        slug={`${route.owner}/${route.repo}`}
        route={route}
        navigate={navigate}
        onRecordRecent={recordVisit}
      />
    );
  }

  return null;
}
