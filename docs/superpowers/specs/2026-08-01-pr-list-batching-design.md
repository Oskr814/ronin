# Batch the per-tick PR reads behind a single `gh pr list` call

## Motivación

Retrospectiva del 2026-08-01: el mismo día se pisaron dos bugs (`mergePullRequest`'s
DELETE manual contra un branch que GitHub ya había borrado solo, y un `gh issue view`
con HTTP 499 dentro del propio path de escalación de `runIssueStep`) causados por la
misma raíz: cada llamada a `gh` es un punto independiente de falla transitoria, y hoy
`tick()` hace muchas más de las necesarias.

El patrón más caliente es `getOpenPrsForIssue` (`github.ts`): por cada issue en
progreso, hace `gh pr list` para encontrar los PRs del stack y después, por cada uno,
un `gh pr view` individual para leer su estado completo — un N+1 real que corre en
cada tick, para cada issue en progreso.

Motivación principal: **reducir la exposición a fallos transitorios** (menos llamadas
= menos superficie), no la latencia ni el rate limit — aunque ambos mejoran como
efecto secundario.

## Alcance

Solo el hot path de lectura por tick: `getOpenPrsForIssue` + el `getPullRequestStatus`
por PR que hace hoy internamente. Fuera de alcance:

- La relectura puntual de un PR individual en `processSlicePr` tras procesar una
  mención (necesita estado fresco post-push del agente, no tiene sentido batchearla).
- `getPullRequestStatus`/`listOpenPrsWithBase` dentro de `mergePullRequest` (mismo
  motivo: necesitan estado fresco justo antes de mergear).
- `getAttemptCount`/`incrementAttemptCount` y cualquier lectura de comments
  (`hasEvidenceComment`, `findUnprocessedMentions`) — quedan para una spec futura si
  hace falta.

## Diseño

### Hallazgo clave

`gh pr list --json` acepta el mismo set de campos que `gh pr view --json`
(`reviewDecision`, `statusCheckRollup`, `mergeable`, `headRefName`, `baseRefName`,
`isDraft`, etc. — confirmado con `gh pr list --json` sin argumentos, que lista los
campos válidos). No hace falta escribir una query GraphQL a mano: alcanza con pedirle
a `gh pr list` los mismos campos que hoy se piden uno por uno vía `gh pr view`.

### `listAllOpenValeriaPrs`

Nueva función en `github.ts`, reemplaza el rol I/O de `getOpenPrsForIssue`:

```ts
export async function listAllOpenValeriaPrs(): Promise<PullRequestStatus[]> {
  const stdout = await gh([
    'pr', 'list', '--state', 'open', '--limit', String(PR_LIST_LIMIT),
    '--json', 'number,state,reviewDecision,statusCheckRollup,mergeable,headRefName,baseRefName,isDraft',
  ]);
  const prs = (JSON.parse(stdout) as RawPr[]).filter((pr) => pr.headRefName.startsWith('valeria/'));
  if (prs.length === PR_LIST_LIMIT) {
    log.error(`listAllOpenValeriaPrs: alcanzó el límite de ${PR_LIST_LIMIT} — puede haber PRs no traídos, subir el límite o paginar`);
  }
  return prs.map(toPullRequestStatus);
}
```

`toPullRequestStatus` es la lógica de normalización (`checksPassing`/`checksPending`
derivados de `statusCheckRollup`, `mergeable === 'MERGEABLE'`, etc.) que hoy vive
inline dentro de `getPullRequestStatus` (`github.ts:199-223`) — se extrae a una
función privada compartida por `getPullRequestStatus` (single-PR, sigue existiendo tal
cual para los call sites fuera de alcance) y `listAllOpenValeriaPrs`, para no duplicar
esa derivación en dos lugares.

`PR_LIST_LIMIT` arranca en 300 (constante en `github.ts`, no config — no hay ninguna
razón operativa para tunearlo por entorno). El filtro por prefijo `valeria/` se aplica
client-side porque `gh pr list` no tiene un filtro nativo por prefijo de branch; el
repo del producto sí tiene PRs humanos ajenos a ValerIA mezclados en el mismo `--state
open`.

