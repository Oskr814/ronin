import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@platform/logger.js', () => ({ log: { error: vi.fn(), info: vi.fn() } }));
vi.mock('@platform/config/config.js', () => ({ config: { githubLogin: 'ronin-agent', exploreNightWindow: '01:00-06:00', exploreTimezone: 'America/Tegucigalpa', worktreeBaseRef: 'origin/main', exploreFunctionsPerNight: 3 } }));
const review = vi.fn();
const branchFile = vi.fn();
vi.mock('./review.js', () => ({
  explorationReview: (...args: unknown[]) => review(...args),
  readBranchFile: (...args: unknown[]) => branchFile(...args),
  isExplorationPr: (pr: { headRefName: string }) => pr.headRefName.startsWith('ronin/exploration/'),
}));
const nights = vi.fn();
vi.mock('@platform/state/local-state.js', () => ({ getNightlyExploration: () => nights(), setNightlyExploration: vi.fn() }));

const { buildExplorationRuns, countFindingCards, explorationList, explorationRows, exploreNow, inventoryViewOf, nextNightly, parseExploreNow, resetExploreNow, runApp, ExploreNowError } = await import('./board.js');
const { parseNightWindow } = await import('./schedule.js');

const ENTRY = { productRepo: 'acme/product', productRepoPath: '/tmp/x', explore: ['backoffice'] } as any;
const OTHER = { productRepo: 'acme/clinic', productRepoPath: '/tmp/y', explore: ['webapp'] } as any;
const QUIET = { productRepo: 'acme/site', productRepoPath: '/tmp/z' } as any;
const PR = { number: 840, headRefName: 'ronin/exploration/2026-10-14', baseRefName: 'main', title: 'Exploración: backoffice', url: 'https://github.com/acme/product/pull/840' };
const FIX = { number: 841, headRefName: 'feat/12-x', baseRefName: 'main', title: 'Otra cosa' };
const run = (fields: Record<string, unknown>) => ({ runId: 'r', repo: 'acme/product', account: 'a', worktree: '', steps: 0, state: 'ok', startedAt: '2026-10-18T07:00:00Z', ...fields }) as any;
const ficha = (estado: string, comments: Array<{ author: string; body?: string; replyTo?: number }> = []) => ({ app: 'backoffice', estado, comments: comments.map((c, i) => ({ id: i + 1, body: '', ...c })) }) as any;

beforeEach(() => {
  review.mockReset();
  branchFile.mockReset();
  nights.mockReset().mockResolvedValue({});
});

describe('runApp', () => {
  it('reads the app, and the function when there is one, from an exploration run', () => {
    expect(runApp({ taskType: 'explore-function', label: 'app backoffice → pedidos' })).toEqual({ app: 'backoffice', fn: 'pedidos' });
    expect(runApp({ taskType: 'explore-evaluate', label: 'app backoffice' })).toEqual({ app: 'backoffice' });
    expect(runApp({ taskType: 'fix-issue', label: 'app backoffice' })).toBeNull();
    // Redoing an after image is about a finding, not a run.
    expect(runApp({ taskType: 'explore-redo-after', label: 'app backoffice → F-0069' })).toBeNull();
  });
});

describe('explorationRows', () => {
  it('says an app is being explored from its run’s record, before its first agent starts', () => {
    const live = new Map([['acme/clinic|webapp', '2026-10-18T22:30:00Z']]);
    const rows = explorationRows([ENTRY, OTHER], new Map(), [], live);
    expect(rows.map((r) => r.running)).toEqual([null, { since: '2026-10-18T22:30:00Z' }]);
  });

  it('gives each app its repo’s exploration PR, and the run going on now', () => {
    const prs = new Map([['acme/product', [FIX, PR]], ['acme/clinic', []]]);
    const runs = [
      run({ taskType: 'explore-function', label: 'app backoffice → surtir', state: 'running', startedAt: '2026-10-18T22:31:00Z', lastStep: 'Abrió /surtir' }),
      run({ taskType: 'explore-function', label: 'app backoffice → pedidos', startedAt: '2026-10-18T07:00:00Z' }),
      run({ taskType: 'fix-issue', label: 'issue 12', state: 'running' }),
    ];
    expect(explorationRows([ENTRY, OTHER, QUIET], prs, runs)).toEqual([
      { repo: 'acme/product', app: 'backoffice', pr: { number: 840, id: 'acme/product#840', title: 'Exploración: backoffice', url: 'https://github.com/acme/product/pull/840' }, running: { since: '2026-10-18T22:31:00Z', step: 'Abrió /surtir', fn: 'surtir' } },
      { repo: 'acme/clinic', app: 'webapp', pr: null, running: null },
    ]);
  });
});

