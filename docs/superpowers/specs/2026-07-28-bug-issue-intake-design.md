# Intake de issues de bug directamente desde GitHub

## Contexto

Hoy la única puerta de entrada de trabajo para ValerIA es un spec PR (`docs/DESIGN.md`
§1): un humano escribe un `.md`, lo etiqueta `valeria:runner-<id>`, lo pasa a ready for
review, y recién ahí el supervisor crea un issue de tracking con checklist de slices y
arranca a implementar.

Un bug reportado como issue de GitHub (label `bugfix`, ya existente en `bmedical`) no
tiene ningún camino hacia ese flujo — hoy requeriría que un humano lo reescriba como spec
PR, que es desproporcionado para algo típicamente acotado a un solo fix.

## Objetivo

Que un issue en `bmedical` etiquetado `bugfix` + `valeria:runner-<id>` dispare
automáticamente: lectura del issue, exploración del repo, fix, tests/e2e, PR con
evidencia cuando corresponda — reusando el máximo posible del motor que ya existe para
specs (merge gate con approval humano, ciclos `fix-review`/`fix-e2e`, límites de
reintento, pipeline de evidencia), en vez de construir un mecanismo paralelo.

## Diseño

### Señal de descubrimiento

Mismo criterio que un spec PR (label de runner = asignación explícita de un humano, sin
carrera entre runners — `docs/DESIGN.md` §1), pero sin paso de draft/ready intermedio:
un issue con label `bugfix` **y** `valeria:runner-<id>`, abierto, y que todavía no tiene
la label `valeria` (= todavía no fue tomado), es la señal de "andá".

Nueva función en `src/github.ts`, análoga a `listAssignedSpecPrs`:

```ts
export interface BugIssue {
  number: number;
  title: string;
}

export async function listAssignedBugIssues(label: string): Promise<BugIssue[]> {
  // gh issue list --label bugfix --label <label> --state open --json number,title,labels
  // filtra fuera los que ya tienen LABEL_MANAGED ('valeria') — ya tomados
}
```

### El issue de bug ES el issue de tracking

A diferencia de un spec (donde el PR se mergea y se crea un issue nuevo), acá no hace
falta un espejo: el issue que reportó el bug pasa a ser directamente el issue de
tracking. Nueva función `discoverAssignedBugs()` en `src/tick.ts`, llamada desde `tick()`
junto a `discoverAssignedSpecs()`:

1. `listAssignedBugIssues(runnerLabel())`.
2. Para cada uno: agregar `## Slices\n\n- [ ] Slice 1: Fix — <título del issue> — PR:
   _pending_\n` al final del body actual (sin tocar el resto — la descripción del bug
   que escribió el humano queda arriba, como contexto legible). Idempotente: si el body
   ya tiene una sección `## Slices`, no la duplica (protege contra un tick interrumpido
   entre este paso y el siguiente).
3. `setIssueState(issue.number, 'in-progress')` (aplica `valeria` + `valeria:in-progress`,
   igual que hace hoy para un issue de spec recién creado).

No hay paso de "plan" ni sesión de Claude en el descubrimiento — la sección de slices se
arma mecánicamente en código, no hace falta razonamiento del agente para saber que un bug
es una sola slice.

### Nueva tarea del agente: `fix-bug`

Nuevo caso en `AgentTask` (`src/agent-task.ts`), branch igual que hoy (`sliceBranch`,
`baseBranchFor` con `sliceIndex = 0` → base es `worktreeBaseRef`, o sea PR directo contra
`main`, sin necesidad de tocar `stack.ts`). Prompt:

- Leer el issue completo, incluyendo comentarios: `gh issue view <n> --comments`.
- Explorar el repo para encontrar la causa raíz — no asumir, no fabricar un fix sin
  evidencia (mismo criterio que ya sigue `fix-e2e` en la práctica, ver log de
  `implement-slice #228` / `fix-e2e #228`).
- Si la información del issue no alcanza para reproducir o el reporte es ambiguo:
  comentar en el issue pidiendo la info que falta (`gh issue comment`) y no tocar
  código — deja la slice sin PR, así que el próximo tick la vuelve a intentar (mismo
  comportamiento de reintento sin límite que ya existe hoy para `implement-slice` cuando
  no llega a abrir PR; no se introduce un mecanismo nuevo para esto).
