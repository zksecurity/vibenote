// Shared hook to close popovers when clicking outside or pressing Escape.
import { useCallback, useEffect, useRef, type RefObject } from 'react';

export { useOnClickOutside };

/**
 * Calls the input handler when a click occurs outside the target.
 * Returns a `ref` which has to be passed on to the target.
 *
 * Optional arguments:
 * - a `ref` to a trigger element, which will also not trigger the outside click. (Otherwise, the handlers might
 *   interfere and clicking the trigger cannot successfully open the modal/target.)
 * - a boolean `handleEscape` (default: true) to also call the handler when Escape is pressed.
 *
 * **Beware:** We assume that the `onClickOutside` handler is stable and do not rerun effects when it changes.
 * It's on the caller to ensure that running a stale handler cannot cause problems.
 */
function useOnClickOutside(
  onClickOutside: (event: MouseEvent | KeyboardEvent) => void,
  { trigger, handleEscape = true }: { trigger?: RefObject<HTMLElement | null>; handleEscape?: boolean }
): (node: HTMLElement | null) => void {
  const panelNode = useRef<HTMLElement | null>(null);

  const assignPanel = useCallback((node: HTMLElement | null) => {
    panelNode.current = node;
  }, []);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelNode.current && panelNode.current.contains(target)) return;
      if (trigger?.current && trigger.current.contains(target)) return;
      onClickOutside(event);
    };
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [trigger]);

  useEffect(() => {
    if (!handleEscape) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClickOutside(event);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleEscape]);

  return assignPanel;
}
