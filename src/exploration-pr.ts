import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { activeRepo } from './repo-context.js';
import { config } from './config.js';
import { log } from './logger.js';
import {
  createIssue,
  createPullRequest,
  findOpenPrByHead,
  listIssuesWithLabel,
  setPullRequestBody,
} from './github.js';
import {
  EXPLORATION_DIR,
  findingFileName,
  loadMemory,
  parseFinding,
  serializeFinding,
  type ExplorationMemory,
  type Finding,
  type FindingMeta,
} from './exploration-memory.js';

const execFileAsync = promisify(execFile);

// The weekly PR of docs/DESIGN.md §11.7: every run of the week commits its
// memory changes to ronin/exploration/<year>-W<week>, the PR's body is the
// digest, a human reviews the findings there, and approving + merging it is
// what turns the surviving findings into issues.

export const EXPLORATION_BRANCH_PREFIX = 'ronin/exploration/';
export const LABEL_PROPOSAL = 'ronin:propuesta';
export const LABEL_IDEA = 'ronin:idea';

// ISO 8601 week, e.g. "2026-W42": weeks start on Monday and belong to the
// year of their Thursday.
export function isoWeek(date: Date): string {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export function explorationBranch(week: string): string {
  return `${EXPLORATION_BRANCH_PREFIX}${week}`;
}

export function weekOfBranch(branch: string): string | undefined {
  return branch.startsWith(EXPLORATION_BRANCH_PREFIX) ? branch.slice(EXPLORATION_BRANCH_PREFIX.length) : undefined;
}

function baseRef(): string {
  return activeRepo().worktreeBaseRef ?? config.worktreeBaseRef;
}

function baseBranchName(): string {
  return baseRef().replace(/^origin\//, '');
}

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: dir, maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

async function remoteBranchExists(branch: string): Promise<boolean> {
  return git(activeRepo().productRepoPath, ['ls-remote', '--exit-code', '--heads', 'origin', branch]).then(() => true, () => false);
}

// The checkout of the week's branch, synced with origin: every run of the
// week (on this runner or another) builds on what's already there.
export async function ensureWeekWorktree(week: string): Promise<string> {
  const branch = explorationBranch(week);
  const dir = join(activeRepo().worktreeBasePath, `exploration-${week}`);
  const repo = activeRepo().productRepoPath;
  await git(repo, ['fetch', 'origin']);
  const remote = await remoteBranchExists(branch);
  const start = remote ? `origin/${branch}` : baseRef();
  const live = existsSync(dir) && (await git(dir, ['rev-parse', '--is-inside-work-tree']).then((o) => o === 'true', () => false));
  if (live) {
    await git(dir, ['checkout', '-B', branch, start]);
  } else {
    await mkdir(activeRepo().worktreeBasePath, { recursive: true });
    await git(repo, ['worktree', 'add', '-B', branch, dir, start]);
  }
  return dir;
}

// false when there was nothing to commit.
export async function commitAndPush(dir: string, branch: string, message: string): Promise<boolean> {
  await git(dir, ['add', '--', EXPLORATION_DIR]);
  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (!staged) return false;
  await git(dir, ['commit', '-m', message]);
  await git(dir, ['push', 'origin', `${branch}:${branch}`]);
  return true;
}

// The visible key an issue carries for its finding — searched in the body,
// so it must be plain text (GitHub search skips HTML comments).
export function findingIssueKey(appName: string, id: string): string {
  return `ronin-ficha:${appName}/${id}`;
}

export function renderFindingIssue(appName: string, finding: Finding, fileUrl: string): { title: string; body: string } {
  const body = [
    finding.body.replace(/^## .*\n+/, ''),
    '',
    ...(finding.mockup ? [`**Mockup:** ${finding.mockup}`, ''] : []),
    `Encontrado por la exploración de ronin en \`${appName}\` (charter \`${finding.charter}\`, ${finding.viewport}, rol ${finding.rol}, semilla ${finding.semilla}). Ficha: [${finding.id}](${fileUrl}).`,
    '',
    `Para que lo implemente, asignámelo. \`${findingIssueKey(appName, finding.id)}\``,
  ].join('\n');
  return { title: finding.titulo, body };
}

function findingPath(memoryDir: string, finding: Pick<FindingMeta, 'id' | 'titulo'>): string {
  return join(memoryDir, 'findings', findingFileName(finding));
}

// Opens the issue of every finding `select` picks that doesn't have one
// yet (found by its key, so a retry never opens a second one), and writes
// the issue number into the finding file. Returns the findings it opened
// issues for.
export async function openFindingIssues(
  appName: string,
  memoryDir: string,
  checkoutDir: string,
  branchForLinks: string,
  select: (f: FindingMeta) => boolean,
): Promise<Array<{ id: string; issue: number }>> {
  const memory = await loadMemory(memoryDir);
  const candidates = memory.findings.filter((f) => !f.issue && f.estado !== 'rechazado' && select(f));
  if (candidates.length === 0) return [];
  const existing = await listIssuesWithLabel(LABEL_PROPOSAL);
  const opened: Array<{ id: string; issue: number }> = [];
  for (const meta of candidates) {
    const key = findingIssueKey(appName, meta.id);
    const path = findingPath(memoryDir, meta);
    const finding = parseFinding(await readFile(path, 'utf8'));
    let number = existing.find((i) => i.body.includes(key))?.number;
    if (!number) {
      const fileUrl = `https://github.com/${activeRepo().productRepo}/blob/${branchForLinks}/${relative(checkoutDir, path)}`;
      const { title, body } = renderFindingIssue(appName, finding, fileUrl);
      number = (await createIssue(title, body, finding.tipo === 'idea' ? [LABEL_PROPOSAL, LABEL_IDEA] : [LABEL_PROPOSAL])).number;
      log.info(`exploración ${appName}: issue #${number} para ${meta.id}`);
    }
    await writeFile(path, serializeFinding({ ...finding, issue: number }));
    opened.push({ id: meta.id, issue: number });
  }
  return opened;
}

// After a week's PR merged, its findings that nobody rejected are approved:
// marks them so in the memory (on the current week's branch, which starts
// from the base). A finding counts as merged once its file exists on the
// base branch.
export async function reconcileApproved(appName: string, memoryDir: string, checkoutDir: string): Promise<string[]> {
  const memory = await loadMemory(memoryDir);
  const changed: string[] = [];
  for (const meta of memory.findings.filter((f) => f.estado === 'propuesto')) {
    const path = findingPath(memoryDir, meta);
    const onBase = await git(checkoutDir, ['cat-file', '-e', `${baseRef()}:${relative(checkoutDir, path)}`]).then(() => true, () => false);
    if (!onBase) continue;
    const finding = parseFinding(await readFile(path, 'utf8'));
    await writeFile(path, serializeFinding({ ...finding, estado: 'aprobado' }));
    changed.push(meta.id);
  }
  if (changed.length > 0) log.info(`exploración ${appName}: aprobadas por el merge del PR semanal: ${changed.join(', ')}`);
  await openFindingIssues(appName, memoryDir, checkoutDir, baseBranchName(), (f) => changed.includes(f.id));
  return changed;
}

const DIGEST_MARKER = '<!-- ronin:exploration-digest -->';

export function renderDigest(opts: {
  week: string;
  branch: string;
  repo: string;
  apps: Array<{ appName: string; memory: ExplorationMemory; runs: string[] }>;
  login: string;
}): string {
  const lines = [
    DIGEST_MARKER,
    `# Exploración de ronin — semana ${opts.week}`,
    '',
    'ronin levantó la app, la usó como cada rol en desktop y mobile y propone lo de abajo. Cada propuesta tiene su ficha en el repo (memoria de la exploración) y, si ayuda a decidir, un mockup.',
    '',
    '**Cómo revisar:**',
    '- **Para rechazar una propuesta**, comentá en su ficha (en "Files changed") con el motivo, por ejemplo: "ya está cubierto". La marco como rechazada y la sumo a `knowledge.md` para no volver a proponerla.',
    '- **Para aceptar el resto**, aprobá el PR. Al mergearlo, abro un issue por cada propuesta que siga en pie; asignándome ese issue, la implemento.',
    '- Los bugs de gravedad alta ya tienen su issue abierto desde que se encontraron.',
    '',
  ];
  for (const { appName, memory, runs } of opts.apps) {
    const thisWeek = memory.findings.filter((f) => f.fecha && isoWeek(new Date(`${f.fecha}T12:00:00`)) === opts.week);
    lines.push(`## ${appName}`, '');
    if (thisWeek.length === 0) {
      lines.push('Sin propuestas esta semana.', '');
    } else {
      lines.push('| Ficha | Tipo | Gravedad | Propuesta | Función | Estado | Mockup |', '|---|---|---|---|---|---|---|');
      for (const f of thisWeek) {
        const file = `https://github.com/${opts.repo}/blob/${opts.branch}/${EXPLORATION_DIR}/${appName}/findings/${findingFileName(f)}`;
        const estado = f.estado === 'rechazado' ? `rechazada${f.motivo ? `: ${f.motivo}` : ''}` : f.issue ? `issue #${f.issue}` : f.estado;
        lines.push(`| [${f.id}](${file}) | ${f.tipo} | \`${f.gravedad}\` | ${f.titulo.replace(/\|/g, '/')} | \`${f.funcion}\` | ${estado.replace(/\|/g, '/')} | ${f.mockup ? `[ver](${f.mockup})` : '—'} |`);
      }
      lines.push('');
    }
    if (runs.length > 0) {
      lines.push(`Corridas: ${runs.map((r) => `[${r}](https://github.com/${opts.repo}/blob/${opts.branch}/${EXPLORATION_DIR}/${appName}/runs/${r}.md)`).join(', ')}`, '');
    }
  }
  return lines.join('\n');
}

export async function weekRuns(memoryDir: string, week: string): Promise<string[]> {
  const files = await readdir(join(memoryDir, 'runs')).catch(() => [] as string[]);
  return files
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((runId) => isoWeek(new Date(`${runId.slice(0, 10)}T12:00:00`)) === week)
    .sort();
}

export async function appsWithMemory(checkoutDir: string): Promise<string[]> {
  const entries = await readdir(join(checkoutDir, EXPLORATION_DIR), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function renderDigestFor(week: string, weekDir: string): Promise<string> {
  const apps = [];
  for (const appName of await appsWithMemory(weekDir)) {
    const memoryDir = join(weekDir, EXPLORATION_DIR, appName);
    apps.push({ appName, memory: await loadMemory(memoryDir), runs: await weekRuns(memoryDir, week) });
  }
  return renderDigest({ week, branch: explorationBranch(week), repo: activeRepo().productRepo, apps, login: config.githubLogin });
}

// Opens the week's PR as a draft the first time, refreshes its body after.
export async function upsertWeeklyPr(week: string, weekDir: string): Promise<number> {
  const branch = explorationBranch(week);
  const body = await renderDigestFor(week, weekDir);
  const open = await findOpenPrByHead(branch);
  if (open) {
    if (open.body !== body) await setPullRequestBody(open.number, body);
    return open.number;
  }
  return createPullRequest({ head: branch, base: baseBranchName(), title: `Exploración de ronin — semana ${week}`, body, draft: true });
}