- Si el bug toca `apps/webapp`: agregar/actualizar un spec de Playwright bajo
  `apps/webapp/e2e/` y correrlo hasta que pase, dejando el output en
  `apps/webapp/test-results/` tal cual (mismo texto que ya usa `implement-slice`) — así
  el pipeline de evidencia (`evidence.ts`) encuentra screenshots para publicar cuando
  corresponde, sin ningún cambio en `evidence.ts` ni en `processSlicePr`.
- Un solo commit, push, y `gh pr create` con `Closes #<n>` en el body (para que GitHub
  cierre el issue automáticamente al mergear — ver ajuste de cierre más abajo) más una
  descripción de la causa raíz y el fix.
- No tocar labels del issue — eso lo sigue manejando el supervisor.

### Enrutamiento en `processIssue`

`TrackingIssue.labels` ya viene poblado por `listTrackingIssues` (`src/github.ts`), así
que no hace falta una llamada extra a la API: alcanza con mirar si el issue trae
`bugfix`.

```ts
function agentTaskFor(issue: TrackingIssue, sliceIndex: number, sliceTitle: string): AgentTask {
  return issue.labels.includes('bugfix')
    ? { type: 'fix-bug', issueNumber: issue.number, sliceIndex, sliceTitle }
    : { type: 'implement-slice', issueNumber: issue.number, sliceIndex, sliceTitle };
}
```

Reemplaza los dos call sites de `{ type: 'implement-slice', ... }` en `processIssue`
(arranque inicial y arranque en paralelo). Todo lo demás en `processIssue` /
`processSlicePr` queda sin cambios: son agnósticos a qué tarea abrió el PR.

### Cierre del issue: ajuste al gap de un tick

Como el PR dice `Closes #<n>`, GitHub cierra el issue apenas mergea. Hoy `processSlicePr`
solo marca `checked` la slice recién mergeada (`markSliceMerged`); la transición a
`valeria:done` pasa recién en el tick siguiente, cuando `processIssue` ve
`stack.length === 0` y confirma `!hasRemainingSlices`. Pero `listTrackingIssues` filtra
`--state open` — si el issue ya está cerrado para ese momento, nunca más aparece en esa
lista, y se queda con `valeria:in-progress` colgado para siempre (nunca llega a
`valeria:done`).

Fix: en `processSlicePr`, inmediatamente después de `markSliceMerged`, si
`!(await hasRemainingSlices(issue.number))`, llamar `setIssueState(issue.number, 'done')`
en el mismo tick, antes de retornar. Esto cierra el gap para bugs (issue ya cerrado por
GitHub) y además achica en un tick la latencia de `done` para specs normales (sin efecto
negativo: hoy ya queda en un estado "todo mergeado, esperando el próximo tick" que no
tiene ninguna otra lógica pendiente).

## Evidencia

Sin cambios en `evidence.ts`: `publishEvidence` ya busca screenshots en el worktree de
*cualquier* PR de un issue trackeado, sin distinguir su origen. Un bug de backend sin
Playwright no genera PNGs → `publishEvidence` devuelve `[]` → no se publica nada, que es
el comportamiento correcto ("evidencia cuando corresponda").

## Testing

`src/tick.test.ts` (ya existe desde el diseño de bottom-only-checks): agregar casos para
`discoverAssignedBugs` (issue nuevo con `bugfix` + label de runner → se le agrega la
sección de slices y pasa a `in-progress`; issue ya `valeria`-managed → se ignora) y para
el enrutamiento (`agentTaskFor` con label `bugfix` → `fix-bug`; sin la label →
`implement-slice`, comportamiento sin cambios). Caso para el ajuste de cierre: merge de
la única slice restante → `setIssueState('done')` se llama en el mismo tick, sin esperar
al siguiente.

`src/checklist.test.ts`: caso para el helper que agrega la sección `## Slices` a un body
existente sin sobreescribir el resto, y su idempotencia si se llama dos veces.

## Fuera de alcance

- Cualquier mecanismo de "confirmación humana extra" antes de que el agente empiece a
  tocar código — la combinación de labels (`bugfix` + `valeria:runner-<id>`) ya es la
  señal de "andá", mismo criterio que undraft en specs (descartado explícitamente por el
  usuario).
- Issues de bug que abarquen más de una slice — si un bug termina necesitando trabajo
  grande, la vía es reportarlo como spec, no forzar el flujo de bug a soportar slicing.
- Cualquier cambio a labels de `bmedical` (`bugfix` ya existe y se reusa tal cual, sin
  crear una label nueva — decisión explícita del usuario).
