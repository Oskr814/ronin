# Evidencia e2e disparada por @mención — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cuando un humano deja `@valeria-agent corré los e2e / dejá evidencia` en un PR, el supervisor publica los screenshots resultantes en ValerIA y postea un comentario con los links raw — reusando `evidence.ts` en vez de dejar la respuesta como texto sin verificar.

**Architecture:** El prompt de `review-request` (`src/agent-task.ts`) instruye al agente headless a correr Playwright solo si el pedido lo pide explícitamente; `runAgentTask` limpia `test-results/` antes de esa tarea puntual para que cualquier `.png` sobreviviente sea inequívocamente de esa corrida. `evidence.ts` pasa a escribir cada publicación en una subcarpeta con timestamp (`evidence/<issue>/<pr>/<timestamp>/`) para no pisar corridas anteriores. `tick.ts` llama `publishEvidence` + `postEvidenceComment` después de cada `review-request`, sin gate de "una vez por PR" (ese gate sigue existiendo, intacto, solo para el publish automático de slice).

**Tech Stack:** TypeScript, Node (`node:fs/promises`, `node:child_process`), Vitest, `gh` CLI.

## Global Constraints

- El agente headless solo corre la suite e2e cuando el pedido del comentario lo pide explícitamente — no en cualquier `review-request`.
- El supervisor no interpreta el texto del comentario: siempre intenta `publishEvidence` después de un `review-request` y es no-op si no hay `.png` nuevos.
- `test-results/` se limpia antes de un `review-request` únicamente — no afecta `implement-slice`, `fix-review`, `fix-e2e`, `fix-rebase`, `fix-bug`, `plan`.
- Cada publicación de evidencia va a su propia subcarpeta con timestamp (`evidence/<issue>/<pr>/<timestamp>/`) — nunca pisa una publicación anterior.
- El publish disparado por mention postea un comentario **nuevo** cada vez que hay evidencia fresca — no reusa el gate `hasEvidenceComment` (ese sigue existiendo tal cual, solo para el publish automático inicial de slice en `processSlicePr` línea ~270).
- Una falla en cualquiera de estos pasos nuevos se loguea localmente y no bloquea el issue (mismo `try/catch` local que ya envuelve el bloque de mentions en `tick.ts`).

Spec completo: `docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md`.

---

### Task 1: `evidence.ts` — publicar cada corrida en su propia subcarpeta con timestamp

**Files:**
- Modify: `src/evidence.ts:51` (línea de `destDir`)
- Test: `src/evidence.test.ts` (nuevo)

**Interfaces:**
- Consumes: nada nuevo — sigue usando `findScreenshots`, `ensureEvidenceCheckout`, `config.valeriaRepo`, `config.githubAppSlug`, `config.githubAppId`, ya existentes en el archivo.
- Produces: `publishEvidence(issueNumber: number, prNumber: number, worktreeDir: string): Promise<string[]>` — la firma no cambia, pero los paths devueltos ahora incluyen un segmento de timestamp: `evidence/<issue>/<pr>/<timestamp>/<archivo>.png`. `rawEvidenceUrl(path: string): string` tampoco cambia — sigue construyendo la URL raw a partir del path devuelto por `publishEvidence`.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/evidence.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: {
    valeriaRepo: 'Bmedical/ValerIA',
    githubAppSlug: 'valeria',
    githubAppId: '12345',
    playwrightTestResultsDir: 'apps/webapp/test-results',
  },
}));

const existsSync = vi.fn();
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => existsSync(...args),
}));

const mkdir = vi.fn();
const readdir = vi.fn();
const copyFile = vi.fn();
vi.mock('node:fs/promises', () => ({
  mkdir: (...args: unknown[]) => mkdir(...args),
  readdir: (...args: unknown[]) => readdir(...args),
  copyFile: (...args: unknown[]) => copyFile(...args),
}));

const execFile = vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => cb(null));
vi.mock('node:child_process', () => ({
  execFile: (...args: unknown[]) => (execFile as any)(...args),
}));

const { publishEvidence } = await import('./evidence.js');

