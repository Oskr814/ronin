import type { ReactNode } from 'react';
import { useHost } from '../../host.js';

// The head of both tabs of Métricas: the title, what the tab is about, its
// filters, and the tabs, each at its own address (/metricas,
// /metricas/suscripcion), which app.js routes.
export function Head({ tab, lead, filters }: { tab: 'trabajo' | 'suscripcion'; lead: string; filters: ReactNode }) {
  const host = useHost();
  return <>
    <div className="mt-top"><div><h1>Métricas</h1><p className="lead">{lead}</p></div>{filters}</div>
    <div className="doctabs mt-tabs" role="tablist">
      <button className="doctab" role="tab" aria-selected={tab === 'trabajo'} onClick={() => host.openMetrics('trabajo')}>Trabajo</button>
      <button className="doctab" role="tab" aria-selected={tab === 'suscripcion'} onClick={() => host.openMetrics('suscripcion')}>Suscripción</button>
    </div>
  </>;
}
