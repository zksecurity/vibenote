import { render, screen, cleanup } from '@testing-library/react';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { Editor } from './Editor';
import type { MarkdownFile, BinaryFile, AssetUrlFile } from '../storage/local';
import { fetchBlob } from '../sync/git-sync';
import { clearAssetPreviewCache } from './asset-preview-cache';

vi.mock('../sync/git-sync', () => {
  const mockFetchBlob = vi.fn();
  return {
    buildRemoteConfig: (slug: string) => {
      let [owner, repo] = slug.split('/', 2);
      return { owner, repo, branch: 'main' };
    },
    fetchBlob: mockFetchBlob,
  };
});

const BASE_DOC: MarkdownFile = {
  id: 'doc-1',
  path: 'docs/nested/guide.md',
  title: 'guide',
  dir: 'docs/nested',
  updatedAt: 0,
  kind: 'markdown',
  mime: 'text/markdown',
  content: '',
};

const fetchBlobMock = fetchBlob as unknown as ReturnType<typeof vi.fn>;

describe('Editor markdown image resolution', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:resolved');
    revokeObjectURL = vi.fn();
    let urlApi = globalThis.URL as unknown as {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    urlApi.createObjectURL = createObjectURL;
    urlApi.revokeObjectURL = revokeObjectURL;
    fetchBlobMock.mockReset();
  });

  afterEach(() => {
    let urlApi = globalThis.URL as unknown as {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    delete urlApi.createObjectURL;
    delete urlApi.revokeObjectURL;
    cleanup();
    clearAssetPreviewCache();
  });

  test('replaces relative image sources with resolved previews', async () => {
    let loadAsset = vi.fn(async () => {
      let asset: BinaryFile = {
        id: 'asset-1',
        path: 'docs/assets/logo.png',
        title: 'logo',
        dir: 'docs/assets',
        updatedAt: 0,
        kind: 'binary',
        mime: 'image/png',
        content: btoa('image-payload'),
      };
      return asset;
    });
    let doc: MarkdownFile = {
      ...BASE_DOC,
      content: '![Logo](../assets/logo.png)',
    };
    let { unmount } = render(
      <Editor doc={doc} onChange={(_path, _text) => {}} loadAsset={loadAsset} slug="user/repo" />
    );
    let image = await screen.findByRole('img', { name: 'Logo' });
    expect(loadAsset).toHaveBeenCalledWith('docs/assets/logo.png');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(image.getAttribute('src')).toBe('blob:resolved');
    unmount();
    clearAssetPreviewCache();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:resolved');
  });

  test('fetches blob placeholders when assets use GitHub blob pointers', async () => {
    fetchBlobMock.mockResolvedValueOnce(btoa('pointer-payload'));
    createObjectURL.mockReturnValueOnce('blob:pointer');
    let loadAsset = vi.fn(async () => {
      let asset: AssetUrlFile = {
        id: 'asset-2',
        path: 'docs/cover.png',
        title: 'cover',
        dir: 'docs',
        updatedAt: 0,
        kind: 'asset-url',
        mime: 'image/png',
        content: 'gh-blob:user/repo#sha123',
        lastRemoteSha: 'sha123',
      };
      return asset;
    });
    let doc: MarkdownFile = {
      ...BASE_DOC,
      path: 'docs/page.md',
      dir: 'docs',
      content: '![Cover](./cover.png)',
    };
    render(<Editor doc={doc} onChange={(_path, _text) => {}} loadAsset={loadAsset} slug="user/repo" />);
    let image = await screen.findByRole('img', { name: 'Cover' });
    expect(fetchBlobMock).toHaveBeenCalledWith({ owner: 'user', repo: 'repo', branch: 'main' }, 'sha123');
    expect(image.getAttribute('src')).toBe('blob:pointer');
  });

  test('does not resolve external image sources', async () => {
    let loadAsset = vi.fn();
    let doc: MarkdownFile = {
      ...BASE_DOC,
      content: '![Remote](https://example.com/image.png)',
    };
    render(<Editor doc={doc} onChange={(_path, _text) => {}} loadAsset={loadAsset} slug="user/repo" />);
    let image = await screen.findByRole('img', { name: 'Remote' });
    expect(loadAsset).not.toHaveBeenCalled();
    expect(image.getAttribute('src')).toBe('https://example.com/image.png');
  });
});
