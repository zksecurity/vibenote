// Unit tests for FileTree interaction patterns (context menus).
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FileTree, type FileEntry } from './FileTree';

function renderTree(onSelectFile = vi.fn()) {
  cleanup();

  let files: FileEntry[] = [
    {
      name: 'note.md',
      path: 'note.md',
      dir: '',
      title: 'note',
    },
  ];

  render(
    <FileTree
      files={files}
      folders={['']}
      activePath={undefined}
      collapsed={{}}
      onCollapsedChange={vi.fn()}
      onSelectFile={onSelectFile}
      onRenameFile={vi.fn()}
      onMoveFile={vi.fn()}
      onDeleteFile={vi.fn()}
      onCreateFile={vi.fn()}
      onCreateFolder={vi.fn()}
      onRenameFolder={vi.fn()}
      onMoveFolder={vi.fn()}
      onDeleteFolder={vi.fn()}
    />
  );

  let title = screen.getByText('note.md');
  let row = title.closest('.tree-row');
  if (!row) throw new Error('expected file row element');
  return { row, onSelectFile };
}

describe('FileTree context menu', () => {
  it('clicking row while menu is open closes menu and selects file', () => {
    let { row, onSelectFile } = renderTree();

    fireEvent.contextMenu(row);
    expect(screen.getByText('Rename')).toBeTruthy();

    // Click while menu is open - should close menu and select file
    fireEvent.click(row);
    expect(onSelectFile).toHaveBeenCalledWith('note.md');
    expect(screen.queryByText('Rename')).toBeNull();
  });

  it('menu survives additional pointerdown on same row', () => {
    // On some mobile browsers, lifting the finger after a long-press can fire
    // additional pointerdown events on the same row. The menu should not close.
    let { row } = renderTree();

    fireEvent.contextMenu(row);
    expect(screen.getByText('Rename')).toBeTruthy();

    // Additional pointerdown on the same row (mobile browser quirk)
    fireEvent.pointerDown(row, { pointerType: 'touch', button: 0 });

    // Menu should still be open
    expect(screen.getByText('Rename')).toBeTruthy();
  });

  it('right-click toggles the file menu on/off on the same file', () => {
    let { row } = renderTree();

    fireEvent.contextMenu(row);
    expect(screen.getByText('Rename')).toBeTruthy();

    fireEvent.contextMenu(row);
    expect(screen.queryByText('Rename')).toBeNull();
  });
});
