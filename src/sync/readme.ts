import { commitBatch, pullRepoFile, type RemoteConfig } from './git-sync';

const README_BODY = `Welcome! This repository is managed by [VibeNote](https://vibenote.dev).

- Your notes live here as regular Markdown files.
- Open [vibenote.dev](https://vibenote.dev) to edit Markdown in a mobile-friendly note-taking app.
- You can also edit notes directly in your editor and push to GitHub.
- VibeNote will sync automatically to the ${'`main`'} branch whenever you're online.
`;

function buildReadme(repoName: string): string {
  return `# ${repoName}\n\n${README_BODY}`;
}

async function ensureIntroReadme(config: RemoteConfig): Promise<void> {
  try {
    const existingReadme = await pullRepoFile(config, 'README.md');
    await commitBatch(
      config,
      [
        {
          path: 'README.md',
          text: buildReadme(config.repo),
          baseSha: existingReadme?.sha,
        },
      ],
      'vibenote: add README'
    );
  } catch {
    // Ignore README failures; syncing notes is more important for first-time setup.
  }
}

export { ensureIntroReadme, buildReadme };