beforeEach(() => {
  vi.clearAllMocks();
  execFile.mockImplementation((_cmd: string, _args: string[], _opts: unknown, cb: (err: unknown) => void) => cb(null));
  existsSync.mockReturnValue(true); // evidence checkout already cloned
  mkdir.mockResolvedValue(undefined);
  copyFile.mockResolvedValue(undefined);
  readdir.mockImplementation(async (dir: string) => {
    if (dir === '/tmp/worktree/apps/webapp/test-results') {
      return [{ name: 'login-smoke-chromium', isDirectory: () => true, isFile: () => false }];
    }
    if (dir === '/tmp/worktree/apps/webapp/test-results/login-smoke-chromium') {
      return [{ name: 'test-finished-1.png', isDirectory: () => false, isFile: () => true }];
    }
    return [];
  });
  vi.spyOn(Date, 'now').mockReturnValue(1234567890);
});

describe('publishEvidence', () => {
  it('writes each publish under a timestamped subfolder, never a flat per-PR path', async () => {
    const committed = await publishEvidence(228, 229, '/tmp/worktree');

    expect(committed).toEqual(['evidence/228/229/1234567890/login-smoke-chromium-test-finished-1.png']);
  });

  it('returns [] without touching the evidence checkout when there are no screenshots', async () => {
    readdir.mockResolvedValue([]);

    const committed = await publishEvidence(228, 229, '/tmp/worktree');

    expect(committed).toEqual([]);
    expect(mkdir).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test para confirmar que falla**

Run: `pnpm vitest run src/evidence.test.ts`
Expected: FAIL — el primer test espera `evidence/228/229/1234567890/...` pero el código actual produce `evidence/228/229/...` (sin subcarpeta de timestamp).

- [ ] **Step 3: Implementar el cambio mínimo**

En `src/evidence.ts`, reemplazar la línea 51:

```ts
const destDir = `evidence/${issueNumber}/${prNumber}`;
```

por:

```ts
// Subcarpeta por corrida — evita que una segunda publicación (p.ej.
// disparada por @mención) pise los archivos de la anterior, o que no haya
// nada que comitear si el contenido es byte-idéntico. Ver
// docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md.
const destDir = `evidence/${issueNumber}/${prNumber}/${Date.now()}`;
```

- [ ] **Step 4: Correr el test para confirmar que pasa**

Run: `pnpm vitest run src/evidence.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/evidence.ts src/evidence.test.ts
git commit -m "feat: publish e2e evidence into a timestamped subfolder per run"
```

---

### Task 2: `agent-task.ts` — correr e2e solo si el mention lo pide, limpiar `test-results/` antes de `review-request`

**Files:**
- Modify: `src/agent-task.ts:1-6` (imports), `src/agent-task.ts:123-148` (prompt de `review-request`), `src/agent-task.ts:152-166` (`runAgentTask`)
- Test: `src/agent-task.test.ts` (nuevo)

**Interfaces:**
- Consumes: `ensureWorktree(branch: string, baseBranch?: string): Promise<string>` (de `./worktree.js`), `runClaudeHeadless(worktreeDir: string, prompt: string, label: string): Promise<void>` (de `./claude-runner.js`), `config.playwrightTestResultsDir: string` (de `./config.js`, ya existe).
- Produces: `runAgentTask` no cambia de firma. Comportamiento nuevo: para `task.type === 'review-request'`, antes de invocar `runClaudeHeadless`, borra `<worktreeDir>/<config.playwrightTestResultsDir>` recursivamente. El prompt de `review-request` incluye una instrucción nueva sobre correr e2e condicionalmente.

- [ ] **Step 1: Escribir el test que falla**

Crear `src/agent-task.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: {
    playwrightTestResultsDir: 'apps/webapp/test-results',
    worktreeBaseRef: 'origin/main',
    productRepo: 'bmedical/bmedical',
  },
}));

const ensureWorktree = vi.fn();
const remoteBranchExists = vi.fn();
vi.mock('./worktree.js', () => ({
  ensureWorktree: (...args: unknown[]) => ensureWorktree(...args),
  remoteBranchExists: (...args: unknown[]) => remoteBranchExists(...args),
}));

const runClaudeHeadless = vi.fn();
vi.mock('./claude-runner.js', () => ({
  runClaudeHeadless: (...args: unknown[]) => runClaudeHeadless(...args),
}));

const getPullRequestStatus = vi.fn();
vi.mock('./github.js', () => ({
  getPullRequestStatus: (...args: unknown[]) => getPullRequestStatus(...args),
}));

const rm = vi.fn();
vi.mock('node:fs/promises', () => ({
  rm: (...args: unknown[]) => rm(...args),
}));

const { runAgentTask } = await import('./agent-task.js');

beforeEach(() => {
  vi.clearAllMocks();
  ensureWorktree.mockResolvedValue('/tmp/worktree');
  runClaudeHeadless.mockResolvedValue(undefined);
  getPullRequestStatus.mockResolvedValue({ headRefName: 'valeria/228/slice-1' });
  rm.mockResolvedValue(undefined);
});

describe('runAgentTask — review-request', () => {
  const task = {
    type: 'review-request' as const,
    issueNumber: 228,
    prNumber: 229,
    mentions: [{ id: 1, kind: 'issue' as const, body: '@valeria-agent corré los e2e y dejá evidencia', reactionsEyes: 0 }],
  };

  it('clears test-results/ before invoking the headless run', async () => {
    await runAgentTask(task);

    expect(rm).toHaveBeenCalledWith('/tmp/worktree/apps/webapp/test-results', { recursive: true, force: true });
    const rmOrder = rm.mock.invocationCallOrder[0];
    const headlessOrder = runClaudeHeadless.mock.invocationCallOrder[0];
    expect(rmOrder).toBeLessThan(headlessOrder);
  });

  it('includes the conditional e2e-evidence instruction in the prompt', async () => {
    await runAgentTask(task);

    const prompt = runClaudeHeadless.mock.calls[0][1] as string;
    expect(prompt).toContain('pnpm --filter @bmedical/webapp exec playwright test');
    expect(prompt).toContain('do not run the e2e suite');
  });
});

describe('runAgentTask — other task types leave test-results/ untouched', () => {
  it('does not clear test-results/ for fix-review', async () => {
    await runAgentTask({ type: 'fix-review', issueNumber: 228, prNumber: 229 });

    expect(rm).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test para confirmar que falla**

Run: `pnpm vitest run src/agent-task.test.ts`
Expected: FAIL — `rm` no se llama todavía (no existe la lógica de limpieza) y el prompt no contiene la instrucción nueva.

- [ ] **Step 3: Implementar el cambio mínimo**

En `src/agent-task.ts`, agregar los imports de `node:fs/promises` y `node:path` (línea 1, antes de los imports existentes):

```ts
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureWorktree, remoteBranchExists } from './worktree.js';
```

En el prompt de `review-request` (dentro del array `.join('\n')`, después de la línea que empieza con `'If the request is concrete and actionable...'` y antes de la línea `` `Reply directly to each mention above...` ``), agregar:

```ts
'If (and only if) the request explicitly asks you to run the e2e suite or leave e2e evidence, run it now (`pnpm --filter @bmedical/webapp exec playwright test`) and report pass/fail in your reply — do not move, copy, commit, or delete anything under apps/webapp/test-results/, the supervisor collects it separately right after this task finishes. For any other kind of request, do not run the e2e suite.',
```

En `runAgentTask` (línea 152-166), limpiar `test-results/` antes de invocar `runClaudeHeadless`, solo para `review-request`:

```ts
export async function runAgentTask(task: AgentTask): Promise<void> {
  const { branch, prompt, baseBranch } = await buildTask(task);
  const worktreeDir = await ensureWorktree(branch, baseBranch);

  // Solo para review-request: cualquier .png que sobreviva en test-results/
  // después de esta tarea debe ser inequívocamente de esta corrida, nunca de
  // una mención anterior no relacionada con evidencia — ver
  // docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md.
  if (task.type === 'review-request') {
    await rm(join(worktreeDir, config.playwrightTestResultsDir), { recursive: true, force: true });
  }

  log.info(`starting ${task.type} for issue #${task.issueNumber} on branch ${branch}`);
  try {
    // Output streams live to the log as the agent works — see
    // claude-runner.ts — so nothing further to dump here once it's done.
    await runClaudeHeadless(worktreeDir, prompt, `${task.type} #${task.issueNumber}`);
    log.info(`finished ${task.type} for issue #${task.issueNumber}`);
  } catch (error) {
    log.error(`${task.type} for issue #${task.issueNumber} failed`, error);
    throw error;
  }
}
```

- [ ] **Step 4: Correr el test para confirmar que pasa**

Run: `pnpm vitest run src/agent-task.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/agent-task.ts src/agent-task.test.ts
git commit -m "feat: run e2e conditionally on mention request, clear stale test-results/ first"
```

---

### Task 3: `tick.ts` — publicar evidencia después de cada `review-request`

**Files:**
- Modify: `src/tick.ts:286-306` (bloque try/catch de mentions en `processSlicePr`)
- Test: `src/tick.test.ts` (extender el describe existente de mentions, línea ~236)

**Interfaces:**
- Consumes: `publishEvidence(issueNumber: number, prNumber: number, worktreeDir: string): Promise<string[]>` (ya importado en `tick.ts:34`), `postEvidenceComment(prNumber: number, imageUrls: string[]): Promise<void>` (ya importado en `tick.ts:19`), `rawEvidenceUrl(path: string): string` (ya importado en `tick.ts:34`), `worktreeDirFor(branch: string): string` (ya importado en `tick.ts:33`) — todos ya usados por el bloque de publish automático de slice (línea ~270), ningún import nuevo hace falta.
- Produces: sin cambio de firma en `processSlicePr`.

- [ ] **Step 1: Escribir el test que falla**

En `src/tick.test.ts`, agregar dentro de `describe('processSlicePr — mentions found on an already-mergeable bottom PR (regression)', ...)` (después del test existente en la línea ~262, antes del `});` de cierre del describe):

```ts
  it('publishes fresh evidence and posts a new comment after a review-request that produced screenshots', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'valeria/228/slice-1',
      checksPassing: true,
      reviewDecision: 'APPROVED',
    });
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent corré los e2e', reactionsEyes: 0 }]);
    getPullRequestStatus.mockResolvedValue(bottomPr);
    publishEvidence.mockResolvedValueOnce(true).mockResolvedValueOnce(['evidence/228/229/999/shot.png']);
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(publishEvidence).toHaveBeenLastCalledWith(228, 229, '/tmp/worktree-bottom');
    expect(postEvidenceComment).toHaveBeenCalledWith(229, ['https://raw/evidence/228/229/999/shot.png']);
  });

  it('does not post an evidence comment when the review-request produced no screenshots', async () => {
    const bottomPr = pr({
      number: 229,
      sliceIndex: 0,
      baseRefName: 'main',
      headRefName: 'valeria/228/slice-1',
      checksPassing: true,
      reviewDecision: 'APPROVED',
    });
    findUnprocessedMentions.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent fijate esta línea', reactionsEyes: 0 }]);
    getPullRequestStatus.mockResolvedValue(bottomPr);
    publishEvidence.mockResolvedValue([]);
    isBehind.mockResolvedValue(false);

    await processSlicePr(issue(), bottomPr, true);

    expect(postEvidenceComment).not.toHaveBeenCalled();
  });
