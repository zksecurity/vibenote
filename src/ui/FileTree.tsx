// File tree sidebar for browsing, editing, and managing repo notes.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { File as FileIcon, Folder as FolderIcon, FolderOpen as FolderOpenIcon } from 'lucide-react';

const treeIconSize = 16;
const treeIconStrokeWidth = 1.8;

export type FileEntry = {
  name: string; // filename including extension
  path: string; // dir + name
  dir: string; // '' for root
  title: string; // extension-trimmed title for editing
};

type Selection = { kind: 'folder' | 'file'; path: string } | null;

type NewEntry = { kind: 'file' | 'folder'; parentDir: string; key: number } | null;

type FileTreeProps = {
  files: FileEntry[];
  folders: string[];
  activePath: string | undefined;
  collapsed: Record<string, boolean>;
  onCollapsedChange: (next: Record<string, boolean>) => void;
  onSelectionChange?: (sel: Selection) => void;
  onSelectFile: (path: string) => void;
  onRenameFile: (path: string, newName: string) => void;
  onMoveFile: (path: string, targetDir: string) => string | undefined;
  onDeleteFile: (path: string) => void;
  onCreateFile: (dir: string, name: string) => void;
  onCreateFolder: (parentDir: string, name: string) => void;
  onRenameFolder: (dir: string, newName: string) => void;
  onMoveFolder: (dir: string, targetDir: string) => string | undefined;
  onDeleteFolder: (path: string) => void;
  newEntry?: NewEntry; // request inline create under parent dir
  onFinishCreate?: () => void;
};

type FolderNode = {
  kind: 'folder';
  dir: string;
  name: string;
  children: (FolderNode | FileNode)[];
};
type FileNode = { kind: 'file'; name: string; dir: string; path: string; title: string };