describe('countFindingCards', () => {
  it('counts the ones waiting on someone apart from the ones waiting on ronin', () => {
    const counts = countFindingCards([
      ficha('propuesto'),
      ficha('propuesto', [{ author: 'oskr814' }, { author: 'ronin-agent', replyTo: 1 }]),
      ficha('propuesto', [{ author: 'oskr814' }]),
      ficha('propuesto', [{ author: 'oskr814' }, { author: 'ronin-agent', replyTo: 1 }, { author: 'oskr814', replyTo: 1, body: 'gracias' }]),
      ficha('propuesto', [{ author: 'oskr814' }, { author: 'ronin-agent', replyTo: 1 }, { author: 'oskr814', replyTo: 1, body: '@ronin-agent otra cosa' }]),
      ficha('aprobado'),
      ficha('rechazado'),
    ]);
    expect(counts).toEqual({ total: 7, decidir: 3, esperando: 2, aprobadas: 1, rechazadas: 1 });
  });
});

describe('nextNightly', () => {
  const window = parseNightWindow('01:00-06:00');
  const tz = 'America/Tegucigalpa';

  it('is tonight’s start during the day', () => {
    expect(nextNightly(new Date('2026-10-18T22:50:00Z'), window, tz, '2026-10-18')).toBe('2026-10-19T07:00:00.000Z');
  });

  it('is right now inside the window while the app hasn’t started, tomorrow once it has', () => {
    const now = new Date('2026-10-19T08:00:00Z'); // 02:00 local
    expect(nextNightly(now, window, tz, '2026-10-18')).toBe(now.toISOString());
    expect(nextNightly(now, window, tz, '2026-10-19')).toBe('2026-10-20T07:00:00.000Z');
  });

  it('is today’s start just after midnight, before the window opens', () => {
    expect(nextNightly(new Date('2026-10-19T06:30:00Z'), window, tz, '2026-10-18')).toBe('2026-10-19T07:00:00.000Z');
  });
});

describe('explorationList', () => {
  it('counts only the app’s own findings, with the last run and the next night', async () => {
    review.mockResolvedValue({ fichas: [ficha('propuesto'), { ...ficha('propuesto'), app: 'otra' }, ficha('rechazado')] });
    nights.mockResolvedValue({ backoffice: '2026-10-18' });
    const prs = new Map([['acme/product', [PR]]]);
    const runs = [run({ taskType: 'explore-evaluate', label: 'app backoffice', startedAt: '2026-10-18T07:40:00Z', state: 'error' }), run({ taskType: 'explore-function', label: 'app backoffice → pedidos' })];
    const rows = explorationRows([ENTRY], prs, runs);
    const [row] = await explorationList([ENTRY], rows, runs, prs, new Date('2026-10-18T22:50:00Z'));
    expect(review).toHaveBeenCalledWith(ENTRY, PR);
    expect(row).toMatchObject({ app: 'backoffice', lastRun: { at: '2026-10-18T07:40:00Z', state: 'error' }, next: '2026-10-19T07:00:00.000Z', fichas: { total: 2, decidir: 1, rechazadas: 1 } });
  });

  it('has no findings to count without a PR', async () => {
    const [row] = await explorationList([OTHER], explorationRows([OTHER], new Map(), []), [], new Map());
    expect(row).toMatchObject({ pr: null, fichas: null, lastRun: null });
    expect(review).not.toHaveBeenCalled();
  });
});

