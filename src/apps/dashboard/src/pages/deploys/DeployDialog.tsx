import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError, client, ok } from '../../api.js';
import { useHost } from '../../host.js';
import { ago, useNow } from '../../lib/time.js';
import { at, planOf, subject, type Plan, type Repos } from './model.js';

const PLAN_MS = 450;

// The dialog: like GitHub's "Draft a new release". What goes in is planned
// on the server as it's typed (the tag checked, the cherry-picks tried), and
// publishing sends that plan's fingerprint, so what's published is what was
// shown.
export function DeployDialog({ repos, repo, pr, onClose }: { repos: Repos; repo: string; pr?: number; onClose: () => void }) {
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
      const done = await ok(client.api.deploys[':owner'][':name'].publish.$post({ ...at(repo), json: { ...body, title: title.trim() || undefined, notes: notes.trim() || undefined, fingerprint: current.fingerprint } }));
      onClose();
      host.toast(`Publicado ${done.tag}: el workflow del repo ya arrancó.${done.pedidos.length ? ` ${done.pedidos.map((n) => `P-${n}`).join(', ')} ${done.pedidos.length === 1 ? 'recibe' : 'reciben'} el aviso cuando termine bien.` : ''}`, done.url || undefined);
      void queryClient.invalidateQueries({ queryKey: ['deploys'] });
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
