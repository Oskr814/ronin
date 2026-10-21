import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode, type ComponentType } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { HostContext, type Host } from './host.js';
import { Deploys } from './pages/deploys/Deploys.js';
import { Exploration } from './pages/explorations/Exploration.js';
import { Explorations } from './pages/explorations/Explorations.js';
import { ExploreNow } from './pages/explorations/ExploreNow.js';
import { ExplorationInventory } from './pages/explorations/Inventory.js';
import { ExplorationRuns } from './pages/explorations/Runs.js';
import { Meeting } from './pages/meetings/Meeting.js';
import { Meetings } from './pages/meetings/Meetings.js';
import { Subscription } from './pages/metrics/Subscription.js';
import { Work } from './pages/metrics/Work.js';
import { Request } from './pages/requests/Request.js';
import { Requests } from './pages/requests/Requests.js';
import { Settings } from './pages/settings/Settings.js';
import { Today } from './pages/today/Today.js';

// The dashboard's pages in React (#235, stage 7): app.js still draws the
// shell (sidebar, status bar, routes) and mounts one of these where a page
// goes — window.roninPages.mount('deploys', element, host) — and
// unmounts it when the person leaves. A page at a time, until app.js is empty.
// What app.js routes to (a request's or a meeting's number) comes as the page's props.
// Some are parts of a page app.js still draws (an exploration PR's runs and
// inventory, Explorar ahora): mounted at once (`sync`), so the page they're
// in has its height when app.js puts back its scroll.

const PAGES: Record<string, ComponentType<any>> = {
  deploys: Deploys,
  explorations: Explorations,
  exploration: Exploration,
  'exploration-runs': ExplorationRuns,
  'exploration-inventory': ExplorationInventory,
  'explore-now': ExploreNow,
  meetings: Meetings,
  meeting: Meeting,
  metrics: Work,
  settings: Settings,
  subscription: Subscription,
  requests: Requests,
  request: Request,
  today: Today,
};

// One cache for every page: going back to one shows what it had.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } });

function mount(name: string, element: HTMLElement, host: Host, props: Record<string, unknown> = {}, sync = false): () => void {
  const Page = PAGES[name];
  if (!Page) throw new Error(`no hay una página ${name}`);
  const root = createRoot(element);
  const render = () => root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <HostContext.Provider value={host}>
          <Page {...props} />
        </HostContext.Provider>
      </QueryClientProvider>
    </StrictMode>,
  );
  if (sync) flushSync(render);
  else render();
  return () => root.unmount();
}

declare global {
  interface Window {
    roninPages: { mount: typeof mount; names: string[] };
  }
}

window.roninPages = { mount, names: Object.keys(PAGES) };
