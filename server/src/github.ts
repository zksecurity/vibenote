import { App } from "@octokit/app";
import { Octokit } from "@octokit/core";
import type { Env } from "./env.ts";

export type { Octokit };

export function makeApp(env: Env): App {
  return new App({ appId: env.GITHUB_APP_ID, privateKey: env.PRIVATE_KEY_PEM });
}

export async function getInstallationOctokit(app: App, installationId: number): Promise<Octokit> {
  return await app.getInstallationOctokit(installationId);
}

export async function getRepoMetadataUnauthed(owner: string, repo: string): Promise<{ ok: boolean; isPrivate?: boolean; defaultBranch?: string }> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: { "Accept": "application/vnd.github+json" },
  });
  if (res.status === 200) {
    const data: any = await res.json();
    return { ok: true, isPrivate: Boolean(data.private), defaultBranch: String(data.default_branch) };
  }
  return { ok: false };
}

export async function getRepositoryInstallation(app: App, owner: string, repo: string) {
  try {
    const r = await app.octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo });
    return r.data; // includes id, repository_selection, etc.
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function getOwnerInstallation(app: App, owner: string, isOrgHint?: boolean) {
  // Try org, then user
  const tryOrg = async () => {
    try {
      const r = await app.octokit.request("GET /orgs/{org}/installation", { org: owner });
      return r.data;
    } catch (e: any) {
      if (e.status === 404) return null; throw e;
    }
  };
  const tryUser = async () => {
    try {
      const r = await app.octokit.request("GET /users/{username}/installation", { username: owner });
      return r.data;
    } catch (e: any) {
      if (e.status === 404) return null; throw e;
    }
  };
  if (isOrgHint === true) {
    return await tryOrg() ?? await tryUser();
  }
  if (isOrgHint === false) {
    return await tryUser() ?? await tryOrg();
  }
  return await tryOrg() ?? await tryUser();
}

export async function getDefaultBranch(app: App, installationId: number, owner: string, repo: string): Promise<string | null> {
  const kit = await getInstallationOctokit(app, installationId);
  try {
    const r = await kit.request("GET /repos/{owner}/{repo}", { owner, repo });
    return String(r.data.default_branch);
  } catch {
    return null;
  }
}