```

Notar que `hasEvidenceComment.mockResolvedValue(true)` ya está seteado en el `beforeEach` global (línea 119), así que el primer `publishEvidence` mock resuelto (`true`, un valor deliberadamente inválido/no-array) nunca se usa — existe solo para dejar en evidencia, si el test fallara de forma rara, que el mock del bloque de publish automático (gateado por `hasEvidenceComment`) no se está llamando en este escenario. El segundo valor mockeado (`['evidence/228/229/999/shot.png']`) es el que debe consumir el nuevo bloque post-`review-request`.

- [ ] **Step 2: Correr el test para confirmar que falla**

Run: `pnpm vitest run src/tick.test.ts -t "review-request"`
Expected: FAIL — `postEvidenceComment` no se llama todavía después de `review-request` (el código actual solo lo llama desde el bloque gateado por `hasEvidenceComment`, ya resuelto en `true` por el `beforeEach`).

- [ ] **Step 3: Implementar el cambio mínimo**

En `src/tick.ts`, dentro de `processSlicePr`, reemplazar el bloque (líneas 286-306):

```ts
  try {
    const mentions = await findUnprocessedMentions(pr.number);
    if (mentions.length > 0) {
      await runAgentTask({ type: 'review-request', issueNumber: issue.number, prNumber: pr.number, mentions });

      // Barato cuando no hay .png nuevos (un readdir vacío) — el supervisor
      // no interpreta el texto del mention, solo intenta publicar lo que
      // haya quedado en test-results/ tras el review-request. Sin el gate
      // de hasEvidenceComment: cada corrida disparada por mención postea su
      // propio comentario. Ver docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md.
      const evidencePaths = await publishEvidence(issue.number, pr.number, worktreeDirFor(pr.headRefName));
      if (evidencePaths.length > 0) {
        await postEvidenceComment(pr.number, evidencePaths.map(rawEvidenceUrl));
      }

      for (const m of mentions) await addReaction(m.id, m.kind, 'eyes');
      // `pr` was read before a claude -p run that can take up to 30
      // minutes and may itself push a commit, so its checks/review fields
      // can be stale now — re-read before falling through to the merge
      // decision below. Without this, an already-approved, checks-passing
      // PR that merely got mentioned would sit unmerged until whatever
      // processIssue does next (e.g. starting a brand new slice) finishes,
      // since the cron lock is single-flight — not just the usual ~5min
      // tick cadence. See docs/superpowers/specs/2026-07-28-mention-review-design.md.
      pr = { ...pr, ...(await getPullRequestStatus(pr.number)) };
    }
  } catch (error) {
    // Local failure, not the issue-wide catch in tick(): a review-request
    // that doesn't land shouldn't block the slice loop. No reaction was
    // added, so the next tick picks these same comments up again.
    log.error(`review-request failed for PR #${pr.number}`, error);
  }
