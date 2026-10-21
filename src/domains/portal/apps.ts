import type { RepoEntry } from '@platform/agents/repo-context.js';
import type { PortalGrant } from './accounts.js';

// What the portal offers (#114): each app of a repo's `portal.apps` in
// repos.json, with the names people see. A grant for an app that's no longer
// there is kept on the account but offers nothing.

export interface PortalApp {
  repo: string;
  // The repo's owner as the portal shows it ("Red Motos").
  org: string;
  app: string;
  name: string;
  description?: string;
}

export function portalApps(entries: RepoEntry[]): PortalApp[] {
  return entries.flatMap((entry) => (entry.portal
    ? Object.entries(entry.portal.apps).map(([app, shown]) => ({
      repo: entry.productRepo,
      org: entry.portal!.name,
      app,
      name: shown.name,
      ...(shown.description ? { description: shown.description } : {}),
    }))
    : []));
}

export function grantedApps(grants: PortalGrant[], entries: RepoEntry[]): PortalApp[] {
  return portalApps(entries).filter((a) => grants.some((g) => g.repo === a.repo && g.app === a.app));
}

// Only grants for apps the portal offers: what an admin sends is checked against repos.json.
export function validGrants(raw: unknown, entries: RepoEntry[]): PortalGrant[] | null {
  if (!Array.isArray(raw)) return null;
  const offered = portalApps(entries);
  const grants: PortalGrant[] = [];
  for (const g of raw) {
    const { repo, app } = (g ?? {}) as Record<string, unknown>;
    if (typeof repo !== 'string' || typeof app !== 'string' || !offered.some((a) => a.repo === repo && a.app === app)) return null;
    grants.push({ repo, app });
  }
  return grants;
}
