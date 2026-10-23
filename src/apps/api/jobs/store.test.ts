import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import { setDb, type Db } from '@platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';
import { claimNext, enqueue, enqueueEvent, finish, heartbeat, lastQueuedOrStarted, listJobs, pruneFinished, reapExpired } from './store.js';
import { runOnce } from './runner.js';
import { runAsJob } from './child.js';
import { scheduleTick } from './scheduler.js';

describe.skipIf(!TEST_DATABASE_URL)('the job queue', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => {
    setDb(null);
    await drop();
  });
  beforeEach(async () => {
    setDb(db);
    await db.deleteFrom('jobs').execute();
  });

  // #370: a burst about one PR, a run with every flow.
  it('adds the flows of an event to the one already waiting for the same resources', async () => {
    const event = (flows: string[], resources = ['pr-12']) => ({ repo: 'acme/app', payload: { repo: 'acme/app', scope: { flows, resources } }, dedupeKey: `event:${JSON.stringify(['acme/app', resources])}` });
    const first = await enqueueEvent(db, event(['auto-merge']));
    const second = await enqueueEvent(db, event(['issues', 'auto-merge']));
    expect(first.joined).toBe(false);
    expect(second).toEqual({ id: first.id, joined: true });
    expect((await enqueueEvent(db, event(['review'], ['pr-13']))).joined).toBe(false);

    const queued = await listJobs(db);
    expect(queued).toHaveLength(2);
    const pr12 = queued.find((j) => j.id === first.id)!;
    expect((pr12.payload as { scope: { flows: string[] } }).scope.flows).toEqual(['auto-merge', 'issues']);

    // And the comments each one brought, both (#370).
    const withComment = (id: number) => ({ ...event(['pr-commands'], ['pr-14']), payload: { repo: 'acme/app', scope: { flows: ['pr-commands'], resources: ['pr-14'], comments: [{ number: 14, comment: { id } }] } } });
    await enqueueEvent(db, withComment(1));
    await enqueueEvent(db, withComment(2));
    const pr14 = (await listJobs(db)).find((j) => (j.payload as { scope: { resources: string[] } }).scope.resources[0] === 'pr-14')!;
    expect((pr14.payload as { scope: { comments: Array<{ comment: { id: number } }> } }).scope.comments.map((c) => c.comment.id)).toEqual([1, 2]);

    // Once it's running, a new one for that PR is queued apart.
    while (await claimNext(db, 'event', 5, 'r'));
    expect((await enqueueEvent(db, event(['portal']))).joined).toBe(false);
    expect(await listJobs(db)).toHaveLength(4);
  });

  it('never queues twice what has the same key, but does once the first one left the queue', async () => {
    expect(await enqueue(db, 'tick', { dedupeKey: 'tick' })).not.toBeNull();
    expect(await enqueue(db, 'tick', { dedupeKey: 'tick' })).toBeNull();
    const job = (await claimNext(db, 'tick', 1, 'r'))!;
    expect(await enqueue(db, 'tick', { dedupeKey: 'tick' })).not.toBeNull();
    expect((await listJobs(db)).map((j) => j.status).sort()).toEqual(['queued', 'running']);
    expect(job.status).toBe('running');
  });

  it('takes the oldest first, up to the cap of its kind, and each one only once', async () => {
    for (const n of [1, 2, 3]) await enqueue(db, 'event', { repo: 'acme/app', payload: { n } });
    const taken = await Promise.all([1, 2, 3, 4].map(() => claimNext(db, 'event', 2, 'r')));
    const got = taken.filter(Boolean).map((j) => (j!.payload as { n: number }).n).sort();
    expect(got).toEqual([1, 2]);
    expect(await claimNext(db, 'event', 2, 'r')).toBeNull();
    await finish(db, taken.find(Boolean)!.id);
    expect((await claimNext(db, 'event', 2, 'r'))?.payload).toEqual({ n: 3 });
  });

  it('marks how one ended, and the ones whose lease ran out as lost', async () => {
    await enqueue(db, 'event');
    await enqueue(db, 'event');
    const a = (await claimNext(db, 'event', 5, 'r'))!;
    const b = (await claimNext(db, 'event', 5, 'r'))!;
    await heartbeat(db, a.id, 123);
    await finish(db, a.id, { error: 'boom' });
    await db.updateTable('jobs').set({ lease_until: sql`now() - interval '1 second'` as unknown as string }).where('id', '=', b.id).execute();
    expect(await reapExpired(db)).toBe(1);
    const jobs = new Map((await listJobs(db)).map((j) => [j.id, j]));
    expect(jobs.get(a.id)).toMatchObject({ status: 'failed', error: 'boom', pid: 123 });
    expect(jobs.get(b.id)?.status).toBe('lost');
    await db.updateTable('jobs').set({ finished_at: sql`now() - interval '15 days'` as unknown as string }).execute();
    expect(await pruneFinished(db, 14)).toBe(2);
  });

  it('the runner starts each job in its own process with its id, and fails the one that does not start', async () => {
    await enqueue(db, 'tick', { dedupeKey: 'tick' });
    await enqueue(db, 'event', { repo: 'acme/app', payload: { repo: 'acme/app', scope: { flows: ['issues'], resources: ['issue-1'] } } });
    await enqueue(db, 'event', { repo: 'acme/app', payload: { repo: 'acme/app', scope: { flows: [], resources: [] }, broken: true } });
    const launch = vi.fn((_script: string, args: string[], env: Record<string, string> = {}) => (args[0]?.includes("broken") ? undefined : Number(env.RONIN_JOB_ID) + 1000));
    const started = await runOnce(db, launch);
    expect(started.map((j) => j.kind)).toEqual(['tick', 'event']);
    expect(launch.mock.calls.map(([script, args]) => [script, args.length])).toEqual([['apps/api/tick/main', 0], ['apps/api/webhooks/handler', 1], ['apps/api/webhooks/handler', 1]]);
    expect(JSON.parse(launch.mock.calls[1][1][0]).scope.resources).toEqual(['issue-1']);
    expect((await listJobs(db, { status: ['failed'] }))[0].error).toBe('el proceso no arrancó');
  });

  it('starts a worker the API queued and ends its job right away: the worker runs on its own', async () => {
    await enqueue(db, 'worker', { repo: 'acme/app', payload: { name: 'domains/explorations/worker', request: { repo: 'acme/app', appName: 'web' } } });
    const launch = vi.fn((_script: string, _args: string[]) => 4321);
    await runOnce(db, launch);
    expect(launch.mock.calls.map(([script, args]) => [script, JSON.parse(args[0])])).toEqual([['domains/explorations/worker', { repo: 'acme/app', appName: 'web' }]]);
    expect((await listJobs(db))[0]).toMatchObject({ kind: 'worker', status: 'done' });
  });

  it("a job's process renews its lease and says how it ended", async () => {
    await enqueue(db, 'tick');
    const job = (await claimNext(db, 'tick', 1, 'r'))!;
    process.env.RONIN_JOB_ID = job.id;
    await runAsJob(async () => {
      expect(process.env.RONIN_JOB_ID).toBeUndefined();
      expect((await listJobs(db))[0].pid).toBe(process.pid);
    });
    expect((await listJobs(db))[0].status).toBe('done');
    await enqueue(db, 'tick');
    const failing = (await claimNext(db, 'tick', 1, 'r'))!;
    process.env.RONIN_JOB_ID = failing.id;
    await expect(runAsJob(async () => { throw new Error('se rompió'); })).rejects.toThrow('se rompió');
    expect((await listJobs(db, { status: ['failed'] }))[0]).toMatchObject({ id: failing.id, error: 'se rompió' });
  });

  it('the scheduler queues a tick when it is due, and only one', async () => {
    expect(await scheduleTick(db)).toBe(true);
    expect(await scheduleTick(db)).toBe(false);
    expect((await listJobs(db)).filter((j) => j.kind === 'tick')).toHaveLength(1);
    expect(await lastQueuedOrStarted(db, 'tick')).not.toBeNull();
  });
});
