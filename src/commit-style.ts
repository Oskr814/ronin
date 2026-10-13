import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Commits and PR titles ronin writes itself (exploration memory, its PR)
// follow the product repo's own convention, read off its base branch — a
// squash-merged PR title lands on main as a commit like any other. Agents
// get the same rule in their prompts (agent-task.ts's COMMIT_STYLE_RULE).

export type CommitStyle = 'conventional' | 'plain';
export type CommitLanguage = 'en' | 'es';

export interface CommitConvention {
  style: CommitStyle;
  language: CommitLanguage;
  // Recent subjects, newest first — examples for whoever writes the next one.
  examples: string[];
}

const CONVENTIONAL_RE = /^[a-z]+(\([^)]+\))?!?: \S/;
const HISTORY_SIZE = 30;

// Conventional when most of the recent subjects are. Merge commits say
// nothing about the team's style, and a repo with too little history is
// left as plain.
export function styleOf(subjects: string[]): CommitStyle {
  const relevant = subjects.filter((s) => s.trim() && !/^Merge (pull request|branch|remote-tracking)/.test(s));
  if (relevant.length < 5) return 'plain';
  const conventional = relevant.filter((s) => CONVENTIONAL_RE.test(s)).length;
  return conventional * 2 >= relevant.length ? 'conventional' : 'plain';
}

const SPANISH_RE = /[áéíóúñ¿¡]|\b(de|del|la|las|los|el|para|con|que|por|una|al|cuando|sin|desde|agregar|corregir|quitar)\b/i;
const ENGLISH_RE = /\b(the|to|and|of|for|with|from|on|add|fix|use|remove|stop|make|drop|when|instead|into)\b/i;

// The language most subjects are written in, ignoring what precedes the
// first ": " (type and scope are English either way). Ties go to English.
export function languageOf(subjects: string[]): CommitLanguage {
  let es = 0;
  let en = 0;
  for (const subject of subjects) {
    const text = subject.replace(/^[^:]*:\s*/, '');
    if (SPANISH_RE.test(text)) es++;
    else if (ENGLISH_RE.test(text)) en++;
  }
  return es > en ? 'es' : 'en';
}

export async function repoCommitConvention(dir: string, ref: string): Promise<CommitConvention> {
  const { stdout } = await execFileAsync('git', ['log', '--format=%s', `-${HISTORY_SIZE}`, ref], { cwd: dir }).catch(() => ({ stdout: '' }));
  const subjects = stdout.split('\n').filter((s) => s.trim());
  return { style: styleOf(subjects), language: languageOf(subjects), examples: subjects.slice(0, 15) };
}

// What a supervisor commit changed, for writing its subject: a description
// of the change for the writer (any language), and a ready subject text per
// language for when no writer answers.
export interface CommitChange {
  description: string;
  fallback: Record<CommitLanguage, string>;
}

const MAX_SUBJECT = 100;

// Whether a subject someone wrote for us is usable: one line, the expected
// prefix, short, with something after the prefix.
export function acceptSubject(raw: string, prefix: string): string | undefined {
  const line = raw.trim().replace(/^["'`]+|["'`]+$/g, '').split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  if (!line.startsWith(prefix) || line.length > MAX_SUBJECT || line.length <= prefix.length + 3) return undefined;
  return line;
}
