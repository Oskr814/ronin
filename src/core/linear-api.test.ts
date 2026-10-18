import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProject, currentCycle, linearIssuesFor, linearKey, resolveProject, teamPlanning, updateIssue } from './linear-api.js';

const ENTRY = { productRepo: 'redmotos/shoppingcart', productRepoPath: '/tmp/x', linear: { apiKeyEnv: 'LINEAR_API_KEY_TEST' } };
const PREFIX = 'https://github.com/redmotos/shoppingcart/issues/';

const raw = (id: string, github: string | null, extra: Record<string, unknown> = {}) => ({
  identifier: id, title: `Issue ${id}`, url: `https://linear.app/red-motos/issue/${id}/slug`,
  state: { name: 'Todo', type: 'unstarted' }, project: null, assignee: null,
  attachments: { nodes: github ? [{ url: github }] : [] },
  ...extra,
});

function respond(data: unknown, status = 200) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(data), { status }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.LINEAR_API_KEY_TEST;
});

describe('linearKey', () => {
  it('reads the key from the env var the repo names, or null', () => {
    expect(linearKey(ENTRY)).toBeNull();
    process.env.LINEAR_API_KEY_TEST = 'lin_api_x';
    expect(linearKey(ENTRY)).toBe('lin_api_x');
    expect(linearKey({ productRepo: 'a/b', productRepoPath: '/x' })).toBeNull();
  });
});

describe('linearIssuesFor', () => {
  it('asks by GitHub URL and maps each Linear issue to its GitHub number', async () => {
    const fetchMock = respond({ data: { issues: { nodes: [
      raw('RED-214', `${PREFIX}909`, { project: { id: 'p1', name: 'Catálogos' }, cycle: { number: 17, name: null, isActive: true }, assignee: { displayName: 'dev-ejemplo' } }),
      raw('RED-1', null),
    ] } } });
    const found = await linearIssuesFor(ENTRY, 'lin_api_x', [909, 910]);
    expect([...found.keys()]).toEqual([909]);
    expect(found.get(909)).toEqual({
      id: 'RED-214', title: 'Issue RED-214', url: 'https://linear.app/red-motos/issue/RED-214/slug',
      state: { name: 'Todo', type: 'unstarted' }, project: { id: 'p1', name: 'Catálogos' }, assignee: 'dev-ejemplo',
      githubNumber: 909, cycle: { number: 17, current: true },
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.linear.app/graphql');
    expect((init.headers as Record<string, string>).Authorization).toBe('lin_api_x');
    expect(JSON.parse(init.body as string).variables).toEqual({ urls: [`${PREFIX}909`, `${PREFIX}910`], prefix: PREFIX });
  });

  it("fails with Linear's message", async () => {
    respond({ errors: [{ message: 'Authentication required' }] }, 401);
    await expect(linearIssuesFor(ENTRY, 'mala', [1])).rejects.toThrow('Linear respondió 401: Authentication required');
  });
});

describe('currentCycle', () => {
  it("reads the team's active cycle, its history and its issues", async () => {
    respond({ data: { issues: { nodes: [{ team: { key: 'RED', activeCycle: {
      number: 17, name: null, startsAt: '2026-10-12T06:00:00.000Z', endsAt: '2026-10-19T06:00:00.000Z',
      issueCountHistory: [9, 21], completedIssueCountHistory: [7, 19],
      issues: { nodes: [raw('RED-206', `${PREFIX}895`, { state: { name: 'Done', type: 'completed' } })] },
    } } }] } } });
    expect(await currentCycle(ENTRY, 'k')).toEqual({
      team: 'RED', number: 17, startsAt: '2026-10-12T06:00:00.000Z', endsAt: '2026-10-19T06:00:00.000Z',
      scopeHistory: [9, 21], doneHistory: [7, 19],
      issues: [expect.objectContaining({ id: 'RED-206', githubNumber: 895, state: { name: 'Done', type: 'completed' }, cycle: { number: 17, current: true } })],
    });
  });

  it('is null without an active cycle, or without any issue of the repo in Linear', async () => {
    respond({ data: { issues: { nodes: [{ team: { key: 'RED', activeCycle: null } }] } } });
    expect(await currentCycle(ENTRY, 'k')).toBeNull();
    respond({ data: { issues: { nodes: [] } } });
    expect(await currentCycle(ENTRY, 'k')).toBeNull();
  });
});

describe('teamPlanning', () => {
  it("reads the team's active projects and the cycles to come, in date order", async () => {
    respond({ data: { issues: { nodes: [{ team: {
      projects: { nodes: [{ id: 'p2', name: 'Seguridad' }, { id: 'p1', name: 'Auditoría' }] },
      cycles: { nodes: [{ id: 'c18', number: 18, name: null, startsAt: '2026-10-19', endsAt: '2026-10-26', isActive: false }, { id: 'c17', number: 17, name: null, startsAt: '2026-10-12', endsAt: '2026-10-19', isActive: true }] },
      members: { nodes: [{ id: 'u2', name: 'Marta', active: true }, { id: 'u3', name: 'Se fue', active: false }, { id: 'u1', name: 'Ana Pérez', active: true }] },
    } }] } } });
    expect(await teamPlanning(ENTRY, 'k')).toEqual({
      projects: [{ id: 'p1', name: 'Auditoría' }, { id: 'p2', name: 'Seguridad' }],
      cycles: [
        { id: 'c17', number: 17, startsAt: '2026-10-12', endsAt: '2026-10-19', current: true },
        { id: 'c18', number: 18, startsAt: '2026-10-19', endsAt: '2026-10-26', current: false },
      ],
      people: [{ id: 'u1', name: 'Ana Pérez' }, { id: 'u2', name: 'Marta' }],
    });
  });
});

describe('resolveProject and updateIssue', () => {
  it('takes an id as is, finds a name, and is null for none or several', async () => {
    expect(await resolveProject('k', '0115fd03-c758-490f-8f57-f559d21e9c44')).toBe('0115fd03-c758-490f-8f57-f559d21e9c44');
    respond({ data: { projects: { nodes: [{ id: 'p1' }] } } });
    expect(await resolveProject('k', 'historial de pedidos')).toBe('p1');
    respond({ data: { projects: { nodes: [] } } });
    expect(await resolveProject('k', 'nada')).toBeNull();
  });

  it('sends the project and cycle, and fails when Linear does not apply it', async () => {
    const fetchMock = respond({ data: { issueUpdate: { success: true } } });
    await updateIssue('k', 'u-1', { projectId: 'p1', cycleId: 'c17' });
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).variables).toEqual({ id: 'u-1', input: { projectId: 'p1', cycleId: 'c17' } });
    respond({ data: { issueUpdate: { success: false } } });
    await expect(updateIssue('k', 'u-1', { projectId: 'p1' })).rejects.toThrow('no aplicó');
  });
});

