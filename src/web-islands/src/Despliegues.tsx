import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, client, ok, type Despliegues as Repos } from './api.js';
import { useHost } from './host.js';
import { ago, useNow } from './time.js';

// Despliegues (#158): a deploy is a GitHub release ronin publishes on the
// tag someone writes; the repo's workflow does the rest. Everything on the
// branch, or — where the repo allows it (deploy.selective) — only the PRs
// picked, cherry-picked onto the last release.

type Repo = Repos[number];
type Ok = Extract<Repo, { pending: unknown }>;
type Change = Ok['pending']['changes'][number];
type Release = Ok['releases'][number];
type Plan = Awaited<ReturnType<typeof planOf>>;

const EVERY_MS = 30_000;
// While a deploy's workflow goes.
const GOING_EVERY_MS = 10_000;
const PLAN_MS = 450;
const STATE: Record<string, [string, string]> = { running: ['live', 'en curso'], deployed: ['ok', 'desplegado'], failed: ['crit', 'falló'], unknown: ['idle', 'sin workflow'] };

const going = (repos: Repos | undefined) => (repos ?? []).some((r) => 'releases' in r && r.releases.some((x) => x.deploy?.state === 'running'));
const subject = (c: Change) => c.subject.replace(/\s*\(#\d+\)\s*$/, '');
const at = (repo: string) => {
  const [owner, name] = repo.split('/');
  return { param: { owner, name } };
};

function planOf(repo: string, body: { tag: string; prs: 'all' | number[]; prerelease: boolean }) {
  return ok(client.api.despliegues[':owner'][':name'].plan.$post({ ...at(repo), json: body }));
}

export function Despliegues() {
  const host = useHost();
  const [dialog, setDialog] = useState<{ repo: string; pr?: number } | null>(null);
  const query = useQuery({
    queryKey: ['despliegues'],
    queryFn: () => ok(client.api.despliegues.$get()).then((d) => d.repos),
    // Not while the dialog is open: it plans on its own.
    refetchInterval: (q) => (dialog ? false : going(q.state.data) ? GOING_EVERY_MS : EVERY_MS),
  });
  const repos = query.data;
  useEffect(() => {
    if (repos) host.read?.('despliegues', repos);
  }, [repos, host]);
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) host.unauthorized(query.error.message);
  }, [query.error, host]);

  const head = (
    <>
      <h1>Despliegues</h1>
      <p className="lead">Un despliegue es un release de GitHub: ronin lo publica con el tag que escribas y el workflow del repo hace el resto. Lleva todo lo mergeado o, donde el repo lo permite, solo los PRs que elijas. Cuando el workflow termina bien, los pedidos del portal que entraron le avisan a su persona.</p>
    </>
  );
  const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? <p className="bad">{query.error.message}</p> : null;
  return (
    <div className="today pd">
      {head}
      {error}
      {!repos ? (!error && <div className="empty">Cargando…</div>)
        : repos.length ? repos.map((r) => <Card key={r.repo} r={r} onNew={(pr) => setDialog({ repo: r.repo, pr })} />)
          : <p className="note">Ningún repo tiene <code>deploy</code> en repos.json.</p>}
      {dialog && repos && <Dialog repos={repos} repo={dialog.repo} pr={dialog.pr} onClose={() => setDialog(null)} />}
    </div>
  );
}

