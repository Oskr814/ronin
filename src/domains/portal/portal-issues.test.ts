import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config, LABEL_AUTO_MERGE, LABEL_PORTAL } from '@platform/config/config.js';
import { createUser } from './accounts.js';
import { createRequest, getRequest, prototypePatchPath, requestImagePath, updateRequest, type PortalRequest } from './requests.js';

vi.mock('@platform/logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
const sendMail = vi.fn(async () => {});
vi.mock('@platform/notify/notifier.js', () => ({ sendMail: (...args: unknown[]) => sendMail(...(args as [])) }));
const gh = {
  addIssueLabel: vi.fn(async () => {}),
  closeIssueNotPlanned: vi.fn(async (_n?: unknown, _c?: unknown) => true),
  createIssue: vi.fn(async () => ({ number: 901, url: 'https://github.com/redmotos/shoppingcart/issues/901' })),
  getIssueState: vi.fn(async (_n?: unknown) => ({ state: 'OPEN', stateReason: '' })),
  getPullRequestStatus: vi.fn(async () => ({ state: 'OPEN' })),
  listIssuesWithLabel: vi.fn(async () => [] as Array<{ number: number; body: string; state: string }>),
  listPrClosingIssues: vi.fn(async () => ({}) as Record<number, number[]>),
};
vi.mock('@platform/github/github.js', () => Object.fromEntries(Object.keys(gh).map((k) => [k, (...args: unknown[]) => (gh as Record<string, (...a: unknown[]) => unknown>)[k](...args)])));
const approvePr = vi.fn(async (..._args: unknown[]) => ({ id: 1, url: 'u' }));
vi.mock('@platform/github/github-as-user.js', () => ({ approvePr: (...args: unknown[]) => approvePr(...args) }));
const publishEvidence = vi.fn(async () => 'abc123');
vi.mock('../product-app/index.js', () => ({
  publishEvidence: (...args: unknown[]) => publishEvidence(...(args as [])),
  evidenceUrl: (sha: string, path: string) => `https://github.com/redmotos/shoppingcart/blob/${sha}/${path}?raw=true`,
}));
const team: { notifyTo?: string[] } = {};
vi.mock('@platform/agents/repo-context.js', () => ({ activeRepo: () => ({ productRepo: 'redmotos/shoppingcart', productRepoPath: '/repo', portal: { name: 'Red Motos', apps: { backoffice: { name: 'Backoffice' } }, ...team } }) }));

const { portalIssueBody, issueMarker, openPortalIssue } = await import('./issue.js');
const { closedReply, DECLINED_REPLY, DEPLOY_READY_REPLY, DONE_REPLY, dropCloseNote, FIX_READY_REPLY, FIXED_REPLY, followPortalIssues, noteClosing, PR_READY_REPLY, RESOLVED_REPLY } = await import('./follow.js');
const { seal } = await import('@platform/crypto/sealed.js');

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

  it("a big one that went through the interview carries what the person decided (#225)", () => {
    const answers = [{ id: 'quien', question: '¿Quién | decide?', answer: 'Gerencia' }, { id: 'aviso', question: '¿A quién se avisa?', answer: 'No sé, que lo decida el equipo', unsure: true }];
    const base = {
      number: 3, title: 'Precios para mayoristas', app: 'backoffice', status: 'big', verdict: { kind: 'big', reason: 'Regla nueva', summary: 'PriceList', at: '' },
      messages: [
        { id: 1, from: 'person', text: 'Precios para mayoristas', images: [], at: '' },
        { id: 2, from: 'ronin', text: 'Respóndeme esto', images: [], questions: [], at: '' },
        { id: 3, from: 'person', text: '', images: [], answers, at: '' },
        { id: 4, from: 'ronin', text: 'Así lo entendí', images: [], understood: { decisions: [{ topic: 'Quién decide', decision: 'Gerencia' }], out: ['Precios por producto'], team: ['A quién se avisa'] }, at: '' },
      ],
    };
    const body = (over: object) => portalIssueBody({ ...base, ...over } as unknown as PortalRequest, undefined, { prototype: [], attached: [] }, undefined, undefined);
    const confirmed = body({ interview: { rounds: 1, corrections: 0, confirmed: true } });
    for (const part of ['## Lo que definió la persona', 'la persona confirmó este resumen', '| Quién decide | Gerencia |', '**Queda fuera:** Precios por producto.', '**Para decidir el equipo:** A quién se avisa.', '- ¿Quién | decide? → Gerencia', '- ¿A quién se avisa? → _No sé, que lo decida el equipo_']) expect(confirmed).toContain(part);
    expect(confirmed.indexOf('## Lo que definió la persona')).toBeLessThan(confirmed.indexOf('## Lo que vio ronin'));
    expect(body({ interview: { rounds: 1, corrections: 0 } })).toContain('La persona **no confirmó** este resumen');
    // Answered, no summary: the answers as a table.
    const answered = body({ interview: { rounds: 1, corrections: 0 }, messages: base.messages.slice(0, 3) });
    expect(answered).toContain('| ¿Quién \\| decide? | Gerencia |');
    expect(answered).toContain('| ¿A quién se avisa? | _Sin decidir: lo decide el equipo._ |');
    expect(body({ interview: { rounds: 1, corrections: 0, skipped: true }, messages: base.messages.slice(0, 2) })).toContain('prefirió enviarlo sin responderlas');
    expect(body({})).not.toContain('Lo que definió la persona');
  });

  it('approved in words only, the issue is for the proposal, without a prototype (#409)', () => {
    const body = portalIssueBody({
      number: 5, title: 'Sin los anulados', app: 'backoffice', status: 'approved', messages: [], proposals: 1,
      verdict: { kind: 'minor', proposal: 'La lista de pedidos deja fuera los anulados.', prototype: false, summary: 'orders.ts: filtro por estado', at: '' },
      prototypes: [{ round: 1, summary: 'Un prototipo anterior', messageId: 2, at: '' }],
    } as unknown as PortalRequest, undefined, { prototype: [], attached: [] }, undefined, undefined);
    for (const part of ['Aprobó la propuesta, sin prototipo (después de 1 ajuste)', 'La lista de pedidos deja fuera los anulados.', 'No hubo prototipo', 'orders.ts: filtro por estado']) expect(body).toContain(part);
    for (const part of ['Partir del diff', 'Un prototipo anterior', 'una maqueta']) expect(body).not.toContain(part);
  });

  it("carries what the dev answered approving it, for ronin to follow (#413)", () => {
    const devDecision = { kind: 'review', by: 'ana-dev', at: '', answers: [{ question: '¿También en el reporte?', answer: 'Sí,\nen los dos.' }] };
    const of = (over: object) => portalIssueBody({ number: 5, title: 't', app: 'backoffice', messages: [], verdict: { kind: 'minor', proposal: 'p', summary: '', at: '' }, ...over } as unknown as PortalRequest, undefined, { prototype: [], attached: [] }, undefined, undefined);
    for (const status of ['approved', 'fixing']) {
      const body = of({ status, devDecision, ...(status === 'fixing' ? { bug: { steps: 's', reproductions: [{ round: 1, reproduced: true, steps: [], summary: 'c', messageId: 1, at: '' }] } } : {}) });
      for (const part of ['## Lo que decidió el equipo', 'Al aprobarlo, ana-dev respondió', 'manda esta respuesta', '- **¿También en el reporte?**\n  Sí, en los dos.']) expect(body).toContain(part);
      expect(body.indexOf('## Lo que decidió el equipo')).toBeLessThan(body.indexOf('## Para implementarlo'));
    }
    expect(of({ status: 'approved', devDecision: { ...devDecision, answers: undefined } })).not.toContain('Lo que decidió el equipo');
    const noted = of({ status: 'approved', devDecision: { ...devDecision, answers: undefined, note: 'Igual que en Reportes.\nSin tocar el PDF.' } });
    for (const part of ['## Lo que decidió el equipo', 'Al aprobarlo, ana-dev agregó', '> Igual que en Reportes.\n> Sin tocar el PDF.']) expect(noted).toContain(part);
    expect(of({ status: 'approved', devDecision: { ...devDecision, note: 'n' } })).toContain('Y agregó');
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

  it('a dev chose to deploy it (#353): its PR is approved as them, once, and their token goes', async () => {
    (config.dashboard as { sessionSecret: string }).sessionSecret = 's'.repeat(40);
    const token = seal('gho_inventado', config.dashboard.sessionSecret, 'dev-decision');
    const n = await approvedRequest({ issue: { number: 901, url: 'u' }, devDecision: { kind: 'deploy', by: 'ana-dev', at: '', token } });
    gh.listPrClosingIssues.mockResolvedValue({ 950: [901] });
    await followPortalIssues();
    expect(gh.addIssueLabel).toHaveBeenCalledWith(950, LABEL_AUTO_MERGE);
    expect(approvePr).toHaveBeenCalledWith('gho_inventado', 'redmotos/shoppingcart', 950, expect.stringContaining(`P-${n}`));
    const r = (await getRequest(n))!;
    expect(r.devDecision).toEqual({ kind: 'deploy', by: 'ana-dev', at: '' });
    expect(r.events?.slice(0, 2)).toEqual([{ kind: 'pr', number: 950, at: expect.any(String) }, { kind: 'pr-approved', number: 950, by: 'ana-dev', ok: true, at: expect.any(String) }]);
    expect(r.messages.at(-1)?.text).toBe(DEPLOY_READY_REPLY);
    expect((sendMail.mock.calls[0] as unknown as [{ text: string }])[0].text).toContain('ana-dev eligió aprobarlo y desplegarlo');
  });

  it("deploying it with a token that no longer works, the PR waits for an approval and the request says so", async () => {
    (config.dashboard as { sessionSecret: string }).sessionSecret = 's'.repeat(40);
    const token = seal('gho_revocado', config.dashboard.sessionSecret, 'dev-decision');
    const n = await approvedRequest({ issue: { number: 901, url: 'u' }, devDecision: { kind: 'deploy', by: 'ana-dev', at: '', token } });
    gh.listPrClosingIssues.mockResolvedValue({ 950: [901] });
    approvePr.mockRejectedValueOnce(new Error('Bad credentials'));
    await followPortalIssues();
    const r = (await getRequest(n))!;
    expect(r.devDecision?.token).toBeUndefined();
    expect(r.events?.[1]).toMatchObject({ kind: 'pr-approved', ok: false });
    expect(r.messages.at(-1)?.text).toBe(PR_READY_REPLY);
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

  it('closed from the tablero with a reason, the person gets those same words, in the portal and by mail', async () => {
    const n = await approvedRequest({ pr: 950, issue: { number: 901, url: 'u' } });
    const other = await approvedRequest({ issue: { number: 902, url: 'u' } });
    expect(await noteClosing('redmotos/shoppingcart', { issue: 901, pr: 950 }, 'Ya lo cubre el reporte de ventas.\n\nLo vemos en el próximo ciclo.', 'oskr814')).toBe(n);
    expect(await noteClosing('redmotos/shoppingcart', { pr: 999 }, 'x', 'oskr814')).toBeNull();
    expect(await noteClosing('acme/otro', { issue: 901 }, 'x', 'oskr814')).toBeNull();
    // Its PR closed, then its issue as not planned.
    gh.getPullRequestStatus.mockResolvedValue({ state: 'CLOSED' });
    await followPortalIssues();
    gh.listIssuesWithLabel.mockResolvedValue([{ number: 901, body: '', state: 'CLOSED' }]);
    gh.getIssueState.mockResolvedValue({ state: 'CLOSED', stateReason: 'NOT_PLANNED' });
    await followPortalIssues();
    const reply = closedReply('declined', 'Ya lo cubre el reporte de ventas.\n\nLo vemos en el próximo ciclo.');
    expect(await getRequest(n)).toMatchObject({ status: 'declined', messages: expect.arrayContaining([expect.objectContaining({ from: 'ronin', text: reply })]) });
    expect(reply).toContain('decidió no hacerlo por ahora:\n\nYa lo cubre');
    const [mail] = (sendMail.mock.calls.at(-1) as unknown as [{ text: string; html: string }]);
    expect(mail.text).toContain('Ya lo cubre el reporte de ventas.\n\nLo vemos en el próximo ciclo.');
    expect(mail.html).toContain('Lo vemos en el próximo ciclo.');
    // Without one, the usual words; a note taken back leaves nothing.
    await noteClosing('redmotos/shoppingcart', { issue: 902 }, 'x', 'oskr814');
    await dropCloseNote(other);
    expect((await getRequest(other))?.closeNote).toBeUndefined();
  });

  it('an approved one the team closed as not planned, without its PR, is declined', async () => {
    const n = await approvedRequest({ issue: { number: 901, url: 'u' } });
    gh.listIssuesWithLabel.mockResolvedValue([{ number: 901, body: '', state: 'CLOSED' }]);
    gh.getIssueState.mockResolvedValue({ state: 'CLOSED', stateReason: 'NOT_PLANNED' });
    await followPortalIssues();
    expect((await getRequest(n))?.status).toBe('declined');
  });

  it('a request that changed while GitHub answered is left alone: no close, no mail (#402)', async () => {
    const n = await approvedRequest({ status: 'big', issue: { number: 901, url: 'u' } });
    gh.listIssuesWithLabel.mockResolvedValue([{ number: 901, body: '', state: 'CLOSED' }]);
    // Handed back to ronin for its prototype, its issue unlinked, while the pass asked how the issue closed.
    gh.getIssueState.mockImplementation(async () => {
      await updateRequest(n, (x) => { x.status = 'minor'; delete x.issue; });
      return { state: 'CLOSED', stateReason: 'NOT_PLANNED' };
    });
    await followPortalIssues();
    const r = (await getRequest(n))!;
    expect(r.status).toBe('minor');
    expect(r.messages.map((m) => m.text)).not.toContain(DECLINED_REPLY);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("a PR found for a request cancelled meanwhile doesn't touch it (#402)", async () => {
    const n = await approvedRequest({ issue: { number: 901, url: 'u' } });
    gh.listPrClosingIssues.mockImplementation(async () => {
      await updateRequest(n, (x) => { x.status = 'cancelled'; });
      return { 950: [901] };
    });
    await followPortalIssues();
    expect((await getRequest(n))?.pr).toBeUndefined();
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('leaves other repos and requests without an issue alone', async () => {
    await approvedRequest({ repo: 'Bmedical/bmedical', issue: { number: 5, url: 'u' } });
    await approvedRequest();
    await followPortalIssues();
    expect(gh.listPrClosingIssues).not.toHaveBeenCalled();
  });
});
