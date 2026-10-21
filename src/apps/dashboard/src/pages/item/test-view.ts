import type { QueryKey } from '@tanstack/react-query';
import type { Snapshot } from '../../api.js';
import type { ItemDetail, ItemRun, ShownRun, SnapshotItem } from '../../shell/hooks.js';
import { detailKey, runKey, runsKey, S } from '../../shell/state.js';
import { testSnapshot } from '../../test-shell.js';
import type { Doc } from './model.js';

// An item as the shell would have read it for a page's test: an issue of
// acme/tienda with ronin's PR moving, invented.

export const NOW = Date.parse('2026-10-21T15:00:00Z');
const iso = (minAgo: number) => new Date(NOW - minAgo * 60e3).toISOString();

export function doc(over: Partial<Doc> = {}): Doc {
  return { number: 41, title: 'Mostrar el teléfono del cliente', body: 'Hace falta el teléfono en la ficha.', author: 'ana-dev', createdAt: iso(600), url: 'https://github.com/acme/tienda/issues/41', state: 'OPEN', labels: [], comments: [], ...over };
}

export function detail(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    ref: { kind: 'issue', number: 41, pr: 42 },
    ronin: 'ronin-bot',
    fetchedAt: iso(2),
    exploration: false,
    pedido: null,
    actions: [],
    issue: doc(),
    pr: doc({ number: 42, title: 'Teléfono en la ficha', author: 'ronin-bot', url: 'https://github.com/acme/tienda/pull/42', body: '## Qué se pidió\nEl teléfono.\n\n## Decisiones propias\nLo puse arriba.', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'ronin/41/telefono', isDraft: false, reviewDecision: '', decisions: [] }),
    ...over,
  } as ItemDetail;
}

export function item(over: Partial<SnapshotItem> = {}): SnapshotItem {
  return { id: 'acme/tienda#41', repo: 'acme/tienda', number: 41, kind: 'issue', title: 'Mostrar el teléfono del cliente', status: 'waiting', runs: 0, listed: true, pr: { number: 42, title: 'Teléfono en la ficha', url: 'https://github.com/acme/tienda/pull/42', author: 'ronin-bot', isDraft: false, reviewDecision: '', checks: [] }, ...over } as SnapshotItem;
}

export interface ItemRead {
  item?: Partial<SnapshotItem>;
  // Its detail from GitHub (detail() unless said), its runs and the one shown.
  detail?: ItemDetail;
  runs?: ItemRun[];
  run?: ShownRun;
  // The tab open on its page.
  doc?: string;
  me?: string;
}

// The item in the snapshot, what was read of it in the cache (showPage's
// `data`) and the tab the shell has open on its page.
export function itemRead(read: ItemRead = {}): { id: string; snap: Snapshot; data: Array<[QueryKey, unknown]> } {
  const it = item(read.item);
  if (read.doc) S.doc[it.id] = read.doc;
  const data: Array<[QueryKey, unknown]> = [[detailKey(it.id), read.detail ?? detail()], [runsKey(it.id), read.runs ?? []]];
  if (read.run) data.push([runKey(read.run.runId), { ...read.run, from: read.run.lines.length }]);
  return { id: it.id, snap: testSnapshot({ me: read.me ?? 'ana-dev', items: [it] }), data };
}
