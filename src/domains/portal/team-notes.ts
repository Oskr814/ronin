// What a prototype or a reproduction leaves for the dev who decides (#406),
// besides its free-text summary: the changes, the tests (passed, or not
// run and why), what to decide before approving, and the risks. The agent
// writes them under "equipo" (plugin/skills/prototype, reproduce-error);
// older ones have only the summary.

export interface TeamNotes {
  changes: string[];
  tests: Array<{ ok: boolean; text: string }>;
  decide: string[];
  risks: string[];
}

const MAX_ITEMS = 8;
const MAX_TEXT = 400;

const line = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, MAX_TEXT) : undefined);
const lines = (value: unknown) => (Array.isArray(value) ? value.map(line).filter((s): s is string => Boolean(s)).slice(0, MAX_ITEMS) : []);

export function parseTeamNotes(value: unknown): TeamNotes | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  const tests = (Array.isArray(v.pruebas) ? v.pruebas : []).flatMap((t) => {
    const text = typeof t === 'object' && t !== null ? line((t as Record<string, unknown>).texto) : undefined;
    return text ? [{ ok: (t as Record<string, unknown>).ok === true, text }] : [];
  }).slice(0, MAX_ITEMS);
  const notes = { changes: lines(v.cambios), tests, decide: lines(v.decidir), risks: lines(v.riesgos) };
  return Object.values(notes).some((list) => list.length) ? notes : undefined;
}

// A diff's files and their lines added and removed, and the areas they
// touch: a monorepo's apps or packages by name ("api", "backoffice"),
// otherwise the top folder.
export interface PatchScope {
  files: Array<{ path: string; add: number; del: number }>;
  areas: string[];
  add: number;
  del: number;
}

const CONTAINERS = new Set(['apps', 'packages', 'services', 'libs', 'modules']);

export function areaOf(path: string): string {
  const parts = path.split('/');
  if (parts.length === 1) return '(raíz)';
  return CONTAINERS.has(parts[0]) && parts.length > 2 ? parts[1] : parts[0];
}

export function patchScope(patch: string): PatchScope {
  const files: PatchScope['files'] = [];
  let current: PatchScope['files'][number] | undefined;
  for (const l of patch.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
    if (header) {
      current = { path: header[2], add: 0, del: 0 };
      files.push(current);
    } else if (current && l.startsWith('+') && !l.startsWith('+++')) current.add++;
    else if (current && l.startsWith('-') && !l.startsWith('---')) current.del++;
  }
  return {
    files,
    areas: [...new Set(files.map((f) => areaOf(f.path)))],
    add: files.reduce((s, f) => s + f.add, 0),
    del: files.reduce((s, f) => s + f.del, 0),
  };
}
