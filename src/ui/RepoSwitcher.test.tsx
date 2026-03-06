// Unit tests for RepoSwitcher probe behavior.
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppQueries } from '../data';
import { RepoSwitcher } from './RepoSwitcher';

function renderSwitcher({
  queries,
  dispatch = vi.fn(),
}: {
  queries: AppQueries;
  dispatch?: ReturnType<typeof vi.fn>;
}) {
  cleanup();
  return {
    dispatch,
    ...render(<RepoSwitcher dispatch={dispatch} queries={queries} recents={[]} onClose={vi.fn()} />),
  };
}

describe('RepoSwitcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
  });

  it('does not re-probe the same repo on rerender once a probe exists', () => {
    let probeStatus: AppQueries['getRepoProbe'] = () => undefined;
    let queries: AppQueries = {
      getRepoProbe: (owner, repo) => probeStatus(owner, repo),
    };
    let dispatch = vi.fn();
    let view = renderSwitcher({ dispatch, queries });

    fireEvent.change(screen.getByPlaceholderText('owner/repo'), {
      target: { value: 'acme/docs' },
    });

    vi.advanceTimersByTime(300);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith({ type: 'repo.probe', owner: 'acme', repo: 'docs' });

    probeStatus = () => ({ status: 'checking', owner: 'acme', repo: 'docs' });
    view.rerender(<RepoSwitcher dispatch={dispatch} queries={queries} recents={[]} onClose={vi.fn()} />);

    vi.advanceTimersByTime(600);
    expect(dispatch).toHaveBeenCalledTimes(1);

    probeStatus = () => ({ status: 'ready', owner: 'acme', repo: 'docs', exists: true });
    view.rerender(<RepoSwitcher dispatch={dispatch} queries={queries} recents={[]} onClose={vi.fn()} />);

    vi.advanceTimersByTime(600);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
