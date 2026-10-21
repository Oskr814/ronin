import { describe, expect, it } from 'vitest';
import { addRepos, formatValue, generateSecret, mergeEnv, parseEnv, pendingQuestions, withGeneratedSecrets } from './env-file.js';

const EXAMPLE = [
  '# Un comentario',
  'RUNNER_ID=',
  'TICK_CONCURRENCY=3',
  '',
  '# --- Base ---',
  '# DATABASE_URL=postgres://ronin:<contraseña>@127.0.0.1:<puerto>/ronin',
  '# Authorization callback URL: <DASHBOARD_URL>/api/auth/callback',
  '',
].join('\n');

describe('parseEnv', () => {
  it('reads values, skips comments and drops quotes', () => {
    expect(parseEnv("A=1\n# B=2\n\nC='con espacios'\nD=\"x\"\nE=\n")).toEqual({ A: '1', C: 'con espacios', D: 'x', E: '' });
  });
});

describe('formatValue', () => {
  it('leaves plain values alone and quotes the rest', () => {
    expect(formatValue('https://<host>.<tailnet>.ts.net:8443')).toBe('https://<host>.<tailnet>.ts.net:8443');
    expect(formatValue('persona@gmail.com,otra@gmail.com')).toBe('persona@gmail.com,otra@gmail.com');
    expect(formatValue('abcd efgh')).toBe("'abcd efgh'");
    expect(formatValue("it's")).toBe('"it\'s"');
    expect(formatValue('')).toBe('');
  });
});

describe('mergeEnv', () => {
  it('fills the example lines and keeps its comments', () => {
    const out = mergeEnv(EXAMPLE, { RUNNER_ID: 'persona', TICK_CONCURRENCY: '2' });
    expect(out).toContain('# Un comentario\nRUNNER_ID=persona\nTICK_CONCURRENCY=2\n');
    expect(out).toContain('# DATABASE_URL=postgres://');
    expect(out).not.toContain('Otras');
  });

  it('uncomments a key that has a value and keeps prose comments', () => {
    const out = mergeEnv(EXAMPLE, { DATABASE_URL: 'postgres://ronin:x@postgres:5432/ronin' });
    expect(out).toContain('\nDATABASE_URL=postgres://ronin:x@postgres:5432/ronin\n');
    expect(out).toContain('# Authorization callback URL:');
  });

  it('keeps the keys the example does not have, at the end', () => {
    const out = mergeEnv(EXAMPLE, { RUNNER_ID: 'persona', LINEAR_API_KEY_X: 'k' });
    expect(out.trimEnd().split('\n').slice(-2)).toEqual(['# --- Otras, de un .env anterior ---', 'LINEAR_API_KEY_X=k']);
  });

  it('round-trips through parseEnv', () => {
    const values = { RUNNER_ID: 'persona', TICK_CONCURRENCY: '3', DATABASE_URL: 'postgres://a b' };
    expect(parseEnv(mergeEnv(EXAMPLE, values))).toEqual(values);
  });
});

describe('secrets', () => {
  it('generates 64 hex characters by default', () => {
    expect(generateSecret()).toMatch(/^[0-9a-f]{64}$/);
    expect(generateSecret()).not.toBe(generateSecret());
  });

  it('fills only the missing ones', () => {
    const out = withGeneratedSecrets({ WEBHOOK_SECRET: 'existente' }, () => 'nuevo');
    expect(out).toMatchObject({ WEBHOOK_SECRET: 'existente', DASHBOARD_SESSION_SECRET: 'nuevo', PORTAL_SESSION_SECRET: 'nuevo', RONIN_PG_PASSWORD: 'nuevo' });
  });
});

describe('pendingQuestions', () => {
  it('asks only what is missing, and Tailscale only in Docker', () => {
    const keys = (docker: boolean) => pendingQuestions({ RUNNER_ID: 'persona' }, { docker }).map((q) => q.key);
    expect(keys(true)).toContain('TS_AUTHKEY');
    expect(keys(false)).not.toContain('TS_AUTHKEY');
    expect(keys(true)).not.toContain('RUNNER_ID');
  });
});

describe('addRepos', () => {
  it('adds new repos under the repos dir and keeps the existing entries', () => {
    const existing = [{ productRepo: 'acme/uno', productRepoPath: '/otra/ruta', deploy: { selective: true } }];
    expect(addRepos(existing, ['ACME/uno', 'acme/dos'], '/repos/')).toEqual([
      existing[0],
      { productRepo: 'acme/dos', productRepoPath: '/repos/acme/dos/repo' },
    ]);
  });

  it('refuses something that is not owner/name', () => {
    expect(() => addRepos([], ['nada'], '/repos')).toThrow('owner/nombre');
  });
});
