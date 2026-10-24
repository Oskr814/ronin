import { Component, memo, type ComponentType, type ReactNode } from 'react';
import { Deploys } from '../pages/deploys/Deploys.js';
import { Exploration } from '../pages/explorations/Exploration.js';
import { Explorations } from '../pages/explorations/Explorations.js';
import { Item } from '../pages/item/Item.js';
import { Meeting } from '../pages/meetings/Meeting.js';
import { Meetings } from '../pages/meetings/Meetings.js';
import { Subscription } from '../pages/metrics/Subscription.js';
import { RequestMetrics } from '../pages/metrics/Requests.js';
import { Work } from '../pages/metrics/Work.js';
import { Request } from '../pages/requests/Request.js';
import { Requests } from '../pages/requests/Requests.js';
import { Settings } from '../pages/settings/Settings.js';
import { Today } from '../pages/today/Today.js';
import { RunDot } from '../lib/runs.js';
import { ItemCtx } from './Context.js';
import { back, closeTab, docOf, togglePin, type Item as ShellItem, itemById, S, select, viewOf } from './state.js';

// The center: the page the address says, under the tabs of the items open
// (on Hoy and an item's page; an item opens over the tab shown unless it's
// pinned, with its button or a double click) and the bar that goes back to the list on a
// phone.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const PAGES: Record<string, ComponentType<any>> = {
  deploys: Deploys,
  explorations: Explorations,
  exploration: Exploration,
  item: Item,
  meetings: Meetings,
  meeting: Meeting,
  metrics: Work,
  settings: Settings,
  subscription: Subscription,
  requestMetrics: RequestMetrics,
  requests: Requests,
  request: Request,
  today: Today,
};

export interface Route {
  // The page (PAGES), what it's about, and what else makes it a new page
  // to mount (Ajustes: each visit).
  page: string;
  props: Record<string, unknown>;
  key?: string;
  title: string;
  // The tabs of the items open, over it.
  tabs?: boolean;
  // Whether it takes the room of the context column.
  wide: boolean;
  // The item whose context goes under it on a phone.
  item?: ShellItem;
}

// Where the shell is (S), as the page it shows.
export function route(): Route {
  const item = itemById(S.sel);
  if (!item && (S.page === 'pedidos' || S.page === 'pedido')) {
    // A request's page takes the room of the context column.
    return S.page === 'pedido'
      ? { page: 'request', props: { ...S.ped }, title: `Pedido P-${S.ped.n}`, wide: true }
      : { page: 'requests', props: {}, title: 'Portal de pedidos', wide: false };
  }
  if (!item && (S.page === 'reuniones' || S.page === 'reunion')) {
    return S.page === 'reunion'
      ? { page: 'meeting', props: { n: S.reu.n, run: S.reu.run }, title: `Reunión R-${S.reu.n}`, wide: true }
      : { page: 'meetings', props: {}, title: 'Reuniones', wide: false };
  }
  if (!item && S.page === 'despliegues') return { page: 'deploys', props: {}, title: 'Despliegues', wide: false };
  // Its tables and charts take the room of the context column.
  if (!item && S.page === 'metricas') return { page: S.mt.tab === 'suscripcion' ? 'subscription' : S.mt.tab === 'pedidos' ? 'requestMetrics' : 'metrics', props: {}, title: 'Métricas', wide: true };
  if (!item && (S.page === 'exploraciones' || S.page === 'exploracion')) {
    return S.page === 'exploracion'
      ? { page: 'exploration', props: { repo: S.xpl.repo, app: S.xpl.app }, title: S.xpl.app ?? '', wide: false }
      : { page: 'explorations', props: {}, title: 'Exploraciones', wide: false };
  }
  // Mounted again on each visit: the page reads what to show, and reads it again.
  if (!item && S.page === 'ajustes') return { page: 'settings', props: {}, key: `settings-${S.aj.visits}`, title: 'Ajustes', wide: true };
  if (!item) return { page: 'today', props: {}, title: 'Hoy', tabs: true, wide: false };
  // Reviewing findings or a diff takes the room of the context column.
  return { page: 'item', props: { id: item.id }, title: item.title, tabs: true, wide: viewOf(item) === 'ficha' && ['fichas', 'files'].includes(docOf(item) ?? ''), item };
}

function Tabs() {
  return (
    <div className="tabs" role="tablist">{S.open.map((id) => {
      const item = itemById(id);
      const pinned = S.pinned.includes(id);
      return (
        // The wheel's click closes a tab, as in a browser; holding it down
        // there doesn't start the browser's autoscroll.
        <div key={id} className={`tab${pinned ? ' pinned' : ''}`} role="tab" aria-selected={S.sel === id} onMouseDown={(e) => { if (e.button === 1) e.preventDefault(); }} onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          closeTab(id);
        }}><button className="open" data-tab={id} onClick={() => void select(id)} onDoubleClick={() => togglePin(id)}>{item ? <RunDot state={item.status} /> : null}<span className="l">{item ? item.title : id}</span></button>
          <button className="pin" aria-pressed={pinned} aria-label={pinned ? 'Soltar la pestaña' : 'Fijar la pestaña'} title={pinned ? 'Fijada: lo que abras no la reemplaza' : 'Fijar: lo que abras no la reemplaza'} onClick={() => togglePin(id)}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 4h6l-1 6 3 3v2H7v-2l3-3zM12 15v5" /></svg></button>
          <button className="x" data-close={id} aria-label="Cerrar" onClick={() => closeTab(id)}>×</button></div>
      );
    })}</div>
  );
}

export const BackBar = ({ title }: { title: string }) => (
  <button className="back" id="back" onClick={back}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg><span>{title}</span></button>
);

// A page that breaks takes only itself: the shell around it stays.
class PageBoundary extends Component<{ children: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  componentDidCatch(error: unknown) {
    console.error(error);
  }
  render() {
    return this.state.broken ? null : this.props.children;
  }
}

// The page, drawn again only by what it reads (its queries, the hooks),
// not each time the shell around it is: `id` says it's the same page.
const PageView = memo(function PageView({ page, props }: { id: string; page: string; props: Record<string, unknown> }) {
  const Page = PAGES[page];
  return <PageBoundary><Page {...props} /></PageBoundary>;
}, (a, b) => a.id === b.id);

export function Center({ at }: { at: Route }) {
  const id = JSON.stringify([at.page, at.props, at.key ?? '']);
  let tail: ReactNode = null;
  // An item's context column, under its page on a phone.
  if (at.item) tail = <div className="ctx-inline"><ItemCtx item={at.item} /></div>;
  return (
    <main className="center" id="center">
      {at.tabs ? <Tabs /> : null}
      <BackBar title={at.title} />
      <div key={id} className="react-page" data-page={at.page}><PageView id={id} page={at.page} props={at.props} /></div>
      {tail}
    </main>
  );
}
