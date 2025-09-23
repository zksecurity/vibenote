import React, { useEffect, useMemo, useRef, useState } from 'react';

export type FileEntry = {
  id: string;
  name: string; // filename without directory
  path: string; // dir + name
  dir: string; // '' for root
};

type Selection = { kind: 'folder'; dir: string } | { kind: 'file'; id: string } | null;

type NewEntry = { kind: 'file' | 'folder'; parentDir: string; key: number } | null;

type FileTreeProps = {
  files: FileEntry[];
  folders: string[];
  activeId: string | null;
  collapsed?: Record<string, boolean>;
  onCollapsedChange?: (next: Record<string, boolean>) => void;
  onSelectionChange?: (sel: Selection) => void;
  onSelectFile: (id: string) => void;
  onRenameFile: (id: string, newName: string) => void;
  onDeleteFile: (id: string) => void;
  onCreateFile: (dir: string, name: string) => string | void;
  onCreateFolder: (parentDir: string, name: string) => void;
  onRenameFolder: (dir: string, newName: string) => void;
  onDeleteFolder: (dir: string) => void;
  newEntry?: NewEntry; // request inline create under parent dir
  onFinishCreate?: () => void;
};

type FolderNode = { kind: 'folder'; dir: string; name: string; children: (FolderNode | FileNode)[] };
type FileNode = { kind: 'file'; id: string; name: string; dir: string; path: string };