describe('createProject', () => {
  it("creates it in the team, in the workspace's first backlog status, with its lead", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectStatuses: { nodes: [{ id: 's-planned', type: 'planned', position: 1 }, { id: 's-backlog2', type: 'backlog', position: 5 }, { id: 's-backlog', type: 'backlog', position: 0 }] } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectCreate: { success: true, project: { id: 'p9', name: 'Devoluciones', url: 'https://linear.app/x/project/p9' } } } })));
    vi.stubGlobal('fetch', fetchMock);
    const long = `Registrar   devoluciones ${'x'.repeat(300)}`;
    expect(await createProject('k', { name: 'Devoluciones', description: long, content: '## Qué\nTodo.', teamId: 't1', leadId: 'u1' })).toEqual({ id: 'p9', url: 'https://linear.app/x/project/p9' });
    const input = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).variables.input;
    expect(input).toMatchObject({ name: 'Devoluciones', content: '## Qué\nTodo.', teamIds: ['t1'], statusId: 's-backlog', leadId: 'u1' });
    expect(input.description).toHaveLength(255);
    expect(input.description.startsWith('Registrar devoluciones x')).toBe(true);
  });

  it('fails when Linear does not create it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectStatuses: { nodes: [] } } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { projectCreate: { success: false, project: null } } })));
    vi.stubGlobal('fetch', fetchMock);
    await expect(createProject('k', { name: 'X', description: '', content: '', teamId: 't1' })).rejects.toThrow('no creó el proyecto');
    expect(JSON.parse((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).variables.input).not.toHaveProperty('statusId');
  });
});
