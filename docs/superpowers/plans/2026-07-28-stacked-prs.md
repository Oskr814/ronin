# Stacked PRs for Slices Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a tracking issue have several slice PRs open and in review at the same time, each stacked (in git history and in PR `--base`) on the previous one, instead of waiting for slice N to merge before starting slice N+1.

**Architecture:** Each slice's branch/PR is based on the previous slice's branch (not `main`), except the first. `getOpenPrsForIssue` returns every open PR for an issue; only the lowest-index one (`pickBottomPr`) is ever merged, and only after a mechanical rebase attempt (falling back to an agent `fix-rebase` task, then to the existing "conflicto de merge no mecánico" block) confirms it's caught up with `main`. As soon as a slice's PR exists, the next slice is started on top of it — no cap.

**Tech Stack:** TypeScript (Node ESM, `NodeNext`), `gh` CLI via `execFile`, Vitest for unit tests.

Full design background: `docs/superpowers/specs/2026-07-28-stacked-prs-design.md`.

## Global Constraints

- No hay cap de concurrencia: se arranca la siguiente slice apenas la anterior tiene PR abierto (spec §"Decisiones de alcance").
- Solo se rebasea el PR inmediatamente siguiente en la cadena cuando el fondo del stack mergea — nunca en cascada.
- Un commit por PR se logra vía instrucción de prompt (`git commit --amend` + `git push --force-with-lease`) — sin verificación mecánica del lado del supervisor.
- Dependencias externas en "Notas de secuenciación" (texto libre) quedan fuera de alcance de este plan.
- Tests: Vitest con mocks para lógica pura nueva (`stack.ts`, `checklist.ts`). Sin tests de integración con git real — la mecánica de `git rebase` se valida con un dry run manual, no automatizado.
- Convención de imports: ESM con extensión `.js` en cada import relativo (`moduleResolution: NodeNext` — ver `tsconfig.json`).
- Nunca importar `config.js` (ni nada que lo importe transitivamente) desde un módulo que se quiera puramente testeable — `config.ts` llama `requireEnv` a nivel de módulo y explota sin las env vars reales. Por eso `stack.ts` solo importa el *tipo* `PullRequestStatus` de `github.ts` (`import type`, se borra en compilación).

---

### Task 1: Agregar Vitest al proyecto

**Files:**
- Modify: `package.json`
- Create: `vitest.config.ts`

**Interfaces:**
- Produces: script `pnpm test` (`vitest run`), usado por todas las tasks siguientes.

- [ ] **Step 1: Instalar Vitest como dev dependency**

Run: `pnpm add -D vitest`

- [ ] **Step 2: Agregar el script `test` a `package.json`**

En `package.json`, dentro de `"scripts"`, agregar:

```json
"test": "vitest run"
```

(Queda alfabéticamente/lógicamente junto a `"typecheck"`.)

- [ ] **Step 3: Crear `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
```

- [ ] **Step 4: Verificar que el runner arranca (sin tests todavía)**

Run: `pnpm test`
Expected: Vitest corre y reporta "No test files found" (o similar) — sin error de configuración. Esto confirma que el setup de Task 1 está bien antes de escribir el primer test real en la Task 2.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml vitest.config.ts
git commit -m "chore: add vitest test runner"
```

---

### Task 2: Mover `sliceBranch`/`sliceIndexFromBranch` a un módulo `stack.ts` nuevo

**Files:**
- Create: `src/stack.ts`
- Create: `src/stack.test.ts`
- Modify: `src/agent-task.ts:17-30` (elimina las definiciones locales, importa de `stack.js`)

**Interfaces:**
- Produces: `sliceBranch(issueNumber: number, sliceIndex: number): string`, `sliceIndexFromBranch(branch: string): number | null` — mismo comportamiento que hoy, solo cambia de archivo. Estas son la base de la Task 3 (`toStackedPrs`) y la Task 4 (`baseBranchFor`).

Por qué moverlas: `agent-task.ts` importa `config.js` a nivel de módulo (para `repoUrl()`), y `config.ts` llama `requireEnv` al cargar — cualquier test que importe algo de `agent-task.ts`, aunque sea una función pura, dispara esas excepciones sin un montón de env vars reales seteadas. `stack.ts` no importa nada de `config.ts` (ver Global Constraints), así que queda testeable sin mocks.

- [ ] **Step 1: Escribir el test (fallará porque `stack.ts` no existe)**

`src/stack.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sliceBranch, sliceIndexFromBranch } from './stack.js';

