import type { ReactNode } from 'react';

// The icons of an activity's timeline (a request's, a meeting's).
export const ICON: Record<string, ReactNode> = {
  person: <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4" /><path d="M4 21c1-4 4-6 8-6s7 2 8 6" /></svg>,
  ronin: <svg viewBox="0 0 24 24"><path d="M4 5h16v11H9l-5 4z" /></svg>,
  run: <svg viewBox="0 0 24 24"><path d="M7 4l12 8-12 8z" /></svg>,
  ok: <svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10" /></svg>,
  crit: <svg viewBox="0 0 24 24"><path d="M12 7v6M12 17h.01" /></svg>,
  mail: <svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 7l9 6 9-6" /></svg>,
  wait: <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" /><path d="M12 8v4l3 2" /></svg>,
};
