import React, { useMemo, useState, useEffect } from 'react';
import { NoteList } from './NoteList';
import { Editor } from './Editor';
import { LocalStore, type NoteMeta, type NoteDoc } from '../storage/local';
import { getStoredToken, requestDeviceCode, fetchCurrentUser, clearToken } from '../auth/github';
import { configureRemote, getRemoteConfig, pullNote, commitBatch, ensureRepoExists, repoExists, clearRemoteConfig, listNoteFiles, deleteFiles } from '../sync/git-sync';
import { RepoConfigModal } from './RepoConfigModal';
import { DeviceCodeModal } from './DeviceCodeModal';

export function App() {
  const store = useMemo(() => new LocalStore(), []);
  const [notes, setNotes] = useState<NoteMeta[]>(store.listNotes());
  const [activeId, setActiveId] = useState<string | null>(notes[0]?.id ?? null);
  const [doc, setDoc] = useState<NoteDoc | null>(activeId ? store.loadNote(activeId) : null);
  const [token, setToken] = useState<string | null>(getStoredToken());
  const [showConfig, setShowConfig] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [device, setDevice] = useState<import('../auth/github').DeviceCodeResponse | null>(null);
  const [ownerLogin, setOwnerLogin] = useState<string | null>(null);
  const [remoteCfg, setRemoteCfg] = useState(getRemoteConfig());
  const [user, setUser] = useState<{ login: string; name?: string; avatar_url?: string } | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; href?: string } | null>(null);
  const [repoModalMode, setRepoModalMode] = useState<'onboard' | 'manage'>('manage');

  useEffect(() => {
    setNotes(store.listNotes());
  }, [store]);

  useEffect(() => {
    setDoc(activeId ? store.loadNote(activeId) : null);
  }, [store, activeId]);

  const onCreate = () => {
    const id = store.createNote();
    setNotes(store.listNotes());
    setActiveId(id);
  };

  const onRename = (id: string, title: string) => {
    try {
      store.renameNote(id, title);
      setNotes(store.listNotes());
    } catch (e) {
      console.error(e);
      setSyncMsg('Invalid title. Avoid / and control characters.');
    }
  };

  const onDelete = (id: string) => {
    store.deleteNote(id);
    const list = store.listNotes();
    setNotes(list);
    if (activeId === id) setActiveId(list[0]?.id ?? null);
  };

  const onConnect = async () => {
    try {
      const d = await requestDeviceCode();
      setDevice(d);
    } catch (e) {
      console.error(e);
      setSyncMsg('Failed to start GitHub authorization');
    }
  };

  const onConfigSubmit = async (cfg: { owner: string; repo: string; branch: string }) => {
    try {
      setSyncMsg(null);
      setSyncing(true);
      const existed = await repoExists(cfg.owner, cfg.repo);
      await ensureRepoExists(cfg.owner, cfg.repo, true);
      configureRemote({ ...cfg, notesDir: 'notes' });
      setRemoteCfg(getRemoteConfig());
      // Seed initial notes if newly created
      if (!existed) {
        const files: { path: string; text: string; baseSha?: string }[] = [];
        for (const n of store.listNotes()) {
          const local = store.loadNote(n.id);
          if (!local) continue;
          files.push({ path: local.path, text: local.text });
        }
        if (files.length > 0) {
          await commitBatch(files, 'gitnote: initialize notes');
        }
        setSyncMsg('Repository created and initialized');
        setToast({ text: 'Repository ready', href: `https://github.com/${cfg.owner}/${cfg.repo}` });
      } else {
        // Existing repo: pull notes from remote and replace local state
        const entries = await listNoteFiles();
        const files: { path: string; text: string; sha?: string }[] = [];
        for (const e of entries) {
          const rf = await pullNote(e.path);
          if (rf) files.push({ path: rf.path, text: rf.text, sha: rf.sha });
        }
        // Replace local storage with remote files
        store.replaceWithRemote(files);
        setNotes(store.listNotes());
        setActiveId(store.listNotes()[0]?.id ?? null);
        setSyncMsg('Connected to repository');
      }
    } catch (e) {
      console.error(e);
      setSyncMsg('Failed to configure repository');
    } finally {
      setShowConfig(false);
      setSyncing(false);
    }
  };

  const ensureOwnerAndOpen = async () => {
    if (!token) {
      await onConnect();
      return;
    }
    if (!ownerLogin) {
      const u = await fetchCurrentUser();
      setOwnerLogin(u?.login ?? null);
    }
    setRepoModalMode('manage');
    setShowConfig(true);
  };

  const GitHubIcon = () => (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8a8 8 0 0 0 5.47 7.59c.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.01.08-2.11 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.91.08 2.11.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/>
    </svg>
  );

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(t);
  }, [toast]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target.closest('.account-menu') && !target.closest('.account-btn')) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('click', onDoc);
    return () => document.removeEventListener('click', onDoc);
  }, []);

  // Restore user/account info on reload when a token is present
  useEffect(() => {
    if (!token) return;
    (async () => {
      const u = await fetchCurrentUser();
      setUser(u);
      setOwnerLogin(u?.login ?? null);
    })();
  }, [token]);

  const onSignOut = () => {
    clearToken();
    clearRemoteConfig();
    setToken(null);
    setUser(null);
    setOwnerLogin(null);
    setRemoteCfg(null);
    setMenuOpen(false);
    setSyncMsg('Signed out');
  };

  const onSyncNow = async () => {
    try {
      setSyncMsg(null);
      setSyncing(true);
      const cfg = getRemoteConfig();
      if (!token || !cfg) {
        setSyncMsg('Connect GitHub and configure repo first');
        return;
      }
      // Gather changed files by comparing local text to remote HEAD
      const files: { path: string; text: string; baseSha?: string }[] = [];
      const toDelete: { path: string; sha: string }[] = [];
      const remoteEntries = await listNoteFiles();
      const remoteMap = new Map(remoteEntries.map(e => [e.path, e.sha] as const));
      const localPaths = new Set<string>();
      for (const n of store.listNotes()) {
        const local = store.loadNote(n.id);
        if (!local) continue;
        localPaths.add(local.path);
        const remote = await pullNote(local.path);
        if (!remote || remote.text !== local.text) {
          files.push({ path: local.path, text: local.text, baseSha: remote?.sha });
        }
      }
      // Anything on remote not present locally should be deleted
      for (const e of remoteEntries) {
        if (!localPaths.has(e.path)) {
          toDelete.push({ path: e.path, sha: e.sha });
        }
      }
      if (files.length === 0 && toDelete.length === 0) {
        setSyncMsg('Up to date');
        return;
      }
      const commitSha1 = files.length ? await commitBatch(files, 'gitnote: update notes') : null;
      const commitSha2 = toDelete.length ? await deleteFiles(toDelete, 'gitnote: delete removed notes') : null;
      setSyncMsg(commitSha1 || commitSha2 ? 'Synced ✔' : 'Nothing to commit');
    } catch (err) {
      console.error(err);
      setSyncMsg('Sync failed');
    } finally {
      setSyncing(false);
      // Refresh list timestamps from storage
      setNotes(store.listNotes());
    }
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="toolbar">
          <button className="btn primary" onClick={onCreate}>New</button>
        </div>
        <NoteList
          notes={notes}
          activeId={activeId}
          onSelect={setActiveId}
          onRename={onRename}
          onDelete={onDelete}
        />
      </aside>
      <section className="content">
        <div className="header">
          <strong>GitNote</strong>
          <span style={{ color: 'var(--muted)' }}>— Offline‑first Markdown + Git</span>
          <span style={{ marginLeft: 'auto', display:'flex', gap:8, alignItems:'center' }}>
            {/* 1) Sync Now */}
            <button className="btn" onClick={onSyncNow} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync Now'}</button>
            {/* 2) Repo status */}
            {remoteCfg ? (
              <button className="btn" title="Change repository" onClick={ensureOwnerAndOpen} style={{ display:'flex', gap:6, alignItems:'center' }}>
                <GitHubIcon />
                <span>{remoteCfg.owner}/{remoteCfg.repo}</span>
              </button>
            ) : (
              <button className="btn primary" onClick={ensureOwnerAndOpen}>
                Connect repository
              </button>
            )}
            {/* 3) Account / Connect GitHub */}
            {token && user ? (
              <button className="btn account-btn" onClick={() => setMenuOpen((v) => !v)} style={{ display:'flex', gap:8, alignItems:'center' }}>
                {user.avatar_url && (
                  <img src={user.avatar_url} alt={user.login} style={{ width:20, height:20, borderRadius:'50%' }} />
                )}
                <span>{user.login}</span>
              </button>
            ) : (
              <button className="btn" onClick={onConnect}>Connect GitHub</button>
            )}
          </span>
        </div>
        <div className="editor">
          {doc ? (
            <Editor doc={doc} onChange={(text) => store.saveNote(doc.id, text)} />
          ) : (
            <div style={{ padding: 16, color: 'var(--muted)' }}>
              <div style={{ marginBottom: 8 }}>Select or create a note.</div>
              <div style={{ marginBottom: 8 }}>To sync with GitHub, click "Connect GitHub", then "Repo" to set your repository, and use "Sync Now".</div>
              {syncMsg && <div style={{ marginTop: 8, color: 'var(--accent)' }}>{syncMsg}</div>}
            </div>
          )}
        </div>
        {syncMsg && (
          <div className="header" style={{ borderTop:'1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted)' }}>Status:</span>
            <span>{syncMsg}</span>
          </div>
        )}
        {menuOpen && user && (
          <div className="account-menu" style={{ position:'absolute', top:50, right:12, background:'var(--panel)', border:'1px solid var(--border)', borderRadius:8, padding:8, zIndex:10 }}>
            <div style={{ padding:'6px 8px', color:'var(--muted)' }}>{user.name || user.login}</div>
            <button className="btn" onClick={onSignOut}>Sign out</button>
          </div>
        )}
        {toast && (
          <div className="toast" style={{ position:'fixed', bottom:16, right:16, background:'var(--panel)', border:'1px solid var(--border)', borderRadius:8, padding:'10px 12px', display:'flex', gap:8, alignItems:'center' }}>
            <span>{toast.text}</span>
            {toast.href && (
              <a className="btn" href={toast.href} target="_blank" rel="noreferrer">Open</a>
            )}
          </div>
        )}
      </section>
      {showConfig && ownerLogin && (
        <RepoConfigModal
          defaultOwner={ownerLogin}
          defaultRepo={remoteCfg?.repo}
          mode={repoModalMode}
          onSubmit={onConfigSubmit}
          onCancel={() => setShowConfig(false)}
        />
      )}
      {device && (
        <DeviceCodeModal
          device={device}
          onDone={(t) => {
            if (t) {
              localStorage.setItem('gitnote:gh-token', t);
              setToken(t);
              fetchCurrentUser().then((u) => {
                setOwnerLogin(u?.login ?? null);
                setUser(u);
                setRepoModalMode('onboard');
                setShowConfig(true);
              });
            }
            setDevice(null);
          }}
          onCancel={() => setDevice(null)}
        />
      )}
    </div>
  );
}
