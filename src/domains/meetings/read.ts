import { join } from 'node:path';
import { runAgentTask } from '../../platform/agents/agent-task.js';
import { config } from '../../platform/config/config.js';
import { listOpenIssues } from '../../platform/github/github.js';
import { linearKey, teamContext } from '../../platform/linear/linear-api.js';
import { log } from '../../platform/logger.js';
import { sendMail } from '../../platform/notify/notifier.js';
import { activeRepo } from '../../platform/agents/repo-context.js';
import { removeWorktreeDir } from '../../platform/git/worktree.js';
import { teamTo } from '../portal/notify.js';
import { MEETINGS_FROM_NAME, meetingMail } from './mail.js';
import { addEvent, errorLine, getMeeting, listMeetings, noteEvent, noteLines, readNotes, updateMeeting, type Meeting } from './meetings.js';
import { meetingTask } from './prompts.js';
import { parseProposals, proposalCount } from './proposals.js';
import { host } from '../../platform/host/host.js';


// ronin reads a meeting's notes (#62) against what already exists — the
// repo's open issues and code, its Linear projects and cycles, what other
// meetings proposed — and proposes the work that comes out of them. A
// read-only agent proposes; nothing is created until someone approves it on
// the dashboard.

// A detached checkout of the base branch, of its own: it leaves no branch
// behind, and two meetings never share one.
async function checkout(n: number): Promise<string> {
  const repo = activeRepo();
  const dir = join(repo.worktreeBasePath, `meeting-R-${n}`);
  if (await host().fs.exists(dir)) await removeWorktreeDir(dir, 'meeting');
  await host().fs.mkdir(repo.worktreeBasePath, { recursive: true });
  await host().exec('git', ['fetch', 'origin'], { cwd: repo.productRepoPath }).catch(() => {});
  await host().exec('git', ['worktree', 'add', '--detach', dir, repo.worktreeBaseRef ?? config.worktreeBaseRef], { cwd: repo.productRepoPath });
  return dir;
}

// What the agent reads the notes against. Linear, when the repo has a key:
// failing to read it fails the reading, since without it ronin would
// propose projects that may exist.
async function context(meeting: Meeting) {
  const key = linearKey(activeRepo());
  const [openIssues, linear, others] = await Promise.all([
    listOpenIssues(),
    key ? teamContext(activeRepo(), key) : Promise.resolve(null),
    listMeetings(),
  ]);
  const pending = others
    .filter((m) => m.repo === meeting.repo && m.number !== meeting.number && m.status === 'review' && m.proposals)
    .map((m) => ({
      meeting: `R-${m.number}`,
      projects: m.proposals!.projects.map((p) => ({ name: p.name, issues: p.issues.map((i) => i.title) })),
      issues: m.proposals!.issues.map((i) => i.title),
      comments: m.proposals!.comments.map((c) => `#${c.issue}`),
    }));
  return { openIssues, linear, pending };
}

async function notifyTeam(meeting: Meeting): Promise<void> {
  let ok = true;
  try {
    await sendMail(meetingMail(meeting, await teamTo('reunion'), config.dashboard.url), MEETINGS_FROM_NAME);
  } catch (error) {
    ok = false;
    log.error(`reuniones: no se pudo enviar el correo de R-${meeting.number}`, error);
  }
  await noteEvent(meeting.number, { kind: 'mail', ok });
}

// Inside withActiveRepo, for a meeting that's 'pending' or 'reading' (a
// worker that died midway). Never throws: a failure leaves it 'failed', for
// someone to ask again.
export async function readMeeting(n: number): Promise<void> {
  const meeting = await getMeeting(n);
  if (!meeting || !(meeting.status === 'pending' || meeting.status === 'reading')) return;
  const outDir = join(activeRepo().worktreeBasePath, 'meeting-read-out', `R-${n}`);
  let dir: string | undefined;
  try {
    await updateMeeting(n, (m) => {
      m.status = 'reading';
    });
    await host().fs.rm(outDir, { recursive: true, force: true });
    await host().fs.mkdir(outDir, { recursive: true, mode: 0o700 });
    const lines = noteLines(await readNotes(n));
    const notesPath = join(outDir, 'notes.txt');
    await host().fs.writeFile(notesPath, lines.map((line, i) => `[${i + 1}] ${line}`).join('\n'), { mode: 0o600 });
    const ctx = await context(meeting);
    const contextPath = join(outDir, 'context.json');
    await host().fs.writeFile(contextPath, JSON.stringify({
      openIssues: ctx.openIssues.map((i) => ({ number: i.number, title: i.title, labels: i.labels })),
      ...(ctx.linear ? { linear: { projects: ctx.linear.projects.map(({ id: _id, ...p }) => p), cycles: ctx.linear.cycles.map(({ id: _id, ...c }) => c), people: ctx.linear.people.map((p) => p.name) } } : {}),
      pending: ctx.pending,
    }, null, 2), { mode: 0o600 });
    dir = await checkout(n);
    const outputPath = join(outDir, 'result.json');
    await runAgentTask(meetingTask({ type: 'meeting-read', meetingNumber: n, title: meeting.title, checkoutDir: dir, notesPath, contextPath, outputPath, linear: Boolean(ctx.linear) }));
    const parsed = parseProposals(await host().fs.readFile(outputPath, 'utf8'), {
      lines: lines.length,
      openIssues: new Map(ctx.openIssues.map((i) => [i.number, i.title])),
      linear: ctx.linear ? { projects: ctx.linear.projects.map((p) => p.name), people: ctx.linear.people.map((p) => p.name) } : null,
    });
    if (parsed.dropped.length) log.info(`reuniones: R-${n}: quedaron fuera ${parsed.dropped.join('; ')}`);
    const { dropped: _dropped, ...proposals } = parsed;
    const updated = await updateMeeting(n, (m) => {
      m.proposals = { ...proposals, at: new Date().toISOString() };
      m.status = proposalCount(proposals) ? 'review' : 'empty';
      delete m.worker;
      addEvent(m, { kind: 'read', projects: proposals.projects.length, issues: proposals.issues.length + proposals.projects.reduce((sum, p) => sum + p.issues.length, 0), comments: proposals.comments.length, discarded: proposals.discarded.length });
      return m;
    });
    log.info(`reuniones: R-${n} → ${updated.status}`);
    // Nothing to review, nothing to tell.
    if (updated.status === 'review') await notifyTeam(updated);
  } catch (error) {
    log.error(`reuniones: no se pudo leer R-${n}`, error);
    await updateMeeting(n, (m) => {
      m.status = 'failed';
      delete m.worker;
      addEvent(m, { kind: 'failed', error: errorLine(error) });
    }).catch((e) => log.error(`reuniones: no se pudo guardar la falla de R-${n}`, e));
  } finally {
    if (dir) await removeWorktreeDir(dir, 'meeting').catch(() => {});
    await host().fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
