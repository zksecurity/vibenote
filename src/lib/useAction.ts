import { useEffect } from 'react';
import { emit, on } from 'minimal-state';

export { useAction, dispatch };

function useAction<Action, Payload>(action: Action, handler: (payload: Payload) => void) {
  useEffect(() => on(action, (payload) => handler(payload as Payload)), [action, handler]);
}

function dispatch<Action, Payload>(action: Action, payload: Payload) {
  emit(action as [unknown], payload);
}
