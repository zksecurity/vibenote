# Data Layer Notes

Short notes on directions we want to preserve while evolving the UI/data boundary.

## Richer Communication

The current model of `dispatch(action)` plus one returned `state` object is useful, but not rich enough for every UI pattern.

Two expansions we want to keep in mind:

- add synchronous `queries` for cached/looked-up data that should not be forced into one durable state object
- consider an outbound effect/event channel for ephemeral async results that are not naturally durable state

## Example: Repo Probe

`repo.probe` is a good example of data that feels awkward as a single "latest probe" field in app state.

Prefer:

- `dispatch({ type: 'repo.probe', ... })` to request work
- `queries.getRepoProbe(owner, repo)` to read cached probe results synchronously

This lets the data layer keep a cache of probe results without pretending the latest probe is durable app state.
