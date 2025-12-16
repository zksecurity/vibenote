// Unit tests for FileTree interaction patterns (context menus + long-press).
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FileTree, type FileEntry } from './FileTree';

function renderTree() {
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
      onSelectFile={vi.fn()}
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
  return { row };
}

describe('FileTree context menu', () => {
  it('mobile: long-press keeps the file menu open (no immediate close)', async () => {
    let { row } = renderTree();

    fireEvent.pointerDown(row, { pointerType: 'touch', button: 0 });

    // FileTree uses a 550ms long-press threshold.
    await new Promise((resolve) => window.setTimeout(resolve, 600));

    // Menu should be open after the long-press delay.
    expect(screen.getByText('Rename')).toBeTruthy();

    // On mobile, releasing the finger frequently triggers a synthetic click.
    // The menu should remain usable after the long-press gesture completes.
    fireEvent.pointerUp(row, { pointerType: 'touch', button: 0 });
    fireEvent.click(row);

    expect(screen.getByText('Rename')).toBeTruthy();
  });

  it('desktop: right-click toggles the file menu on/off on the same file', () => {
    let { row } = renderTree();

    fireEvent.contextMenu(row);
    expect(screen.getByText('Rename')).toBeTruthy();

    fireEvent.contextMenu(row);
    expect(screen.queryByText('Rename')).toBeNull();
  });
});