describe('buildExplorationRuns', () => {
  const agent = (runId: string, label: string, startedAt: string, fields: Record<string, unknown> = {}) => run({ runId, taskType: label.includes('→') ? 'explore-function' : 'explore-inventory', label, startedAt, endedAt: startedAt, costUsd: 0.5, ...fields });
  const record = (fields: Record<string, unknown>) => ({ id: '20261019T070000-backoffice', repo: 'acme/product', app: 'backoffice', trigger: { kind: 'noche' }, startedAt: '2026-10-19T07:00:00Z', endedAt: '2026-10-19T07:50:00Z', state: 'ok', ...fields }) as any;

  it('gives each recorded run the agents that ran during it, with their cost', () => {
    const agents = [agent('a1', 'app backoffice', '2026-10-19T07:01:00Z'), agent('a2', 'app backoffice → surtir', '2026-10-19T07:10:00Z', { costUsd: 1.25 })];
    const [corrida] = buildExplorationRuns([record({ seed: 7, runId: 'r1', prNumber: 919, functions: [{ id: 'surtir', charter: 'interrupciones', role: 'Sales', reason: 'nueva', status: 'explorada', viewports: ['mobile'] }], findings: [] })], agents, false);
    expect(corrida).toMatchObject({ id: '20261019T070000-backoffice', trigger: { kind: 'noche' }, state: 'ok', seed: 7, prNumber: 919, costUsd: 1.75 });
    expect(corrida.agents.map((a) => [a.runId, a.fn])).toEqual([['a1', undefined], ['a2', 'surtir']]);
    expect(corrida.legacy).toBeUndefined();
  });

  it('calls a run that still says running cut once the lock is free', () => {
    expect(buildExplorationRuns([record({ state: 'running', endedAt: undefined })], [], false)[0].state).toBe('cut');
    expect(buildExplorationRuns([record({ state: 'running', endedAt: undefined })], [], true)[0].state).toBe('running');
  });

  it('puts the runs from before the records together from their agents, newest first', () => {
    const corridas = buildExplorationRuns([], [
      agent('b1', 'app backoffice', '2026-10-17T07:00:00Z'),
      agent('b2', 'app backoffice → pedidos', '2026-10-17T07:10:00Z'),
      agent('b3', 'app backoffice → clientes', '2026-10-17T07:20:00Z', { state: 'error', error: 'se cayó\nstack' }),
      agent('c1', 'app backoffice → pedidos', '2026-10-18T07:05:00Z', { state: 'running', endedAt: undefined }),
    ], false);
    expect(corridas.map((c) => [c.id, c.state, c.legacy])).toEqual([['legacy-c1', 'running', true], ['legacy-b1', 'error', true]]);
    expect(corridas[1]).toMatchObject({ trigger: { kind: 'desconocido' }, error: 'se cayó', costUsd: 1.5, functions: [{ id: 'pedidos', status: 'explorada' }, { id: 'clientes', status: 'fallo' }] });
  });
});

describe('inventoryViewOf', () => {
  const yml = `actualizado: { fecha: 2026-10-18, sha: abc123 }
funciones:
  - id: surtir
    nombre: Surtir
    rutas: [/surtir/:id]
    prioridad: alta
    cobertura:
      desktop: { camino-feliz: 2026-10-14 }
      mobile: { camino-feliz: 2026-10-16, interrupciones: 2026-10-18 }
    hallazgos: [F-0021]
  - id: cotizaciones
    nombre: Cotizaciones
`;

  it('reads the open PR’s branch, with each charter’s last date and the last time', async () => {
    branchFile.mockResolvedValue(yml);
    const inv = await inventoryViewOf(ENTRY, 'backoffice', PR);
    expect(branchFile).toHaveBeenCalledWith(ENTRY, 'ronin/exploration/2026-10-14', 'docs/exploration/backoffice/inventory.yml');
    expect(inv.from).toEqual({ branch: 'ronin/exploration/2026-10-14', pr: 840 });
    expect(inv.actualizado).toEqual({ fecha: '2026-10-18', sha: 'abc123' });
    expect(inv.funciones).toEqual([
      { id: 'surtir', nombre: 'Surtir', rutas: ['/surtir/:id'], prioridad: 'alta', charters: { 'camino-feliz': '2026-10-16', interrupciones: '2026-10-18' }, viewports: ['desktop', 'mobile'], ultima: '2026-10-18', hallazgos: 1 },
      { id: 'cotizaciones', nombre: 'Cotizaciones', rutas: [], prioridad: 'normal', charters: {}, viewports: [], hallazgos: 0 },
    ]);
  });

  it('reads the base without a PR, and says when there is no inventory', async () => {
    branchFile.mockResolvedValue(null);
    const inv = await inventoryViewOf({ ...ENTRY, worktreeBaseRef: 'origin/odoo-main' }, 'backoffice', undefined);
    expect(inv).toMatchObject({ from: { branch: 'odoo-main' }, funciones: [], error: 'no hay inventory.yml de backoffice en odoo-main' });
  });
});

