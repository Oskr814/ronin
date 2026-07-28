# Stacked PRs reales para slices de un mismo issue

## Contexto

El flujo actual (`docs/DESIGN.md` §2-§3) es secuencial: `processIssue` solo arranca la
siguiente slice cuando **no hay ningún PR abierto** para el issue. En la práctica esto
significa que, aunque DESIGN.md hable de "técnica de stacked PRs", el supervisor nunca
tiene más de un PR en vuelo por issue — la slice N+1 espera a que la N esté *mergeada*
(lo cual requiere approval humano explícito, gate no negociable en `mergePullRequest`).

Esto se detectó investigando el issue #228 (`docs/superpowers/plans/2026-07-25-appointments-*`
en `bmedical`, 19 slices): el PR #229 (slice 1) quedó con CI verde y mergeable desde las
05:50 del 2026-07-28, pero sin approval humano. Como un PR abierto esperando review es
estado normal (no bloqueo, `docs/BLOCKING.md`), el supervisor no notificó nada y quedó
haciendo tick cada 5 minutos sin avanzar por más de 8 horas — comportamiento correcto
para el diseño actual, pero no lo que se quiere: varias slices en revisión en paralelo,
apiladas.

## Objetivo

Que el supervisor pueda tener **varias slices de un mismo issue en revisión al mismo
tiempo**, cada una apilada (en contenido y en el `base` del PR) sobre la anterior, sin
esperar a que la anterior mergee para arrancar la siguiente.

## Decisiones de alcance

- **Sin cap de concurrencia**: se arrancan todas las slices que ya tengan su predecesora
  con PR abierto, sin límite de cuántas quedan en vuelo a la vez.
- **Rebase solo del siguiente PR en la cadena**: cuando el PR del fondo del stack
  mergea, se rebasea *únicamente* el que pasa a ser el nuevo fondo — nunca en cascada
  sobre el resto del stack de una.
- **Un commit por PR, vía prompt**: se instruye al agente a usar `git commit --amend` +
  `git push --force-with-lease` en vez de commits nuevos. No hay verificación mecánica
  del lado del supervisor — se confía en el prompt, igual que ya se confía en otras
  instrucciones de scope (ej. "no toques la issue").
