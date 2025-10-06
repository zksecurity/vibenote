import { useCallback, useEffect, useRef } from 'react';
import { listNoteFiles, pullNote } from '../../sync/git-sync';
import { hashText, type NoteDoc } from '../../storage/local';
import { logError } from '../../lib/logging';
import {
  dispatchRepoEvent,
  dispatchRepoIntent,
  getRepoDataStore,
  useRepoIntentStream,
} from '../store';
import type { RepoAccessState, RepoDataIntent, ReadOnlyNote } from '../types';
import { remoteConfigForSlug } from '../remote-config';

type Params = {
  slug: string;
  repoAccess: RepoAccessState;
  activeId: string | null;
  setActiveId: React.Dispatch<React.SetStateAction<string | null>>;
};

export function useReadOnlyService({ slug, repoAccess, activeId, setActiveId }: Params) {
  const branchRef = useRef<string | null>(repoAccess.defaultBranch);
  useEffect(() => {
    branchRef.current = repoAccess.defaultBranch;
  }, [repoAccess.defaultBranch]);

  const notesRequestRef = useRef(0);
  const docRequestRef = useRef(0);

  const loadDoc = useCallback(
    async (noteId: string | null) => {
      docRequestRef.current += 1;
      const requestId = docRequestRef.current;
      if (!noteId) {
        dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc: null } });
        return;
      }

      const branch = branchRef.current;
      if (!branch) {
        dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc: null } });
        return;
      }

      try {
        const cfg = remoteConfigForSlug(slug, branch);
        const remote = await pullNote(cfg, noteId);
        if (docRequestRef.current !== requestId) return;
        if (!remote) {
          dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc: null } });
          return;
        }
        const notes = getRepoDataStore(slug).getState().readOnlyNotes;
        const meta = notes.find((note) => note.id === noteId);
        const title = meta?.title ?? deriveTitle(remote.path);
        const dir = meta?.dir ?? deriveDir(remote.path);
        const doc: NoteDoc = {
          id: noteId,
          path: remote.path,
          title,
          dir,
          text: remote.text,
          updatedAt: Date.now(),
          lastRemoteSha: remote.sha,
          lastSyncedHash: hashText(remote.text),
        };
        dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc } });
      } catch (error) {
        if (docRequestRef.current !== requestId) return;
        logError(error);
      }
    },
    [slug]
  );

  const loadNotes = useCallback(
    async (branch: string | null) => {
      notesRequestRef.current += 1;
      const requestId = notesRequestRef.current;
      const store = getRepoDataStore(slug);
      const current = store.getState().readOnlyNotes;
      dispatchRepoEvent(slug, {
        type: 'notes/readOnlyChanged',
        payload: { notes: current, loading: true },
      });

      if (!branch) {
        branchRef.current = null;
        dispatchRepoEvent(slug, {
          type: 'notes/readOnlyChanged',
          payload: { notes: [], loading: false },
        });
        dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc: null } });
        setActiveId(null);
        return;
      }

      try {
        const cfg = remoteConfigForSlug(slug, branch);
        const entries = await listNoteFiles(cfg);
        if (notesRequestRef.current !== requestId) return;

        const mapped: ReadOnlyNote[] = entries.map((entry) => ({
          id: entry.path,
          path: entry.path,
          title: deriveTitle(entry.path),
          dir: deriveDir(entry.path),
          sha: entry.sha,
        }));

        branchRef.current = branch;

        const nextId = selectNextId(activeId, mapped);
        setActiveId(nextId);

        dispatchRepoEvent(slug, {
          type: 'notes/readOnlyChanged',
          payload: { notes: mapped, loading: false },
        });

        if (!nextId) {
          dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc: null } });
          return;
        }

        await loadDoc(nextId);
      } catch (error) {
        if (notesRequestRef.current !== requestId) return;
        logError(error);
        dispatchRepoEvent(slug, {
          type: 'notes/readOnlyChanged',
          payload: { notes: [], loading: false },
        });
        dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc: null } });
        setActiveId(null);
      }
    },
    [activeId, loadDoc, setActiveId, slug]
  );

  const handleIntent = useCallback(
    (intent: RepoDataIntent) => {
      switch (intent.type) {
        case 'notes/readOnly/request':
          void loadNotes(intent.payload.branch);
          break;
        case 'notes/readOnly/select':
          void loadDoc(intent.payload.id);
          break;
        case 'notes/readOnly/clear':
        case 'app/signOut':
          notesRequestRef.current += 1;
          docRequestRef.current += 1;
          branchRef.current = null;
          dispatchRepoEvent(slug, {
            type: 'notes/readOnlyChanged',
            payload: { notes: [], loading: false },
          });
          dispatchRepoEvent(slug, { type: 'notes/readOnlyDocLoaded', payload: { doc: null } });
          setActiveId(null);
          break;
      }
    },
    [loadDoc, loadNotes, setActiveId, slug]
  );

  useRepoIntentStream(slug, handleIntent);

  const prevLevelRef = useRef(repoAccess.level);
  const prevBranchRef = useRef(repoAccess.defaultBranch);

  useEffect(() => {
    const prevLevel = prevLevelRef.current;
    const prevBranch = prevBranchRef.current;
    prevLevelRef.current = repoAccess.level;
    prevBranchRef.current = repoAccess.defaultBranch;

    if (repoAccess.level === 'read') {
      if (prevLevel !== 'read' || repoAccess.defaultBranch !== prevBranch) {
        dispatchRepoIntent(slug, {
          type: 'notes/readOnly/request',
          payload: { branch: repoAccess.defaultBranch ?? null },
        });
      }
      return;
    }

    if (prevLevel === 'read') {
      dispatchRepoIntent(slug, { type: 'notes/readOnly/clear' });
    }
  }, [repoAccess.defaultBranch, repoAccess.level, slug]);
}

function deriveTitle(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1);
  return base.replace(/\.md$/i, '');
}

function deriveDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx >= 0 ? path.slice(0, idx) : '';
}

function selectNextId(currentId: string | null, notes: ReadOnlyNote[]): string | null {
  if (currentId && notes.some((note) => note.id === currentId)) return currentId;
  return notes[0]?.id ?? null;
}
