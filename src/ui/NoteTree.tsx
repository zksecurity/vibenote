import React, { useMemo, useState, useRef, useEffect } from 'react';
import type { NoteMeta } from '../storage/local';

type FolderNode = { kind: 'folder'; dir: string; name: string; children: (FolderNode | NoteNode)[] };
type NoteNode = { kind: 'note'; id: string; title: string; dir: string; path: string };

type Props = {
  notes: NoteMeta[];
  folders: string[];
  activeId: string | null;
  onSelectNote: (id: string) => void;
  onRenameNote: (id: string, title: string) => void;
  onDeleteNote: (id: string) => void;
  onRenameFolder: (dir: string, newName: string) => void;
  onMoveFolder: (fromDir: string, toDir: string) => void;
  onDeleteFolder: (dir: string) => void;
  onCreateNoteIn: (dir: string) => void;
  onCreateFolder: (dir: string) => void; // dir is parent
  onSelectionChange?: (sel: { kind: 'folder'; dir: string } | { kind: 'note'; id: string } | null) => void;
};

export function NoteTree(props: Props) {
  let tree = useMemo(() => buildTree(props.notes, props.folders), [props.notes, props.folders]);
  let [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  let [selected, setSelected] = useState<{ kind: 'folder'; dir: string } | { kind: 'note'; id: string } | null>(null);
  let [editing, setEditing] = useState<{ kind: 'folder'; dir: string } | { kind: 'note'; id: string } | null>(null);
  let [editText, setEditText] = useState('');
  let containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // keep selection in sync with active note
    if (!props.activeId) return;
    setSelected({ kind: 'note', id: props.activeId });
  }, [props.activeId]);

  let onKeyDown = (e: React.KeyboardEvent) => {
    if (!selected) return;
    if (e.key === 'F2') {
      e.preventDefault();
      if (selected.kind === 'note') {
        let n = findNote(props.notes, selected.id);
        if (!n) return;
        setEditing({ kind: 'note', id: selected.id });
        setEditText(n.title);
      } else {
        let name = selected.dir.slice(selected.dir.lastIndexOf('/') + 1);
        setEditing({ kind: 'folder', dir: selected.dir });
        setEditText(name);
      }
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (selected.kind === 'note') props.onDeleteNote(selected.id);
      else props.onDeleteFolder(selected.dir);
    } else if (e.key === 'Enter') {
      if (selected.kind === 'note') {
        props.onSelectNote(selected.id);
      } else {
        toggleCollapse(selected.dir);
      }
    } else if (e.key === 'ArrowLeft') {
      if (selected.kind === 'folder') collapse(selected.dir);
    } else if (e.key === 'ArrowRight') {
      if (selected.kind === 'folder') expand(selected.dir);
    }
  };

  useEffect(() => {
    if (props.onSelectionChange) props.onSelectionChange(selected);
  }, [selected]);

  let collapse = (dir: string) => setCollapsed((m) => ({ ...m, [dir]: true }));
  let expand = (dir: string) => setCollapsed((m) => ({ ...m, [dir]: false }));
  let toggleCollapse = (dir: string) => setCollapsed((m) => ({ ...m, [dir]: !m[dir] }));

  let submitEdit = () => {
    if (!editing) return;
    let text = editText.trim();
    if (text === '') {
      setEditing(null);
      return;
    }
    if (editing.kind === 'note') props.onRenameNote(editing.id, text);
    else props.onRenameFolder(editing.dir, text);
    setEditing(null);
    setEditText('');
  };

  return (
    <div className="note-tree" tabIndex={0} ref={containerRef} onKeyDown={onKeyDown}>
      {tree.children.map((node) => (
        <TreeRow
          key={(node.kind === 'folder' ? 'd:' + node.dir : 'n:' + node.id)}
          node={node}
          depth={0}
          collapsed={collapsed}
          activeId={props.activeId}
          editing={editing}
          editText={editText}
          onSelectFolder={(dir) => setSelected({ kind: 'folder', dir })}
          onSelectNote={(id) => { setSelected({ kind: 'note', id }); props.onSelectNote(id); }}
          onToggleFolder={toggleCollapse}
          onStartEdit={(target) => {
            if (target.kind === 'note') {
              let n = findNote(props.notes, target.id);
              if (!n) return;
              setEditing(target);
              setEditText(n.title);
            } else {
              let name = target.dir.slice(target.dir.lastIndexOf('/') + 1);
              setEditing(target);
              setEditText(name);
            }
          }}
          onEditTextChange={setEditText}
          onSubmitEdit={submitEdit}
          onDeleteNote={props.onDeleteNote}
          onDeleteFolder={props.onDeleteFolder}
          onCreateNoteIn={props.onCreateNoteIn}
          onCreateFolder={props.onCreateFolder}
          onMoveFolder={props.onMoveFolder}
        />
      ))}
    </div>
  );
}

function buildTree(notes: NoteMeta[], folders: string[]): FolderNode {
  let root: FolderNode = { kind: 'folder', dir: '', name: '', children: [] };
  let folderMap = new Map<string, FolderNode>();
  folderMap.set('', root);
  let addFolder = (dir: string) => {
    let d = normalizeDir(dir);
    if (folderMap.has(d)) return folderMap.get(d)!;
    let parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    let parentNode = addFolder(parent);
    let node: FolderNode = { kind: 'folder', dir: d, name: d.slice(d.lastIndexOf('/') + 1), children: [] };
    parentNode.children.push(node);
    folderMap.set(d, node);
    return node;
  };
  for (let dir of folders) addFolder(dir);
  for (let n of notes) {
    let dir = normalizeDir(n.dir ?? extractDirFromPath(n.path));
    let parent = addFolder(dir);
    parent.children.push({ kind: 'note', id: n.id, title: n.title, dir, path: n.path });
  }
  // Sort: folders by name asc, then notes by title asc
  let sortTree = (node: FolderNode) => {
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      if (a.kind === 'folder' && b.kind === 'folder') return a.name.localeCompare(b.name);
      if (a.kind === 'note' && b.kind === 'note') return a.title.localeCompare(b.title);
      return 0;
    });
    for (let c of node.children) if (c.kind === 'folder') sortTree(c);
  };
  sortTree(root);
  return root;
}

