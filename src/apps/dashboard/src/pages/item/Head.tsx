import { useEffect, useState, type ReactNode } from 'react';
import { useProjectColor, useRepoColor, useSession, useShell, useSnapshot } from '@apps/dashboard/src/shell/hooks.js';
import { XplHead } from '../explorations/model.js';
import { DecideBar, DecidedNote, type Decide } from './Decide.js';
import { checksChip, Chips, GhPill, itemRef, runNames, type ItemPage } from './model.js';
import { reviewLabel, ReviewPanel, type Review, type ReviewAt } from './Review.js';

// The head of an item's page (#85): what it is, its buttons (deciding a PR
// of ronin's, reviewing anyone's, the actions), and where it stands. An
// exploration PR's page is its app's (#155), headed as the app's.

// The project and cycle in Linear (#101), for a repo with a Linear key.
function LinearChips({ v }: { v: ItemPage }) {
  const projectColor = useProjectColor();
  const l = v.item.linear;
  if (!l) return null;
  return <>
    {l.project ? <span className="chip plain"><i className="pdot" style={{ background: projectColor(l.project.id), margin: 0 }} />{l.project.name}</span> : <span className="chip plain">sin proyecto</span>}
    {l.cycle ? <span className={`chip ${l.cycle.current ? 'run' : 'plain'}`}>{l.cycle.name || `Ciclo ${l.cycle.number}`}{l.cycle.current ? ', el actual' : ''}</span> : <span className="chip plain">sin ciclo</span>}
  </>;
}

// The review button, with the panel under it when it's open there.
export function ReviewButton({ v, review, at, button }: { v: ItemPage; review: Review; at: ReviewAt; button: ReactNode }) {
  return <div className="actions rwrap">{button}{review.p?.at === at && <ReviewPanel v={v} review={review} />}</div>;
}

// On a phone, an exploration PR's head keeps Acciones and Finalizar; the
// rest goes under ⋯ (#446).
function HeadMore({ url, general, repo, app }: { url: string | null; general: () => void; repo: string; app: string }) {
  const shell = useShell();
  const session = useSession();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [open]);
  return (
    <span className="actions only-m"><button className="gh" id="hmore" aria-haspopup="menu" aria-expanded={open} aria-label="Más" onClick={(e) => { e.stopPropagation(); setOpen(!open); }}>⋯</button>
      {open && <div className="menu" role="menu">
        <button role="menuitem" onClick={general}><b>Comentario general</b><small>Sobre varias fichas a la vez.</small></button>
        {session.can(repo, 'acciones') && <button role="menuitem" onClick={() => shell.exploreNow(repo, app)}><b>Explorar ahora</b><small>Otra corrida de exploración de {app}.</small></button>}
        {url && <a role="menuitem" className="menu-link" href={url} target="_blank" rel="noopener"><b>Abrir el PR en GitHub ↗</b></a>}</div>}</span>
  );
}

const STATE_CHIP: Record<string, [string, string]> = { running: ['run', 'trabajando'], blocked: ['crit', 'bloqueado'], waiting: ['warn', 'esperando a alguien'] };

