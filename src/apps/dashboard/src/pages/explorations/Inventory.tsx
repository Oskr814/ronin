import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { ApiError, client, ok } from '../../api.js';
import { useShell } from '../../shell/hooks.js';
import { dayMonth } from '../../lib/format.js';
import { at, INVENTORY_EVERY_MS } from './model.js';

// An app's functions as ronin found them (inventory.yml, #155 2/4), and
// which charters explored each. On the app's page, and on its exploration
// PR's (pages/item, in its Inventario tab).

type Fn = Awaited<ReturnType<typeof inventoryOf>>['funciones'][number];
const inventoryOf = (repo: string, app: string) => ok(client.api.explorations[':owner'][':name'][':app'].inventory.$get(at(repo, app)));
// A day of inventory.yml, read at noon so no time zone moves it.
const day = (date: string) => dayMonth(`${date}T12:00:00Z`);

function Pill({ f }: { f: Fn }) {
  if (f.retirada) return <span className="xi-p off">retirada el {day(f.retirada)}</span>;
  if (f.prioridad === 'alta') return <span className="xi-p hi">alta</span>;
  if (f.prioridad === 'excluida') return <span className="xi-p off">excluida</span>;
  if (!f.ultima) return <span className="xi-p new">nunca explorada</span>;
  return null;
}

export function ExplorationInventory({ repo, app }: { repo: string; app: string }) {
  const shell = useShell();
  const query = useQuery({ queryKey: ['exploration-inventory', repo, app], queryFn: () => inventoryOf(repo, app), refetchInterval: INVENTORY_EVERY_MS });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) shell.unauthorized(query.error.message);
  }, [query.error, shell]);

  const inv = query.data;
  if (!inv) return <div className="empty">{query.error ? `No se pudo leer el inventario: ${query.error.message}` : 'Leyendo el inventario…'}</div>;
  if (inv.error) return <p className="note">{inv.error}.</p>;
  const from = inv.from.pr ? `la rama del PR #${inv.from.pr}` : inv.from.branch;
  const live = inv.funciones.filter((f) => !f.retirada && f.prioridad !== 'excluida');
  const seen = live.filter((f) => f.ultima).length;
  return <>
    <p className="xi-lead">{seen} de {live.length} funciones exploradas al menos una vez. De <code>inventory.yml</code> en {from}{inv.actualizado ? `, refrescado el ${day(inv.actualizado.fecha)}` : ''}. Se edita en el repo.</p>
    <table className="padm-t xi-t">
      <thead><tr><th>Función</th><th></th><th className="hide-m">Última vez</th><th>Charters</th><th className="hide-m">Fichas</th></tr></thead>
      <tbody>{inv.funciones.map((f) => (
        <tr key={f.id} className={f.retirada || f.prioridad === 'excluida' ? 'dim' : ''}>
          <td><span className="tt">{f.nombre}</span><small>{f.rutas.join(', ') || f.id}</small>{f.notas && <small>{f.notas}</small>}</td>
          <td><Pill f={f} /></td>
          <td className="hide-m m">{f.ultima ? day(f.ultima) : '—'}{f.viewports.length > 0 && <small>{f.viewports.join(', ')}</small>}</td>
          <td><span className="xi-mx">{inv.charters.map((c) => <i key={c} className={f.charters[c] ? 'on' : ''} title={`${c}${f.charters[c] ? `: ${f.charters[c]}` : ': todavía no'}`} />)}</span><span className="m">{Object.keys(f.charters).length}/{inv.charters.length}</span></td>
          <td className="hide-m m">{f.hallazgos || ''}</td>
        </tr>
      ))}</tbody>
    </table>
  </>;
}
