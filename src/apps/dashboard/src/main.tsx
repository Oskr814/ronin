import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { HostContext, type Host } from './host.js';
import { Deploys } from './pages/deploys/Deploys.js';
import { Subscription } from './pages/metrics/Subscription.js';
import { Work } from './pages/metrics/Work.js';
import { Request } from './pages/requests/Request.js';
import { Requests } from './pages/requests/Requests.js';

// The dashboard's pages in React (#235, stage 7): app.js still draws the
// shell (sidebar, status bar, routes) and mounts one of these where a page
// goes — window.roninPages.mount('deploys', element, host) — and
// unmounts it when the person leaves. A page at a time, until app.js is empty.
// What app.js routes to (a request's number) comes as the page's props.

// Each page takes its own props.
const PAGES: Record<string, ComponentType<any>> = {
  deploys: Deploys,
  metrics: Work,
  subscription: Subscription,
  requests: Requests,
  request: Request,
};

// One cache for every page: going back to one shows what it had.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

function mount(name: string, element: HTMLElement, host: Host, props: Record<string, unknown> = {}): () => void {
  const Page = PAGES[name];
  if (!Page) throw new Error(`no hay una página ${name}`);
  const root = createRoot(element);
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <HostContext.Provider value={host}>
          <Page {...props} />
        </HostContext.Provider>
      </QueryClientProvider>
    </StrictMode>,
  );
  return () => root.unmount();
}

declare global {
  interface Window {
    roninPages: { mount: typeof mount; names: string[] };
  }
}

window.roninPages = { mount, names: Object.keys(PAGES) };