export function FileTree(props: FileTreeProps) {
  let tree = useMemo(() => buildTree(props.files, props.folders), [props.files, props.folders]);
  let [collapsed, setCollapsed] = useState<Record<string, boolean>>(props.collapsed ?? {});
  let [selected, setSelected] = useState<Selection>(null);
  let [editing, setEditing] = useState<Selection>(null);
  let [editText, setEditText] = useState('');
  let containerRef = useRef<HTMLDivElement | null>(null);

  // Sync selection to active file
  useEffect(() => {
    if (props.activeId) setSelected({ kind: 'file', id: props.activeId });
  }, [props.activeId]);

  // Inline create handling
  let [createKey, setCreateKey] = useState<number | null>(null);
  useEffect(() => {
    if (!props.newEntry) return;
    setCreateKey(props.newEntry.key);
    setEditing({ kind: props.newEntry.kind === 'file' ? 'file' : 'folder', id: '' } as any);
    setEditText('');
    // Expand parent folder
    if (props.newEntry.parentDir) setCollapsed((m) => ({ ...m, [props.newEntry!.parentDir]: false }));
  }, [props.newEntry?.key]);

  // Keyboard bindings
  const onKeyDown = (e: React.KeyboardEvent) => {
    // When inline-editing, let inputs handle keys (Backspace, Enter, etc.)
    if (editing) return;
    if (!selected) return;
    if (e.key === 'F2') {
      e.preventDefault();
      if (selected.kind === 'file') {
        const f = props.files.find((x) => x.id === selected.id);
        if (!f) return;
        setEditing(selected);
        setEditText(f.name);
      } else {
        const name = selected.dir.slice(selected.dir.lastIndexOf('/') + 1);
        setEditing(selected);
        setEditText(name || '');
      }
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (selected.kind === 'file') props.onDeleteFile(selected.id);
      else if (selected.dir !== '') props.onDeleteFolder(selected.dir);
    } else if (e.key === 'Enter') {
      if (selected.kind === 'file') props.onSelectFile(selected.id);
      else toggleCollapse(selected.dir);
    } else if (e.key === 'ArrowLeft') {
      if (selected.kind === 'folder') collapse(selected.dir);
    } else if (e.key === 'ArrowRight') {
      if (selected.kind === 'folder') expand(selected.dir);
    }
  };

  useEffect(() => {
    props.onSelectionChange?.(selected);
  }, [selected]);

  useEffect(() => {
    props.onCollapsedChange?.(collapsed);
  }, [collapsed]);

  const collapse = (dir: string) => setCollapsed((m) => ({ ...m, [dir]: true }));
  const expand = (dir: string) => setCollapsed((m) => ({ ...m, [dir]: false }));
  const toggleCollapse = (dir: string) => setCollapsed((m) => ({ ...m, [dir]: !m[dir] }));

  const submitEdit = (context: { kind: 'file'; id?: string; dir?: string } | { kind: 'folder'; dir?: string }) => {
    const name = editText.trim();
    if (name === '') {
      setEditing(null);
      props.onFinishCreate?.();
      return;
    }
    if (createKey !== null && props.newEntry) {
      // Creation flow
      if (props.newEntry.kind === 'file') props.onCreateFile(props.newEntry.parentDir, name);
      else props.onCreateFolder(props.newEntry.parentDir, name);
      setCreateKey(null);
      props.onFinishCreate?.();
      setEditing(null);
      setEditText('');
      return;
    }
    if (context.kind === 'file' && context.id) props.onRenameFile(context.id, name);
    else if (context.kind === 'folder' && context.dir) props.onRenameFolder(context.dir, name);
    setEditing(null);
    setEditText('');
  };

  return (
    <div className="file-tree" tabIndex={0} ref={containerRef} onKeyDown={onKeyDown}>
      {tree.children.map((n) => (
        <Row
          key={n.kind === 'folder' ? 'd:' + n.dir : 'f:' + n.id}
          node={n}
          depth={0}
          collapsed={collapsed}
          activeId={props.activeId}
          selected={selected}
          editing={editing}
          editText={editText}
          onSelectFolder={(dir) => setSelected({ kind: 'folder', dir })}
          onSelectFile={(id) => { setSelected({ kind: 'file', id }); props.onSelectFile(id); }}
          onToggleFolder={toggleCollapse}
          onStartEdit={(sel, text) => { setEditing(sel); setEditText(text); }}
          onEditTextChange={setEditText}
          onSubmitEdit={submitEdit}
        />
      ))}
      {props.newEntry && (
        <div className="tree-row is-new" style={{ paddingLeft: 24 + (props.newEntry.parentDir ? props.newEntry.parentDir.split('/').length : 0) * 12 }}>
          <Icon kind={props.newEntry.kind} open={true} />
          <form onSubmit={(e) => { e.preventDefault(); submitEdit({ kind: props.newEntry!.kind === 'file' ? 'file' : 'folder' }); }} className="tree-edit-form">
            <input className="tree-input" value={editText} onChange={(e) => setEditText(e.target.value)} autoFocus placeholder={props.newEntry.kind === 'file' ? 'New file' : 'New folder'} />
          </form>
        </div>
      )}
    </div>
  );
}

