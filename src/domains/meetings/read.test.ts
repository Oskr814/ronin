import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { config } from '../../core/config.js';
import { withActiveRepo, type RepoEntry } from '../../core/repo-context.js';

// The agent, GitHub, Linear, git and Gmail are stand-ins: what's checked is
// what ronin gives the agent and what it makes of its answer.
const runAgentTask = vi.fn();
vi.mock('../../core/agent-task.js', () => ({ runAgentTask: (task: unknown) => runAgentTask(task) }));
const listOpenIssues = vi.fn();
vi.mock('../../core/github.js', () => ({ listOpenIssues: () => listOpenIssues() }));
const teamContext = vi.fn();
vi.mock('../../core/linear-api.js', () => ({ linearKey: (e: RepoEntry) => (e.linear ? 'lin_key' : null), teamContext: () => teamContext() }));
const sendMail = vi.fn();
vi.mock('../../core/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...args) }));
vi.mock('../../core/worktree.js', () => ({ removeWorktreeDir: async () => {} }));
const git = vi.fn();
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, out: { stdout: string; stderr: string }) => void) => {
    git(cmd, ...args);
    cb(null, { stdout: '', stderr: '' });
  },
}));

const { createMeeting, getMeeting, readNotes } = await import('./meetings.js');
const { extractPasted } = await import('./extract.js');
const { readMeeting } = await import('./read.js');

const SC = 'redmotos/shoppingcart';
const ENTRY = { productRepo: SC, productRepoPath: '/tmp/sc', linear: { apiKeyEnv: 'X' }, portal: { name: 'Red Motos', apps: {}, notifyTo: ['equipo@example.com'] } } as unknown as RepoEntry;
const NOTES = [
  'Resumen',
  'Devoluciones: registrar las devoluciones de mayoristas desde el backoffice, con nota de crédito en Odoo.',
  'Exportar pedidos: bodega pidió bajar a Excel la lista de pedidos con los filtros puestos.',
  'Búsqueda de clientes sin tilde: se acordó darle prioridad.',
  'Precios de llantas con el proveedor.',
].join('\n\n');

const ANSWER = {
  resumen: 'Devoluciones y un reporte para bodega.',
  proyectos: [{ nombre: 'Devoluciones', descripcion: 'Registrar devoluciones.', por_que: 'Nada lo cubre.', citas: [2], issues: [{ titulo: 'Modelo de devolución', descripcion: 'El modelo.', por_que: 'Base.', citas: [2] }] }],
  issues: [{ titulo: 'Exportar pedidos a Excel', descripcion: 'Un botón.', por_que: 'Nuevo.', citas: [3], ciclo: 'proximo' }],
  comentarios: [{ issue: 915, comentario: 'Prioridad acordada.', por_que: 'Ya existe.', citas: [4] }],
  descartado: [{ tema: 'Precios', motivo: 'No es un cambio en la aplicación.', citas: [5] }],
};

const answer = (body: unknown) => runAgentTask.mockImplementation(async (task: { outputPath: string }) => {
  await writeFile(task.outputPath, typeof body === 'string' ? body : JSON.stringify(body));
  return '';
});

const read = (n: number, entry = ENTRY) => withActiveRepo(entry, () => readMeeting(n));

beforeEach(async () => {
  await rm(config.meetings.dataDir, { recursive: true, force: true });
  vi.clearAllMocks();
  listOpenIssues.mockResolvedValue([{ number: 915, title: 'Buscar sin tilde no encuentra clientes', url: '', labels: ['bug'] }]);
  teamContext.mockResolvedValue({ team: 'RED', projects: [{ id: 'p', name: 'Mejoras del checkout', status: 'In Progress', statusType: 'started' }], cycles: [{ id: 'c17', number: 17, startsAt: '', endsAt: '', current: true }], people: [{ id: 'u', name: 'Ana Pérez' }] });
  sendMail.mockResolvedValue(undefined);
});

