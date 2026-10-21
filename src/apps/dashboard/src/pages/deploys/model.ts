import { client, ok, type DeployRepos } from '../../api.js';

// What the page and its dialog share: the shapes of what /api/deploys
// answers, and how a change and a repo's routes are written.

export type Repos = DeployRepos;
export type Repo = Repos[number];
type Readable = Extract<Repo, { pending: unknown }>;
export type Change = Readable['pending']['changes'][number];
export type Release = Readable['releases'][number];
export type Plan = Awaited<ReturnType<typeof planOf>>;

// "Mostrar el teléfono (#41)" without its "(#41)": the PR is shown apart.
export const subject = (c: Change) => c.subject.replace(/\s*\(#\d+\)\s*$/, '');

export const at = (repo: string) => {
  const [owner, name] = repo.split('/');
  return { param: { owner, name } };
};

export function planOf(repo: string, body: { tag: string; prs: 'all' | number[]; prerelease: boolean }) {
  return ok(client.api.deploys[':owner'][':name'].plan.$post({ ...at(repo), json: body }));
}
