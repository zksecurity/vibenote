import { buildRemoteConfig, type RemoteConfig } from '../sync/git-sync';

export function remoteConfigForSlug(slug: string, branch: string | null): RemoteConfig {
  const cfg: RemoteConfig = buildRemoteConfig(slug);
  if (branch) cfg.branch = branch;
  return cfg;
}
