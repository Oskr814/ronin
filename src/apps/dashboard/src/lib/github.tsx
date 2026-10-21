import { OCTICON } from '../../vendor/octicons.js';

// How an issue or PR stands on GitHub, with GitHub's own icon and color
// (#129): [class, short label, what it says in words, octicon], as app.js
// draws it.
const GH_STATE: Record<string, Record<string, [string, string, string, string]>> = {
  issue: {
    open: ['open', 'Abierto', 'Issue abierto', 'issue-opened'],
    completed: ['done', 'Cerrado', 'Issue cerrado como completado', 'issue-closed'],
    not_planned: ['neutral', 'No planeado', 'Issue cerrado como no planeado', 'skip'],
  },
  pr: {
    open: ['open', 'Abierto', 'PR abierto', 'git-pull-request'],
    draft: ['neutral', 'Draft', 'PR en draft', 'git-pull-request-draft'],
    merged: ['done', 'Mergeado', 'PR mergeado', 'git-merge'],
    closed: ['closed', 'Cerrado', 'PR cerrado sin mergear', 'git-pull-request-closed'],
  },
};

export function GhIcon({ kind, state }: { kind: string; state: string | undefined }) {
  const info = state ? GH_STATE[kind]?.[state] : undefined;
  if (!info) return null;
  return (
    <svg className={`ghi ${info[0]}`} viewBox="0 0 16 16" role="img" aria-label={info[2]}>
      <title>{info[2]}</title>
      {OCTICON[info[3]].map((d) => <path key={d} d={d} />)}
    </svg>
  );
}

// Linear's mark, before what comes from it.
export const LinearIcon = () => (
  <svg width="12" height="12" viewBox="0 0 100 100" aria-hidden="true" style={{ verticalAlign: '-1px', flex: 'none' }}>
    <path fill="currentColor" d="M1.2 61.5a50 50 0 0 0 37.3 37.3zM.1 48.9l51 51a50 50 0 0 0 9.3-1.4L1.5 39.6A50 50 0 0 0 .1 48.9zm3.6-17.8 65.2 65.2a50 50 0 0 0 7.2-3.9L7.6 23.9a50 50 0 0 0-3.9 7.2zm8.4-12.2a50 50 0 1 1 69 69z" />
  </svg>
);
