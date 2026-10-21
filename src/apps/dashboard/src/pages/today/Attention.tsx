import type { ReactNode } from 'react';
import type { Snapshot } from '@apps/dashboard/src/api.js';
import { useShell } from '@apps/dashboard/src/shell/hooks.js';
import { repoShort } from '@apps/dashboard/src/lib/format.js';
import { GhIcon } from '@apps/dashboard/src/lib/github.js';
import { Dot } from '@apps/dashboard/src/lib/runs.js';
import { useViewState } from '@apps/dashboard/src/lib/view-state.js';
import { short } from '@ui/time.js';
import type { Attention, Item } from './model.js';

// What waits on a person, by kind; ronin's PRs, the first four until asked for all.
export function AttentionCard({ a, snap, now }: { a: Attention; snap: Snapshot; now: number }) {
  const shell = useShell();
  const [all, setAll] = useViewState('today.attention', false);
  const ref = (i: Item) => [`#${i.number}`, i.linear?.id].filter(Boolean).join(' · ');
  const row = (key: string, cls: string, title: string, sub: string, when: string, id: string | undefined, icon: ReactNode = null) => (
    <button key={key} className="arow" onClick={id ? () => shell.openItem(id) : undefined}><Dot cls={cls} /><span className="t">{title}</span><span className="w">{when}</span><span className="s">{icon}{sub}</span></button>
  );
  const none = <div className="none">Ninguno.</div>;
  const total = a.blocked.length + a.review.length + a.exploration.length + a.previews.length;
  const shownReview = all ? a.review : a.review.slice(0, 4);
  return (
    <div className="card"><h2>Necesitan tu atención<span className="c">{total || 'nada'}</span></h2><div className="att">
      <div className="ag">Bloqueados, esperan una respuesta</div>
      {a.blocked.length ? a.blocked.map((i) => row(i.id, 'crit', i.title, `${ref(i)} · ${i.block?.reason ?? 'el motivo está en el email del bloqueo'}`, i.block ? `hace ${short(now - Date.parse(i.block.at))}` : '', i.id, <GhIcon kind="issue" state={i.github} />)) : none}
      <div className="ag">PRs de ronin que esperan tu review o tu merge, el que más espera primero</div>
      {a.review.length ? shownReview.map((i) => row(i.id, i.pr!.reviewDecision === 'APPROVED' ? 'ok' : 'warn', i.title, `PR #${i.pr!.number} · ${[i.linear?.id, i.pr!.reviewDecision === 'APPROVED' ? 'aprobado, falta el merge' : i.pr!.checks.length ? 'checks en verde' : 'sin checks'].filter(Boolean).join(' · ')}`, `hace ${short(now - a.waitedSince(i))}`, i.id, <GhIcon kind="pr" state="open" />)) : none}
      {a.review.length > 4 && <button className="more-l" id="att-more" onClick={() => setAll(!all)}>{all ? 'Ver menos' : `Ver los ${a.review.length} →`}</button>}
      {a.exploration.length || a.previews.length ? <div className="ag">Exploración y previews</div> : null}
      {a.exploration.map((i) => row(i.id, 'run', i.title, `PR #${i.number} · ${repoShort(i.repo)} · fichas para revisar`, i.lastRun ? `hace ${short(now - Date.parse(i.lastRun.endedAt ?? i.lastRun.startedAt))}` : '', i.id, <GhIcon kind="pr" state={i.github} />))}
      {a.previews.map((p) => {
        const left = p.expiresAt ? Date.parse(p.expiresAt) - now : null;
        const item = snap.items.find((i) => i.repo === p.repo && (i.number === p.prNumber || i.slices?.some((sl) => sl.prNumber === p.prNumber)));
        return row(`${p.repo}#${p.prNumber}`, p.preparing || p.updating ? 'live' : 'ok', `Preview de #${p.prNumber} ${p.updating ? 'actualizando' : p.preparing ? 'preparando datos' : 'arriba'}`, `${p.appName} · ${repoShort(p.repo)}${left !== null ? ` · se baja en ${short(left)}` : ''}`, p.startedAt ? short(now - Date.parse(p.startedAt)) : '', item?.id);
      })}
    </div></div>
  );
}
