import { describe, it, expect } from 'vitest';
import { ActionRefused, describeActions, hasMention, validateAction, type CheckoutState, type RunScope } from './catalog.js';

const scope: RunScope = {
  prNumber: 42,
  headRef: 'feat/x',
  startSha: 'start',
  threads: [{ commentId: 100, threadId: 'PRRT_a' }, { commentId: 200, threadId: 'PRRT_b' }],
  triggers: [{ id: 300, kind: 'review' }, { id: 400, kind: 'issue' }],
  allowed: ['pr.reply', 'pr.resolve-thread', 'git.push', 'result.report'],
};

const refusal = (p: Promise<unknown>) => p.then(() => 'aceptada', (e) => (e instanceof ActionRefused ? e.message : `otro error: ${e}`));

describe('validateAction', () => {
  it('accepts a reply to a listed thread or to a review trigger', async () => {
    expect(await validateAction(scope, 'pr.reply', { commentId: 100, body: 'Listo, lo cambié.' })).toEqual({ name: 'pr.reply', input: { commentId: 100, body: 'Listo, lo cambié.' } });
    expect(await refusal(validateAction(scope, 'pr.reply', { commentId: 300, body: 'Hecho.' }))).toBe('aceptada');
  });

  it('refuses what the run is not scoped for', async () => {
    expect(await refusal(validateAction(scope, 'pr.comment', { body: 'hola' }))).toContain('no puede usar');
    expect(await refusal(validateAction(scope, 'pr.reply', { commentId: 999, body: 'hola' }))).toContain('no es de los que');
    // A general trigger has no thread to reply in.
    expect(await refusal(validateAction(scope, 'pr.reply', { commentId: 400, body: 'hola' }))).toContain('no es de los que');
    expect(await refusal(validateAction(scope, 'pr.resolve-thread', { commentId: 300 }))).toContain('no abre ninguno');
    expect(await refusal(validateAction(scope, 'gh.merge', {}))).toContain('no existe');
  });

  it('refuses a mention', async () => {
    expect(await refusal(validateAction(scope, 'pr.reply', { commentId: 100, body: 'Como dijo @persona, va.' }))).toContain('@');
  });

  it('says what is wrong with the input', async () => {
    expect(await refusal(validateAction(scope, 'pr.reply', { commentId: 'cien', body: '' }))).toMatch(/commentId: .*; body: /);
  });

  it('only pushes an amend of the starting commit, with nothing left uncommitted', async () => {
    const at = (state: Partial<CheckoutState>) => async () => ({ head: 'amended', parentOfHead: 'base', parentOfStart: 'base', dirty: false, ...state });
    expect(await refusal(validateAction(scope, 'git.push', {}, at({})))).toBe('aceptada');
    expect(await refusal(validateAction(scope, 'git.push', {}, at({ parentOfHead: 'start' })))).toContain('amend');
    expect(await refusal(validateAction(scope, 'git.push', {}, at({ head: 'start' })))).toContain('nada que subir');
    expect(await refusal(validateAction(scope, 'git.push', {}, at({ dirty: true })))).toContain('sin commitear');
    expect(await refusal(validateAction({ ...scope, headRef: undefined }, 'git.push', {}, at({})))).toContain('no tiene rama');
  });
});

describe('hasMention', () => {
  it('finds a handle', () => {
    expect(hasMention('@persona revisalo')).toBe(true);
    expect(hasMention('gracias, @persona-2.')).toBe(true);
  });

  it('lets through what GitHub does not ping', () => {
    expect(hasMention('Escribile a persona@gmail.com')).toBe(false);
    expect(hasMention('El modal de @acme/ui ya lo soporta')).toBe(false);
    expect(hasMention('Usé `@persona` como ejemplo')).toBe(false);
    expect(hasMention('```\nimport x from "@acme/ui";\n@decorator\n```')).toBe(false);
  });
});

describe('describeActions', () => {
  it("lists only the run's actions, with their JSON schema", () => {
    const listed = describeActions(scope);
    expect(listed.map((a) => a.name)).toEqual(scope.allowed);
    expect(listed[0].inputSchema).toMatchObject({ type: 'object', required: ['commentId', 'body'] });
  });
});
