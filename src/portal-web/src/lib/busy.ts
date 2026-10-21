import { useEffect, useRef } from 'react';

// Whether the person is in the middle of something the page would lose on a
// reload: a message half written, images attached, answers given, a send on
// its way. After a deploy the page reloads itself only when nothing is (api.ts).
const checks = new Set<() => boolean>();

export const anyBusy = () => [...checks].some((busy) => busy());

export function useBusy(busy: boolean): void {
  const now = useRef(busy);
  now.current = busy;
  useEffect(() => {
    const check = () => now.current;
    checks.add(check);
    return () => {
      checks.delete(check);
    };
  }, []);
}
