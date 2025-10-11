import { render, screen, cleanup } from '@testing-library/react';
import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import type { BinaryFile, AssetUrlFile } from '../storage/local';
import { AssetViewer } from './AssetViewer';

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

  test('shows fallback messaging when content is empty', () => {
    const file: BinaryFile = { ...BASE_FILE, content: '' };
    render(<AssetViewer file={file} />);
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(screen.queryByRole('img')).toBeNull();
    const fallback = screen.getByText('Unable to preview this asset. Try downloading it instead.');
    expect(fallback).not.toBeNull();
  });
});
