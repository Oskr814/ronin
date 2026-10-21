import type { RepoEntry } from '../../core/repo-context.js';
import type { RunSummary } from '../runs/data.js';
import { ExtractError, extractFile, extractPasted, MAX_FILE_BYTES, ORIGINAL_EXT, readNotes, readOriginal, type Meeting, type NewMeeting } from './index.js';

// The meetings on the dashboard (#62): anyone who sees a repo uploads the
// notes of one of its meetings, and sees the ones uploaded to it. The notes
// stay on the runner, in MEETINGS_DATA_DIR: never on GitHub.

// The body of POST /api/reuniones: the file goes as a data URL inside the
// JSON, like the portal's images (only JSON gets past tailnet.ts's checks).
// Base64 makes it a third bigger.
export const MAX_UPLOAD_BODY = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64 * 1024;
const LINK_MAX = 500;
const NAME_MAX = 200;

export class MeetingUploadError extends Error {}

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export async function parseUpload(body: Record<string, unknown>, entries: RepoEntry[], login: string): Promise<NewMeeting> {
  const repo = str(body.repo);
  if (!entries.some((e) => e.productRepo === repo)) throw new MeetingUploadError('Elige un repo de los que ves.');
  const link = str(body.link);
  if (link && (link.length > LINK_MAX || !/^https?:\/\/\S+$/.test(link))) throw new MeetingUploadError('El link tiene que ser una dirección http o https.');
  const at = str(body.at);
  if (at && (Number.isNaN(Date.parse(at)) || !/^\d{4}-\d{2}-\d{2}T/.test(at))) throw new MeetingUploadError('La fecha no se entiende.');
  const text = typeof body.text === 'string' ? body.text : '';
  const file = body.file as { name?: unknown; data?: unknown } | undefined;
  if (Boolean(text.trim()) === Boolean(file)) throw new MeetingUploadError('Sube un archivo o pega el texto de las notas (uno de los dos).');
  const base = { repo, by: login, ...(str(body.title) ? { title: str(body.title) } : {}), ...(at ? { at: new Date(at).toISOString() } : {}), ...(link ? { link } : {}) };
  try {
    if (!file) return { ...base, notes: extractPasted(text) };
    const match = typeof file.data === 'string' ? /^data:[\w.+/-]*;base64,([A-Za-z0-9+/=]+)$/.exec(file.data) : null;
    if (!match) throw new MeetingUploadError('El archivo no llegó bien.');
    const data = Buffer.from(match[1], 'base64');
    const name = (str(file.name) || 'notas').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, NAME_MAX);
    return { ...base, notes: await extractFile(data), file: { name, data } };
  } catch (error) {
    if (error instanceof ExtractError) throw new MeetingUploadError(error.message);
    throw error;
  }
}

export interface MeetingRow {
  number: number;
  repo: string;
  title: string;
  at: string | null;
  by: string;
  status: Meeting['status'];
  source: { kind: Meeting['source']['kind']; name: string | null; pages: number | null };
  chars: number;
  // What ronin proposed, once it read it.
  counts: { projects: number; issues: number; comments: number; discarded: number } | null;
  createdAt: string;
}

export function meetingRow(m: Meeting): MeetingRow {
  return {
    number: m.number,
    repo: m.repo,
    title: m.title,
    at: m.at ?? null,
    by: m.by,
    status: m.status,
    source: { kind: m.source.kind, name: m.source.name ?? null, pages: m.source.pages ?? null },
    chars: m.chars,
    counts: m.proposals
      ? { projects: m.proposals.projects.length, issues: m.proposals.issues.length + m.proposals.projects.reduce((sum, p) => sum + p.issues.length, 0), comments: m.proposals.comments.length, discarded: m.proposals.discarded.length }
      : null,
    createdAt: m.createdAt,
  };
}

export async function meetingDetail(m: Meeting, runs: RunSummary[]) {
  return {
    ...meetingRow(m),
    link: m.link ?? null,
    bytes: m.source.bytes ?? null,
    original: Boolean(m.source.file),
    text: await readNotes(m.number).catch(() => ''),
    proposals: m.proposals ?? null,
    results: m.results ?? {},
    events: m.events,
    // Its readings: what ronin did with it.
    runs: runs.filter((run) => run.repo === m.repo && run.meeting === m.number).sort((a, b) => b.startedAt.localeCompare(a.startedAt)),
  };
}

const TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain; charset=utf-8',
};

// The file as it was uploaded, to download: always as an attachment, never
// shown in the dashboard's own origin.
export async function meetingOriginal(m: Meeting): Promise<{ headers: Record<string, string>; data: Buffer } | null> {
  const data = await readOriginal(m);
  if (!data || m.source.kind === 'pasted') return null;
  const ext = ORIGINAL_EXT[m.source.kind];
  const name = m.source.name ?? `R-${m.number}.${ext}`;
  return {
    data,
    headers: {
      'Content-Type': TYPES[ext],
      'Content-Disposition': `attachment; filename="R-${m.number}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  };
}