describe('readMeeting', () => {
  it('gives the agent the numbered notes and what exists, and keeps what it proposes', async () => {
    const m = await createMeeting({ repo: SC, by: 'Oskr814', title: 'Seguimiento', notes: extractPasted(NOTES) });
    let seen: { notes: string; context: Record<string, unknown>; task: Record<string, unknown> } | undefined;
    runAgentTask.mockImplementation(async (task: { notesPath: string; contextPath: string; outputPath: string }) => {
      seen = { notes: await readFile(task.notesPath, 'utf8'), context: JSON.parse(await readFile(task.contextPath, 'utf8')), task };
      await writeFile(task.outputPath, JSON.stringify(ANSWER));
    });
    await read(m.number);
    expect(seen!.notes.split('\n')).toEqual(['[1] Resumen', expect.stringMatching(/^\[2\] Devoluciones/), expect.stringMatching(/^\[3\] Exportar/), expect.stringMatching(/^\[4\] Búsqueda/), '[5] Precios de llantas con el proveedor.']);
    expect(seen!.context).toEqual({
      openIssues: [{ number: 915, title: 'Buscar sin tilde no encuentra clientes', labels: ['bug'] }],
      linear: { projects: [{ name: 'Mejoras del checkout', status: 'In Progress', statusType: 'started' }], cycles: [{ number: 17, startsAt: '', endsAt: '', current: true }], people: ['Ana Pérez'] },
      pending: [],
    });
    expect(seen!.task).toMatchObject({ type: 'meeting-read', meetingNumber: m.number, title: 'Seguimiento', linear: true });
    // A detached checkout of the base branch.
    expect(git).toHaveBeenCalledWith('git', 'worktree', 'add', '--detach', expect.stringContaining(`meeting-R-${m.number}`), 'origin/main');

    const after = (await getMeeting(m.number))!;
    expect(after.status).toBe('review');
    expect(after.worker).toBeUndefined();
    expect(after.proposals).toMatchObject({
      summary: 'Devoluciones y un reporte para bodega.',
      projects: [{ name: 'Devoluciones', issues: [{ title: 'Modelo de devolución' }] }],
      issues: [{ title: 'Exportar pedidos a Excel', cycle: 'next' }],
      comments: [{ issue: 915, issueTitle: 'Buscar sin tilde no encuentra clientes' }],
      discarded: [{ topic: 'Precios' }],
    });
    expect(after.events.map((e) => e.kind)).toEqual(['uploaded', 'read', 'mail']);
    expect(after.events[1]).toMatchObject({ projects: 1, issues: 2, comments: 1, discarded: 1 });
    // The notes are left as they were.
    expect(await readNotes(m.number)).toBe(NOTES);
  });

  it('tells the repo\'s team, with what it proposes and never the notes', async () => {
    const m = await createMeeting({ repo: SC, by: 'Oskr814', title: 'Seguimiento', notes: extractPasted(NOTES) });
    answer(ANSWER);
    await read(m.number);
    expect(sendMail).toHaveBeenCalledTimes(1);
    const [mail, from] = sendMail.mock.calls[0];
    expect(from).toBe('ronin · Reuniones');
    expect(mail.to).toBe('equipo@example.com');
    expect(mail.subject).toBe('[ronin] Reunión "Seguimiento": 1 proyecto, 2 issues y 1 comentario por revisar');
    expect(mail.text).toContain('- Devoluciones, con 1 issue');
    expect(mail.text).toContain('- #915 Buscar sin tilde no encuentra clientes');
    expect(mail.text).toContain('- Precios: No es un cambio en la aplicación.');
    expect(mail.text).not.toContain('Odoo');
  });

  it('proposes nothing when nothing comes out, and says nothing', async () => {
    const m = await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) });
    answer({ resumen: 'Nada nuevo.', proyectos: [], issues: [], comentarios: [], descartado: [{ tema: 'Precios', motivo: 'No es de la app.', citas: [5] }] });
    await read(m.number);
    expect((await getMeeting(m.number))!.status).toBe('empty');
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('shows earlier meetings\' pending proposals, of the same repo only', async () => {
    const one = await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) });
    answer(ANSWER);
    await read(one.number);
    await createMeeting({ repo: 'Bmedical/bmedical', by: 'a', notes: extractPasted(NOTES) });
    const two = await createMeeting({ repo: SC, by: 'a', notes: extractPasted(`${NOTES}\n\nOtra cosa.`) });
    let pending: unknown;
    runAgentTask.mockImplementation(async (task: { contextPath: string; outputPath: string }) => {
      pending = JSON.parse(await readFile(task.contextPath, 'utf8')).pending;
      await writeFile(task.outputPath, JSON.stringify(ANSWER));
    });
    await read(two.number);
    expect(pending).toEqual([{ meeting: `R-${one.number}`, projects: [{ name: 'Devoluciones', issues: ['Modelo de devolución'] }], issues: ['Exportar pedidos a Excel'], comments: ['#915'] }]);
  });

  it('without Linear, reads it without projects', async () => {
    const m = await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) });
    let task: { linear?: boolean; contextPath?: string } = {};
    runAgentTask.mockImplementation(async (t: { linear: boolean; contextPath: string; outputPath: string }) => {
      task = { linear: t.linear, contextPath: JSON.parse(await readFile(t.contextPath, 'utf8')).linear };
      await writeFile(t.outputPath, JSON.stringify(ANSWER));
    });
    await read(m.number, { ...ENTRY, linear: undefined } as RepoEntry);
    expect(task).toEqual({ linear: false, contextPath: undefined });
    expect(teamContext).not.toHaveBeenCalled();
    const proposals = (await getMeeting(m.number))!.proposals!;
    expect(proposals).toMatchObject({ projects: [], issues: [{ title: 'Modelo de devolución' }, { title: 'Exportar pedidos a Excel' }] });
    expect(proposals.issues[1]).not.toHaveProperty('cycle');
  });

  it('fails, for someone to ask again, when the agent or Linear does', async () => {
    const m = await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) });
    answer('esto no es JSON');
    await read(m.number);
    let after = (await getMeeting(m.number))!;
    expect(after.status).toBe('failed');
    expect(after.events.at(-1)).toMatchObject({ kind: 'failed' });
    expect(sendMail).not.toHaveBeenCalled();

    const other = await createMeeting({ repo: SC, by: 'a', notes: extractPasted(`${NOTES} Otra.`) });
    teamContext.mockRejectedValue(new Error('Linear respondió 500: caído'));
    await read(other.number);
    after = (await getMeeting(other.number))!;
    expect(after.status).toBe('failed');
    expect(after.events.at(-1)).toMatchObject({ kind: 'failed', error: 'Linear respondió 500: caído' });
    expect(runAgentTask).toHaveBeenCalledTimes(1);
  });

  it('leaves alone a meeting that is not to read', async () => {
    const m = await createMeeting({ repo: SC, by: 'a', notes: extractPasted(NOTES) });
    answer(ANSWER);
    await read(m.number);
    runAgentTask.mockClear();
    await read(m.number);
    expect(runAgentTask).not.toHaveBeenCalled();
  });
});
