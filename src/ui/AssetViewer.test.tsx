import { render, screen, cleanup } from '@testing-library/react';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import type { BinaryFile, AssetUrlFile } from '../storage/local';
import { AssetViewer } from './AssetViewer';
import { fetchBlob } from '../sync/git-sync';

vi.mock('../sync/git-sync', () => {
  const mockFetchBlob = vi.fn();
  return {
    buildRemoteConfig: (slug: string) => {
      const [owner, repo] = slug.split('/', 2);
      return { owner, repo, branch: 'main' };
    },
    fetchBlob: mockFetchBlob,
  };
});

const BASE_FILE: BinaryFile = {
  id: 'asset-1',
  path: 'assets/logo.png',
  title: 'logo.png',
  dir: 'assets',
  updatedAt: 0,
  kind: 'binary',
  mime: 'image/png',
  content: '',
};

const fetchBlobMock = fetchBlob as unknown as ReturnType<typeof vi.fn>;

describe('AssetViewer', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    createObjectURL = vi.fn().mockReturnValue('blob:preview');
    revokeObjectURL = vi.fn();
    const urlApi = globalThis.URL as unknown as {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    urlApi.createObjectURL = createObjectURL;
    urlApi.revokeObjectURL = revokeObjectURL;
    fetchBlobMock.mockReset();
  });

  afterEach(() => {
    const urlApi = globalThis.URL as unknown as {
      createObjectURL?: (blob: Blob) => string;
      revokeObjectURL?: (url: string) => void;
    };
    delete urlApi.createObjectURL;
    delete urlApi.revokeObjectURL;
    cleanup();
  });

  test('renders an image preview and download link when content is present', () => {
    const file: BinaryFile = {
      ...BASE_FILE,
      content: btoa('fake image payload'),
    };
    const { unmount } = render(<AssetViewer file={file} />);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const image = screen.getByRole('img', { name: 'logo.png' }) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('blob:preview');
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('href')).toBe('blob:preview');
    expect(link.getAttribute('download')).toBe('logo.png');
    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview');
  });

  test('renders direct URL assets without creating blobs', () => {
    const urlFile: AssetUrlFile = {
      ...BASE_FILE,
      kind: 'asset-url',
      content: 'https://cdn.example.com/logo.png',
    };
    render(<AssetViewer file={urlFile} />);
    expect(createObjectURL).not.toHaveBeenCalled();
    const image = screen.getByRole('img', { name: 'logo.png' }) as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://cdn.example.com/logo.png');
    const link = screen.getByRole('link', { name: 'Download' });
    expect(link.getAttribute('href')).toBe('https://cdn.example.com/logo.png');
    expect(link.getAttribute('download')).toBe('logo.png');
  });

  test('renders placeholder assets by fetching blob on demand', async () => {
    fetchBlobMock.mockResolvedValueOnce(btoa('fetched image payload'));
    const placeholder: AssetUrlFile = {
      ...BASE_FILE,
      kind: 'asset-url',
      content: 'gh-blob:user/repo#sha123',
      lastRemoteSha: 'sha123',
    };
    render(<AssetViewer file={placeholder} />);
    expect(createObjectURL).not.toHaveBeenCalled();
    const image = await screen.findByRole('img', { name: 'logo.png' });
    expect(image.getAttribute('src')).toMatch(/^blob:/);
    expect(fetchBlobMock).toHaveBeenCalledTimes(1);
    expect(fetchBlobMock).toHaveBeenCalledWith({ owner: 'user', repo: 'repo', branch: 'main' }, 'sha123');
  });

  test('shows fallback messaging when content is empty', () => {
    const file: BinaryFile = { ...BASE_FILE, content: '' };
    render(<AssetViewer file={file} />);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    const fallback = screen.getByText('Unable to preview this asset. Try downloading it instead.');
    expect(fallback).not.toBeNull();
  });
});