function Row(props: {
  node: FolderNode | FileNode;
  depth: number;
  collapsed: Record<string, boolean>;
  activeId: string | null;
  selected: Selection;
  editing: Selection;
  editText: string;
  onSelectFolder: (dir: string) => void;
  onSelectFile: (id: string) => void;
  onToggleFolder: (dir: string) => void;
  onStartEdit: (sel: Selection, text: string) => void;
  onEditTextChange: (t: string) => void;
  onSubmitEdit: (ctx: { kind: 'file'; id?: string; dir?: string } | { kind: 'folder'; dir?: string }) => void;
}) {
  const { node, depth } = props;
  if (node.kind === 'folder') {
    const isCollapsed = props.collapsed[node.dir] === true;
    const isActive = props.selected?.kind === 'folder' && props.selected.dir === node.dir;
    const isEditing = props.editing?.kind === 'folder' && props.editing.dir === node.dir;
    return (
      <div className="tree-folder">
        <div
          className={`tree-row ${isActive ? 'is-active' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
          onClick={() => props.onSelectFolder(node.dir)}
        >
          <button className="tree-disclosure" onClick={(e) => { e.stopPropagation(); props.onToggleFolder(node.dir); }} aria-label="Toggle folder">
            {isCollapsed ? '▸' : '▾'}
          </button>
          <Icon kind="folder" open={!isCollapsed} />
          {isEditing ? (
            <form className="tree-edit-form" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); props.onSubmitEdit({ kind: 'folder', dir: node.dir }); }}>
              <input className="tree-input" value={props.editText} onChange={(e) => props.onEditTextChange(e.target.value)} autoFocus />
            </form>
          ) : (
            <span className="tree-title">{node.name || 'Root'}</span>
          )}
        </div>
        {!isCollapsed && node.children.map((c) => (
          <Row
            key={c.kind === 'folder' ? 'd:' + c.dir : 'f:' + c.id}
            node={c}
            depth={depth + 1}
            collapsed={props.collapsed}
            activeId={props.activeId}
            selected={props.selected}
            editing={props.editing}
            editText={props.editText}
            onSelectFolder={props.onSelectFolder}
            onSelectFile={props.onSelectFile}
            onToggleFolder={props.onToggleFolder}
            onStartEdit={props.onStartEdit}
            onEditTextChange={props.onEditTextChange}
            onSubmitEdit={props.onSubmitEdit}
          />
        ))}
      </div>
    );
  }
  const isActive = props.activeId === node.id;
  const isSelected = props.selected?.kind === 'file' && props.selected.id === node.id;
  const isEditing = props.editing?.kind === 'file' && props.editing.id === node.id;
  return (
    <div
      className={`tree-row ${isActive || isSelected ? 'is-active' : ''}`}
      style={{ paddingLeft: 24 + depth * 12 }}
      onClick={() => props.onSelectFile(node.id)}
      onDoubleClick={() => props.onSelectFile(node.id)}
    >
      <Icon kind="file" />
      {isEditing ? (
        <form className="tree-edit-form" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); props.onSubmitEdit({ kind: 'file', id: node.id }); }}>
          <input className="tree-input" value={props.editText} onChange={(e) => props.onEditTextChange(e.target.value)} autoFocus />
        </form>
      ) : (
        <span className="tree-title">{node.name}</span>
      )}
    </div>
  );
}

function Icon({ kind, open }: { kind: 'file' | 'folder' | 'folder-open' | 'file-leaf' | 'file-md' | 'folder-closed' | 'folder' ; open?: boolean }) {
  const isFolder = kind === 'folder';
  return (
    <span className={`tree-icon ${isFolder ? (open ? 'folder-open' : 'folder') : 'file'}`} aria-hidden />
  );
}

function buildTree(files: FileEntry[], folders: string[]): FolderNode {
  let root: FolderNode = { kind: 'folder', dir: '', name: '', children: [] };
  let folderMap = new Map<string, FolderNode>();
  folderMap.set('', root);
  const addFolder = (dir: string) => {
    let d = normalizeDir(dir);
    if (folderMap.has(d)) return folderMap.get(d)!;
    let parent = d.includes('/') ? d.slice(0, d.lastIndexOf('/')) : '';
    let parentNode = addFolder(parent);
    let node: FolderNode = { kind: 'folder', dir: d, name: d.slice(d.lastIndexOf('/') + 1), children: [] };
    parentNode.children.push(node);
    folderMap.set(d, node);
    return node;
  };
  for (let d of folders) addFolder(d);
  for (let f of files) {
    const parent = addFolder(f.dir);
    parent.children.push({ kind: 'file', id: f.id, name: f.name, dir: f.dir, path: f.path });
  }
  // Sort like GitHub: folders A→Z, then files A→Z
  const sortNode = (n: FolderNode) => {
    n.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
      const an = a.kind === 'folder' ? a.name : a.name;
      const bn = b.kind === 'folder' ? b.name : b.name;
      return an.localeCompare(bn);
    });
    for (let c of n.children) if (c.kind === 'folder') sortNode(c);
  };
  sortNode(root);
  return root;
}

function normalizeDir(dir: string): string {
  let d = (dir || '').trim();
  d = d.replace(/(^\/+|\/+?$)/g, '');
  if (d === '.' || d === '..') d = '';
  return d;
}