function Card({ r, onNew }: { r: Repo; onNew: (pr?: number) => void }) {
  const host = useHost();
  const now = useNow();
  const header = <i style={{ background: host.repoColor(r.repo) }} />;
  if (!('pending' in r)) {
    return <section className="pd-card dep-card"><header>{header}<b>{r.repo}</b></header><p className="bad">No se pudo leer: {r.error}</p></section>;
  }
  const p = r.pending;
  return (
    <section className="pd-card dep-card">
      <header>
        {header}<b>{r.repo}</b>
        <span className="m">desde {r.branch}{r.prerelease ? ' · con pre-releases' : ''}{r.selective ? ' · PRs elegidos' : ''}</span>
        <button className="act-btn" onClick={() => onNew()}>Nuevo despliegue</button>
      </header>
      <div className="dep-pend">
        {!p.base ? <p className="m">El repo no tiene releases todavía: el primero lleva todo lo de la rama.</p>
          : p.changes.length ? (
            <>
              <div className="dep-h"><b>{p.changes.length === 1 ? '1 cambio' : `${p.changes.length} cambios`}</b> mergeados desde <span className="pd-gh">{p.base}</span>, sin desplegar</div>
              <ul className="dep-list">
                {p.changes.map((c) => (
                  <li key={c.sha}>
                    <span className="pd-gh">{c.pr ? `#${c.pr}` : c.sha.slice(0, 7)}</span><span className="t">{subject(c)}</span>
                    {c.apps.length > 0 && <span className="apps">{c.apps.join(' · ')}</span>}
                    {c.pedidos.map((n) => <button key={n} className="chip plain goped" onClick={() => host.openPedido(n)}>del pedido P-{n}</button>)}
                    {r.selective && c.pr && <button className="link" onClick={() => onNew(c.pr!)}>Desplegar solo este</button>}
                  </li>
                ))}
              </ul>
            </>
          ) : <p className="m">Nada mergeado desde {p.base}.</p>}
      </div>
      {r.releases.length > 0 && (
        <table className="padm-t dep-t">
          <thead><tr><th>Release</th><th className="hide-m">Publicado</th><th>Workflow</th><th className="hide-m">Por</th></tr></thead>
          <tbody>{r.releases.map((x) => <ReleaseRow key={x.tag} x={x} now={now} />)}</tbody>
        </table>
      )}
    </section>
  );
}

function ReleaseRow({ x, now }: { x: Release; now: number }) {
  const d = x.deploy;
  const [cls, label] = d ? STATE[d.state] ?? STATE.unknown : [];
  return (
    <tr>
      <td>
        <span className="dep-tag">{x.url ? <a href={x.url} target="_blank" rel="noopener">{x.tag}</a> : x.tag}</span>
        {x.latest && <span className="chip ok">Latest</span>}{x.prerelease && <span className="chip warn">Pre-release</span>}{d?.mode === 'pick' && <span className="chip run">Solo elegidos</span>}
      </td>
      <td className="hide-m m">{ago(x.at, now)}</td>
      <td>
        {d ? (
          <>
            <span className="dep-wf">
              <span className={`dot ${cls}`} aria-hidden="true" />{label}
              {d.runs.length > 0 && <> · {d.runs.map((run, i) => <span key={run.url}>{i > 0 && ', '}<a href={run.url} target="_blank" rel="noopener">{run.name}</a></span>)}</>}
            </span>
            {d.releaseError && <small className="bad">El release no se creó: {d.releaseError}</small>}
            {d.pedidos.length > 0 && <small>{d.pedidos.map((n) => `P-${n}`).join(', ')}</small>}
          </>
        ) : <span className="m">publicado en GitHub</span>}
      </td>
      <td className="hide-m m">{d?.by ?? ''}</td>
    </tr>
  );
}

