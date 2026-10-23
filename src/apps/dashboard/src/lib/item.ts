import type { ItemDetail, Snapshot } from '../api.js';

// What an item's page shows, worked out from what was read of it: the
// shell (the center's width, the context column) and the page (pages/item)
// ask the same.

type Item = Snapshot['items'][number];

export const sameLogin = (a: string | null | undefined, b: string | null | undefined) => Boolean(a && b) && a!.toLowerCase() === b!.toLowerCase();

// The page's tabs ([key, label]). `app`: an exploration PR that's its app's
// page (#155), with the app's runs and inventory.
export function docTabsOf(item: Item, d: ItemDetail | undefined, app: boolean): Array<[string, string]> {
  // Archivos: the PR's "Files changed" (#111), an issue's moving PR's.
  // An issue with a PR opens on the PR, what was done (its "Qué se pidió" says what was asked).
  if (item.kind === 'issue') return d?.pr ? [['pr', `PR #${d.pr.number}`], ['issue', 'Issue'], ['files', 'Archivos']] : [['issue', 'Issue']];
  // An exploration PR opens on its findings, to review them (#93).
  const xpl: Array<[string, string]> = d?.exploration && app ? [['corridas', 'Corridas'], ['inventario', 'Inventario']] : [];
  return [...(d?.exploration ? [['fichas', 'Fichas'] as [string, string]] : []), ...xpl, ['pr', 'Descripción'], ...(d?.issue ? [['issue', `Issue #${d.issue.number}`] as [string, string]] : []), ['files', 'Archivos']];
}

// The tab shown: the one chosen, while the page has it, or the first.
export function docOf(tabs: Array<[string, string]>, chosen: string | undefined): string | null {
  if (!tabs.length) return null;
  return tabs.some(([k]) => k === chosen) ? chosen! : tabs[0][0];
}

// A PR's page offers the review, and so does an issue's, for its moving PR
// (the one in its Archivos tab); an exploration PR has its own approval (#93).
export const reviewable = (item: Item, d: ItemDetail) => (item.kind === 'pr' || item.kind === 'issue') && !d?.exploration && d?.pr?.state === 'OPEN';
// A spec ronin wrote (/spec): its branch is ronin/<issue>/spec, as
// domains/items/decision.ts's isSpecPr reads it.
export const isSpecPr = (pr: { headRefName?: string }) => /^ronin\/\d+\/spec$/.test(pr.headRefName ?? '');
// A PR ronin opened, decided in the item's page (pages/item/Decide.tsx,
// #195): not a draft, but for a spec, which approving starts.
export const decidable = (item: Item, d: ItemDetail) => reviewable(item, d) && Boolean(d.ronin) && sameLogin(d.pr!.author, d.ronin) && (!d.pr!.isDraft || isSpecPr(d.pr!));