describe('parseExploreNow', () => {
  it('takes how many functions and for how long, standing for tonight’s run unless said otherwise', () => {
    expect(parseExploreNow({})).toEqual({ maxFunctions: 3, hours: null, tonight: true });
    expect(parseExploreNow({ maxFunctions: 5, hours: 2, tonight: false })).toEqual({ maxFunctions: 5, hours: 2, tonight: false });
  });

  it('refuses what it can’t run', () => {
    expect(() => parseExploreNow({ maxFunctions: 0 })).toThrow('de 1 a 10');
    expect(() => parseExploreNow({ maxFunctions: 2.5 })).toThrow(ExploreNowError);
    expect(() => parseExploreNow({ hours: 3 })).toThrow('1, 2, 4 horas');
    expect(() => parseExploreNow({ tonight: 'sí' })).toThrow('sí o no');
  });
});

describe('exploreNow', () => {
  const launch = vi.fn();
  const markNight = vi.fn();
  beforeEach(() => {
    resetExploreNow();
    launch.mockReset();
    markNight.mockReset().mockResolvedValue(undefined);
  });

  it('starts the worker as the person, and takes the place of the next night', async () => {
    const now = new Date('2026-10-18T22:50:00Z'); // 16:50 local: the next night is tonight's, the 19th
    const done = await exploreNow(ENTRY, 'backoffice', 'persona', { maxFunctions: 2, hours: 1, tonight: true }, now, { busy: async () => false, launch, markNight });
    expect(markNight).toHaveBeenCalledWith('2026-10-19');
    expect(launch).toHaveBeenCalledWith({ repo: 'acme/product', appName: 'backoffice', maxFunctions: 2, by: 'persona', until: '2026-10-18T23:50:00.000Z' });
    expect(done).toEqual({ until: '2026-10-18T23:50:00.000Z', night: '2026-10-19' });
  });

  it('leaves the night alone and has no cap when asked so', async () => {
    const done = await exploreNow(ENTRY, 'backoffice', 'persona', { maxFunctions: 3, hours: null, tonight: false }, new Date('2026-10-18T22:50:00Z'), { busy: async () => false, launch, markNight });
    expect(markNight).not.toHaveBeenCalled();
    expect(launch).toHaveBeenCalledWith({ repo: 'acme/product', appName: 'backoffice', maxFunctions: 3, by: 'persona' });
    expect(done).toEqual({});
  });

  it('inside the window, stands for the night going on', async () => {
    await exploreNow(ENTRY, 'backoffice', 'persona', { maxFunctions: 3, hours: null, tonight: true }, new Date('2026-10-19T08:00:00Z'), { busy: async () => false, launch, markNight });
    expect(markNight).toHaveBeenCalledWith('2026-10-19');
  });

  it('refuses while the repo explores, and right after a launch whose worker hasn’t taken the lock yet', async () => {
    await expect(exploreNow(ENTRY, 'backoffice', 'persona', { maxFunctions: 3, hours: null, tonight: true }, new Date(), { busy: async () => true, launch, markNight })).rejects.toMatchObject({ status: 409 });
    expect(launch).not.toHaveBeenCalled();
    expect(markNight).not.toHaveBeenCalled();
    const now = new Date('2026-10-18T22:50:00Z');
    await exploreNow(ENTRY, 'backoffice', 'persona', { maxFunctions: 3, hours: null, tonight: false }, now, { busy: async () => false, launch, markNight });
    await expect(exploreNow(ENTRY, 'backoffice', 'otra', { maxFunctions: 3, hours: null, tonight: false }, new Date(now.getTime() + 30_000), { busy: async () => false, launch, markNight })).rejects.toThrow('una por repo a la vez');
    await exploreNow(ENTRY, 'backoffice', 'otra', { maxFunctions: 3, hours: null, tonight: false }, new Date(now.getTime() + 61_000), { busy: async () => false, launch, markNight });
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