// The dialog: like GitHub's "Draft a new release". What goes in is planned
// on the server as it's typed (the tag checked, the cherry-picks tried), and
// publishing sends that plan's fingerprint, so what's published is what was
// shown.
function Dialog({ repos, repo, pr, onClose }: { repos: Repos; repo: string; pr?: number; onClose: () => void }) {
  const host = useHost();
  const queryClient = useQueryClient();
  const now = useNow();
  const r = repos.find((x) => x.repo === repo);
  const okRepo = r && 'pending' in r ? r : undefined;
  const [tag, setTag] = useState('');
  const [pre, setPre] = useState(false);
  const [mode, setMode] = useState<'all' | 'pick'>(pr ? 'pick' : 'all');
  const [sel, setSel] = useState<Set<number>>(new Set(pr ? [pr] : []));
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [plan, setPlan] = useState<{ key: string; plan: Plan } | null>(null);
  const [planning, setPlanning] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tagBox = useRef<HTMLInputElement>(null);
  useEffect(() => tagBox.current?.focus(), []);

  const p = (pre ? okRepo?.prePending : okRepo?.pending) ?? { base: null, changes: [] };
  const body = { tag: tag.trim(), prs: mode === 'all' ? ('all' as const) : [...sel], prerelease: pre };
  const key = JSON.stringify([repo, body.tag, pre, mode, mode === 'pick' ? [...sel].sort((a, b) => a - b) : 'all']);
  const current = plan?.key === key ? plan.plan : null;

  const close = () => {
    if (!sending) onClose();
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  });

  // Planned a moment after the last change, and only the latest counts.
  useEffect(() => {
    if (!body.tag || (mode === 'pick' && !sel.size)) return;
    let stale = false;
    const timer = setTimeout(async () => {
      setPlanning(true);
      try {
        const next = await planOf(repo, body);
        if (!stale) {
          setPlan({ key, plan: next });
          setError(null);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return host.unauthorized(e.message);
        if (!stale) {
          setPlan(null);
          setError((e as Error).message);
        }
      } finally {
        if (!stale) setPlanning(false);
      }
    }, PLAN_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [key]);

  const send = async () => {
    if (sending || !current || current.problems.length) return;
    setSending(true);
    setError(null);
    try {
      const done = await ok(client.api.despliegues[':owner'][':name'].publish.$post({ ...at(repo), json: { ...body, title: title.trim() || undefined, notes: notes.trim() || undefined, fingerprint: current.fingerprint } }));
      onClose();
      host.toast(`Publicado ${done.tag}: el workflow del repo ya arrancó.${done.pedidos.length ? ` ${done.pedidos.map((n) => `P-${n}`).join(', ')} ${done.pedidos.length === 1 ? 'recibe' : 'reciben'} el aviso cuando termine bien.` : ''}`, done.url || undefined);
      void queryClient.invalidateQueries({ queryKey: ['despliegues'] });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return host.unauthorized(e.message);
      setSending(false);
      setError((e as Error).message);
      // What goes in changed: the new plan, to look at again.
      if (e instanceof ApiError && e.body?.plan) setPlan({ key, plan: e.body.plan as Plan });
    }
  };

  const lastFull = okRepo?.releases.find((rel) => !rel.prerelease && !rel.deploy?.releaseError);
  const lastPre = okRepo?.releases.find((rel) => rel.prerelease);
  const problemText = (kind: (k: string) => boolean) => current?.problems.flatMap((pb, i) => (kind(pb.kind) ? [current.messages[i]] : [])) ?? [];
  const tagProblem = problemText((k) => k === 'tag-invalid' || k === 'tag-exists')[0];
  const conflicts = new Map((current?.problems ?? []).filter((pb) => pb.kind === 'conflict').map((pb) => [pb.pr, pb]));
  const others = problemText((k) => !['tag-invalid', 'tag-exists', 'conflict'].includes(k));
  const count = current ? current.changes.length : mode === 'all' ? p.changes.length : sel.size;
  const peds = [...new Set((current?.changes ?? []).flatMap((c) => c.pedidos))];
  const ready = current && !current.problems.length && !planning && !sending;
  const toggle = (n: number, on: boolean) => {
    const next = new Set(sel);
    if (on) next.add(n);
    else next.delete(n);
    setSel(next);
  };

  // On the body, as the page's other dialogs: app.js's showLogin finds it
  // there to know something is half written.
  return createPortal(
    <div className="scrim" onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="dlg dep-dlg" role="dialog" aria-modal="true" aria-labelledby="dp-t">
        <h2 id="dp-t">Nuevo despliegue · {repo}</h2>
        <p className="help">Como “Draft a new release” en GitHub: ronin sube el tag y publica el release; el workflow del repo hace el resto.</p>
        <label className="field"><span>Tag</span>
          <input id="dp-tag" ref={tagBox} className="mono" value={tag} placeholder={lastFull?.tag ?? 'v1.0.0'} autoComplete="off" spellCheck={false} onChange={(e) => setTag(e.target.value)} />
          <small>Último: {lastFull ? <><span className="pd-gh">{lastFull.tag}</span> {ago(lastFull.at, now)}</> : 'ninguno'}{okRepo?.prerelease && lastPre && <> · pre-release: <span className="pd-gh">{lastPre.tag}</span></>}</small>
          {!tag.trim() ? <small>Se crea al publicar{mode === 'all' ? `, sobre la punta de ${okRepo?.branch ?? ''}` : `, sobre ${p.base ?? 'el último release'} y los PRs elegidos`}.</small>
            : tagProblem ? <small className="bad">{tagProblem}</small>
              : current ? <small className="ok">✓ Tag nuevo: se crea al publicar.</small> : <small>Revisando…</small>}
        </label>
        {okRepo?.prerelease && (
          <label className="check"><input type="checkbox" id="dp-pre" checked={pre} onChange={(e) => {
            const on = e.target.checked;
            const changes = (on ? okRepo.prePending : okRepo.pending)?.changes ?? [];
            setPre(on);
            setSel(new Set([...sel].filter((n) => changes.some((c) => c.pr === n))));
          }} /><span>Pre-release<small>Lo compara con el último pre-release{p.base ? ` (${p.base})` : ''}.</small></span></label>
        )}
        <div className="field"><span>Qué entra</span>
          {okRepo?.selective ? (
            <>
              <div className="seg dep-seg">
                <button aria-pressed={mode === 'all'} onClick={() => setMode('all')}>Todo lo de {okRepo.branch} <span className="c">{p.changes.length}</span></button>
                <button aria-pressed={mode === 'pick'} onClick={() => setMode('pick')}>Solo lo que elijas</button>
              </div>
              {mode === 'pick' && (
                <div className="dep-pick">
                  {p.changes.filter((c) => c.pr).length ? p.changes.filter((c) => c.pr).map((c) => {
                    const bad = conflicts.get(c.pr!);
                    return (
                      <label key={c.pr} className={bad ? 'bad' : ''}>
                        <input type="checkbox" checked={sel.has(c.pr!)} onChange={(e) => toggle(c.pr!, e.target.checked)} />
                        <span className="pd-gh">#{c.pr}</span>
                        <span className="t">{subject(c)}{bad && <small>No se aplica: choca en {bad.files.join(', ') || 'el commit'}.{bad.needs.length ? ` Elige también ${bad.needs.map((n) => `#${n}`).join(', ')}.` : ''}</small>}</span>
                        {c.apps.length > 0 && <span className="apps">{c.apps.join(' · ')}</span>}
                        {c.pedidos.map((n) => <span key={n} className="chip plain">P-{n}</span>)}
                      </label>
                    );
                  }) : <p className="m">Nada mergeado sin desplegar.</p>}
                </div>
              )}
            </>
          ) : <p className="help">{p.changes.length ? `Todo lo mergeado en ${okRepo?.branch ?? ''}: ${p.changes.map((c) => (c.pr ? `#${c.pr}` : c.sha.slice(0, 7))).join(', ')}.` : 'Nada mergeado sin desplegar.'}</p>}
        </div>
        {mode === 'pick' && current && sel.size > 0 && (conflicts.size
          ? <p className="dep-probe bad">✕ ronin lo probó: {[...conflicts.keys()].map((n) => (n ? `#${n}` : 'un commit')).join(', ')} no se aplica limpio sobre {current.base ?? ''}.</p>
          : current.target ? <p className="dep-probe ok">✓ ronin lo probó: {current.changes.length === 1 ? 'se aplica' : `los ${current.changes.length} se aplican`} limpio sobre {current.base ?? ''}.</p> : null)}
        {current && current.apps.length > 0 && <p className="help">Apps que cambian: <b>{current.apps.join(', ')}</b>.</p>}
        {others.map((m) => <p key={m} className="bad">{m}</p>)}
        <label className="field"><span>Título</span><input id="dp-title" value={title} placeholder={tag.trim() || 'Igual que el tag'} onChange={(e) => setTitle(e.target.value)} /></label>
        <label className="field"><span className="dep-nl">Notas<button className="btn-s" disabled={!current?.notes} onClick={() => current?.notes && setNotes(current.notes)}>Generar notas</button></span>
          <textarea id="dp-notes" rows={6} placeholder="Si las dejas vacías, ronin pone la lista de lo que entra." value={notes} onChange={(e) => setNotes(e.target.value)} />
        </label>
        {okRepo?.prerelease && <p className={`dep-where ${pre ? 'qa' : 'prod'}`}>{pre ? 'Un pre-release: el workflow del repo lo despliega como pre-release (QA). No avisa a los pedidos.' : 'Un release completo: queda como Latest, y el workflow del repo lo despliega a producción.'}</p>}
        <p className="bad" hidden={!error}>{error ?? ''}</p>
        <div className="foot-d">
          <span className="kbd-hint">{count === 1 ? 'Entra 1 cambio' : `Entran ${count} cambios`}{peds.length > 0 && ` · avisa a ${peds.map((n) => `P-${n}`).join(', ')}`}</span>
          <button className="btn-s" onClick={close}>Cancelar</button>
          <button className="btn-s primary" disabled={!ready} onClick={() => void send()}>{sending ? 'Publicando…' : planning ? 'Revisando…' : okRepo?.prerelease ? (pre ? 'Publicar el pre-release' : 'Publicar y desplegar a producción') : 'Publicar y desplegar'}</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