```

- [ ] **Step 4: Correr el test para confirmar que pasa**

Run: `pnpm vitest run src/tick.test.ts`
Expected: PASS (todos los tests del archivo, incluidos los 2 nuevos)

- [ ] **Step 5: Commit**

```bash
git add src/tick.ts src/tick.test.ts
git commit -m "feat: publish e2e evidence after a mention-triggered review-request"
```

---

### Task 4: Verificación final

**Files:** ninguno nuevo — corre la suite completa y confirma que el spec quedó cubierto de punta a punta.

- [ ] **Step 1: Correr toda la suite**

Run: `pnpm vitest run`
Expected: PASS — sin regressions en `tick.test.ts`, `mentions.test.ts`, `checklist.test.ts`, `stack.test.ts`, `claude-runner.test.ts`, y los dos archivos nuevos (`evidence.test.ts`, `agent-task.test.ts`).

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit` (o el script equivalente en `package.json`, ej. `pnpm typecheck`)
Expected: sin errores.

- [ ] **Step 3: Repasar el spec contra lo implementado**

Confirmar manualmente, releyendo `docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md`, que cada punto de "Decisiones" tiene su contraparte en el código:
- Agente decide correr e2e solo si el pedido es explícito → Task 2, prompt.
- Supervisor siempre intenta publicar, sin interpretar texto → Task 3.
- `test-results/` se limpia antes de `review-request` únicamente → Task 2, `runAgentTask`.
- Subcarpeta por corrida → Task 1.
- Comentario nuevo por corrida con evidencia fresca → Task 3.
- Sin límite de reintentos / no bloquea el issue → ya cubierto por el `try/catch` local preexistente, sin cambios necesarios.