export function FileTree(props: FileTreeProps) {
  // Rebuild the nested node structure whenever the note list changes.
  let tree = useMemo(() => buildTree(props.files, props.folders), [props.files, props.folders]);
  // Currently highlighted item in the tree, used for keyboard navigation.
  let [selected, setSelected] = useState<Selection>(null);
  // Node being renamed inline.
  let [editing, setEditing] = useState<Selection>(null);
  // Text buffer shown while editing.
  let [editText, setEditText] = useState('');
  // Root element ref to focus the tree container.
  let containerRef = useRef<HTMLDivElement | null>(null);
  // Tracks which row shows the inline action menu.
  let [menuSel, setMenuSel] = useState<Selection>(null);
  // Remembers the item marked for moving with cut/paste (in-memory fallback when clipboard API fails).
  let [clipboardFallback, setClipboard] = useState<Selection>(null);

  // Keep the latest collapsed map available to effects without resubscribing.
  let collapsedMapRef = useRef(props.collapsed);
  // Remember folders the user explicitly collapsed so auto-expand respects that choice.
  let manualCollapsedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // Keep a fresh copy of the collapsed map for background effects.
    collapsedMapRef.current = props.collapsed;
  }, [props.collapsed]);
  useEffect(() => {
    // Drop manual tracking for entries that are no longer collapsed or no longer present.
    const manual = manualCollapsedRef.current;
    for (let dir of Array.from(manual)) {
      if (dir === '') continue;
      if (props.collapsed[dir] !== true) manual.delete(dir);
    }
  }, [props.collapsed]);

  // Leaving edit mode always resets the clipboard so rename flows stay isolated.
  useEffect(() => {
    if (editing) setClipboard(null);
  }, [editing]);

  type FlatItem = { kind: 'folder' | 'file'; path: string; depth: number };
  // Flatten the tree into the list rendered on screen, respecting collapsed state.
  const visibleItems = useMemo<FlatItem[]>(() => {
    const list: FlatItem[] = [];
    const walk = (node: FolderNode, depth: number) => {
      if (node.dir !== '' || depth === 0) {
        // root folder entry is not clickable label; still include for navigation to root folder
        list.push({ kind: 'folder', path: node.dir, depth });
      }
      const isCollapsed = node.dir !== '' && props.collapsed[node.dir] !== false;
      if (isCollapsed) return;
      for (const c of node.children) {
        if (c.kind === 'folder') walk(c, depth + 1);
        else list.push({ kind: 'file', path: c.path, depth: depth + 1 });
      }
    };
    walk(tree, 0);
    return list;
  }, [tree, props.collapsed]);

  // Sync selection to the active note supplied by the data layer.
  useEffect(() => {
    if (props.activePath !== undefined) setSelected({ kind: 'file', path: props.activePath });
  }, [props.activePath]);

  // Inline create handling
  // Per-request key identifying the current inline creation row.
  let [createKey, setCreateKey] = useState<number | null>(null);

  // Prepare inline creation or rename whenever a new-entry request arrives.
  useEffect(() => {
    if (!props.newEntry) return;
    setCreateKey(props.newEntry.key);
    setEditing(
      props.newEntry.kind === 'file'
        ? { kind: 'file', path: '' }
        : { kind: 'folder', path: props.newEntry.parentDir }
    );
    setEditText('');
    // Expand parent folder
    if (props.newEntry.parentDir) {
      let dir = props.newEntry.parentDir;
      if (dir !== '') {
        let next = ensureDirOpen(props.collapsed, dir);
        if (next) props.onCollapsedChange(next);
      }
    }
  }, [props.newEntry?.key, props.collapsed, props.onCollapsedChange, props.newEntry?.parentDir]);

  // Convenience helpers to resolve file metadata and paste destinations.
  const findFileByPath = (path: string) =>
    props.files.find((file) => normalizePath(file.path) === normalizePath(path));

  const resolvePasteTargetDir = (target: Selection | null) => {
    if (target?.kind === 'folder') return target.path;
    if (target?.kind === 'file') {
      let file = findFileByPath(target.path);
      if (file) return file.dir;
    }
    return '';
  };

  // Guard against moving a folder into one of its own subdirectories.
  const isDescendantDir = (parent: string, target: string) => {
    let normalizedParent = normalizePath(parent);
    let normalizedTarget = normalizePath(target);
    if (normalizedParent === '' || normalizedTarget === '') return false;
    return normalizedTarget.startsWith(`${normalizedParent}/`);
  };

  const writeClipboard = async (payload: Selection | null) => {
    if (!payload) return false;
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== 'function'
    )
      return false;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify({ vibenoteCut: { kind: payload.kind, path: payload.path } })
      );
      return true;
    } catch {
      return false;
    }
  };

  const readClipboard = async () => {
    if (
      typeof navigator === 'undefined' ||
      !navigator.clipboard ||
      typeof navigator.clipboard.readText !== 'function'
    )
      return null;
    try {
      let text = await navigator.clipboard.readText();
      let parsed = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        parsed.vibenoteCut &&
        (parsed.vibenoteCut.kind === 'file' || parsed.vibenoteCut.kind === 'folder') &&
        typeof parsed.vibenoteCut.path === 'string'
      ) {
        return parsed.vibenoteCut as Selection;
      }
    } catch {}
    return null;
  };

  const normalizeSelection = (sel: Selection | null): Selection | null => {
    if (!sel) return null;
    if (sel.kind === 'file') {
      let file = findFileByPath(sel.path);
      if (!file) return null;
      return { kind: 'file', path: file.path };
    }
    let normalized = normalizePath(sel.path);
    if (normalized === '') return null;
    let exists = props.folders.some((dir) => normalizePath(dir) === normalized);
    if (!exists) return null;
    return { kind: 'folder', path: normalized };
  };

  const rememberCutSelection = (sel: Selection | null) => {
    let normalized = normalizeSelection(sel);
    if (!normalized) {
      setClipboard(null);
      return null;
    }
    setClipboard(normalized);
    return normalized;
  };

  const cutSelection = async (sel: Selection | null) => {
    let normalized = rememberCutSelection(sel);
    if (!normalized) return false;
    await writeClipboard(normalized);
    return true;
  };

  const pasteIntoSelection = async (sel: Selection | null) => {
    let clipboard = (await readClipboard()) ?? clipboardFallback;
    if (!clipboard) return false;
    let targetDir = resolvePasteTargetDir(sel ?? selected);
    if (clipboard.kind === 'file') {
      let file = findFileByPath(clipboard.path);
      if (!file) {
        setClipboard(null);
        return true;
      }
      let normalizedTarget = normalizePath(targetDir);
      let normalizedCurrent = normalizePath(file.dir);
      if (normalizedTarget === normalizedCurrent) {
        setClipboard(null);
        setSelected({ kind: 'file', path: file.path });
        return true;
      }
      let nextPath = props.onMoveFile(file.path, normalizedTarget);
      setClipboard(null);
      if (nextPath) setSelected({ kind: 'file', path: nextPath });
      return true;
    }
    let folderPath = normalizePath(clipboard.path);
    if (folderPath === '') {
      setClipboard(null);
      return true;
    }
    let normalizedTarget = normalizePath(targetDir);
    if (isDescendantDir(folderPath, normalizedTarget)) {
      setClipboard(null);
      return true;
    }
    if (normalizedTarget === folderPath) {
      setClipboard(null);
      setSelected({ kind: 'folder', path: folderPath });
      return true;
    }
    let nextDir = props.onMoveFolder(folderPath, normalizedTarget);
    setClipboard(null);
    if (nextDir) setSelected({ kind: 'folder', path: nextDir });
    return true;
  };

  // Keyboard bindings handle navigation plus cut/paste moves using primary shortcuts.
  const onKeyDown = (e: React.KeyboardEvent) => {
    // When inline-editing, let inputs handle keys (Backspace, Enter, etc.)
    if (editing) return;
    if (e.key === 'Escape') {
      if (clipboardFallback) {
        e.preventDefault();
        setClipboard(null);
        return;
      }
    }
    let usesPrimaryModifier = e.metaKey || e.ctrlKey;
    if (usesPrimaryModifier) {
      let key = e.key.toLowerCase();
      if (key === 'x') {
        e.preventDefault();
        cutSelection(selected);
        return;
      }
      if (key === 'v') {
        e.preventDefault();
        pasteIntoSelection(selected);
        return;
      }
    }
    // Arrow navigation operates inside the tree only when focused
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (visibleItems.length === 0) return;
      let index = -1;
      if (selected) {
        index = visibleItems.findIndex(
          (it) =>
            (it.kind === 'folder' &&
              selected.kind === 'folder' &&
              normalizePath(it.path) === normalizePath(selected.path)) ||
            (it.kind === 'file' &&
              selected.kind === 'file' &&
              normalizePath(it.path) === normalizePath(selected.path))
        );
      }
      if (index < 0) index = 0;
      index += e.key === 'ArrowDown' ? 1 : -1;
      if (index < 0) index = 0;
      if (index >= visibleItems.length) index = visibleItems.length - 1;
      const it = visibleItems[index];
      if (!it) return;
      if (it.kind === 'folder') setSelected({ kind: 'folder', path: it.path });
      else setSelected({ kind: 'file', path: it.path });
      return;
    }
    if (!selected) return;
    if (e.key === 'F2') {
      e.preventDefault();
      if (selected.kind === 'file') {
        const f = props.files.find((x) => normalizePath(x.path) === normalizePath(selected.path));
        if (!f) return;
        setEditing({ kind: 'file', path: f.path });
        setEditText(f.title);
      } else {
        const name = selected.path.slice(selected.path.lastIndexOf('/') + 1);
        setEditing(selected);
        setEditText(name);
      }
    } else if (e.key === 'Delete') {
      e.preventDefault();
      if (selected.kind === 'file') props.onDeleteFile(selected.path);
      else if (selected.path !== '') props.onDeleteFolder(selected.path);
    } else if (e.key === 'Enter') {
      if (selected.kind === 'file') props.onSelectFile(selected.path);
      else toggleCollapse(selected.path);
    } else if (e.key === 'ArrowLeft') {
      if (selected.kind === 'folder') {
        e.preventDefault();
        collapse(selected.path);
      }
    } else if (e.key === 'ArrowRight') {
      if (selected.kind === 'folder') {
        e.preventDefault();
        expand(selected.path);
      }
    }
  };

  // Reflect the current selection back to parent components.
  useEffect(() => {
    props.onSelectionChange?.(selected);
  }, [selected]);

  const collapse = (dir: string) => {
    if (dir === '') return;
    let next = setCollapsedValue(props.collapsed, dir, true);
    if (next) manualCollapsedRef.current.add(dir);
    if (next) props.onCollapsedChange(next);
  };
  const expand = (dir: string) => {
    if (dir === '') return;
    manualCollapsedRef.current.delete(dir);
    let next = setCollapsedValue(props.collapsed, dir, false);
    if (next) props.onCollapsedChange(next);
  };
  const toggleCollapse = (dir: string) => {
    if (dir === '') return;
    let current = props.collapsed[dir] !== false;
    let nextValue = !current;
    if (nextValue) manualCollapsedRef.current.add(dir);
    else manualCollapsedRef.current.delete(dir);
    let next = setCollapsedValue(props.collapsed, dir, nextValue);
    if (next) props.onCollapsedChange(next);
  };

  // Auto-expand ancestors of the active file unless the user collapsed them manually.
  useEffect(() => {
    if (props.activePath === undefined) return;
    let file = props.files.find((f) => normalizePath(f.path) === normalizePath(props.activePath));
    if (!file) return;
    let dirs = ancestorsOf(file.dir);
    if (dirs.length === 0) return;
    let next = collapsedMapRef.current;
    let changed = false;
    for (let dir of dirs) {
      if (dir === '') continue;
      if (manualCollapsedRef.current.has(dir)) continue;
      if (next[dir] === true) {
        manualCollapsedRef.current.delete(dir);
        next = { ...next, [dir]: false };
        changed = true;
      }
    }
    if (changed) props.onCollapsedChange(next);
  }, [props.activePath, props.files, props.onCollapsedChange]);

  const submitEdit = (context: { kind: 'file' | 'folder'; path?: string }) => {
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
    if (context.kind === 'file' && context.path) props.onRenameFile(context.path, name);
    else if (context.kind === 'folder' && context.path) props.onRenameFolder(context.path, name);
    setEditing(null);
    setEditText('');
  };

  const cancelEdit = () => {
    // Cancel inline rename or creation without committing
    setEditing(null);
    setEditText('');
    if (createKey !== null) {
      setCreateKey(null);
      props.onFinishCreate?.();
    }
  };

  // Dismiss inline menu when clicking anywhere outside the tree (e.g., closing sidebar)
  useEffect(() => {
    const onGlobalPointerDown = (e: Event) => {
      if (!menuSel) return;
      const el = e.target as HTMLElement | null;
      // Close menu when clicking/tapping anywhere that is not the inline menu itself
      if (!el || !el.closest('.tree-menu')) setMenuSel(null);
    };
    window.addEventListener('pointerdown', onGlobalPointerDown, true);
    return () => window.removeEventListener('pointerdown', onGlobalPointerDown, true);
  }, [menuSel]);

  return (
    <div
      className="file-tree"
      tabIndex={0}
      ref={containerRef}
      onKeyDown={(e) => {
        if (menuSel && e.key === 'Escape') {
          e.preventDefault();
          setMenuSel(null);
          return;
        }
        onKeyDown(e);
      }}
      onBlur={() => setClipboard(null)}
    >
      {props.newEntry && props.newEntry.parentDir === '' && (
        <div className="tree-row is-new" style={{ paddingLeft: 6 }}>
          <span className="tree-disclosure-spacer" />
          <Icon kind={props.newEntry.kind} open={true} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitEdit({ kind: props.newEntry!.kind === 'file' ? 'file' : 'folder' });
            }}
            className="tree-edit-form"
          >
            <input
              className="tree-input"
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              autoFocus
              onBlur={cancelEdit}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              placeholder={props.newEntry.kind === 'file' ? 'New file' : 'New folder'}
            />
          </form>
        </div>
      )}
      {tree.children.map((n) => (
        <Row
          key={n.kind === 'folder' ? 'd:' + n.dir : 'f:' + n.path}
          node={n}
          depth={0}
          collapsed={props.collapsed}
          activePath={props.activePath}
          selected={selected}
          onSetSelection={(sel) => setSelected(sel)}
          onCutSelection={cutSelection}
          onPasteSelection={pasteIntoSelection}
          menuSel={menuSel}
          editing={editing}
          editText={editText}
          onSelectFolder={(dir) => {
            setMenuSel(null);
            setSelected({ kind: 'folder', path: dir });
          }}
          onSelectFile={(path) => {
            setMenuSel(null);
            setSelected({ kind: 'file', path });
            props.onSelectFile(path);
          }}
          onToggleFolder={toggleCollapse}
          onStartEdit={(sel, text) => {
            setEditing(sel);
            setEditText(text);
          }}
          onEditTextChange={setEditText}
          onSubmitEdit={submitEdit}
          newEntry={props.newEntry ?? null}
          onCancelEditing={cancelEdit}
          onRequestMenu={(sel) => setMenuSel(sel)}
          onCloseMenu={() => setMenuSel(null)}
          onDeleteFile={props.onDeleteFile}
          onDeleteFolder={props.onDeleteFolder}
          clipboard={clipboardFallback}
        />
      ))}
    </div>
  );
}

