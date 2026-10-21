import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { Despliegues } from './Despliegues.js';
import { HostContext, type Host } from './host.js';

// The dashboard's sections in React (#235, stage 7), as islands: app.js
// still draws the page, and mounts one of these where a section goes —
// window.roninIslands.mount('despliegues', element, host) — and unmounts it
// when the person leaves. A section at a time, until app.js is empty.

const ISLANDS: Record<string, ComponentType> = {
  despliegues: Despliegues,
};

// One cache for every island: going back to a section shows what it had.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

function mount(name: string, element: HTMLElement, host: Host): () => void {
  const Island = ISLANDS[name];
  if (!Island) throw new Error(`no hay una isla ${name}`);
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <HostContext.Provider value={host}>
          <Island />
        </HostContext.Provider>
      </QueryClientProvider>
    </StrictMode>,
  );
  return () => root.unmount();
}

declare global {
  interface Window {
    roninIslands: { mount: typeof mount; names: string[] };
  }
}

window.roninIslands = { mount, names: Object.keys(ISLANDS) };
