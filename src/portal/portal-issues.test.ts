import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config, LABEL_AUTO_MERGE, LABEL_PORTAL } from '../core/config.js';
import { createUser } from './accounts.js';
import { createRequest, getRequest, prototypePatchPath, requestImagePath, updateRequest, type PortalRequest } from './requests.js';

vi.mock('../core/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async () => {});
vi.mock('../core/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...(args as [])) }));
const gh = {
  addIssueLabel: vi.fn(async () => {}),
  closeIssueNotPlanned: vi.fn(async (_n?: unknown, _c?: unknown) => true),
  createIssue: vi.fn(async () => ({ number: 901, url: 'https://github.com/redmotos/shoppingcart/issues/901' })),
  getIssueState: vi.fn(async (_n?: unknown) => ({ state: 'OPEN', stateReason: '' })),
  getPullRequestStatus: vi.fn(async () => ({ state: 'OPEN' })),
  listIssuesWithLabel: vi.fn(async () => [] as Array<{ number: number; body: string; state: string }>),
  listPrClosingIssues: vi.fn(async () => ({}) as Record<number, number[]>),
};
vi.mock('../core/github.js', () => Object.fromEntries(Object.keys(gh).map((k) => [k, (...args: unknown[]) => (gh as Record<string, (...a: unknown[]) => unknown>)[k](...args)])));
const publishEvidence = vi.fn(async () => 'abc123');
vi.mock('../app/index.js', () => ({
  publishEvidence: (...args: unknown[]) => publishEvidence(...(args as [])),
  evidenceUrl: (sha: string, path: string) => `https://github.com/redmotos/shoppingcart/blob/${sha}/${path}?raw=true`,
}));
const team: { notifyTo?: string[] } = {};
vi.mock('../core/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', productRepoPath: '/repo', portal: { name: 'Red Motos', apps: { backoffice: { name: 'Backoffice' } }, ...team } }) }));

const { portalIssueBody, issueMarker, openPortalIssue } = await import('./issue.js');
const { DECLINED_REPLY, DONE_REPLY, FIX_READY_REPLY, FIXED_REPLY, followPortalIssues, PR_READY_REPLY, RESOLVED_REPLY } = await import('./follow.js');

async function approvedRequest(over: Partial<PortalRequest> = {}): Promise<number> {
  const user = await createUser({ email: `mf${Math.random()}@x.com`, name: 'María Fernández', grants: [], createdBy: 'oskr814' });
  const r = await createRequest({ userId: user.id, repo: 'redmotos/shoppingcart', app: 'backoffice', text: 'El total en negrita, @alguien', images: [{ ext: 'png', data: Buffer.from('x') }] });
  for (const file of ['p1-antes-1.png', 'p1-despues-1.png']) {
    await mkdir(dirname(requestImagePath(r.number, file)), { recursive: true });
    await writeFile(requestImagePath(r.number, file), file);
  }
  await mkdir(dirname(prototypePatchPath(r.number, '1.diff')), { recursive: true });
  await writeFile(prototypePatchPath(r.number, '1.diff'), 'diff --git a/O.tsx b/O.tsx\n+font-bold\n');
  await updateRequest(r.number, (x) => {
    x.title = 'Total en negrita en Gestionar pedidos';
    x.status = 'approved';
    x.verdict = { kind: 'minor', proposal: 'El total se ve en negrita.', instruction: 'Gestionar pedidos', summary: 'OrdersPage.tsx, columna total', at: '' };
    x.messages.push({ id: 2, from: 'ronin', text: 'Así quedaría', images: ['p1-antes-1.png', 'p1-despues-1.png'], captions: ['Antes: hoy', 'Después: en negrita'], at: '' });
    x.prototypes = [{ round: 1, summary: 'Agrega font-bold', patch: '1.diff', messageId: 2, at: '' }];
    Object.assign(x, over);
  });
  return r.number;
}

beforeEach(async () => {
  await rm(config.portal.dataDir, { recursive: true, force: true });
  sendMail.mockClear();
  publishEvidence.mockClear();
  for (const fn of Object.values(gh)) fn.mockClear();
  gh.listIssuesWithLabel.mockResolvedValue([]);
  gh.listPrClosingIssues.mockResolvedValue({});
  gh.getPullRequestStatus.mockResolvedValue({ state: 'OPEN' });
  gh.getIssueState.mockResolvedValue({ state: 'OPEN', stateReason: '' });
});

