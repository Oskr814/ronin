import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useReducer } from 'react';
import { ApiError, client, ok } from '@apps/dashboard/src/api.js';
import { reread, type ShellActions, useShell } from '@apps/dashboard/src/shell/hooks.js';
import { itemParam } from '../model.js';
import { pendingOf, type DiffThread, type PendingReview, type PrFile } from './diff.js';

// A PR's "Files changed" (#111), as an item's page reads it: the files with
// their patches and threads, read with ronin's token, and what's only the
// person's (what they marked as viewed, their pending review), read with
// theirs. Read when Archivos is first shown, or when something that carries
// the pending review (the review panel, Ajustar) asks; again once old while
// Archivos is shown, and after each write. An issue's is its moving PR's.

const EVERY_MS = 30_000;

export interface PrFiles {
  pr: number;
  author: string;
  headSha: string;
  files: PrFile[];
  threads: DiffThread[];
  error?: string;
}
export interface FilesRead {
  data: PrFiles;
  viewed: string[];
  review: PendingReview | null;
}

export const filesKey = (key: string) => ['item-files', key];

// What the page shows of Archivos outside of it (its tab's counter, the
// review panel, Ajustar), and how it asks for it.
export interface FilesView {
  // Read, or why it couldn't be; null while it's being read the first time.
  data: { pr: number; author: string; headSha: string; count: number } | null;
  error: string | null;
  // The person's pending review on GitHub, and its comments.
  review: boolean;
  pending: PendingComment[];
  // Reads it, if it wasn't yet.
  load(): void;
  // Something was written on GitHub: it's read again, and so is the item.
  reread(): Promise<void>;
}

export interface PendingComment {
  path: string;
  subject: string;
  line: number | null;
  // A comment that starts a thread, not a reply.
  isNew: boolean;
  nodeId: string;
  body: string;
}

// The items whose Archivos were asked for: read from then on.
const asked = new Set<string>();

async function read(qc: QueryClient, shell: ShellActions, key: string): Promise<FilesRead> {
  const param = itemParam(key);
  try {
    // What the person marked as viewed and their pending review are theirs, read with their token; without them the diff still shows.
    const [data, mine] = await Promise.all([
      ok(client.api.items[':id'].files.$get({ param })) as Promise<PrFiles>,
      ok(client.api.items[':id'].files.mine.$get({ param })).catch((e) => (e instanceof ApiError && e.status === 401 ? Promise.reject(e) : null)),
    ]);
    const before = qc.getQueryData<FilesRead>(filesKey(key));
    return { data, viewed: mine ? mine.viewed : before?.viewed ?? [], review: mine ? (mine.review as PendingReview | null) : before?.review ?? null };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) shell.unauthorized(e.message);
    throw e;
  }
}

export function useFiles(key: string, shown: boolean) {
  const shell = useShell();
  const qc = useQueryClient();
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  if (shown) asked.add(key);
  const q = useQuery({
    queryKey: filesKey(key),
    queryFn: () => read(qc, shell, key),
    enabled: asked.has(key),
    staleTime: EVERY_MS,
    gcTime: Infinity,
    refetchInterval: shown ? EVERY_MS : false,
  });
  const files = q.data;
  const view: FilesView = {
    data: files ? { pr: files.data.pr, author: files.data.author, headSha: files.data.headSha, count: files.data.files.length } : null,
    error: q.error ? q.error.message : null,
    review: Boolean(files?.review),
    pending: pendingOf(files?.review ?? null).map(({ t, c }) => ({ path: t.path, subject: t.subject, line: t.line, isNew: t.isNew, nodeId: c.nodeId, body: c.body })),
    load() {
      if (asked.has(key)) return;
      asked.add(key);
      redraw();
    },
    reread: () => rereadFiles(qc, shell, key),
  };
  return { q, view };
}

// After writing on GitHub: the files and the item's comments are read again.
export function rereadFiles(qc: QueryClient, shell: ShellActions, key: string): Promise<void> {
  return Promise.all([qc.invalidateQueries({ queryKey: filesKey(key) }), reread(key)]).then(() => {});
}

// A file, and a comment in it, picked in the review panel: shown once
// Archivos is drawn with its files.
let jump: { key: string; path: string; comment?: string } | null = null;
export function goFile(key: string, path: string, comment?: string) {
  jump = { key, path, comment };
}
export function takeJump(key: string) {
  const to = jump?.key === key ? jump : null;
  if (to) jump = null;
  return to;
}
