import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { ApiError, client, ok, type MeetingRow } from '../../api.js';
import { useHost } from '../../host.js';
import { repoShort, when } from '../../lib/format.js';
import { Dot } from '../../lib/runs.js';
import { ago, useNow } from '../../../../../ui/time.js';
import { plural, source, STATUS } from './model.js';
import { Upload } from './Upload.js';

// Reuniones (#62): the team uploads a meeting's notes (a PDF, a Word .docx,
// text, or pasted) and ronin proposes the work that comes out of it. Anyone
// who sees a repo uploads to it and sees its meetings. The notes stay on the
// runner.

// Read again this often while the page is open.
export const EVERY_MS = 10_000;

export function StatusChip({ m }: { m: Pick<MeetingRow, 'status'> }) {
  const [cls, label] = STATUS[m.status] ?? ['idle', m.status];
  return <span className={`chip ${cls}`}>{m.status === 'reading' && <Dot cls="live" />}{label}</span>;
}

function Counts({ c }: { c: MeetingRow['counts'] }) {
  if (!c) return <span className="m">—</span>;
  const parts = [c.projects ? plural(c.projects, 'proyecto', 'proyectos') : '', c.issues ? plural(c.issues, 'issue', 'issues') : '', c.comments ? plural(c.comments, 'comentario', 'comentarios') : ''].filter(Boolean);
  return <span className="reu-counts">{parts.map((p) => <span key={p}>{p}</span>)}<span className="m">{plural(c.discarded, 'descartado', 'descartados')}</span></span>;
}

export function Meetings() {
  const host = useHost();
  const now = useNow();
  const [uploading, setUploading] = useState(false);
  const query = useQuery({
    queryKey: ['meetings'],
    queryFn: () => ok(client.api.meetings.$get()).then((d) => d.meetings),
    refetchInterval: EVERY_MS,
  });
  useEffect(() => {
    if (query.error instanceof ApiError && query.error.status === 401) host.unauthorized(query.error.message);
  }, [query.error, host]);
  // The repos it can upload a meeting's notes to (#174).
  const repos = host.repos().filter((repo) => host.can(repo, 'notas'));

  const head = (
    <div className="reu-top">
      <div><h1>Reuniones</h1><p className="lead">Sube las notas de una reunión (PDF, Word o texto) y ronin propone el trabajo que sale de ella: proyectos de Linear, issues y comentarios en issues que ya existen. Nada se crea hasta que alguien lo apruebe aquí.</p></div>
      {repos.length > 0 && <button className="btn-s primary" onClick={() => setUploading(true)}>+ Subir notas</button>}
    </div>
  );
  const list = query.data;
  const upload = uploading && <Upload repos={repos} onClose={() => setUploading(false)} />;
  if (!list) {
    const error = query.error && !(query.error instanceof ApiError && query.error.status === 401) ? query.error.message : null;
    return <div className="today pd">{head}{error ? <p className="bad">{error}</p> : <div className="empty">Cargando…</div>}{upload}</div>;
  }
  return (
    <div className="today pd">
      {head}
      {list.length ? (
        <table className="padm-t pd-t">
          <thead><tr><th></th><th>Reunión</th><th>Estado</th><th className="hide-m">Propuestas</th><th className="hide-m">Subida por</th></tr></thead>
          <tbody>
            {list.map((m) => (
              <tr key={m.number} tabIndex={0} onClick={() => host.openMeeting(m.number)} onKeyDown={(e) => e.key === 'Enter' && host.openMeeting(m.number)}>
                <td className="pn">R-{m.number}</td>
                <td><span className="tt">{m.title}</span><small>{m.at ? `${when(m.at)} · ` : ''}{repoShort(m.repo)} · {source(m)}</small></td>
                <td><StatusChip m={m} /></td>
                <td className="hide-m"><Counts c={m.counts} /></td>
                <td className="hide-m m">{m.by} · <span>{ago(m.createdAt, now)}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="note">Todavía nadie subió las notas de una reunión.</p>}
      {upload}
    </div>
  );
}