describe('portal issues', () => {
  it("opens the issue for ronin, with the approved prototype, its diff and the conversation", async () => {
    const n = await approvedRequest();
    await openPortalIssue(n);
    expect(gh.createIssue).toHaveBeenCalledOnce();
    const [title, body, labels, assignees] = gh.createIssue.mock.calls[0] as unknown as [string, string, string[], string[]];
    expect([title, labels, assignees]).toEqual(['Total en negrita en Gestionar pedidos', [LABEL_PORTAL], [config.githubLogin]]);
    for (const part of [issueMarker(n), 'de María Fernández, en **Backoffice** (`backoffice` en ronin.app.json)', 'El total se ve en negrita.', '**Después: en negrita**', '/despues-1.png?raw=true', 'OrdersPage.tsx, columna total', 'Agrega font-bold', '+font-bold', '> El total en negrita, @​alguien']) expect(body).toContain(part);
    // Befores (the prototype's and the person's) are named so the PR leaves them out.
    const published = (publishEvidence.mock.calls[0] as unknown as [string, Array<{ path: string }>])[1].map((f) => f.path.split('/').pop());
    expect(published).toEqual(['antes-1.png', 'despues-1.png', 'antes-2.png']);
    expect((await getRequest(n))?.issue).toEqual({ number: 901, url: 'https://github.com/redmotos/shoppingcart/issues/901' });
  });

  it('cancelled while its issue was being opened, closes the issue too', async () => {
    const n = await approvedRequest({ status: 'big' });
    gh.createIssue.mockImplementationOnce(async () => {
      await updateRequest(n, (x) => { x.status = 'cancelled'; });
      return { number: 905, url: 'u' };
    });
    await openPortalIssue(n);
    expect(gh.closeIssueNotPlanned).toHaveBeenCalledWith(905, `La persona canceló el pedido P-${n} desde el portal de pedidos.`);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('finds the issue a worker already opened instead of opening another', async () => {
    const n = await approvedRequest();
    gh.listIssuesWithLabel.mockResolvedValue([{ number: 77, body: `${issueMarker(n)}\n…`, state: 'OPEN' }]);
    await openPortalIssue(n);
    expect(gh.createIssue).not.toHaveBeenCalled();
    expect((await getRequest(n))?.issue?.number).toBe(77);
  });

  it("a reported error's issue is the team's, with the reproduction, its test, its images and its diff (#137)", async () => {
    const n = await approvedRequest({ status: 'big', prototypes: [] });
    for (const file of ['r1-error-1.png', 'r1-arreglo-1.png']) await writeFile(requestImagePath(n, file), file);
    await writeFile(prototypePatchPath(n, 'r1.diff'), 'diff --git a/T.cs b/T.cs\n+[Fact]\n');
    await updateRequest(n, (x) => {
      x.title = 'Filtro de pedidos deja fuera los del último día';
      x.verdict = { kind: 'big', reason: 'ronin lo reprodujo, con un test que falla y probó un arreglo pequeño que lo pasa a verde.', summary: 'OrderHeaderExtensions', at: '' };
      x.messages.push({ id: 3, from: 'ronin', text: 'Lo pude reproducir', images: ['r1-error-1.png', 'r1-arreglo-1.png'], captions: ['El error', 'Con el arreglo de prueba'], at: '' });
      x.bug = {
        steps: 'Sales, Gestionar Pedidos, hasta 16/10',
        reproductions: [{
          round: 1, reproduced: true, steps: ['Creó 3 pedidos del 16/10', 'Filtró hasta 16/10'], fix: 'small', summary: 'FilterByDateRange compara con la medianoche', patch: 'r1.diff', messageId: 3, at: '',
          test: { kind: 'direct', name: 'FilterByDateRange_IncluyeLosPedidosDelDiaFinal', file: 'apps/api/T.cs', red: true, green: true, redOutput: 'Failed: 1', greenOutput: 'Passed: 15' },
        }],
      };
    });
    await openPortalIssue(n);
    const [, body, , assignees] = gh.createIssue.mock.calls[0] as unknown as [string, string, string[], string[]];
    expect(assignees).toEqual([]);
    for (const part of ['Es un **reporte de error**, para el equipo de desarrollo', '## Lo que reporta', '## Reproducción', '**Reproducido**', '1. Creó 3 pedidos del 16/10', '**Causa:**', '`FilterByDateRange_IncluyeLosPedidosDelDiaFinal` en `apps/api/T.cs`', 'Rojo en la rama base; en verde con el arreglo de prueba.', 'Failed: 1', 'Passed: 15', '**Con el arreglo de prueba**', 'Diff de la reproducción (el test y el arreglo de prueba)', '+[Fact]']) expect(body).toContain(part);
    expect(body).not.toContain('Diff del prototipo');
    // The error is a before and the fix an after, like a prototype's.
    const published = (publishEvidence.mock.calls[0] as unknown as [string, Array<{ path: string }>])[1].map((f) => f.path.split('/').pop());
    expect(published).toEqual(['antes-1.png', 'despues-1.png', 'antes-2.png']);
    // The team's mail says what it is.
    expect(sendMail.mock.calls.at(-1)).toMatchObject([{ subject: expect.stringContaining('(error reproducido)'), text: expect.stringContaining('rojo sin el arreglo y verde con él') }, expect.any(String)]);
  });

  it("a reported error's small fix is ronin's issue, to make from the test and the diff, and is followed like an approved one (#137)", async () => {
    const n = await approvedRequest({ status: 'fixing', prototypes: [] });
    await writeFile(prototypePatchPath(n, 'r1.diff'), 'diff --git a/T.cs b/T.cs\n+[Fact]\n');
    await updateRequest(n, (x) => {
      x.verdict = { kind: 'error', summary: 'OrderHeaderExtensions', at: '' };
      x.bug = { steps: 'hasta 16/10', reproductions: [{ round: 1, reproduced: true, steps: ['Filtró'], fix: 'small', summary: 'medianoche', patch: 'r1.diff', messageId: 2, at: '', test: { kind: 'direct', name: 'T', red: true, green: true } }] };
    });
    await openPortalIssue(n);
    const [, body, , assignees] = gh.createIssue.mock.calls[0] as unknown as [string, string, string[], string[]];
    expect(assignees).toEqual([config.githubLogin]);
    for (const part of [issueMarker(n), 'Es un **reporte de error**: ronin lo reprodujo con un test que falla y el arreglo es pequeño. Este issue es para hacer ese arreglo.', '## Reproducción', 'Partir del diff de la reproducción', '+[Fact]']) expect(body).toContain(part);
    expect(body).not.toContain('Cuando se cierre este issue');
    // ronin's: the team hears once there's a PR to approve.
    expect(sendMail).not.toHaveBeenCalled();

    gh.listPrClosingIssues.mockResolvedValue({ 950: [901] });
    await followPortalIssues();
    expect(gh.addIssueLabel).toHaveBeenCalledWith(950, LABEL_AUTO_MERGE);
    expect((await getRequest(n))?.messages.at(-1)?.text).toBe(FIX_READY_REPLY);
    expect(sendMail.mock.calls[0]).toMatchObject([{ subject: expect.stringContaining('PR para aprobar'), text: expect.stringContaining('Es el arreglo de un error que reportó') }, expect.any(String)]);
    sendMail.mockClear();
    gh.getPullRequestStatus.mockResolvedValue({ state: 'MERGED' });
    await followPortalIssues();
    expect((await getRequest(n))).toMatchObject({ status: 'done', messages: expect.arrayContaining([expect.objectContaining({ text: FIXED_REPLY })]) });
    expect(sendMail.mock.calls[0]).toMatchObject([{ text: expect.stringContaining('ya está corregido') }, expect.any(String)]);
  });

  it('a test that never failed goes as what was tried, not as proof of the error', () => {
    const body = portalIssueBody({
      number: 3, title: 't', app: 'backoffice', messages: [], status: 'big', verdict: { kind: 'big', reason: 'No se pudo reproducir con datos de prueba.', summary: '', at: '' },
      bug: { steps: 's', reproductions: [{ round: 1, reproduced: false, steps: [], summary: 'Quizás viene de Odoo', messageId: 2, at: '', test: { kind: 'e2e', name: 'filtro', red: false, green: false } }] },
    } as unknown as PortalRequest, undefined, { prototype: [], attached: [] }, undefined, undefined);
    for (const part of ['**No se pudo reproducir** con datos de prueba', '**Lo que sospecha ronin:**', '**El test que se intentó** (e2e)', 'no prueba el error']) expect(body).toContain(part);
  });

  it('cuts a huge diff and says where the whole one is', () => {
    const body = portalIssueBody({ number: 3, title: 't', app: 'backoffice', messages: [], verdict: { kind: 'minor', summary: '', at: '' } } as unknown as PortalRequest, undefined, { prototype: [], attached: [] }, 'x'.repeat(50_000), '/data/requests/3/proto/1.diff');
    expect(body.length).toBeLessThan(45_000);
    expect(body).toContain('… (recortado)');
    expect(body).toContain('/data/requests/3/proto/1.diff');
  });

  it("puts ronin:auto-merge on the PR ronin opened, tells the team, and keeps the person posted", async () => {
    const n = await approvedRequest({ issue: { number: 901, url: 'u' } });
    gh.listPrClosingIssues.mockResolvedValue({ 950: [901], 951: [12] });
    await followPortalIssues();
    expect(gh.addIssueLabel).toHaveBeenCalledWith(950, LABEL_AUTO_MERGE);
    const r = (await getRequest(n))!;
    expect(r).toMatchObject({ status: 'approved', pr: 950 });
    expect(r.messages.at(-1)?.text).toBe(PR_READY_REPLY);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0]).toMatchObject([{ to: config.notifyTo, subject: expect.stringContaining('PR para aprobar') }, expect.any(String)]);
    expect(r.events).toEqual([{ kind: 'pr', number: 950, at: expect.any(String) }, { kind: 'mail', to: 'team', subject: expect.stringContaining('PR para aprobar'), ok: true, at: expect.any(String) }]);
    // Next tick: nothing new until it merges.
    sendMail.mockClear();
    await followPortalIssues();
    expect(sendMail).not.toHaveBeenCalled();
    expect((await getRequest(n))?.status).toBe('approved');
  });

  it('once merged, tells the person it goes out in the next release', async () => {
    const n = await approvedRequest({ issue: { number: 901, url: 'u' }, pr: 950 });
    gh.getPullRequestStatus.mockResolvedValue({ state: 'MERGED' });
    await followPortalIssues();
    const r = (await getRequest(n))!;
    expect(r.status).toBe('done');
    expect(r.messages.at(-1)?.text).toBe(DONE_REPLY);
    expect(sendMail.mock.calls[0]).toMatchObject([{ subject: expect.stringMatching(/^Listo, sale en la próxima actualización/) }, expect.any(String)]);
    expect((await getRequest(n))?.events?.map((e) => [e.kind, 'status' in e ? e.status : 'to' in e ? e.to : ''])).toEqual([['closed', 'done'], ['mail', 'person']]);
  });

  it('a PR closed without merging is forgotten, and an issue closed as done without one finishes it', async () => {
    const closed = await approvedRequest({ issue: { number: 901, url: 'u' }, pr: 950 });
    gh.getPullRequestStatus.mockResolvedValue({ state: 'CLOSED' });
    await followPortalIssues();
    expect((await getRequest(closed))?.pr).toBeUndefined();
    expect((await getRequest(closed))?.events).toEqual([{ kind: 'pr-closed', number: 950, at: expect.any(String) }]);
    gh.listIssuesWithLabel.mockResolvedValue([{ number: 901, body: '', state: 'CLOSED' }]);
    gh.getIssueState.mockResolvedValue({ state: 'CLOSED', stateReason: 'COMPLETED' });
    await followPortalIssues();
    expect((await getRequest(closed))?.status).toBe('done');
  });

  it("opens the team's issue for a big one, assigned to no one, and tells the team with the link", async () => {
    const n = await approvedRequest({ status: 'big', decision: { kind: 'rejected', at: '' }, verdict: { kind: 'big', reason: 'La persona no aprobó el prototipo.', proposal: 'El total se ve en negrita.', summary: 'OrdersPage.tsx', at: '' } });
    await openPortalIssue(n);
    const [, body, labels, assignees] = gh.createIssue.mock.calls[0] as unknown as [string, string, string[], string[]];
    expect([labels, assignees]).toEqual([[LABEL_PORTAL], []]);
    for (const part of ['Es para el equipo de desarrollo: La persona vio el prototipo y no lo aprobó', 'Lo que ronin le propuso: El total se ve en negrita.', 'Diff del último prototipo', 'ronin le avisa a la persona por correo']) expect(body).toContain(part);
    expect(body).not.toContain('Para implementarlo');
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0]).toMatchObject([{ to: config.notifyTo, text: expect.stringContaining('Issue: https://github.com/redmotos/shoppingcart/issues/901') }, expect.any(String)]);
    expect((await getRequest(n))?.issue?.number).toBe(901);
    expect((await getRequest(n))?.events?.map((e) => e.kind)).toEqual(['issue', 'mail']);
    expect((await getRequest(n))?.events?.[0]).toMatchObject({ number: 901, team: true });
  });

  it("tells only the repo's own team when its portal block lists one", async () => {
    team.notifyTo = ['ana@x.com', 'luis@x.com'];
    try {
      const big = await approvedRequest({ status: 'big', verdict: { kind: 'big', reason: 'Toca dos apps.', summary: '', at: '' } });
      await openPortalIssue(big);
      const approved = await approvedRequest({ issue: { number: 901, url: 'u' } });
      gh.listPrClosingIssues.mockResolvedValue({ 950: [901] });
      await followPortalIssues();
      expect((sendMail.mock.calls as unknown as Array<[{ to: string }]>).map(([mail]) => mail.to)).toEqual(['ana@x.com, luis@x.com', 'ana@x.com, luis@x.com']);
      expect((await getRequest(approved))?.pr).toBe(950);
    } finally {
      delete team.notifyTo;
    }
  });

  it("when the team's issue closes, tells the person how: solved, or not for now", async () => {
    const solved = await approvedRequest({ status: 'big', issue: { number: 61, url: 'u' } });
    const declined = await approvedRequest({ status: 'big', issue: { number: 62, url: 'u' } });
    const open = await approvedRequest({ status: 'big', issue: { number: 63, url: 'u' } });
    gh.listIssuesWithLabel.mockResolvedValue([{ number: 61, body: '', state: 'CLOSED' }, { number: 62, body: '', state: 'CLOSED' }, { number: 63, body: '', state: 'OPEN' }]);
    gh.getIssueState.mockImplementation(async (n: unknown) => ({ state: 'CLOSED', stateReason: n === 61 ? 'COMPLETED' : 'NOT_PLANNED' }));
    await followPortalIssues();
    expect(gh.listIssuesWithLabel).toHaveBeenCalledOnce();
    expect((await getRequest(solved))).toMatchObject({ status: 'resolved', messages: expect.arrayContaining([expect.objectContaining({ text: RESOLVED_REPLY })]) });
    expect((await getRequest(declined))).toMatchObject({ status: 'declined', messages: expect.arrayContaining([expect.objectContaining({ text: DECLINED_REPLY })]) });
    expect((await getRequest(open))?.status).toBe('big');
    expect(sendMail.mock.calls.map((c) => (c as unknown as [{ subject: string }])[0].subject).sort()).toEqual(['Resuelto: Total en negrita en Gestionar pedidos', 'Revisamos tu pedido: Total en negrita en Gestionar pedidos']);
  });

  it('an approved one the team closed as not planned, without its PR, is declined', async () => {
    const n = await approvedRequest({ issue: { number: 901, url: 'u' } });
    gh.listIssuesWithLabel.mockResolvedValue([{ number: 901, body: '', state: 'CLOSED' }]);
    gh.getIssueState.mockResolvedValue({ state: 'CLOSED', stateReason: 'NOT_PLANNED' });
    await followPortalIssues();
    expect((await getRequest(n))?.status).toBe('declined');
  });

  it('leaves other repos and requests without an issue alone', async () => {
    await approvedRequest({ repo: 'Bmedical/bmedical', issue: { number: 5, url: 'u' } });
    await approvedRequest();
    await followPortalIssues();
    expect(gh.listPrClosingIssues).not.toHaveBeenCalled();
  });
});
