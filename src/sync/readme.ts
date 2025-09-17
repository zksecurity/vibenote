import { commitBatch, pullNote } from './git-sync';

const README_BODY = `Welcome! This repository is managed by [VibeNote](https://vibenote.dev).

- Your notes live here as regular Markdown files.
- Open [vibenote.dev](https://vibenote.dev) to edit Markdown in a mobile-friendly note-taking app.
- You can also edit notes directly in your editor and push to GitHub.
- VibeNote will sync automatically to the ${'`main`'} branch whenever you're online.
`;

function buildReadme(repoName: string): string {
  return `# ${repoName}\n\n${README_BODY}`;
}

async function ensureIntroReadme(repoName: string): Promise<void> {
  try {
    const existingReadme = await pullNote('README.md');
    await commitBatch(
      [
        {
          path: 'README.md',
          text: buildReadme(repoName),
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
