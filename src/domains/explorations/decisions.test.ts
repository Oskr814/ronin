import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '@platform/db/db.js';
import { TEST_DATABASE_URL, testDb } from '@platform/db/testing.js';
import { decide, listDecisions, markApplied, undecide } from './decisions.js';

describe.skipIf(!TEST_DATABASE_URL)('the team’s decisions on the findings', () => {
  let db: Db;
  let drop: () => Promise<void>;
  beforeAll(async () => ({ db, drop } = await testDb()));
  afterAll(async () => drop());
  beforeEach(async () => {
    await db.deleteFrom('finding_decisions').execute();
  });

  it('keeps one per finding, the last one said, until it is written into the PR', async () => {
    await decide(db, 'acme/web', 12, 'backoffice/F-0001', 'aprobar', 'ana-dev');
    await decide(db, 'acme/web', 12, 'backoffice/F-0002', 'rechazar', 'ana-dev', 'Ya está cubierto');
    const changed = await decide(db, 'acme/web', 12, 'backoffice/F-0001', 'rechazar', 'beto-dev', 'No aplica');
    expect(changed).toMatchObject({ ficha: 'backoffice/F-0001', decision: 'rechazar', reason: 'No aplica', by: 'beto-dev', applied: false });
    expect((await listDecisions(db, 'acme/web', 12)).map((d) => [d.ficha, d.decision])).toEqual([['backoffice/F-0002', 'rechazar'], ['backoffice/F-0001', 'rechazar']]);
    expect(await listDecisions(db, 'acme/web', 13)).toEqual([]);

    expect(await undecide(db, 'acme/web', 12, 'backoffice/F-0002')).toBe(true);
    expect(await undecide(db, 'acme/web', 12, 'backoffice/F-0002')).toBe(false);

    await markApplied(db, 'acme/web', 12, ['backoffice/F-0001']);
    expect(await listDecisions(db, 'acme/web', 12)).toEqual([expect.objectContaining({ ficha: 'backoffice/F-0001', applied: true })]);
    await expect(decide(db, 'acme/web', 12, 'backoffice/F-0001', 'aprobar', 'ana-dev')).rejects.toThrow('ya quedó escrita');
    expect(await undecide(db, 'acme/web', 12, 'backoffice/F-0001')).toBe(false);
  });
});
