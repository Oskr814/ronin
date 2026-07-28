# Solo el fondo del stack evalúa checks de CI

## Contexto

El pipeline de CI en `bmedical` corre únicamente para PRs cuyo `base` es `main`: su
workflow (`ci.yml`) usa trigger `on: pull_request` con filtro explícito `branches:
[main]` — sin ese filtro, `pull_request` correría contra cualquier `base`. Con
stacked PRs (`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`), solo el PR del
fondo del stack tiene `base = main`; el resto tiene `base` = el branch de la slice
anterior. Esos PRs intermedios nunca van a disparar el pipeline, y por lo tanto nunca
van a tener `statusCheckRollup` con entradas.

`processSlicePr` (`src/tick.ts`) hoy evalúa `pr.checksPending`/`pr.checksPassing` para
**todos** los PRs del stack, no solo el del fondo. Como `checksPending` es `true`
mientras `statusCheckRollup.length === 0` (`src/github.ts`, `getPullRequestStatus`), un
PR intermedio queda con `checksPending: true` indefinidamente. Tras `e2eRetryLimit`
intentos, esto dispara `blockOnAttemptLimit` con el mensaje "CI nunca reportó resultados
tras el límite de reintentos" — una escalación falsa: el issue se bloquea y se notifica
a un humano por un estado que en realidad es normal (la slice está esperando su turno en
el stack, no hay nada roto).

## Objetivo

Que el supervisor solo evalúe checks de CI (`checksPending`, `checksPassing`, merge,
`fix-e2e`) para el PR del fondo del stack — el único que realmente puede tener
resultados de CI, porque es el único cuyo `base` es `main`.

## Diseño

En `processSlicePr` (`src/tick.ts`), reordenar el cuerpo de la función así:

1. `hasEvidenceComment` / `publishEvidence`, `isDraft`, `findUnprocessedMentions`: sin
   cambios — no dependen de checks ni de la posición en el stack.
2. Bloque `isBottom` (chequeo de base al día + intento de merge): sin cambios de
   contenido, pero el chequeo `pr.checksPassing && reviewDecision === 'APPROVED'` que
   dispara el merge queda **anidado dentro** de `if (isBottom)`, ya que solo tiene
   sentido evaluarlo ahí (antes vivía afuera y devolvía `true` temprano para el caso
   `!isBottom`).
3. `reviewDecision === 'CHANGES_REQUESTED'` → `fix-review`: se mueve fuera del bloque
   `isBottom`, sin cambios de lógica. Esto puede pasar en cualquier posición del stack
   (un review humano no depende de CI) y debe seguir arreglándose sin importar si el PR
   es o no el fondo.
4. Nuevo corte explícito: `if (!isBottom) return true;` — un PR que no es el fondo, no
   tiene `CHANGES_REQUESTED`, y no acaba de mergear, está en espera normal de su turno.
   No se evalúa `checksPending` ni `checksPassing` para él.
5. `checksPending` → escalación por `blockOnAttemptLimit`, y `!checksPassing` →
   `fix-e2e`: sin cambios de contenido, pero ahora solo se alcanzan cuando `isBottom` es
   `true` (por el corte del punto 4).

No cambia el comportamiento para el PR del fondo del stack en ningún caso. No cambia
`ensureBottomUpToDate`, `blockOnAttemptLimit`, `stack.ts`, `github.ts`, ni el pipeline de
`bmedical`.

## Testing

Se agrega `src/tick.test.ts` (no existe hoy) con Vitest, mockeando `./github.js`,
`./checklist.js`, `./agent-task.js`, `./worktree.js`, `./evidence.js`, `./mentions.js`,
`./claim.js`, `./notifier.js` de la misma forma que ya hace `stack.test.ts` para sus
dependencias. Casos mínimos para `processSlicePr`:

- PR no-fondo con `checksPending: true`, `reviewDecision: 'REVIEW_REQUIRED'` → no llama
  `blockOnAttemptLimit` ni `runAgentTask('fix-e2e', ...)`, devuelve `true`.
- PR no-fondo con `checksPending: true`, `reviewDecision: 'CHANGES_REQUESTED'` → sí
  llama `runAgentTask('fix-review', ...)` (confirma que el corte del punto 4 no rompe
  este caso, porque el chequeo de `CHANGES_REQUESTED` sigue estando antes del corte).
- PR fondo con `checksPending: true` tras agotar `e2eRetryLimit` intentos → sigue
  bloqueando el issue (comportamiento sin cambios, verifica que no se rompió el camino
  existente).
- PR fondo con `checksPassing: true` y `reviewDecision: 'APPROVED'` → mergea (camino
  existente, sin cambios).

## Fuera de alcance

- Cambios al pipeline de CI de `bmedical` (descartado explícitamente por el usuario:
  este fix se resuelve enteramente del lado del supervisor).
- Cualquier mecanismo para que un PR intermedio "herede" o simule el resultado de checks
  de un PR anterior en el stack — no es necesario, el chequeo de checks se difiere
  simplemente hasta que la slice llega al fondo.