- **Dependencias externas en texto libre** (ej. "Slice 6 bloqueada hasta que PR #221
  esté en main", en la sección "Notas de secuenciación" del issue): quedan **fuera de
  alcance**. Si una slice arranca antes de que su dependencia externa esté lista,
  probablemente no pueda completarse y caiga en una categoría de bloqueo ya existente
  (spec ambiguo / loop guard de intentos, `docs/BLOCKING.md`). Se revisita si en la
  práctica molesta.
- **Testing**: unit tests con mocks (Vitest) para la lógica de decisión nueva. La
  mecánica real de `git rebase` (conflicto real vs. mecánico) no queda cubierta por
  test automatizado — sigue necesitando un dry run puntual como el de DESIGN.md §10.

## Enfoques considerados

1. **Stacked PRs nativos de git/gh (elegido).** Slice N+1 se rama sobre el branch de
   slice N; su PR se abre con `--base valeria/<issue>/slice-N`. Al mergear slice N con
   `--delete-branch`, GitHub retarget-ea automáticamente el base del PR de N+1 a `main`.
   El supervisor solo necesita resolver el contenido (rebase mecánico + escalado).
2. **Todas las branches sobre `main`, apiladas solo en contenido.** Descartado: el diff
   de cada PR incluiría todo lo de las slices previas no mergeadas, rompiendo el
   principio de "PRs revisables en minutos" (DESIGN.md, Principios de diseño).
3. **Herramienta externa de stacked PRs (Graphite, git-spice).** Descartado por ahora:
   suma una dependencia y una identidad/auth más, contradice el principio de "sin base
   de datos ni lock service aparte" que ya sigue `claim.ts`, y es overkill para la
   escala actual (un repo, ráfagas de ~19 slices).

## Diseño

### 1. Encadenamiento de branches y PRs

- `implement-slice` basa el worktree en el branch de la slice inmediatamente anterior
  (`valeria/<issue>/slice-<N-1>`) en vez de en `main` — salvo para la primera slice del
  issue, que sigue basándose en `main` (`config.worktreeBaseRef`), igual que hoy.
- El PR se abre con `gh pr create --base valeria/<issue>/slice-<N-1>` (o sin `--base`
  para la primera slice, como hoy).
- `worktree.ts` no cambia: `ensureWorktree(branch, baseRef)` ya acepta un `baseRef`
  explícito: solo cambia qué valor le pasa `agent-task.ts`.

### 2. Checklist: distinguir "slice sin arrancar" de "slice sin mergear"

`checklist.ts` hoy solo tiene `nextSlice` (primera slice no tildada — mezcla "no
mergeada" con "no arrancada"). Se agrega:

```ts
// Primera slice sin PR asignado — la próxima a implementar, sin importar si otra
// slice más atrás en el checklist sigue con su PR abierto.
export async function nextUnstartedSlice(issueNumber: number): Promise<Slice | null> {
  const next = (await getSlices(issueNumber)).find((s) => s.prNumber === null);
  return next ?? null;
}
```

`nextSlice` y `hasRemainingSlices` no cambian — siguen resolviendo "queda algo sin
mergear" para la transición a `done`.

### 3. `github.ts`: múltiples PRs abiertos por issue

`getOpenPrForIssue` (singular) pasa a `getOpenPrsForIssue` (plural):

```ts
export async function getOpenPrsForIssue(issueNumber: number): Promise<PullRequestStatus[]> {
  const stdout = await gh(['pr', 'list', '--state', 'open', '--json', 'number,headRefName']);
  const prs = JSON.parse(stdout) as Array<{ number: number; headRefName: string }>;
  const matches = prs.filter((pr) => pr.headRefName.startsWith(branchPrefix(issueNumber)));
  return Promise.all(matches.map((pr) => getPullRequestStatus(pr.number)));
}
```

Devuelve sin ordenar — el orden por índice de slice se resuelve en `stack.ts` (§4),
usando `sliceIndexFromBranch` (ya existe en `agent-task.ts`), para no crear un import
circular entre `github.ts` y `agent-task.ts`.

`mergePullRequest` agrega `--delete-branch`:

```ts
await gh(['pr', 'merge', String(prNumber), '--merge', '--delete-branch']);
```

para disparar el auto-retarget nativo de GitHub sobre el PR inmediatamente superior.

### 4. Módulo nuevo `stack.ts`: decisiones puras, testeables sin red/filesystem

```ts
export interface StackedPr extends PullRequestStatus {
  sliceIndex: number;
}

// Ordena por índice de slice; descarta cualquier PR cuyo branch no matchee el patrón
// (no debería pasar, pero mejor un PR ignorado que uno mal indexado).
export function toStackedPrs(prs: PullRequestStatus[]): StackedPr[] { ... }

// El único PR elegible para intentar merge: el de menor índice, sin importar el
// estado de aprobación de los que están más arriba en el stack.
export function pickBottomPr(prs: StackedPr[]): StackedPr | null { ... }

// Branch base para la próxima slice a arrancar: main si es la slice 0, o el branch
// de la slice anterior si no.
export function baseBranchFor(sliceIndex: number, issueNumber: number): string { ... }
```

`processIssue` en `tick.ts` pasa a:

1. `getOpenPrsForIssue(issue.number)` → `toStackedPrs(...)`.
2. Para cada PR del stack (en cualquier orden): la misma lógica de hoy (evidencia,
   draft, fix-review, fix-e2e) — **sin cambios de comportamiento por PR individual**.
3. Para `pickBottomPr(stack)` específicamente, **antes** de evaluar si está en
   condiciones de mergear: si su base quedó desactualizada (el merge anterior del
   fondo del stack lo dejó atrás), se ejecuta el chequeo/rebase de §5. Esto corre en
   cada tick, no una sola vez — igual que `hasEvidenceComment`, se repite hasta que
   converge.
4. Intento de merge: solo sobre `pickBottomPr(stack)`, y solo si está `APPROVED` y con
   checks en verde (igual que hoy). Los demás, aunque estén aprobados, quedan en espera
   normal hasta que les toque — sin notificación, es el mismo "estado de espera" que ya
   documenta BLOCKING.md.
5. `nextUnstartedSlice(issue.number)` → si existe, dispara `implement-slice` con
   `baseBranchFor(slice.index, issue.number)` como base del worktree/branch/PR.
6. Si no hay slice sin arrancar, ni PRs abiertos, ni `nextSlice` (sin mergear) →
   `done`, igual que hoy.

### 5. Rebase al mergear el fondo del stack

Cuando `pickBottomPr` cambia (el anterior fondo mergeó), el nuevo fondo puede tener su
`base` desactualizado. En cada tick, mientras esto siga siendo cierto:

1. Si el nuevo fondo del stack no está ya al día con `main` (mismo chequeo que hace
   `mergeable` de `gh pr view`, o un `git merge-base --is-ancestor` en el worktree),
   se intenta `git fetch && git rebase main` en su worktree.
2. Sin conflictos → `git push --force-with-lease`; en el próximo tick ya aparece al día
   y sigue el flujo normal (evaluación de merge, §4 paso 4).
3. Con conflictos → nueva tarea de agente `fix-rebase` (`agent-task.ts`): resolver el
   conflicto sin apartarse del spec, commit final vía `--amend`, push
   `--force-with-lease`.
4. El contador de intentos es el mismo mecanismo de `incrementAttemptCount`/label
   `valeria:attempts-N` que ya usan `fix-review`/`fix-e2e`, contra un límite nuevo
   `config.rebaseRetryLimit` (default 3, alineado con el "loop guard" de 3 intentos que
   ya documenta BLOCKING.md). Si se agota → `blockOnAttemptLimit` bloquea el issue bajo
   la categoría ya existente *"Conflicto de merge no mecánico"*.

Solo se toca el PR inmediatamente siguiente en cada merge — el resto del stack no se
rebasea preventivamente.

### 6. Un commit por PR

Los prompts de `agent-task.ts` (`implement-slice`, `fix-review`, `fix-e2e`, y el nuevo
`fix-rebase`) cambian la instrucción final de "commit and push" a:

> "amend the existing commit (`git commit --amend`) — never create a new commit — and
> force-push (`git push --force-with-lease`) to this same branch."

Para `implement-slice` se agrega explícitamente: si internamente hizo varios commits de
trabajo, debe squashearlos a uno solo antes de abrir el PR.

### 7. Testing

- Se agrega Vitest (`devDependency` + script `"test": "vitest run"` en `package.json`),
  consistente con lo que ya usa `bmedical`.
- Cobertura con mocks, sin red/filesystem real:
  - `checklist.ts`: parseo/render de líneas, `nextSlice`, `nextUnstartedSlice`,
    `hasRemainingSlices`, `recordSlicePr`, `markSliceMerged` (mockeando
    `getIssueBody`/`setIssueBody`). Hoy no tiene ningún test.
  - `agent-task.ts`: `sliceBranch` / `sliceIndexFromBranch`.
  - `stack.ts`: `toStackedPrs`, `pickBottomPr`, `baseBranchFor` — casos incluyendo "PR
    de índice mayor aprobado pero el de índice menor sigue abierto" (no debe mergear el
    de mayor índice).
- Fuera de esta cobertura: la mecánica real de `git rebase` (detectar conflicto real vs.
  mecánico) — sigue necesitando un dry run puntual como el de DESIGN.md §10.

## Archivos afectados

- `src/checklist.ts` — agrega `nextUnstartedSlice`.
- `src/github.ts` — `getOpenPrForIssue` → `getOpenPrsForIssue`; `mergePullRequest` agrega `--delete-branch`.
- `src/agent-task.ts` — nuevo tipo de tarea `fix-rebase`; prompts de las 4 tareas existentes cambian a amend+force-push; `implement-slice` recibe el branch base a usar.
- `src/stack.ts` — nuevo módulo (`toStackedPrs`, `pickBottomPr`, `baseBranchFor`).
- `src/tick.ts` — `processIssue` reescrito según §4-§5.
- `src/config.ts` — nuevo `rebaseRetryLimit` (default 3).
- `package.json` — agrega Vitest + script `test`.
- Tests nuevos: `src/checklist.test.ts`, `src/agent-task.test.ts`, `src/stack.test.ts`.

## Fuera de alcance (explícito)

- Parseo estructurado de dependencias externas en "Notas de secuenciación".
- Verificación mecánica del supervisor de que el agente efectivamente dejó un solo commit.
- Test de integración con repos git temporales para la mecánica de rebase.
- Manejo del caso "el PR del fondo se cierra sin mergear" (branch huérfano) — gap conocido, no bloqueante.
