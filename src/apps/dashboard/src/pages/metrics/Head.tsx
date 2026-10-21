import type { ReactNode } from 'react';
import { useShell } from '../../shell/hooks.js';

// The head of both tabs of Métricas: the title, what the tab is about, its
// filters, and the tabs, each at its own address (/metricas,
// /metricas/suscripcion), which the shell routes.
export function Head({ tab, lead, filters }: { tab: 'trabajo' | 'suscripcion'; lead: string; filters: ReactNode }) {
  const shell = useShell();
  return <>
    <div className="mt-top"><div><h1>Métricas</h1><p className="lead">{lead}</p></div>{filters}</div>
    <div className="doctabs mt-tabs" role="tablist">
      <button className="doctab" role="tab" aria-selected={tab === 'trabajo'} onClick={() => shell.openMetrics('trabajo')}>Trabajo</button>
      <button className="doctab" role="tab" aria-selected={tab === 'suscripcion'} onClick={() => shell.openMetrics('suscripcion')}>Suscripción</button>
    </div>
  </>;
}