function Row(props: {
  node: FolderNode | FileNode;
  depth: number;
  collapsed: Record<string, boolean>;
  activePath: string | undefined;
  selected: Selection;
  onSetSelection: (sel: Selection) => void;
  onCutSelection: (sel: Selection) => Promise<boolean>;
  onPasteSelection: (sel: Selection) => Promise<boolean>;
  menuSel: Selection;
  editing: Selection;
  editText: string;
  onSelectFolder: (dir: string) => void;
  onSelectFile: (path: string) => void;
  onToggleFolder: (dir: string) => void;
  onStartEdit: (sel: Selection, text: string) => void;
  onEditTextChange: (t: string) => void;
  onSubmitEdit: (ctx: { kind: 'file' | 'folder'; path?: string }) => void;
  newEntry: NewEntry | null;
  onCancelEditing: () => void;
  onRequestMenu: (sel: Selection) => void;
  onCloseMenu: () => void;
  onDeleteFile: (path: string) => void;
  onDeleteFolder: (path: string) => void;
  clipboard: Selection | null;
}) {
  const { node, depth } = props;
  const isMenuHere =
    props.menuSel &&
    ((props.menuSel.kind === 'folder' &&
      node.kind === 'folder' &&
      normalizePath(props.menuSel.path) === normalizePath(node.dir)) ||
      (props.menuSel.kind === 'file' &&
        node.kind === 'file' &&
        normalizePath(props.menuSel.path) === normalizePath(node.path)));

  const startLongPress = (e: React.PointerEvent, sel: Selection) => {
    if (e.pointerType !== 'touch') return; // mobile gesture
    props.onSetSelection(sel);
    let timer = window.setTimeout(() => {
      let current = props.menuSel;
      if (current && current.kind === sel?.kind && normalizePath(current.path) === normalizePath(sel?.path)) {
        props.onCloseMenu();
      } else {
        props.onRequestMenu(sel);
      }
    }, 550);
    const clear = () => window.clearTimeout(timer);
    const target = e.currentTarget as HTMLElement;
    const remove = () => {
      target.removeEventListener('pointerup', clear);
      target.removeEventListener('pointercancel', clear);
      target.removeEventListener('pointerleave', clear);
    };
    target.addEventListener(
      'pointerup',
      () => {
        clear();
        remove();
      },
      { once: true }
    );
    target.addEventListener(
      'pointercancel',
      () => {
        clear();
        remove();
      },
      { once: true }
    );
    target.addEventListener(
      'pointerleave',
      () => {
        clear();
        remove();
      },
      { once: true }
    );
  };
  if (node.kind === 'folder') {
    const isCollapsed = node.dir !== '' && props.collapsed[node.dir] !== false;
    const isActive =
      props.selected?.kind === 'folder' && normalizePath(props.selected.path) === normalizePath(node.dir);
    const isEditing =
      props.editing?.kind === 'folder' && normalizePath(props.editing.path) === normalizePath(node.dir);
    const isCut =
      props.clipboard?.kind === 'folder' && normalizePath(props.clipboard.path) === normalizePath(node.dir);
    let className = 'tree-row';
    if (isActive) className += ' is-active';
    if (isCut) className += ' is-cut';
    return (
      <div className="tree-folder">
        <div
          className={className}
          style={{ paddingLeft: 6 + depth * 10 }}
          onClick={() => props.onSelectFolder(node.dir)}
          onContextMenu={(e) => {
            e.preventDefault();
            let next: Selection = { kind: 'folder', path: node.dir };
            props.onSetSelection(next);
            let current = props.menuSel;
            if (
              current &&
              current.kind === next.kind &&
              normalizePath(current.path) === normalizePath(next.path)
            ) {
              props.onCloseMenu();
              return;
            }
            props.onRequestMenu(next);
          }}
          onPointerDown={(e) => startLongPress(e, { kind: 'folder', path: node.dir })}
        >
          <button
            className="tree-disclosure"
            onClick={(e) => {
              e.stopPropagation();
              props.onToggleFolder(node.dir);
            }}
            aria-label="Toggle folder"
          >
            {isCollapsed ? '▸' : '▾'}
          </button>
          <Icon kind="folder" open={!isCollapsed} />
          {isEditing ? (
            <form
              className="tree-edit-form"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                props.onSubmitEdit({ kind: 'folder', path: node.dir });
              }}
            >
              <input
                className="tree-input"
                value={props.editText}
                onChange={(e) => props.onEditTextChange(e.target.value)}
                autoFocus
                onBlur={props.onCancelEditing}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    props.onCancelEditing();
                  }
                }}
              />
            </form>
          ) : (
            <span className="tree-title">{node.name || 'Root'}</span>
          )}
          {isMenuHere && (
            <TreeMenu
              onClose={props.onCloseMenu}
              actions={[
                {
                  label: 'Cut',
                  disabled: node.dir === '',
                  onSelect: () => props.onCutSelection({ kind: 'folder', path: node.dir }),
                },
                {
                  label: 'Paste',
                  onSelect: () => props.onPasteSelection({ kind: 'folder', path: node.dir }),
                },
                {
                  label: 'Rename',
                  onSelect: () => {
                    const name = node.name || '';
                    props.onStartEdit({ kind: 'folder', path: node.dir }, name);
                    return true;
                  },
                },
                ...(node.dir !== ''
                  ? [
                      {
                        label: 'Delete',
                        onSelect: () => {
                          props.onDeleteFolder(node.dir);
                          return true;
                        },
                        variant: 'danger' as const,
                      },
                    ]
                  : []),
                {
                  label: 'Cancel',
                  onSelect: () => true,
                },
              ]}
            />
          )}
        </div>
        {!isCollapsed && props.newEntry && props.newEntry.parentDir === node.dir && (
          <div className="tree-row is-new" style={{ paddingLeft: 6 + (depth + 1) * 10 }}>
            <span className="tree-disclosure-spacer" />
            <Icon kind={props.newEntry.kind} open={true} />
            <form
              className="tree-edit-form"
              onClick={(e) => e.stopPropagation()}
              onSubmit={(e) => {
                e.preventDefault();
                props.onSubmitEdit({
                  kind: props.newEntry!.kind === 'file' ? 'file' : 'folder',
                  path: node.dir,
                });
              }}
            >
              <input
                className="tree-input"
                value={props.editText}
                onChange={(e) => props.onEditTextChange(e.target.value)}
                autoFocus
                onBlur={props.onCancelEditing}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    props.onCancelEditing();
                  }
                }}
                placeholder={props.newEntry.kind === 'file' ? 'New file' : 'New folder'}
              />
            </form>
          </div>
        )}
        {!isCollapsed &&
          node.children.map((c) => (
            <Row
              key={c.kind === 'folder' ? 'd:' + c.dir : 'f:' + c.path}
              node={c}
              depth={depth + 1}
              collapsed={props.collapsed}
              activePath={props.activePath}
              selected={props.selected}
              menuSel={props.menuSel}
              editing={props.editing}
              editText={props.editText}
              onSelectFolder={props.onSelectFolder}
              onSelectFile={props.onSelectFile}
              onSetSelection={props.onSetSelection}
              onCutSelection={props.onCutSelection}
              onPasteSelection={props.onPasteSelection}
              onToggleFolder={props.onToggleFolder}
              onStartEdit={props.onStartEdit}
              onEditTextChange={props.onEditTextChange}
              onSubmitEdit={props.onSubmitEdit}
              newEntry={props.newEntry}
              onCancelEditing={props.onCancelEditing}
              onRequestMenu={props.onRequestMenu}
              onCloseMenu={props.onCloseMenu}
              onDeleteFile={props.onDeleteFile}
              onDeleteFolder={props.onDeleteFolder}
              clipboard={props.clipboard}
            />
          ))}
      </div>
    );
  }
  const isActive =
    props.activePath !== undefined &&
    node.kind === 'file' &&
    normalizePath(props.activePath) === normalizePath(node.path);
  const isSelected =
    props.selected?.kind === 'file' && normalizePath(props.selected.path) === normalizePath(node.path);
  const isEditing =
    props.editing?.kind === 'file' && normalizePath(props.editing.path) === normalizePath(node.path);
  const isCut =
    props.clipboard?.kind === 'file' && normalizePath(props.clipboard.path) === normalizePath(node.path);
  let rowClass = 'tree-row';
  if (isActive || isSelected) rowClass += ' is-active';
  if (isCut) rowClass += ' is-cut';
  return (
    <div
      className={rowClass}
      style={{ paddingLeft: 6 + depth * 10 }}
      onClick={() => props.onSelectFile(node.path)}
      onContextMenu={(e) => {
        e.preventDefault();
        let next: Selection = { kind: 'file', path: node.path };
        props.onSetSelection(next);
        let current = props.menuSel;
        if (
          current &&
          current.kind === next.kind &&
          normalizePath(current.path) === normalizePath(next.path)
        ) {
          props.onCloseMenu();
          return;
        }
        props.onRequestMenu(next);
      }}
      onPointerDown={(e) => startLongPress(e, { kind: 'file', path: node.path })}
      onDoubleClick={() => props.onSelectFile(node.path)}
    >
      <span className="tree-disclosure-spacer" />
      <Icon kind="file" />
      {isEditing ? (
        <form
          className="tree-edit-form"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            props.onSubmitEdit({ kind: 'file', path: node.path });
          }}
        >
          <input
            className="tree-input"
            value={props.editText}
            onChange={(e) => props.onEditTextChange(e.target.value)}
            autoFocus
            onBlur={props.onCancelEditing}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                props.onCancelEditing();
              }
            }}
          />
        </form>
      ) : (
        <span className="tree-title">{node.name}</span>
      )}
      {isMenuHere && (
        <TreeMenu
          onClose={props.onCloseMenu}
          actions={[
            {
              label: 'Cut',
              onSelect: () => props.onCutSelection({ kind: 'file', path: node.path }),
            },
            {
              label: 'Paste',
              onSelect: () => props.onPasteSelection({ kind: 'file', path: node.path }),
            },
            {
              label: 'Rename',
              onSelect: () => {
                props.onStartEdit({ kind: 'file', path: node.path }, node.title);
                return true;
              },
            },
            {
              label: 'Delete',
              onSelect: () => {
                props.onDeleteFile(node.path);
                return true;
              },
              variant: 'danger',
            },
            {
              label: 'Cancel',
              onSelect: () => true,
            },
          ]}
        />
      )}
    </div>
  );
}

