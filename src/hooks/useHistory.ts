import { useCallback, useRef, useState } from "react";

/**
 * Undo / redo over snapshots of the user's edits. Snapshots are stored as
 * JSON, so an entry can't be changed after it's taken and two equal states
 * are never recorded twice in a row.
 */
export function useHistory<T>(limit = 100) {
  const stack = useRef<{ entries: string[]; index: number }>({ entries: [], index: -1 });
  const [, setVersion] = useState(0);
  const bump = () => setVersion(v => v + 1);

  /** Starts over from `snap` (new media, restored session). */
  const reset = useCallback((snap: T) => {
    stack.current = { entries: [JSON.stringify(snap)], index: 0 };
    bump();
  }, []);

  /** Records `snap` if it differs from the current entry; drops any redo steps. */
  const commit = useCallback((snap: T) => {
    const s = stack.current, json = JSON.stringify(snap);
    if (s.entries[s.index] === json) return;
    const entries = [...s.entries.slice(0, s.index + 1), json];
    while (entries.length > limit) entries.shift();
    stack.current = { entries, index: entries.length - 1 };
    bump();
  }, [limit]);

  const step = useCallback((dir: -1 | 1): T | null => {
    const s = stack.current, i = s.index + dir;
    if (i < 0 || i >= s.entries.length) return null;
    stack.current = { ...s, index: i };
    bump();
    return JSON.parse(s.entries[i]) as T;
  }, []);

  const { entries, index } = stack.current;
  return {
    reset,
    commit,
    undo: useCallback(() => step(-1), [step]),
    redo: useCallback(() => step(1), [step]),
    canUndo: index > 0,
    canRedo: index >= 0 && index < entries.length - 1,
  };
}
