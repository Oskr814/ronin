import { useState } from 'react';

// A page's view (its filters, its sort, what's open) kept while the person
// is elsewhere: app.js keeps it in S, and coming back finds it as it was.
const kept = new Map<string, unknown>();

export function useViewState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => (kept.has(key) ? (kept.get(key) as T) : initial));
  return [value, (next: T) => {
    kept.set(key, next);
    setValue(next);
  }];
}
