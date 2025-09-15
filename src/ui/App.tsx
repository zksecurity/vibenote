import React, { useMemo, useState, useEffect } from 'react';
import { NoteList } from './NoteList';
import { Editor } from './Editor';
import { LocalStore, type NoteMeta, type NoteDoc } from '../storage/local';
import { getStoredToken, requestDeviceCode } from '../auth/github';
import { configureRemote, getRemoteConfig, pullNote, commitBatch } from '../sync/git-sync';
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
    store.renameNote(id, title);
    setNotes(store.listNotes());
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

  const onConfigSubmit = (cfg: { owner: string; repo: string; branch: string }) => {
    configureRemote({ ...cfg, notesDir: 'notes' });
    setShowConfig(false);
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
      for (const n of store.listNotes()) {
        const local = store.loadNote(n.id);
        if (!local) continue;
        const remote = await pullNote(local.path);
        if (!remote || remote.text !== local.text) {
          files.push({ path: local.path, text: local.text, baseSha: remote?.sha });
        }
      }
      if (files.length === 0) {
        setSyncMsg('Up to date');
        return;
      }
      const commitSha = await commitBatch(files, 'gitnote: update notes');
      setSyncMsg(commitSha ? 'Synced ✔' : 'Nothing to commit');
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
            {token ? (
              <span style={{ color: 'var(--muted)' }}>GitHub connected</span>
            ) : (
              <button className="btn" onClick={onConnect}>Connect GitHub</button>
            )}
            <button className="btn" onClick={() => setShowConfig(true)}>Repo</button>
            <button className="btn primary" onClick={onSyncNow} disabled={syncing}>{syncing ? 'Syncing…' : 'Sync Now'}</button>
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
      </section>
      {showConfig && (
        <RepoConfigModal
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
              setShowConfig(true);
            }
            setDevice(null);
          }}
          onCancel={() => setDevice(null)}
        />
      )}
    </div>
  );
}
