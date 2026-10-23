// The tag of an automatic batch (#353), from the repo's pattern in
// repos.json (deploy.auto.tag): {major}, {minor} and {patch} come from the
// last release's tag, each with a +k to add to it ({patch+1}); {yyyy}, {mm}
// and {dd} are the batch's date, and {n} the batch number of that day.
//   v{major}.{minor}.{patch+1}   after v1.4.7 → v1.4.8
//   {yyyy}.{mm}.{dd}-{n}         the second batch of the day → 2026.10.22-2

const MARKER = /\{(major|minor|patch)(?:\+(\d+))?\}|\{(yyyy|mm|dd|n)\}/g;

export type TagProblem = 'pattern-invalid' | 'no-base' | 'base-mismatch';

// What's wrong with a pattern written in Ajustes, or null.
export function patternProblem(pattern: string): string | null {
  if (!pattern.trim()) return 'El patrón del tag está vacío.';
  const literal = pattern.replace(MARKER, '0');
  if (/[{}]/.test(literal)) return 'El patrón solo puede usar {major}, {minor}, {patch} (con +1 si hace falta), {yyyy}, {mm}, {dd} y {n}.';
  if (!/^[A-Za-z0-9._-]+$/.test(literal)) return 'Fuera de los marcadores, el patrón solo puede tener letras, números, puntos, guiones y guiones bajos.';
  const dated = /\{(yyyy|mm|dd)\}/.test(pattern);
  const versioned = /\{(major|minor|patch)/.test(pattern);
  if (!dated && !versioned) return 'El patrón necesita un número que cambie: {patch+1}, por ejemplo, o la fecha con {n}.';
  if (dated && !versioned && !pattern.includes('{n}')) return 'Con la fecha, el patrón necesita {n}, el número de lote del día: puede haber más de uno.';
  if (versioned && !/\+\d+\}/.test(pattern)) return 'El patrón tiene que subir algún número: {patch+1}, por ejemplo.';
  return null;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The pattern as a regex, each marker a group: to read the last tag, and the
// tags of the day.
function parser(pattern: string): { regex: RegExp; groups: string[] } {
  const groups: string[] = [];
  let source = '';
  let last = 0;
  for (const m of pattern.matchAll(MARKER)) {
    source += escape(pattern.slice(last, m.index));
    const name = m[1] ?? m[3];
    groups.push(name);
    source += name === 'yyyy' ? '(\\d{4})' : name === 'mm' || name === 'dd' ? '(\\d{2})' : '(\\d+)';
    last = m.index! + m[0].length;
  }
  source += escape(pattern.slice(last));
  return { regex: new RegExp(`^${source}$`), groups };
}

export interface NextTagInput {
  pattern: string;
  // The last release's tag (not a pre-release), when there is one.
  lastTag: string | null;
  // The batch's date, YYYY-MM-DD by the team's clock.
  day: string;
  // The tags that exist: {n} skips them, and the tag must not be one.
  tags: Set<string>;
}

export function nextTag({ pattern, lastTag, day, tags }: NextTagInput): { tag: string } | { problem: TagProblem } {
  if (patternProblem(pattern)) return { problem: 'pattern-invalid' };
  const { regex, groups } = parser(pattern);
  const version: Record<string, number> = {};
  if (/\{(major|minor|patch)/.test(pattern)) {
    if (!lastTag) return { problem: 'no-base' };
    const read = regex.exec(lastTag);
    if (!read) return { problem: 'base-mismatch' };
    groups.forEach((name, i) => {
      if (name === 'major' || name === 'minor' || name === 'patch') version[name] = Number(read[i + 1]);
    });
  }
  const [yyyy, mm, dd] = day.split('-');
  const write = (n: number) => pattern.replace(MARKER, (_, part: string | undefined, plus: string | undefined, other: string | undefined) => {
    if (part) return String(version[part] + Number(plus ?? 0));
    return other === 'yyyy' ? yyyy : other === 'mm' ? mm : other === 'dd' ? dd : String(n);
  });
  if (!pattern.includes('{n}')) return { tag: write(1) };
  // The day's next batch: one more than the highest that day.
  for (let n = 1; n < 1000; n++) if (!tags.has(write(n))) return { tag: write(n) };
  return { problem: 'pattern-invalid' };
}