type MenuAction = {
  label: string;
  onSelect: () => boolean | Promise<boolean>;
  disabled?: boolean;
  variant?: 'danger';
};

function TreeMenu({ actions, onClose }: { actions: MenuAction[]; onClose: () => void }) {
  return (
    <div className="tree-menu" onClick={(e) => e.stopPropagation()}>
      {actions.map((action, index) => {
        let className = 'btn small subtle';
        if (action.variant === 'danger') className += ' danger';
        return (
          <button
            key={index}
            className={className}
            disabled={action.disabled}
            onClick={() => {
              if (action.disabled) return;
              Promise.resolve(action.onSelect()).then((shouldClose) => {
                if (shouldClose !== false) onClose();
              });
            }}
          >
            {action.label}
          </button>
        );
      })}
    </div>
  );
}

function Icon({
  kind,
  open,
}: {
  kind: 'file' | 'folder' | 'folder-open' | 'file-leaf' | 'file-md' | 'folder-closed' | 'folder';
  open?: boolean;
}) {
  let isFolder = kind === 'folder';
  let className = 'tree-icon';
  let IconSvg = FileIcon;
  if (isFolder) {
    IconSvg = open ? FolderOpenIcon : FolderIcon;
    className += open ? ' folder-open' : ' folder';
  } else {
    className += ' file';
  }
  return (
    <span className={className} aria-hidden>
      <IconSvg size={treeIconSize} strokeWidth={treeIconStrokeWidth} />
    </span>
  );
}

