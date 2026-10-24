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
    // A request from the tablero (#446) is answered by its id too.
    expect(await refusal(validateAction({ ...scope, triggers: [{ id: 12, kind: 'command' }] }, 'pr.reply', { commentId: 12, body: 'Hecho.' }))).toBe('aceptada');
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
    const at = (state: Partial<CheckoutState>) => async () => ({ head: 'amended', parentOfHead: 'base', parentOfStart: 'base', dirty: false, onBase: true, onStart: false, ...state });
    expect(await refusal(validateAction(scope, 'git.push', {}, at({})))).toBe('aceptada');
    expect(await refusal(validateAction(scope, 'git.push', {}, at({ parentOfHead: 'start' })))).toContain('amend');
    expect(await refusal(validateAction(scope, 'git.push', {}, at({ head: 'start' })))).toContain('nada que subir');
    expect(await refusal(validateAction(scope, 'git.push', {}, at({ dirty: true })))).toContain('sin commitear');
    expect(await refusal(validateAction({ ...scope, headRef: undefined }, 'git.push', {}, at({})))).toContain('no tiene rama');
  });
});

describe('validateAction — implementing', () => {
  const at = (state: Partial<CheckoutState>) => async () => ({ head: 'new', parentOfHead: 'x', parentOfStart: 'y', dirty: false, onBase: true, onStart: true, ...state });

  it('pushes its own branch only on its base, and new commits only on top in fast-forward', async () => {
    const own: RunScope = { ...scope, push: { mode: 'branch', baseSha: 'b', remoteSha: null } };
    expect(await refusal(validateAction(own, 'git.push', {}, at({})))).toBe('aceptada');
    expect(await refusal(validateAction(own, 'git.push', {}, at({ onBase: false })))).toContain('base');
    const ff: RunScope = { ...scope, push: { mode: 'fast-forward' } };
    expect(await refusal(validateAction(ff, 'git.push', {}, at({})))).toBe('aceptada');
    expect(await refusal(validateAction(ff, 'git.push', {}, at({ onStart: false })))).toContain('solo commits nuevos');
  });

  it('opens a PR whose body closes its issue', async () => {
    const opening: RunScope = { ...scope, prNumber: undefined, pr: { base: 'main', draft: false, closes: 9 }, allowed: ['pr.create'] };
    expect(await refusal(validateAction(opening, 'pr.create', { title: 'Arreglo', body: 'Closes #9\n\n## Qué cambió' }))).toBe('aceptada');
    expect(await refusal(validateAction(opening, 'pr.create', { title: 'Arreglo', body: '## Qué cambió\nCloses #9' }))).toContain('Closes #9');
    expect(await refusal(validateAction({ ...opening, pr: undefined }, 'pr.create', { title: 'x', body: 'y' }))).toContain('no abre un PR');
  });

  // A slice PR of an issue with several slices: "Closes" would close the
  // issue when the first one merges (#515 of bmedical).
  it('opens a PR that closes no other issue than its own', async () => {
    const slice: RunScope = { ...scope, prNumber: undefined, pr: { base: 'main', draft: false }, allowed: ['pr.create'] };
    expect(await refusal(validateAction(slice, 'pr.create', { title: 'Slice 1', body: 'Parte de #9\n\n## Qué cambió' }))).toBe('aceptada');
    expect(await refusal(validateAction(slice, 'pr.create', { title: 'Slice 1', body: 'Closes #9 (slice 1 de 12)\n\n## Qué cambió' }))).toContain('no cierra ningún issue');
    const opening: RunScope = { ...slice, pr: { base: 'main', draft: false, closes: 9 } };
    expect(await refusal(validateAction(opening, 'pr.create', { title: 'Arreglo', body: 'Closes #9\n\nTambién fixes #4' }))).toContain('solo cierra #9');
  });

  it('edits the issue only as the run allows', async () => {
    const withIssue: RunScope = { ...scope, issue: { number: 9 }, allowed: ['issue.comment', 'issue.update-body'] };
    expect(await refusal(validateAction(withIssue, 'issue.comment', { body: 'Necesito saber si…' }))).toBe('aceptada');
    expect(await refusal(validateAction(withIssue, 'issue.update-body', { body: 'x' }))).toContain('no puede cambiar la descripción');
  });
});

describe('validateAction — app.exec', () => {
  it('takes a service and a command, in its running container unless asked for a new one', async () => {
    const withApp: RunScope = { ...scope, allowed: ['app.exec'] };
    expect(await validateAction(withApp, 'app.exec', { service: 'db', command: 'psql -c "select 1"' })).toEqual({ name: 'app.exec', input: { service: 'db', command: 'psql -c "select 1"', oneOff: false } });
    expect(await refusal(validateAction(withApp, 'app.exec', { service: '', command: 'x' }))).toMatch(/service/);
    expect(await refusal(validateAction(scope, 'app.exec', { service: 'db', command: 'x' }))).toContain('no puede usar');
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
