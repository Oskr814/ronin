import { useEffect } from 'react';
import { useHost } from '../../host.js';
import { RunDot } from '../../lib/runs.js';
import { Body, Comments, conversation } from '../item/Doc.js';
import { Avatar, checksChip, Chips, GhPill, useItem } from '../item/model.js';
import { when } from '../../lib/format.js';
import type { Detail } from './model.js';

// The request's issue and its PR (#158), read as on their page, without
// leaving the request: the shell reads them (Host.watchItem), again as
// GitHub's copy gets old. Acting on them (comments, review, actions) stays
// on their page.
export function GitHub({ d, show, setShow }: { d: Detail; show: 'issue' | 'pr'; setShow: (show: 'issue' | 'pr') => void }) {
  const host = useHost();
  const issue = d.issue!.number;
  const isPr = Boolean(show === 'pr' && d.pr);
  const key = `${d.repo}#${isPr ? d.pr : issue}`;
  useEffect(() => host.watchItem(key, isPr ? 'pr' : 'issue'), [host, key, isPr]);
  const v = useItem(key);
  // The PR's checks and review, from the sidebar's issue or PR when it's there.
  const issueView = useItem(`${d.repo}#${issue}`);
  const prView = useItem(d.pr ? `${d.repo}#${d.pr}` : '');
  const pr = [issueView?.item, prView?.item].map((i) => i?.pr).find((p) => p && p.number === d.pr);
  const checks = checksChip(pr?.checks);
  const dd = v?.detail?.data;
  const doc = dd && (isPr ? dd.pr : dd.issue);
  const bar = (
    <div className="pd-ghbar"><div className="seg"><button aria-pressed={!isPr} onClick={() => setShow('issue')}>Issue #{issue}</button>{d.pr ? <button aria-pressed={isPr} onClick={() => setShow('pr')}>PR #{d.pr}{checks?.[0] === 'crit' && <RunDot state="error" />}</button> : <button disabled>Sin PR todavía</button>}</div>
      <span className="sp">{isPr && doc?.state === 'OPEN' && <button className="act-btn" onClick={() => {
        host.showDoc(key, 'files');
        host.openItem(key);
      }}>Revisar el PR</button>}<button className="gh" onClick={() => host.openItem(key)}>Abrir la ficha</button>{doc && <a className="gh" href={doc.url} target="_blank" rel="noopener">GitHub ↗</a>}</span></div>
  );
  if (!v || !dd || !doc) {
    const error = v?.detail?.error ?? dd?.error;
    return <div>{bar}<div className="empty">{error ? `No se pudo leer de GitHub: ${error}` : 'Cargando de GitHub…'}</div></div>;
  }
  const chips: Array<[string, string]> = [];
  if (isPr && checks) chips.push(checks);
  if (isPr && doc.mergeable === 'CONFLICTING') chips.push(['crit', `conflictos con ${doc.baseRefName}`]);
  if (isPr && pr?.reviewDecision === 'APPROVED') chips.push(['ok', 'aprobado']);
  else if (isPr && pr?.reviewDecision === 'CHANGES_REQUESTED') chips.push(['warn', 'cambios pedidos']);
  const facts: string[] = [];
  const item = v.item;
  if (!isPr && item.slices?.length) facts.push(`${item.slices.filter((sl) => sl.status === 'merged').length} de ${item.slices.length} slices mergeadas`);
  if (isPr && doc.headRefName) facts.push(`${doc.headRefName} → ${doc.baseRefName}`);
  return (
    <div>{bar}<div className="pd-ghhead"><h2>{doc.title} <span className="n">#{doc.number}</span></h2>
      <div className="state"><GhPill item={item} d={dd} /><Chips chips={chips} />{doc.labels.map((l) => <span key={l} className="chip plain">{l}</span>)}{facts.map((f) => <span key={f}>{f}</span>)}</div></div>
      <div className="page pd-ghpage"><div className="meta"><Avatar login={doc.author} /><b>{doc.author}</b><span>{when(doc.createdAt)}</span></div>
        <Body body={doc.body} repo={d.repo} /></div>
      {conversation(doc).length ? <Comments doc={doc} ronin={dd.ronin} repo={d.repo} /> : <p className="m pd-note">Nadie comentó todavía.</p>}</div>
  );
}
