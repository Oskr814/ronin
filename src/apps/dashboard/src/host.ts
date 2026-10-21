import { createContext, useContext } from 'react';

// What a page asks of the shell around it (app.js), which mounts it.
export interface Host {
  // A note at the bottom, with a link to GitHub if there's one.
  toast(message: string, url?: string): void;
  // Opens a portal request's page.
  openPedido(n: number): void;
  // The session ended: the page logs in again, or says so.
  unauthorized(message: string): void;
  // A repo's color in the sidebar.
  repoColor(repo: string): string;
  // What the page read, for what the sidebar shows of it.
  read?(name: string, data: unknown): void;
}

export const HostContext = createContext<Host | null>(null);

export function useHost(): Host {
  const host = useContext(HostContext);
  if (!host) throw new Error('página fuera del tablero');
  return host;
}
