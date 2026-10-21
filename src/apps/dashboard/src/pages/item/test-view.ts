import type { ItemDetail, ItemView, SnapshotItem } from '../../host.js';
import type { Doc } from './model.js';

// An item as the shell would hand it to a page's test (Host.item): an issue
// of acme/tienda with ronin's PR moving, invented.

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

export function view(over: Partial<ItemView> = {}, item: Partial<SnapshotItem> = {}): ItemView {
  const d = over.detail === undefined ? detail() : over.detail?.data;
  return {
    item: { id: 'acme/tienda#41', repo: 'acme/tienda', number: 41, kind: 'issue', title: 'Mostrar el teléfono del cliente', status: 'waiting', runs: 0, listed: true, pr: { number: 42, title: 'Teléfono en la ficha', url: 'https://github.com/acme/tienda/pull/42', author: 'ronin-bot', isDraft: false, reviewDecision: '', checks: [] }, ...item } as SnapshotItem,
    detail: { data: d ?? null, error: null },
    runs: [],
    run: null,
    runIdx: 0,
    view: 'ficha',
    tabs: [['pr', 'PR #42'], ['issue', 'Issue'], ['files', 'Archivos']],
    doc: 'pr',
    decidable: true,
    reviewable: true,
    exploration: null,
    ...over,
  };
}