function TreeRow(props: {
  node: FolderNode | NoteNode;
  depth: number;
  collapsed: Record<string, boolean>;
  activeId: string | null;
  editing: { kind: 'folder'; dir: string } | { kind: 'note'; id: string } | null;
  editText: string;
  onSelectFolder: (dir: string) => void;
  onSelectNote: (id: string) => void;
  onToggleFolder: (dir: string) => void;
  onStartEdit: (t: { kind: 'folder'; dir: string } | { kind: 'note'; id: string }) => void;
  onEditTextChange: (t: string) => void;
  onSubmitEdit: () => void;
  onDeleteNote: (id: string) => void;
  onDeleteFolder: (dir: string) => void;
  onCreateNoteIn: (dir: string) => void;
  onCreateFolder: (dir: string) => void;
  onMoveFolder: (from: string, to: string) => void;
}) {
  let { node, depth, collapsed } = props;
  if (node.kind === 'folder') {
    let isEditing = props.editing?.kind === 'folder' && props.editing.dir === node.dir;
    let isCollapsed = collapsed[node.dir] === true;
    return (
      <div className="tree-folder">
        <div
          className={`tree-row folder`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => props.onSelectFolder(node.dir)}
        >
          <button className="tree-disclosure" onClick={(e) => { e.stopPropagation(); props.onToggleFolder(node.dir); }} aria-label="Toggle">
            {isCollapsed ? '▸' : '▾'}
          </button>
          {isEditing ? (
            <form onSubmit={(e) => { e.preventDefault(); props.onSubmitEdit(); }} onClick={(e) => e.stopPropagation()} className="tree-edit-form">
              <input className="input" value={props.editText} onChange={(e) => props.onEditTextChange(e.target.value)} autoFocus />
            </form>
          ) : (
            <span className="tree-title">{node.name || 'Root'}</span>
          )}
          <div className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button className="btn subtle small" onClick={() => props.onStartEdit({ kind: 'folder', dir: node.dir })}>Rename</button>
            <button className="btn subtle small" onClick={() => {
              let to = window.prompt('Move folder to (parent path, empty for root)', '') ?? undefined;
              if (to !== undefined) props.onMoveFolder(node.dir, to);
            }}>Move</button>
            <button className="btn subtle small" onClick={() => props.onCreateFolder(node.dir)}>New folder</button>
            <button className="btn subtle small" onClick={() => props.onCreateNoteIn(node.dir)}>New note</button>
            {node.dir !== '' && (
              <button className="btn subtle small danger" onClick={() => props.onDeleteFolder(node.dir)}>Delete</button>
            )}
          </div>
        </div>
        {!isCollapsed && node.children.map((c) => (
          <TreeRow key={(c.kind === 'folder' ? 'd:' + c.dir : 'n:' + c.id)}
            node={c}
            depth={depth + 1}
            collapsed={collapsed}
            activeId={props.activeId}
            editing={props.editing}
            editText={props.editText}
            onSelectFolder={props.onSelectFolder}
            onSelectNote={props.onSelectNote}
            onToggleFolder={props.onToggleFolder}
            onStartEdit={props.onStartEdit}
            onEditTextChange={props.onEditTextChange}
            onSubmitEdit={props.onSubmitEdit}
            onDeleteNote={props.onDeleteNote}
            onDeleteFolder={props.onDeleteFolder}
            onCreateNoteIn={props.onCreateNoteIn}
            onCreateFolder={props.onCreateFolder}
            onMoveFolder={props.onMoveFolder}
          />
        ))}
      </div>
    );
  }
  let isActive = props.activeId === node.id;
  let isEditing = props.editing?.kind === 'note' && props.editing.id === node.id;
  return (
    <div
      className={`tree-row note ${isActive ? 'active' : ''}`}
      style={{ paddingLeft: 24 + depth * 12 }}
      onClick={() => props.onSelectNote(node.id)}
    >
      {isEditing ? (
        <form onSubmit={(e) => { e.preventDefault(); props.onSubmitEdit(); }} onClick={(e) => e.stopPropagation()} className="tree-edit-form">
          <input className="input" value={props.editText} onChange={(e) => props.onEditTextChange(e.target.value)} autoFocus />
        </form>
      ) : (
        <span className="tree-title">{node.title || 'Untitled'}</span>
      )}
      <div className="tree-actions" onClick={(e) => e.stopPropagation()}>
        <button className="btn subtle small" onClick={() => props.onStartEdit({ kind: 'note', id: node.id })}>Rename</button>
        <button className="btn subtle small danger" onClick={() => props.onDeleteNote(node.id)}>Delete</button>
      </div>
    </div>
  );
}

function normalizeDir(dir: string): string {
  let d = (dir || '').trim();
  d = d.replace(/(^\/+|\/+?$)/g, '');
  if (d === '.' || d === '..') d = '';
  return d;
}

function extractDirFromPath(path: string): string {
  let i = path.lastIndexOf('/');
  return normalizeDir(i >= 0 ? path.slice(0, i) : '');
}

function findNote(notes: NoteMeta[], id: string) {
  for (let n of notes) if (n.id === id) return n;
  return null;
}