### `getOpenPrsForIssue` se vuelve pura

Pasa de hacer I/O a filtrar un array ya traído — mismo shape que ya usa
`toStackedPrs` en `stack.ts`, así que se mueve ahí:

```ts
// stack.ts
export function prsForIssue(allPrs: PullRequestStatus[], issueNumber: number): PullRequestStatus[] {
  const prefix = `valeria/${issueNumber}/`;
  return allPrs.filter((pr) => pr.headRefName.startsWith(prefix));
}
```

`processIssue` en `tick.ts` cambia de `toStackedPrs(await getOpenPrsForIssue(issue.number))`
a `toStackedPrs(prsForIssue(allPrs, issue.number))`, donde `allPrs` llega como parámetro
desde `tick()`.

### Cambio en `tick()`

```ts
export async function tick(): Promise<void> {
  log.info(`tick start (commit ${await currentCommit()})`);
  await discoverAssignedSpecs();
  await discoverAssignedBugs();

  const inProgress = await listTrackingIssues('in-progress');
  log.info(`${inProgress.length} issue(s) en progreso`);

  let allPrs: PullRequestStatus[];
  try {
    allPrs = await listAllOpenValeriaPrs();
  } catch (error) {
    // Falla compartida por todo el tick, no de un issue en particular — no
    // hay a quién culpar ni a quién bloquear. Mismo tratamiento que
    // ClaudeUsageLimitError: loguear y reintentar en el próximo tick, nunca
    // escalar a un humano por esto.
    log.info(`tick: listAllOpenValeriaPrs falló, reintentando en el próximo tick: ${(error as Error).message}`);
    return;
  }

  // ... resto del loop, pasando allPrs a processIssue en ambos passes
}
```

`processIssue` y `processSlicePr` reciben `allPrs` como parámetro adicional en vez de
volver a pedirlo.

### Manejo de errores — el trade-off de este enfoque

Con una sola llamada compartida, si falla, afecta a *todos* los issues del tick por
igual — antes, una falla en el `gh pr view` de un PR puntual solo afectaba a ese
issue via el try/catch de `runIssueStep`. Por diseño, esto es aceptable: se trata
igual que `ClaudeUsageLimitError` (transitorio, se resuelve solo, nunca bloquea a un
humano) y el próximo tick reintenta desde cero — ningún issue individual queda peor
que hoy, porque tampoco hoy un issue con esa llamada fallida avanzaba.

### Testing

`prsForIssue` (y el ajuste correspondiente en `toStackedPrs`'s test si aplica) es pura
— se testea igual que el resto de `stack.test.ts`, sin mocks de `gh`. `listAllOpenValeriaPrs`
queda sin test unitario directo, consistente con el resto de `github.ts` hoy (ninguna
de sus funciones que invocan `gh` tiene test — se validan con un dry run puntual antes
de mergear, mismo patrón que ya usa este repo). `tick.test.ts` se actualiza para pasar
un `allPrs` mockeado a `processIssue`/`processSlicePr` en vez de mockear
`getOpenPrsForIssue`.

## Archivos afectados

- `src/github.ts` — nueva `listAllOpenValeriaPrs`; `getOpenPrsForIssue` se elimina
  (su lógica de filtrado se muda a `stack.ts` como `prsForIssue`).
- `src/stack.ts` — nueva `prsForIssue` (pura).
- `src/tick.ts` — `tick()` hace el fetch único con manejo de error dedicado;
  `processIssue`/`processSlicePr` reciben `allPrs` por parámetro en vez de pedirlo.
- `src/tick.test.ts`, `src/stack.test.ts` — ajustados al nuevo shape.

## Fuera de alcance (posible spec futura)

Batchear `getAttemptCount`/`incrementAttemptCount` (hoy cada uno hace su propio `gh
issue view`) y las lecturas de comments (`hasEvidenceComment`,
`findUnprocessedMentions`) en el mismo `allPrs`/estado-por-tick si esta primera
iteración resulta insuficiente una vez medida con las métricas de tick propuestas por
separado.
