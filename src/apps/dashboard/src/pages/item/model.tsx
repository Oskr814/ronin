import { sameLogin } from '@apps/dashboard/src/lib/item.js';
import { groupName, runKind, runTitle } from '@apps/dashboard/src/lib/runs.js';
import { type ItemDetail, type ItemRun, type ItemView, type SnapshotItem, useItem } from '@apps/dashboard/src/shell/hooks.js';
import { GhIcon } from '@apps/dashboard/src/lib/github.js';
import type { FilesView } from './files/model.js';

// What an item's page (#85) shares: the item as the shell has it, how its
// runs are listed, and how GitHub's state of it is written.

export type Doc = NonNullable<ItemDetail['issue']>;
export type Action = NonNullable<ItemDetail['actions']>[number];

// The item as the page draws it: as the shell has it, and its Archivos as
// far as the page shows them outside of their tab (files/model.ts).
export interface ItemPage extends ItemView {
  files: FilesView;
}

// The item, again each time the shell draws.
export { useItem };

// An item's key in its routes' path (/api/items/<key>/…): the client puts
// it there as it is, and its # would end the path.
export const itemParam = (key: string) => ({ id: encodeURIComponent(key) });

export { sameLogin };
export const oneOr = (n: number, one: string, many: string) => (n === 1 ? one : many);

// A PR's checks in one chip: [class, words].
export function checksChip(checks: Array<{ outcome: string }> | undefined): [string, string] | null {
  if (!checks?.length) return null;
  const failed = checks.filter((c) => c.outcome === 'failed').length;
  if (failed) return ['crit', `${failed} ${failed === 1 ? 'check falla' : 'checks fallan'}`];
  if (checks.some((c) => c.outcome === 'pending')) return ['run', 'checks corriendo'];
  return ['ok', `checks ${checks.length}/${checks.length}`];
}

export const Chips = ({ chips }: { chips: Array<[string, string]> }) => <>{chips.map(([cls, text], i) => <span key={i} className={`chip ${cls}`}>{text}</span>)}</>;

// An item's state: from the sidebar's read, else from its page (an old
// closed one opened with "Abrir #N").
function ghStateOf(item: SnapshotItem, d: ItemDetail | null | undefined): string | undefined {
  if (item.github) return item.github;
  const doc = item.kind === 'pr' ? d?.pr : item.kind === 'issue' ? d?.issue : undefined;
  if (!doc?.state) return undefined;
  if (doc.state === 'MERGED') return 'merged';
  if (doc.state === 'OPEN') return doc.isDraft ? 'draft' : 'open';
  if (item.kind === 'pr') return 'closed';
  return doc.stateReason === 'NOT_PLANNED' ? 'not_planned' : 'completed';
}

const PILL: Record<string, Record<string, [string, string, string]>> = {
  issue: { open: ['open', 'Abierto', 'Issue abierto'], completed: ['done', 'Cerrado', 'Issue cerrado como completado'], not_planned: ['neutral', 'No planeado', 'Issue cerrado como no planeado'] },
  pr: { open: ['open', 'Abierto', 'PR abierto'], draft: ['neutral', 'Draft', 'PR en draft'], merged: ['done', 'Mergeado', 'PR mergeado'], closed: ['closed', 'Cerrado', 'PR cerrado sin mergear'] },
};

// The item's state as GitHub's pill at the head of its page: "Abierto",
// "Cerrado", "Mergeado"…
export function GhPill({ item, d }: { item: SnapshotItem; d: ItemDetail | null | undefined }) {
  const state = ghStateOf(item, d);
  const info = state ? PILL[item.kind]?.[state] : undefined;
  return info ? <span className={`ghs ${info[0]}`} title={info[2]}><GhIcon kind={item.kind} state={state} />{info[1]}</span> : null;
}

export function itemRef(item: SnapshotItem, runKind: (run: ItemRun) => string): string {
  if (item.kind === 'issue') return `#${item.number}`;
  if (item.kind === 'pr') return `PR #${item.number}`;
  return item.lastRun ? runKind(item.lastRun as ItemRun) : '';
}

// The item's runs as they're listed (newest first): one entry per run, but
// a group's steps together as one, its newest first. `idx`: their places
// in the list.
export interface Entry {
  group?: string;
  idx: number[];
}

export function runEntries(runs: ItemRun[]): Entry[] {
  const out: Entry[] = [];
  runs.forEach((run, i) => {
    const last = out.at(-1);
    if (last && groupName(run) && last.group === run.group) last.idx.push(i);
    else out.push({ group: groupName(run) ? run.group : undefined, idx: [i] });
  });
  return out;
}

// A group as one run: running while a step runs, else how its last step
// ended (or the first one that failed); from its first step to its last.
export function entryRun(runs: ItemRun[], entry: Entry): ItemRun {
  const steps = entry.idx.map((i) => runs[i]);
  if (steps.length === 1) return steps[0];
  const failed = steps.find((run) => ['error', 'timeout', 'cut', 'usage_limit'].includes(run.state));
  const state = steps.some((run) => run.state === 'running') ? 'running' : failed?.state ?? steps[0].state;
  const sum = (key: 'durationMs' | 'costUsd') => (steps.some((run) => run[key] !== undefined) ? steps.reduce((total, run) => total + (run[key] ?? 0), 0) : undefined);
  return { ...steps[0], state, startedAt: steps.at(-1)!.startedAt, durationMs: sum('durationMs'), costUsd: sum('costUsd'), ...(failed?.error ? { error: failed.error } : {}) };
}

// What a run is, and the run's names in the item's lists.
const runName = (item: SnapshotItem, run: ItemRun, of = runTitle) => of(run) + (run.issueNumber == null && run.prNumber != null && run.prNumber !== item.number ? ` en #${run.prNumber}` : '');
export const runNames = {
  kind: runKind,
  title: runTitle,
  // A run's task, and the PR it was on when that's not the item itself: an
  // issue's history carries its slices' PR runs too (/resolve-conflicts on #849).
  name: runName,
  entryName: (item: SnapshotItem, runs: ItemRun[], entry: Entry) => runName(item, runs[entry.idx[0]], entry.idx.length > 1 ? runKind : runTitle),
};

// The item's runs: the ones read, or its last one until they are.
export const runsOf = (v: ItemView): ItemRun[] => v.runs ?? (v.item.lastRun ? [v.item.lastRun as ItemRun] : []);

export const avatarOk = (login: string | null | undefined) => /^[\w-]+$/.test(login ?? '');
export const Avatar = ({ login }: { login: string | null | undefined }) => (avatarOk(login) ? <img className="av" src={`https://avatars.githubusercontent.com/${login}?s=40`} alt="" /> : <span className="av" />);