function setCollapsedValue(
  map: Record<string, boolean>,
  dir: string,
  value: boolean
): Record<string, boolean> | null {
  if (dir === '') return null;
  if (map[dir] === value) return null;
  let next: Record<string, boolean> = { ...map };
  next[dir] = value;
  return next;
}

function ensureDirOpen(map: Record<string, boolean>, dir: string): Record<string, boolean> | null {
  if (dir === '') return null;
  if (map[dir] === false) return null;
  let next: Record<string, boolean> = { ...map };
  next[dir] = false;
  return next;
}

function ancestorsOf(dir: string): string[] {
  let list: string[] = [];
  let current = normalizeDir(dir);
  while (current !== '') {
    list.push(current);
    let idx = current.lastIndexOf('/');
    current = idx >= 0 ? current.slice(0, idx) : '';
  }
  return list;
}

function normalizePath(path: string | undefined): string {
  if (path === undefined) return '';
  return path.replace(/^\/+/, '').replace(/\+$/, '');
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
    let node: FolderNode = {
      kind: 'folder',
      dir: d,
      name: d.slice(d.lastIndexOf('/') + 1),
      children: [],
    };
    parentNode.children.push(node);
    folderMap.set(d, node);
    return node;
  };
  for (let d of folders) addFolder(d);
  for (let f of files) {
    const parent = addFolder(f.dir);
    parent.children.push({ kind: 'file', name: f.name, dir: f.dir, path: f.path, title: f.title });
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