describe('sliceBranch / sliceIndexFromBranch', () => {
  it('round-trips a slice index through a branch name', () => {
    expect(sliceBranch(228, 0)).toBe('valeria/228/slice-1');
    expect(sliceIndexFromBranch('valeria/228/slice-1')).toBe(0);
  });

  it('returns null for a branch that does not match the slice pattern', () => {
    expect(sliceIndexFromBranch('valeria/228/plan')).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm test stack.test.ts`
Expected: FAIL — `Cannot find module './stack.js'` (o equivalente).

- [ ] **Step 3: Crear `src/stack.ts` con las funciones movidas**

```ts
// Placeholder slug — once slice titles are used for the branch name instead
// of the raw index, this and the regex below need to move to a slugify
// scheme instead of a fixed-format parse.
export function sliceBranch(issueNumber: number, sliceIndex: number): string {
  return `valeria/${issueNumber}/slice-${sliceIndex + 1}`;
}

const SLICE_BRANCH_RE = /^valeria\/\d+\/slice-(\d+)$/;

export function sliceIndexFromBranch(branch: string): number | null {
  const match = branch.match(SLICE_BRANCH_RE);
  return match ? Number(match[1]) - 1 : null;
}
```

- [ ] **Step 4: Correr el test y confirmar que pasa**

Run: `pnpm test stack.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Actualizar `src/agent-task.ts` para importar de `stack.js` en vez de definir localmente**

En `src/agent-task.ts`, borrar las líneas 17-30 (el comentario y las dos funciones) y agregar el import correspondiente junto a los otros imports relativos del archivo:

```ts
import { sliceBranch, sliceIndexFromBranch } from './stack.js';
```

(`sliceIndexFromBranch` sigue exportado desde `agent-task.ts` porque `tick.ts` lo importa hoy de ahí — la Task 10 lo actualiza para importarlo de `stack.js` directamente; hasta entonces, re-exportarlo evita romper el build a mitad de plan: `export { sliceIndexFromBranch } from './stack.js';`)

- [ ] **Step 6: Typecheck completo**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add src/stack.ts src/stack.test.ts src/agent-task.ts
git commit -m "refactor: move sliceBranch/sliceIndexFromBranch to a config-free stack.ts"
```

---

### Task 3: `toStackedPrs` y `pickBottomPr` en `stack.ts`

**Files:**
- Modify: `src/stack.ts`
- Modify: `src/stack.test.ts`

**Interfaces:**
- Consumes: `type PullRequestStatus` de `src/github.ts` (import type-only, sin efecto de carga en runtime).
- Produces: `interface StackedPr extends PullRequestStatus { sliceIndex: number }`, `toStackedPrs(prs: PullRequestStatus[]): StackedPr[]`, `pickBottomPr(prs: StackedPr[]): StackedPr | null` — usados por `tick.ts` en la Task 10.

- [ ] **Step 1: Agregar los tests (fallarán — las funciones no existen)**

Agregar a `src/stack.test.ts`:

```ts
import type { PullRequestStatus } from './github.js';
import { toStackedPrs, pickBottomPr } from './stack.js';

function pr(headRefName: string, overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
  return {
    number: 1,
    state: 'OPEN',
    reviewDecision: '',
    checksPassing: true,
    mergeable: true,
    headRefName,
    isDraft: false,
    ...overrides,
  };
}

describe('toStackedPrs', () => {
  it('sorts by slice index and drops non-slice branches', () => {
    const prs = [
      pr('valeria/228/slice-2', { number: 230 }),
      pr('valeria/228/slice-1', { number: 229 }),
      pr('valeria/228/plan', { number: 1 }),
    ];
    expect(toStackedPrs(prs).map((p) => [p.sliceIndex, p.number])).toEqual([
      [0, 229],
      [1, 230],
    ]);
  });
});

describe('pickBottomPr', () => {
  it('returns the lowest slice index even if a higher one is approved first', () => {
    const stack = toStackedPrs([
      pr('valeria/228/slice-2', { number: 230, reviewDecision: 'APPROVED' }),
      pr('valeria/228/slice-1', { number: 229, reviewDecision: '' }),
    ]);
    expect(pickBottomPr(stack)?.number).toBe(229);
  });

  it('returns null for an empty stack', () => {
    expect(pickBottomPr([])).toBeNull();
  });
});
```

- [ ] **Step 2: Correr los tests y confirmar que fallan**

Run: `pnpm test stack.test.ts`
Expected: FAIL — `toStackedPrs`/`pickBottomPr` no exportados.

- [ ] **Step 3: Implementar en `src/stack.ts`**

Agregar (después de las funciones de la Task 2):

```ts
import type { PullRequestStatus } from './github.js';

export interface StackedPr extends PullRequestStatus {
  sliceIndex: number;
}

// Ordena por índice de slice; descarta cualquier PR cuyo branch no matchee el
// patrón valeria/<issue>/slice-N (ej. el branch de la tarea 'plan') — no
// debería pasar en la práctica, pero mejor un PR ignorado que uno mal indexado.
export function toStackedPrs(prs: PullRequestStatus[]): StackedPr[] {
  return prs
    .flatMap((pr) => {
      const sliceIndex = sliceIndexFromBranch(pr.headRefName);
      return sliceIndex === null ? [] : [{ ...pr, sliceIndex }];
    })
    .sort((a, b) => a.sliceIndex - b.sliceIndex);
}

// El único PR elegible para intentar merge: el de menor índice, sin importar
// el estado de aprobación de los que están más arriba en el stack.
export function pickBottomPr(prs: StackedPr[]): StackedPr | null {
  if (prs.length === 0) return null;
  return prs.reduce((bottom, pr) => (pr.sliceIndex < bottom.sliceIndex ? pr : bottom));
}
```

- [ ] **Step 4: Correr los tests y confirmar que pasan**

Run: `pnpm test stack.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat: add toStackedPrs/pickBottomPr for multi-PR-per-issue ordering"
```

---

### Task 4: `baseBranchFor` en `stack.ts`

**Files:**
- Modify: `src/stack.ts`
- Modify: `src/stack.test.ts`

**Interfaces:**
- Produces: `baseBranchFor(sliceIndex: number, issueNumber: number, rootBaseRef: string): string` — usado por `agent-task.ts` (Task 9) para decidir el branch base de una nueva slice.

- [ ] **Step 1: Agregar el test (fallará)**

Agregar a `src/stack.test.ts`:

```ts
import { baseBranchFor } from './stack.js';

describe('baseBranchFor', () => {
  it('uses the root base ref for the first slice', () => {
    expect(baseBranchFor(0, 228, 'origin/main')).toBe('origin/main');
  });

  it('chains onto the previous slice branch otherwise', () => {
    expect(baseBranchFor(2, 228, 'origin/main')).toBe('valeria/228/slice-2');
  });
});
```

- [ ] **Step 2: Correr y confirmar que falla**

Run: `pnpm test stack.test.ts`
Expected: FAIL — `baseBranchFor` no exportada.

- [ ] **Step 3: Implementar**

Agregar a `src/stack.ts`:

```ts
// Branch base para arrancar la próxima slice: el ref raíz (main) para la
// primera, o el branch de la slice anterior para cualquier otra — así cada
// slice se apila en contenido sobre la anterior sin esperar a que mergee.
export function baseBranchFor(sliceIndex: number, issueNumber: number, rootBaseRef: string): string {
  return sliceIndex === 0 ? rootBaseRef : sliceBranch(issueNumber, sliceIndex - 1);
}
```

- [ ] **Step 4: Correr y confirmar que pasa**

Run: `pnpm test stack.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/stack.ts src/stack.test.ts
git commit -m "feat: add baseBranchFor to chain slice branches"
```

---

### Task 5: `nextUnstartedSlice` en `checklist.ts`

**Files:**
- Modify: `src/checklist.ts`
- Create: `src/checklist.test.ts`

**Interfaces:**
- Consumes: mockea `getIssueBody`/`setIssueBody` de `./github.js` (no toca `config.ts` ni la red).
- Produces: `nextUnstartedSlice(issueNumber: number): Promise<Slice | null>` — primera slice sin PR asignado (`prNumber === null`), a diferencia de `nextSlice` (primera sin tildar). Usado por `tick.ts` en la Task 10 para decidir cuál slice arrancar.

- [ ] **Step 1: Escribir el test file completo (algunos tests fallarán: los de `nextUnstartedSlice`; los de las funciones ya existentes deberían pasar de una)**

`src/checklist.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const bodies = new Map<number, string>();

vi.mock('./github.js', () => ({
  getIssueBody: vi.fn(async (issueNumber: number) => bodies.get(issueNumber) ?? ''),
  setIssueBody: vi.fn(async (issueNumber: number, body: string) => {
    bodies.set(issueNumber, body);
  }),
}));

import { nextSlice, nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged } from './checklist.js';

const SAMPLE_BODY = [
  '## Slices',
  '',
  '- [x] Slice 1: Catálogo de permisos — PR: #229',
  '- [ ] Slice 2: Tabla de citas — PR: #230',
  '- [ ] Slice 3: Lectura — PR: _pending_',
].join('\n');

beforeEach(() => {
  bodies.clear();
  bodies.set(228, SAMPLE_BODY);
});

describe('nextSlice (unchanged)', () => {
  it('returns the first unchecked slice regardless of PR state', async () => {
    const slice = await nextSlice(228);
    expect(slice).toMatchObject({ index: 1, title: 'Tabla de citas' });
  });
});

describe('hasRemainingSlices (unchanged)', () => {
  it('is true while any slice is unchecked', async () => {
    expect(await hasRemainingSlices(228)).toBe(true);
  });

  it('is false once every slice is checked', async () => {
    bodies.set(228, SAMPLE_BODY.replaceAll('[ ]', '[x]').replace('_pending_', '#231'));
    expect(await hasRemainingSlices(228)).toBe(false);
  });
});

describe('nextUnstartedSlice', () => {
  it('returns the first slice with no PR recorded yet, regardless of merge state', async () => {
    const slice = await nextUnstartedSlice(228);
    expect(slice).toMatchObject({ index: 2, title: 'Lectura' });
  });

  it('returns null once every slice has a PR, merged or not', async () => {
    bodies.set(228, SAMPLE_BODY.replace('_pending_', '#231'));
    expect(await nextUnstartedSlice(228)).toBeNull();
  });
});

describe('recordSlicePr / markSliceMerged', () => {
  it('recordSlicePr writes the PR number for a pending slice', async () => {
    await recordSlicePr(228, 2, 231);
    expect(bodies.get(228)).toContain('- [ ] Slice 3: Lectura — PR: #231');
  });

  it('markSliceMerged checks off the slice', async () => {
    await markSliceMerged(228, 1);
    expect(bodies.get(228)).toContain('- [x] Slice 2: Tabla de citas — PR: #230');
  });
});
```

- [ ] **Step 2: Correr los tests**

Run: `pnpm test checklist.test.ts`
Expected: FAIL solo en el describe `nextUnstartedSlice` (`nextUnstartedSlice` no exportada) — el resto ya pasa, porque esas funciones ya existen sin cambios.

- [ ] **Step 3: Implementar `nextUnstartedSlice` en `src/checklist.ts`**

Agregar después de `nextSlice` (la función existente, no tocarla):

```ts
// Primera slice sin PR asignado — la próxima a implementar, sin importar si
// otra slice más atrás en el checklist sigue con su PR abierto (a diferencia
// de nextSlice, que mira "sin mergear").
export async function nextUnstartedSlice(issueNumber: number): Promise<Slice | null> {
  const next = (await getSlices(issueNumber)).find((s) => s.prNumber === null);
  return next ?? null;
}
```

- [ ] **Step 4: Correr los tests y confirmar que todos pasan**

Run: `pnpm test checklist.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/checklist.ts src/checklist.test.ts
git commit -m "feat: add nextUnstartedSlice to checklist.ts"
```

---

### Task 6: `config.rebaseRetryLimit`

**Files:**
- Modify: `src/config.ts:49-50`

**Interfaces:**
- Produces: `config.rebaseRetryLimit: number` — usado por `tick.ts` (Task 10) como límite para `blockOnAttemptLimit` en el flujo de rebase.

- [ ] **Step 1: Agregar el campo**

En `src/config.ts`, junto a `e2eRetryLimit`/`sliceAttemptLimit`:

```ts
  e2eRetryLimit: Number(process.env.E2E_RETRY_LIMIT ?? 2),
  sliceAttemptLimit: Number(process.env.SLICE_ATTEMPT_LIMIT ?? 3),
  // "Loop guard" de docs/BLOCKING.md: 3 intentos de dejar mergeable el fondo
  // del stack antes de escalar a bloqueo por "conflicto de merge no mecánico".
  rebaseRetryLimit: Number(process.env.REBASE_RETRY_LIMIT ?? 3),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores (no hay test dedicado — `config.ts` exige env vars reales para importarse, fuera del alcance de test acordado).

- [ ] **Step 3: Commit**

```bash
git add src/config.ts
git commit -m "feat: add config.rebaseRetryLimit"
```

---

### Task 7: `github.ts` — múltiples PRs por issue + `--delete-branch`

**Files:**
- Modify: `src/github.ts:207-212` (`getOpenPrForIssue` → `getOpenPrsForIssue`)
- Modify: `src/github.ts:197` (`mergePullRequest`)

**Interfaces:**
- Produces: `getOpenPrsForIssue(issueNumber: number): Promise<PullRequestStatus[]>` (reemplaza a `getOpenPrForIssue`, que desaparece) — consumida por `tick.ts` en la Task 10.
- Sin test dedicado: son wrappers directos de `gh`/`execFile`, sin lógica de decisión nueva — coherente con el alcance de testing acordado (mocks solo para `checklist.ts`/`stack.ts`).

- [ ] **Step 1: Reemplazar `getOpenPrForIssue` por `getOpenPrsForIssue`**

En `src/github.ts`, reemplazar (líneas 204-212):

```ts
export function branchPrefix(issueNumber: number): string {
  return `valeria/${issueNumber}/`;
}

// Slice branches are created as `valeria/<issue>/<slice-slug>` (see agent-task.ts),
// so the PR for a given issue's current slice is found by branch prefix instead
// of maintaining a separate mapping.
export async function getOpenPrForIssue(issueNumber: number): Promise<PullRequestStatus | null> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName']);
  const prs = JSON.parse(stdout) as Array<{ number: number; headRefName: string }>;
  const match = prs.find((pr) => pr.headRefName.startsWith(branchPrefix(issueNumber)));
  return match ? getPullRequestStatus(match.number) : null;
}
```

por:

```ts
export function branchPrefix(issueNumber: number): string {
  return `valeria/${issueNumber}/`;
}

// Slice branches are created as `valeria/<issue>/<slice-slug>` (see agent-task.ts),
// so every open PR for an issue's stack is found by branch prefix instead of
// maintaining a separate mapping. Can return more than one now that several
// slices of the same issue can be in flight at once (see
// docs/superpowers/specs/2026-07-28-stacked-prs-design.md).
export async function getOpenPrsForIssue(issueNumber: number): Promise<PullRequestStatus[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName']);
  const prs = JSON.parse(stdout) as Array<{ number: number; headRefName: string }>;
  const matches = prs.filter((pr) => pr.headRefName.startsWith(branchPrefix(issueNumber)));
  return Promise.all(matches.map((pr) => getPullRequestStatus(pr.number)));
}
```

- [ ] **Step 2: `mergePullRequest` agrega `--delete-branch`**

En `src/github.ts`, cambiar:

```ts
  await gh(['pr', 'merge', String(prNumber), '--merge']);
```

por:

```ts
  // --delete-branch: dispara el auto-retarget nativo de GitHub del PR
  // inmediatamente superior en el stack (su base pasa de este branch a
  // `main` solo, sin que el supervisor tenga que tocar nada del lado de
  // GitHub) — ver docs/superpowers/specs/2026-07-28-stacked-prs-design.md §1.
  await gh(['pr', 'merge', String(prNumber), '--merge', '--delete-branch']);
```

- [ ] **Step 3: Typecheck (va a fallar — `tick.ts` todavía usa el nombre viejo)**

Run: `pnpm typecheck`
Expected: FAIL — `tick.ts` referencia `getOpenPrForIssue`, que ya no existe. Esto es esperado: la Task 10 arregla `tick.ts`. Confirmá que el único error es ese (en `src/tick.ts`), no algo inesperado en `github.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/github.ts
git commit -m "feat: getOpenPrsForIssue (plural) + --delete-branch on merge"
```

(El typecheck queda roto entre esta task y la Task 10 — es intencional, cada task es un commit atómico pero el build completo solo vuelve a estar verde al final del plan. Si preferís mantener cada commit compilando, avisá y lo reordeno para tocar `tick.ts` en el mismo commit que este cambio.)

---

### Task 8: `worktree.ts` — rebase mecánico

**Files:**
- Modify: `src/worktree.ts`

**Interfaces:**
- Produces: `isBehind(worktreeDir: string, ontoBranch: string): Promise<boolean>`, `attemptRebase(worktreeDir: string, ontoBranch: string): Promise<boolean>` — usados por `tick.ts` (Task 10).
- Sin test automatizado — decisión explícita del spec (§"Fuera de esta cobertura"): la mecánica real de `git rebase` se valida con un dry run manual, no con un repo git temporal en CI.

- [ ] **Step 1: Agregar las dos funciones al final de `src/worktree.ts`**

```ts
export async function isBehind(worktreeDir: string, ontoBranch: string): Promise<boolean> {
  await execFileAsync('git', ['fetch', 'origin'], { cwd: worktreeDir });
  return execFileAsync('git', ['merge-base', '--is-ancestor', ontoBranch, 'HEAD'], { cwd: worktreeDir })
    .then(() => false)
    .catch(() => true);
}

// Best-effort: usado solo para el fondo del stack, después de que su
// predecesor mergea (ver docs/superpowers/specs/2026-07-28-stacked-prs-design.md
// §5). Un conflicto real es un resultado esperado a veces — el caller cae a
// una tarea de agente fix-rebase cuando esto devuelve false, nunca propaga el
// error crudo de git.
export async function attemptRebase(worktreeDir: string, ontoBranch: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rebase', ontoBranch], { cwd: worktreeDir });
  } catch {
    await execFileAsync('git', ['rebase', '--abort'], { cwd: worktreeDir }).catch(() => {});
    return false;
  }
  await execFileAsync('git', ['push', '--force-with-lease'], { cwd: worktreeDir });
  return true;
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: mismo único error preexistente de la Task 7 (`tick.ts`), nada nuevo en `worktree.ts`.

- [ ] **Step 3: Commit**

```bash
git add src/worktree.ts
git commit -m "feat: mechanical rebase helpers (isBehind, attemptRebase)"
```

---

### Task 9: `agent-task.ts` — tarea `fix-rebase`, prompts a amend, slice apilada

**Files:**
- Modify: `src/agent-task.ts` (todo el archivo salvo `runAgentTask`, que solo cambia una línea)

**Interfaces:**
- Consumes: `baseBranchFor`, `sliceBranch` de `./stack.js` (Tasks 2-4); `config.rebaseRetryLimit` no se usa acá (vive en `tick.ts`); `config.worktreeBaseRef` (ya importado).
- Produces: nuevo variante de `AgentTask`: `{ type: 'fix-rebase'; issueNumber: number; prNumber: number }` — consumida por `tick.ts` (Task 10).

- [ ] **Step 1: Actualizar el import de `stack.js` (ya estaba desde la Task 2) y el tipo `AgentTask`**

En `src/agent-task.ts`, el import de la Task 2 pasa a:

```ts
import { sliceBranch, baseBranchFor } from './stack.js';
```

**No borrar todavía** el `export { sliceIndexFromBranch } from './stack.js';` que quedó como puente en la Task 2 — `tick.ts` (sin tocar hasta la Task 10) todavía lo importa de `agent-task.js`. Se borra recién en la Task 10, Step 1, cuando se reescribe el bloque de imports de `tick.ts` y deja de hacer falta.

El tipo `AgentTask` pasa a:

```ts
export type AgentTask =
  | { type: 'plan'; issueNumber: number; specPaths: string[] }
  | { type: 'implement-slice'; issueNumber: number; sliceIndex: number; sliceTitle: string }
  | { type: 'fix-review'; issueNumber: number; prNumber: number }
  | { type: 'fix-e2e'; issueNumber: number; prNumber: number }
  | { type: 'fix-rebase'; issueNumber: number; prNumber: number };
```

- [ ] **Step 2: `buildTask` devuelve un `baseBranch` opcional**

Cambiar la firma:

```ts
async function buildTask(task: AgentTask): Promise<{ branch: string; prompt: string; baseBranch?: string }> {
```

- [ ] **Step 3: Reescribir el caso `implement-slice` para apilar sobre la slice anterior**

Reemplazar el case actual por:

```ts
    case 'implement-slice': {
      const worktreeBase = baseBranchFor(task.sliceIndex, task.issueNumber, config.worktreeBaseRef);
      const prCommand = task.sliceIndex === 0 ? 'gh pr create' : `gh pr create --base ${worktreeBase}`;
      return {
        branch: sliceBranch(task.issueNumber, task.sliceIndex),
        baseBranch: worktreeBase,
        prompt: [
          `You are ValerIA, an autonomous agent working on tracking issue #${task.issueNumber} in ${repoUrl()}.`,
          `Implement this single slice: "${task.sliceTitle}".`,
          "Follow this repo's CLAUDE.md conventions, including its testing requirements.",
          'If this slice touches user-facing behavior in apps/webapp, add or update a Playwright e2e spec under apps/webapp/e2e/ covering it, and run it (`pnpm --filter @bmedical/webapp exec playwright test`) until it passes — do not leave that for CI to catch. Leave the resulting output under apps/webapp/test-results/ as-is; do not move, copy, or commit it — the supervisor collects it separately.',
          `When done: run the relevant tests, and make exactly one commit for this slice (squash any work-in-progress commits into one before pushing). Push this branch and open a PR (\`${prCommand}\`) describing the slice.`,
          'Scope: only touch files needed for this slice. Do not edit the tracking issue (body, labels, assignees, or anything else) — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```

- [ ] **Step 4: `fix-review` pasa a amend + force-push**

Reemplazar la línea del prompt:

```ts
          `Read them with "gh pr view ${task.prNumber} --comments", apply the necessary changes following this repo's CLAUDE.md conventions, and commit and push to this same branch.`,
```

por:

```ts
          `Read them with "gh pr view ${task.prNumber} --comments", apply the necessary changes following this repo's CLAUDE.md conventions, then amend the existing commit (\`git commit --amend\`) — never create a new commit — and force-push (\`git push --force-with-lease\`) to this same branch.`,
```

- [ ] **Step 5: `fix-e2e` pasa a amend + force-push**

Reemplazar:

```ts
          'Investigate the cause, fix it, and confirm the affected e2e spec(s) pass by re-running them (`pnpm --filter @bmedical/webapp exec playwright test`), then commit and push to this same branch.',
```

por:

```ts
          'Investigate the cause, fix it, and confirm the affected e2e spec(s) pass by re-running them (`pnpm --filter @bmedical/webapp exec playwright test`), then amend the existing commit (`git commit --amend`) — never create a new commit — and force-push (`git push --force-with-lease`) to this same branch.',
```

- [ ] **Step 6: Agregar el case `fix-rebase`**

Agregar después del case `fix-e2e` (antes de la llave de cierre del `switch`):

```ts
    case 'fix-rebase': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. PR #${task.prNumber} (tracking issue #${task.issueNumber}) is behind \`${config.worktreeBaseRef}\` and couldn't be rebased mechanically — it hit a real conflict.`,
          `Run \`git fetch origin\` and \`git rebase ${config.worktreeBaseRef}\` in this worktree, and resolve the conflicts following this repo's CLAUDE.md conventions and the spec — do not deviate from what the spec explicitly requires.`,
          'Re-run the relevant tests after resolving, then amend the existing commit (`git commit --amend`) — never create a new commit — and force-push (`git push --force-with-lease`) to this same branch.',
          'If a conflict requires a decision the spec does not clearly resolve, stop and leave the branch as-is — that needs a human decision, do not guess.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```

- [ ] **Step 7: `runAgentTask` pasa el `baseBranch` a `ensureWorktree`**

Cambiar:

```ts
  const { branch, prompt } = await buildTask(task);
  const worktreeDir = await ensureWorktree(branch);
```

por:

```ts
  const { branch, prompt, baseBranch } = await buildTask(task);
  const worktreeDir = await ensureWorktree(branch, baseBranch);
```

(`ensureWorktree(branch, undefined)` cae en su propio default `config.worktreeBaseRef` — ver `src/worktree.ts:26`, sin cambios ahí.)

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: mismo único error preexistente de la Task 7 (`tick.ts` — se arregla en la Task 10).

- [ ] **Step 9: Correr toda la suite de tests (nada debería haberse roto)**

Run: `pnpm test`
Expected: PASS — mismos tests de `stack.test.ts` y `checklist.test.ts` de las tasks anteriores.

- [ ] **Step 10: Commit**

```bash
git add src/agent-task.ts
git commit -m "feat: stack slice branches, amend-only prompts, fix-rebase task"
```

---

### Task 10: `tick.ts` — múltiples PRs por issue, orden de merge, rebase

**Files:**
- Modify: `src/tick.ts`

**Interfaces:**
- Consumes: `getOpenPrsForIssue`, `mergePullRequest` (Task 7); `nextUnstartedSlice`, `hasRemainingSlices`, `recordSlicePr`, `markSliceMerged` (Task 5, checklist.ts sin cambios en las últimas 3); `toStackedPrs`, `pickBottomPr`, `type StackedPr` (Tasks 3-4, `stack.js`); `isBehind`, `attemptRebase` (Task 8, `worktree.js`); `config.rebaseRetryLimit` (Task 6).
- Sin test dedicado — orquestación de I/O real (`gh`, `git`, `claude -p`), fuera del alcance de test acordado. Se verifica con `pnpm typecheck` + la suite completa (para confirmar que no rompió nada de lo ya testeado) + una revisión manual del flujo.

- [ ] **Step 1: Actualizar los imports**

Reemplazar el bloque de imports de `./github.js`, `./checklist.js` y agregar `./stack.js`, `./worktree.js` (ya se importaba `worktreeDirFor` de ahí):

```ts
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  setPrState,
  getSpecPathsFromPr,
  mergeSpecPr,
  commentOnSpecPr,
  getOpenPrsForIssue,
  mergePullRequest,
  setIssueState,
  incrementAttemptCount,
  hasEvidenceComment,
  postEvidenceComment,
  type TrackingIssue,
  type PullRequestStatus,
} from './github.js';
import { fetchOriginMain, readSpecFile, extractTitle } from './spec-content.js';
import { nextUnstartedSlice, hasRemainingSlices, recordSlicePr, markSliceMerged } from './checklist.js';
import { notifyBlocker } from './notifier.js';
import { runAgentTask } from './agent-task.js';
import { toStackedPrs, pickBottomPr, type StackedPr } from './stack.js';
import { tryClaim, releaseIfNoLongerInProgress, runnerLabel } from './claim.js';
import { worktreeDirFor, isBehind, attemptRebase } from './worktree.js';
import { publishEvidence, rawEvidenceUrl } from './evidence.js';
import { config } from './config.js';
```

(`sliceIndexFromBranch` ya no se importa acá — vivía en `agent-task.js`, ahora la usa internamente `toStackedPrs` desde `stack.js`.)

Con este cambio, `agent-task.ts` deja de necesitar el puente `export { sliceIndexFromBranch } from './stack.js';` de la Task 2 (ya ningún archivo lo importa desde ahí) — borrarlo también en este step.

- [ ] **Step 2: Agregar `ensureBottomUpToDate`**

Agregar después de `blockOnAttemptLimit` (no tocarla — se reutiliza tal cual):

```ts
async function ensureBottomUpToDate(issue: TrackingIssue, pr: StackedPr): Promise<boolean> {
  const worktreeDir = worktreeDirFor(pr.headRefName);
  if (!(await isBehind(worktreeDir, config.worktreeBaseRef))) return true;
  if (await attemptRebase(worktreeDir, config.worktreeBaseRef)) return true;

  const blocked = await blockOnAttemptLimit(
    issue, pr, config.rebaseRetryLimit,
    'Rebase con conflicto real tras el límite de reintentos',
  );
  if (!blocked) await runAgentTask({ type: 'fix-rebase', issueNumber: issue.number, prNumber: pr.number });
  return false;
}
```

- [ ] **Step 3: Agregar `processSlicePr`**

Agregar justo después de `ensureBottomUpToDate`:

```ts
async function processSlicePr(issue: TrackingIssue, pr: StackedPr, isBottom: boolean): Promise<void> {
  await recordSlicePr(issue.number, pr.sliceIndex, pr.number);

  // Checked every tick until it succeeds once (hasEvidenceComment gates the
  // repeat work) — ver docs/DESIGN.md §4.
  if (!(await hasEvidenceComment(pr.number))) {
    const paths = await publishEvidence(issue.number, pr.number, worktreeDirFor(pr.headRefName));
    if (paths.length > 0) {
      await postEvidenceComment(pr.number, paths.map(rawEvidenceUrl));
    }
  }

  if (pr.isDraft) return;

  // Solo el fondo del stack necesita estar al día con main antes de evaluar
  // merge — ver docs/superpowers/specs/2026-07-28-stacked-prs-design.md §5.
  if (isBottom && !(await ensureBottomUpToDate(issue, pr))) return;

  if (pr.checksPassing && pr.reviewDecision === 'APPROVED') {
    // Aprobado pero no es el fondo del stack: espera su turno sin
    // notificación — mismo "estado de espera normal" de docs/BLOCKING.md.
    if (!isBottom) return;
    await mergePullRequest(pr.number);
    await markSliceMerged(issue.number, pr.sliceIndex);
    return;
  }

  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.sliceAttemptLimit,
      'Feedback de review sin converger tras el límite de intentos',
    );
    if (blocked) return;
    await runAgentTask({ type: 'fix-review', issueNumber: issue.number, prNumber: pr.number });
    return;
  }

  if (!pr.checksPassing) {
    const blocked = await blockOnAttemptLimit(
      issue, pr, config.e2eRetryLimit,
      'E2E fallando persistentemente tras el límite de reintentos',
    );
    if (blocked) return;
    await runAgentTask({ type: 'fix-e2e', issueNumber: issue.number, prNumber: pr.number });
    return;
  }

  // Checks passing, no changes requested, not yet approved: normal
  // waiting-for-review state per docs/BLOCKING.md — no action, no notification.
}
```

- [ ] **Step 4: Reescribir `processIssue`**

Reemplazar toda la función `processIssue` actual por:

```ts
async function processIssue(issue: TrackingIssue): Promise<void> {
  const stack = toStackedPrs(await getOpenPrsForIssue(issue.number));

  if (stack.length === 0) {
    const slice = await nextUnstartedSlice(issue.number);
    if (slice) {
      await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: slice.index, sliceTitle: slice.title });
      return;
    }
    // Ningún PR abierto y ninguna slice sin arrancar: o todo mergeó, o algún
    // PR se cerró sin mergear (gap conocido, fuera de alcance — ver spec) y
    // queda huérfano. hasRemainingSlices distingue ambos casos.
    if (await hasRemainingSlices(issue.number)) return;
    await setIssueState(issue.number, 'done');
    return;
  }

  const bottom = pickBottomPr(stack)!; // stack.length >= 1 acá, chequeado arriba
  for (const pr of stack) {
    await processSlicePr(issue, pr, pr.sliceIndex === bottom.sliceIndex);
  }

  const nextSlice = await nextUnstartedSlice(issue.number);
  if (nextSlice) {
    await runAgentTask({ type: 'implement-slice', issueNumber: issue.number, sliceIndex: nextSlice.index, sliceTitle: nextSlice.title });
  }
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores — este era el último archivo con el error pendiente de las Tasks 7-9.

- [ ] **Step 6: Correr toda la suite de tests**

Run: `pnpm test`
Expected: PASS — mismos tests de `stack.test.ts` / `checklist.test.ts`, nada roto.

- [ ] **Step 7: Commit**

```bash
git add src/tick.ts
git commit -m "feat: process every open slice PR per issue, gate merge order, trigger rebase"
```

---

### Task 11: Verificación final

**Files:** ninguno (solo comandos)

- [ ] **Step 1: Typecheck completo**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 2: Suite completa**

Run: `pnpm test`
Expected: PASS — todos los tests de `stack.test.ts` (7) y `checklist.test.ts` (7), 14 en total.

- [ ] **Step 3: Dry run manual (fuera del alcance de test automatizado)**

Como quedó explícito en el spec (§"Fuera de esta cobertura") y en Global Constraints: la mecánica real de `git rebase` con un conflicto real no tiene test automatizado. Antes de usar esto contra el issue #228 real, correr un dry run como el de `docs/DESIGN.md` §10 — spec descartable con 2-3 slices triviales, forzando que una de ellas produzca un conflicto real al mergear la anterior, para confirmar que la escalada mecánico → `fix-rebase` → bloqueo funciona de punta a punta.

No hay commit en esta task — es solo verificación.
