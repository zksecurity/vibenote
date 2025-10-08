import { describe, expect, it } from 'vitest';

import { parseRoute, routeToPath, type Route } from './routing';

describe('routing helpers', () => {
  it('parses /new without note path', () => {
    expect(parseRoute('/new')).toEqual<Route>({ kind: 'new' });
  });

  it('parses /new with nested note path', () => {
    expect(parseRoute('/new/docs/setup.md')).toEqual<Route>({
      kind: 'new',
      notePath: 'docs/setup.md',
    });
  });

  it('round-trips /new with encoded segments', () => {
    const path = '/new/docs/My%20Note.md';
    const route = parseRoute(path);
    expect(route).toEqual<Route>({ kind: 'new', notePath: 'docs/My Note.md' });
    expect(routeToPath(route)).toBe(path);
  });

  it('parses repo routes with note path', () => {
    expect(parseRoute('/acme/docs/guides/intro.md')).toEqual<Route>({
      kind: 'repo',
      owner: 'acme',
      repo: 'docs',
      notePath: 'guides/intro.md',
    });
  });

  it('builds repo paths with nested note path', () => {
    expect(
      routeToPath({ kind: 'repo', owner: 'acme', repo: 'docs', notePath: 'guides/intro.md' })
    ).toBe('/acme/docs/guides/intro.md');
  });
});
