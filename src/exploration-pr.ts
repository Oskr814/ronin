import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { activeRepo } from './repo-context.js';
import { config } from './config.js';
import { log } from './logger.js';
import { acceptSubject, repoCommitConvention, type CommitChange, type CommitConvention } from './commit-style.js';
import { runAgentTask } from './agent-task.js';
import {
  createIssue,
  createPullRequest,
  findOpenPrByHead,
  listIssuesWithLabel,
  listOpenPrsByHeadPrefix,
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

// The rolling exploration PR of docs/DESIGN.md §11.7: one open at a time per
// repo, ready for review as soon as a run lands. Each run commits its memory
// changes to that PR's branch — or, when none is open, starts a new one,
// ronin/exploration/<date> — and refreshes its body, the digest. A human
// reviews the findings there whenever it suits them; approving + merging it
// turns the surviving findings into issues, and the next run opens the next
// PR. One at a time keeps the memory in one place: two open PRs would edit
// the same inventory and miss each other's findings when deduping.

export const EXPLORATION_BRANCH_PREFIX = 'ronin/exploration/';
export const LABEL_PROPOSAL = 'ronin:propuesta';
export const LABEL_IDEA = 'ronin:idea';

// The batch a branch belongs to: the suffix after the prefix — a date, or
// the ISO week of PRs opened before batches were rolling.
export function batchOfBranch(branch: string): string | undefined {
  return branch.startsWith(EXPLORATION_BRANCH_PREFIX) ? branch.slice(EXPLORATION_BRANCH_PREFIX.length) : undefined;
}

export function explorationBranch(batch: string): string {
  return `${EXPLORATION_BRANCH_PREFIX}${batch}`;
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

// The batch the next run goes to: the open exploration PR's (the oldest, if
// somehow there are more), or a new one named after today — "<today>-2" and
// on when a merged PR already used that name.
export async function currentBatch(today: string): Promise<{ batch: string; prNumber?: number }> {
  const open = (await listOpenPrsByHeadPrefix(EXPLORATION_BRANCH_PREFIX)).sort((a, b) => a.number - b.number)[0];
  const openBatch = open && batchOfBranch(open.headRefName);
  if (open && openBatch) return { batch: openBatch, prNumber: open.number };
  await git(activeRepo().productRepoPath, ['fetch', 'origin']);
  for (let n = 1; ; n++) {
    const batch = n === 1 ? today : `${today}-${n}`;
    if (!(await remoteBranchExists(explorationBranch(batch)))) return { batch };
  }
}

// The checkout of the batch's branch, synced with origin: every run of the
// batch (on this runner or another) builds on what's already there.
export async function ensureBatchWorktree(batch: string): Promise<string> {
  const branch = explorationBranch(batch);
  const dir = join(activeRepo().worktreeBasePath, `exploration-${batch}`);
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

function subjectPrefix(convention: CommitConvention): string {
  if (convention.style === 'conventional') return 'docs(exploration): ';
  return convention.language === 'es' ? 'exploración: ' : 'exploration: ';
}

// The subject of a commit to the exploration memory: written by a small
// model from what changed, in the repo's convention and language, or the
// change's own fallback when that fails.
export async function explorationCommitSubject(dir: string, change: CommitChange): Promise<string> {
  const convention = await repoCommitConvention(dir, baseRef());
  const prefix = subjectPrefix(convention);
  try {
    const raw = await runAgentTask({ type: 'commit-subject', checkoutDir: dir, prefix, language: convention.language, examples: convention.examples, description: change.description });
    const subject = acceptSubject(raw, prefix);
    if (subject) return subject;
    log.info(`exploración: el asunto propuesto no sirve (${raw.trim().slice(0, 120)}), uso el de respaldo`);
  } catch (error) {
    log.error('exploración: no se pudo escribir el asunto del commit, uso el de respaldo', error);
  }
  return `${prefix}${change.fallback[convention.language]}`;
}

// false when there was nothing to commit.
export async function commitAndPush(dir: string, branch: string, change: CommitChange): Promise<boolean> {
  await git(dir, ['add', '--', EXPLORATION_DIR]);
  const staged = await git(dir, ['diff', '--cached', '--name-only']);
  if (!staged) return false;
  await git(dir, ['commit', '-m', await explorationCommitSubject(dir, change)]);
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

// After an exploration PR merged, its findings that nobody rejected are
// approved: marks them so in the memory (on the next batch's branch, which
// starts from the base). A finding counts as merged once its file exists on the
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
  if (changed.length > 0) log.info(`exploración ${appName}: aprobadas por el merge del PR de exploración: ${changed.join(', ')}`);
  await openFindingIssues(appName, memoryDir, checkoutDir, baseBranchName(), (f) => changed.includes(f.id));
  return changed;
}

const DIGEST_MARKER = '<!-- ronin:exploration-digest -->';

export interface DigestApp {
  appName: string;
  memory: ExplorationMemory;
  // The findings and runs this PR adds (the rest are on the base already).
  findingIds: Set<string>;
  runs: string[];
}

export function renderDigest(opts: { since: string; branch: string; repo: string; apps: DigestApp[] }): string {
  const lines = [
    DIGEST_MARKER,
    `# Exploración de ronin — desde ${opts.since}`,
    '',
    'ronin levantó la app, la usó como cada rol en desktop y mobile y propone lo de abajo. Cada propuesta tiene su ficha en el repo (memoria de la exploración), con las capturas del antes y, si ayuda a decidir, del después: abrí la ficha desde la tabla para verlas. Mientras este PR siga abierto, las corridas de cada noche se suman acá.',
    '',
    '**Cómo revisar:**',
    '- **Para rechazar una propuesta**, comentá en su ficha (en "Files changed") con el motivo, por ejemplo: "ya está cubierto". La marco como rechazada y la sumo a `knowledge.md` para no volver a proponerla.',
    '- **Para corregir una propuesta**, comentá qué cambiar: ajusto la ficha y, si hace falta, rehago la captura del después. **Para pedir un issue aparte** a partir de una ficha, pedímelo en el comentario.',
    `- **Para decidir sobre varias propuestas a la vez** (por ejemplo, "los de mobile se resuelven con F-0003") o sobre lo que no querés que vuelva a proponer, dejá un comentario general en el PR mencionándome. Rechazo o corrijo las fichas que cubre y lo sumo a \`knowledge.md\`.`,
    '- **Para aceptar el resto**, aprobá el PR cuando quieras. Al mergearlo, abro un issue por cada propuesta que siga en pie; asignándome ese issue, la implemento.',
    '- Los bugs de la app de gravedad alta ya tienen su issue abierto desde que se encontraron.',
    '',
  ];
  for (const { appName, memory, findingIds, runs } of opts.apps) {
    const mine = memory.findings.filter((f) => findingIds.has(f.id));
    lines.push(`## ${appName}`, '');
    if (mine.length === 0) {
      lines.push('Sin propuestas en este PR.', '');
    } else {
      lines.push('| Ficha | Tipo | Gravedad | Propuesta | Función | Estado |', '|---|---|---|---|---|---|');
      for (const f of mine) {
        const file = `https://github.com/${opts.repo}/blob/${opts.branch}/${EXPLORATION_DIR}/${appName}/findings/${findingFileName(f)}`;
        const estado = f.estado === 'rechazado' ? `rechazada${f.motivo ? `: ${f.motivo}` : ''}` : f.issue ? `issue #${f.issue}` : f.estado;
        lines.push(`| [${f.id}](${file}) | ${f.tipo} | \`${f.gravedad}\` | ${f.titulo.replace(/\|/g, '/')}${f.entorno ? ' _(entorno de dev)_' : ''} | \`${f.funcion}\` | ${estado.replace(/\|/g, '/')} |`);
      }
      lines.push('');
    }
    if (runs.length > 0) {
      lines.push(`Corridas: ${runs.map((r) => `[${r}](https://github.com/${opts.repo}/blob/${opts.branch}/${EXPLORATION_DIR}/${appName}/runs/${r}.md)`).join(', ')}`, '');
    }
  }
  return lines.join('\n');
}

const findingIdOf = (path: string): string[] => {
  const id = path.match(/\/findings\/(F-\d+)[^/]*\.md$/)?.[1];
  return id ? [id] : [];
};

// The findings a batch's PR brings: those its branch touches whose id isn't
// on the base yet. A finding from an earlier, merged PR also shows up in the
// branch's diff — the next batch marks it approved and writes its issue
// number (reconcileApproved) — but it isn't this PR's to review: listing it
// made redmotos/shoppingcart#810 offer F-0001…F-0005 again, issues and all.
// By id, not path, so an old finding whose file was renamed still counts as old.
export function findingsAddedOverBase(changedFiles: string[], baseFiles: string[]): Set<string> {
  const onBase = new Set(baseFiles.flatMap(findingIdOf));
  return new Set(changedFiles.flatMap(findingIdOf).filter((id) => !onBase.has(id)));
}

// What the batch's branch adds over the base, per app: finding ids and run ids.
async function addedByBranch(dir: string, appName: string): Promise<{ findingIds: Set<string>; runs: string[] }> {
  const lines = (out: string) => out.split('\n').filter(Boolean);
  const files = lines(await git(dir, ['diff', '--name-only', `${baseRef()}...HEAD`, '--', `${EXPLORATION_DIR}/${appName}`]).catch(() => ''));
  const baseFiles = lines(await git(dir, ['ls-tree', '-r', '--name-only', baseRef(), '--', `${EXPLORATION_DIR}/${appName}/findings`]).catch(() => ''));
  const runs = files.flatMap((f) => f.match(/\/runs\/([^/]+)\.md$/)?.[1] ?? []).sort();
  return { findingIds: findingsAddedOverBase(files, baseFiles), runs };
}

export async function appsWithMemory(checkoutDir: string): Promise<string[]> {
  const entries = await readdir(join(checkoutDir, EXPLORATION_DIR), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function renderDigestFor(batch: string, batchDir: string): Promise<string> {
  const apps: DigestApp[] = [];
  for (const appName of await appsWithMemory(batchDir)) {
    const memoryDir = join(batchDir, EXPLORATION_DIR, appName);
    apps.push({ appName, memory: await loadMemory(memoryDir), ...(await addedByBranch(batchDir, appName)) });
  }
  return renderDigest({ since: batch, branch: explorationBranch(batch), repo: activeRepo().productRepo, apps });
}

// Opens the batch's PR the first time — ready for review, not a draft —
// and refreshes its body after.
export async function upsertExplorationPr(batch: string, batchDir: string): Promise<number> {
  const branch = explorationBranch(batch);
  const body = await renderDigestFor(batch, batchDir);
  const open = await findOpenPrByHead(branch);
  if (open) {
    if (open.body !== body) await setPullRequestBody(open.number, body);
    return open.number;
  }
  const convention = await repoCommitConvention(batchDir, baseRef());
  const text = convention.language === 'es' ? `exploración de ronin desde ${batch}` : `ronin exploration since ${batch}`;
  const title = convention.style === 'conventional' ? `docs(exploration): ${text}` : `${text[0].toUpperCase()}${text.slice(1)}`;
  return createPullRequest({ head: branch, base: baseBranchName(), title, body, draft: false });
}