export function Head({ v, actions, decide, review, explore }: { v: ItemPage; actions: ReactNode; decide: Decide; review: Review; explore: (action: 'general' | 'approve') => void }) {
  const shell = useShell();
  const repoColor = useRepoColor();
  const snap = useSnapshot();
  const { item } = v;
  // A slice's PR says whose and which one, and goes back to its issue.
  const spec = item.kind === 'pr' ? snap.items.find((i) => i.repo === item.repo && i.slices?.some((s) => s.prNumber === item.number)) : undefined;
  const slice = spec?.slices?.find((s) => s.prNumber === item.number);
  const d = v.detail?.data;
  const general = d?.exploration && <button className="gh hide-m" onClick={() => explore('general')}>Comentario general</button>;
  const finish = d?.exploration && <button className="act-btn" title="Termina la revisión: aprueba las fichas que quedan y mergea el PR" onClick={() => explore('approve')}>Finalizar…</button>;
  if (v.exploration) {
    const url = item.url?.startsWith('https://github.com/') ? item.url : /^[\w.-]+\/[\w.-]+$/.test(item.repo) && item.number !== undefined ? `https://github.com/${item.repo}/${item.kind === 'pr' ? 'pull' : 'issues'}/${item.number}` : null;
    return <XplHead r={v.exploration} compact pill={<GhPill item={item} d={d} />} buttons={<>{url && <a className="gh hide-m" href={url} target="_blank" rel="noopener">PR #{item.number} ↗</a>}{general}{actions}{finish}{d?.exploration && <HeadMore url={url} general={() => explore('general')} repo={item.repo} app={v.exploration.app} />}</>} />;
  }
  const pr = item.pr;
  const prDoc = d?.pr;
  const pending = v.files.pending.length;
  // For an issue, what's said about its PR is said with the PR's number.
  const of = item.kind === 'issue' && pr ? `#${pr.number}: ` : '';
  // A run's outcome is in the activity line, not here: "terminó bien" next to "conflictos" would read as the PR's.
  const chips: Array<[string, string]> = STATE_CHIP[item.status] ? [STATE_CHIP[item.status]] : [];
  if (prDoc?.mergeable === 'CONFLICTING') chips.push(['crit', `${of}conflictos con ${prDoc.baseRefName}`]);
  const checks = checksChip(pr?.checks);
  if (checks) chips.push([checks[0], of + checks[1]]);
  if (pr?.reviewDecision === 'APPROVED') chips.push(['ok', `${of}aprobado`]);
  else if (pr?.reviewDecision === 'CHANGES_REQUESTED') chips.push(['warn', `${of}cambios pedidos`]);
  if (pr?.isDraft) chips.push(['idle', `${of}draft`]);
  const facts: string[] = [];
  if (item.slices?.length) facts.push(`${item.slices.filter((s) => s.status === 'merged').length} de ${item.slices.length} slices mergeadas`);
  if (item.note && item.status !== 'running') facts.push(item.note);
  if (item.kind === 'pr' && prDoc?.headRefName) facts.push(`${prDoc.headRefName} → ${prDoc.baseRefName}`);
  if (item.kind === 'pr' && pr?.author) facts.push(`de ${pr.author}`);
  const open = review.p?.at === 'head';
  const reviewButton = v.reviewable && <ReviewButton v={v} review={review} at="head" button={pending
    ? <button className="act-btn" aria-haspopup="dialog" aria-expanded={open} onClick={(e) => { e.stopPropagation(); review.open('head'); }}>Terminar revisión <span className="rn">{pending}</span> ▾</button>
    : <button className="gh" aria-haspopup="dialog" aria-expanded={open} onClick={(e) => { e.stopPropagation(); review.open('head'); }}>{reviewLabel(v)} ▾</button>} />;
  return (
    <div className="head">
      <div className="crumb"><i style={{ background: repoColor(item.repo) }} />{item.repo} · {item.kind === 'pr' ? 'Pull request' : item.kind === 'issue' ? 'Issue' : 'Tarea'}</div>
      <div className="row"><h1>{item.title}{item.number !== undefined && <> <span className="n">{itemRef(item, runNames.kind)}</span></>}</h1>{general}{v.decidable ? <div className="hbtns"><DecideBar v={v} decide={decide} />{actions}</div> : reviewButton}{!v.decidable && actions}{finish}</div>
      <div className="state"><GhPill item={item} d={d} />{spec && slice && <button className="chip plain goped" title={spec.title} onClick={() => shell.openItem(spec.id)}>slice {slice.index + 1} de {spec.slices!.length} de #{spec.number}</button>}{d?.pedido && <button className="chip plain goped" title={d.pedido.title} onClick={() => shell.openRequest(d.pedido!.number)}>del pedido P-{d.pedido.number}</button>}<LinearChips v={v} /><Chips chips={chips} />{v.decidable && pending > 0 && <span className="chip run">✎ {pending} en Archivos</span>}{facts.map((f, i) => <span key={i}>{f}</span>)}</div><DecidedNote id={item.id} /></div>
  );
}
