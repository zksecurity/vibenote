// Provides an async loader for repo assets so previews can fetch binary/image data on demand.
import { useCallback } from 'react';
import { normalizePath } from '../lib/util';
import {
  getRepoStore,
  basename,
  stripExtension,
  extractDir,
  isBinaryFile,
  isAssetUrlFile,
  type BinaryFile,
  type AssetUrlFile,
} from '../storage/local';
import { buildRemoteConfig, pullRepoFile, type RemoteFile } from '../sync/git-sync';

export { useRepoAssetLoader };

type RepoAssetLoader = (path: string) => Promise<BinaryFile | AssetUrlFile | undefined>;

function useRepoAssetLoader(params: {
  slug: string;
  isReadOnly: boolean;
  defaultBranch?: string;
}): RepoAssetLoader {
  let { slug, isReadOnly, defaultBranch } = params;
  return useCallback<RepoAssetLoader>(
    async (inputPath: string) => {
      let normalized = normalizePath(inputPath);
      if (normalized === undefined) return undefined;
      if (!isReadOnly) {
        let store = getRepoStore(slug);
        let meta = store.findMetaByPath(normalized);
        if (!meta) return undefined;
        if (meta.kind !== 'binary' && meta.kind !== 'asset-url') return undefined;
        let file = store.loadFileById(meta.id);
        if (!file) return undefined;
        if (isBinaryFile(file) || isAssetUrlFile(file)) return file;
        return undefined;
      }
      try {
        let config = buildRemoteConfig(slug, defaultBranch);
        let remote = await pullRepoFile(config, normalized);
        if (!remote) return undefined;
        if (remote.kind === 'markdown') return undefined;
        return toAssetFile(remote);
      } catch {
        return undefined;
      }
    },
    [slug, isReadOnly, defaultBranch]
  );
}

function toAssetFile(remote: RemoteFile): BinaryFile | AssetUrlFile | undefined {
  if (remote.kind === 'markdown') return undefined;
  let common = {
    id: remote.path,
    path: remote.path,
    title: stripExtension(basename(remote.path)),
    dir: extractDir(remote.path),
    updatedAt: Date.now(),
    lastRemoteSha: remote.sha,
  };
  if (remote.kind === 'binary') {
    return { ...common, kind: 'binary', content: remote.content };
  }
  if (remote.kind === 'asset-url') {
    return { ...common, kind: 'asset-url', content: remote.content };
  }
  return undefined;
}
