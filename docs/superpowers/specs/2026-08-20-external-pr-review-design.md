# Review automática (estilo Copilot) de PRs externos

## Contexto

Hoy `tick.ts` solo procesa PRs que ronin abrió (`listAllOpenRoninPrs`, filtrado
por `headRefName.startsWith('ronin/')`) — los PRs de humanos u otros bots en
`PRODUCT_REPO` son invisibles para el pipeline. `config.requestCopilotReview`
existe pero solo *pide* la review real de GitHub Copilot vía API para los PRs
propios de ronin; no simula una revisión de código nueva.

Este feature agrega un flujo independiente: cada vez que un PR abierto,
no-draft, **que ronin no abrió**, recibe cambios (nuevo `headRefOid`), un
agente corre una revisión de código estilo Copilot (duplicación, code
smells, código sin cobertura de test, bugs, riesgos de seguridad) y postea
los hallazgos como comentarios inline en una review formal — nunca
`APPROVE` ni `REQUEST_CHANGES`, mismo principio de "autor y aprobador nunca
son la misma identidad" que ya rige `review-request` (ver
`docs/superpowers/specs/2026-07-28-mention-review-design.md`).

`tick.ts` es 100% polling (§9/§3 del diseño, sin webhook expuesto) — este
feature se mantiene consistente con eso: detecta "recibió cambios"
comparando el `headRefOid` actual contra el último SHA revisado, guardado en
el local-state por-repo que ya usa `checksPendingCounts`.

## Objetivo

Que cualquier PR externo (no abierto por la cuenta `ronin`) reciba,
automáticamente y sin intervención humana, una revisión de código en cada
tick donde su HEAD cambió — con la misma profundidad que se espera de un
reviewer humano (acceso al repo completo, no solo el diff), con los
hallazgos posteados como comentarios inline reutilizables (resolubles) en
corridas subsiguientes, y sin nunca bloquear el merge por su cuenta.

## Decisiones

- **Alcance**: todo PR abierto y no-draft de cada repo en `repos.json`
  (`activeRepo().productRepo`), sin importar quién lo abrió — excepto los de
  la propia cuenta `ronin` (`author.login === config.githubLogin`). A
  diferencia de `listAllOpenRoninPrs`, no filtra por prefijo de branch: acá
  el universo relevante es justamente "todo lo que ronin no abrió".
- **PRs en draft se ignoran**: mismo criterio que el resto del pipeline —
  mientras el PR siga en draft, no se revisa. Al salir de draft con el mismo
  SHA que ya tenía, se revisa igual (nunca se marcó como revisado estando en
  draft).
- **Trigger = cambio de `headRefOid`**: sin webhook. En cada tick, si el SHA
  actual del PR difiere del último guardado en `lastReviewedSha[prNumber]`
  (o no hay entrada previa), se dispara una nueva corrida. Un PR sin cambios
  desde la última revisión no vuelve a correr.
- **Motor: worktree completo, no solo el diff**: evaluar "duplicación" y
  "código sin cobertura de test" con calidad requiere ver el resto del
  repo, no solo el diff en texto plano — sin eso, el modelo no puede saber
  si ya existe código equivalente en otro archivo o si otro test ya cubre
  el path tocado. Mismo patrón que `review-request`:
  `ensureWorktree(pr.headRefName)`.
- **Posteo: review formal con comentarios inline** (`event: COMMENT`), no
  comentarios generales sueltos — necesario para poder resolver
  automáticamente (`resolveReviewThread`) los hallazgos ya atendidos en
  corridas subsiguientes, algo que la API de GitHub solo soporta para
  comentarios de review (`pulls/comments`), no para comentarios generales
  (`issues/comments`).
- **Taxonomía fija**: severidad {Crítico🔴, Importante🟠, Menor🟡} × confianza
  {Alta, Media, Baja}; categoría es texto libre elegido por el modelo según
  el hallazgo (Bug, Seguridad, Duplicación, Cobertura, Code smell, etc.).
  Template igual al que ya usa el equipo para este tipo de reviews (header
  con emoji+severidad, línea Confianza/Severidad/Categoría, y tres
  collapsibles: explicación, sugerencia, prompt para agentes de IA) — sin la
  sección "Ubicación" en el body (redundante: el comentario ya está anclado
  a archivo/línea) y sin el footer de pipeline/CI que no aplica acá.
- **Resolución de threads previos**: antes de postear hallazgos nuevos, el
  agente recibe la lista de threads del bot aún abiertos en ese PR
  (`author.login == config.githubLogin`, `isResolved == false`, vía
  GraphQL `reviewThreads`) con su `threadId` y body. Para cada uno que el
  diff actual ya no amerita, llama `resolveReviewThread(threadId)`. El
  agente decide esto con el mismo criterio que cualquier reviewer humano —
  no hay heurística separada en código: la evaluación de "¿sigue
  aplicando?" vive en el prompt, igual que la generación de hallazgos
  nuevos.
- **Mensaje de cierre sin hallazgos nuevos**: si tras resolver threads no
  queda ningún hallazgo nuevo que postear:
  - Si había threads previos que se acaban de resolver → comentario general
    breve: "✅ Ajustes confirmados, no quedan observaciones pendientes."
  - Si no había ningún thread previo abierto (primera pasada limpia, o ya
    estaba todo resuelto de antes) → comentario general breve: "LGTM 🚀"
- **Nunca `APPROVE` ni `REQUEST_CHANGES`**: la review siempre se postea con
  `event: COMMENT`, sin importar la severidad de lo encontrado — un bot no
  tiene poder de gate sobre el merge.
- **Falla local, no bloquea el tick**: un error en la corrida (excepción,
  timeout de `claude -p`, fallo de `gh`) se loguea y se ignora a nivel de
  ese PR — no dispara `notifyBlocker`, no pone ningún issue en `blocked`, y
  no propaga al `try` grande de `tick()`. Sin guardar `headSha` en el
  local-state, así que el próximo tick lo vuelve a levantar como no
  revisado. Sin límite de reintentos (mismo trade-off aceptado que
  `review-request`).
- **Opt-in**: ninguno — corre siempre que haya un repo configurado en
  `repos.json`, sin flag adicional (a diferencia de
  `REQUEST_COPILOT_REVIEW`).
- **Concurrencia**: corre bajo `runWithConcurrency` con el mismo
  `config.tickConcurrency` que el loop de issues, en paralelo con ese loop
  (son PRs disjuntos: unos son de ronin, estos no).

## Diseño

### 1. `src/github.ts`

Funciones nuevas:

- `listAllOpenExternalPrs(): Promise<ExternalPr[]>` — `gh pr list --state
  open --json number,isDraft,headRefName,headRefOid,author --limit
  <PR_LIST_LIMIT>`, filtrado client-side a `!pr.isDraft && author.login !==
  config.githubLogin`. Tipo nuevo, separado de `PullRequestStatus` (no
  necesita `mergeable`/`reviewDecision`/checks — esos campos son del loop
  de issues):

  ```ts
  export interface ExternalPr {
    number: number;
    headRefName: string;
    headRefOid: string;
  }
  ```

- `listBotOpenReviewThreads(prNumber: number): Promise<ReviewThread[]>` —
  `gh api graphql` contra `reviewThreads(first: 100) { nodes { id
  isResolved comments(first: 1) { nodes { author { login } body } } } }`
  del PR, filtrado a `!isResolved && comments.nodes[0].author.login ===
  config.githubLogin`. `ReviewThread` es `{ id: string; body: string }`.

No hace falta una función de posteo de review ni de `resolveReviewThread`
acá: igual que `review-request`, quien publica la review y resuelve threads
es el propio `claude -p` corriendo en su worktree, vía `gh` /
`gh api graphql` directo. El supervisor solo descubre elegibilidad y trackea
el SHA revisado.

### 2. `src/local-state.ts`

Nuevo campo en `LocalState`:

```ts
lastReviewedSha: Record<string, string>; // PR number -> headRefOid revisado
```

Con su getter/setter (`getLastReviewedSha` / `setLastReviewedSha`), mismo
patrón que `incrementChecksPendingCount`/`resetChecksPendingCount` (lock vía
`withLocalStateLock`). Default `{}` si falta en el JSON existente (backward
compat, igual que los otros campos).

### 3. `src/agent-task.ts`

Nueva variante:

```ts
| { type: 'external-review'; prNumber: number; headSha: string; openThreads: ReviewThread[] }
```

Prompt: instruye a `claude -p` a

1. Leer el diff (`gh pr diff <n>`) con el repo completo disponible en el
   worktree (`ensureWorktree(pr.headRefName)`, igual que `review-request`).
2. Evaluar duplicación, code smells, código sin cobertura de test, bugs y
   riesgos de seguridad.
3. Para cada uno de `openThreads`: decidir si el diff actual ya lo resuelve;
   si sí, `gh api graphql` con la mutación `resolveReviewThread(threadId)`.
4. Si hay hallazgos nuevos: postear una review
   (`gh api repos/{owner}/{repo}/pulls/{n}/reviews`, `event: COMMENT`) con
   un comentario inline por hallazgo, template exacto (ver Decisiones),
   taxonomía fija de severidad/confianza, categoría libre.
5. Si no hay hallazgos nuevos: postear un único comentario general — el
   texto de confirmación o "LGTM 🚀" según si se resolvió algo en el paso 3
   (ver Decisiones).
6. Explícito en el prompt: **nunca `APPROVE` ni `REQUEST_CHANGES`**, sin
   importar la severidad. No tocar labels, no tocar el body del PR/issue.

### 4. `src/external-review.ts` (nuevo módulo)

Mismo criterio que `mentions.ts`: lógica de negocio separada de `tick.ts`
(orquestador) y de `github.ts` (capa baja contra `gh`).

```ts
export interface ReviewCandidate {
  prNumber: number;
  headRefName: string;
  headSha: string;
  openThreads: ReviewThread[];
}

export async function findPrsNeedingReview(): Promise<ReviewCandidate[]>
```

Combina `listAllOpenExternalPrs()` con `lastReviewedSha` del local-state:
devuelve solo los PRs cuyo `headRefOid` difiere del último guardado (o sin
entrada previa), cada uno ya con sus `openThreads` resueltos vía
`listBotOpenReviewThreads` (solo para los candidatos, no para todo PR
listado — evita la llamada GraphQL extra en el caso común de "sin cambios
nuevos").

### 5. `src/tick.ts`

Dentro de `tickOneRepo()`, después del loop de issues existente:

```ts
const reviewCandidates = await findPrsNeedingReview();
await runWithConcurrency(reviewCandidates, config.tickConcurrency, async (candidate) => {
  try {
    await runAgentTask({
      type: 'external-review',
      prNumber: candidate.prNumber,
      headSha: candidate.headSha,
      openThreads: candidate.openThreads,
    });
    await setLastReviewedSha(candidate.prNumber, candidate.headSha);
  } catch (error) {
    log.error(`external-review failed for PR #${candidate.prNumber}`, error);
    // Sin guardar el SHA → el próximo tick lo vuelve a levantar como no revisado.
  }
});
```

Try/catch local por candidato, fuera del `try` grande que rodea el loop de
issues — una falla acá no debe poner ningún issue en `blocked` ni abortar
el resto del tick.

## Testing

- `findPrsNeedingReview`: unit tests con fixtures de `gh pr list` — cubrir
  exclusión de draft, exclusión de autor `ronin`, exclusión de SHA sin
  cambios, inclusión de PR nuevo sin entrada previa en local-state, y que
  `listBotOpenReviewThreads` solo se llama para los candidatos elegibles.
- `local-state.ts`: test de `getLastReviewedSha`/`setLastReviewedSha`
  round-trip y de default `{}` cuando el campo falta en el JSON existente.
- `tickOneRepo`: test del paso nuevo con `runAgentTask`/`setLastReviewedSha`
  mockeados — confirmar que guarda el SHA solo tras éxito, y que una
  excepción no propaga hacia el catch de `tick()`.
- Sin e2e — no hay UI involucrada; el template de comentario no se
  snapshot-testea acá (vive enteramente en el prompt, no en código
  estructurado).

## Fuera de alcance

- Opt-in vía env var — corre siempre que haya `repos.json` configurado.
- Exclusión de otros bots aparte de `ronin` (ej. dependabot) — si en la
  práctica generan ruido, es una config nueva a agregar después.
- Límite de reintentos / escalamiento a humano si un PR nunca logra
  revisarse (mismo trade-off ya aceptado y documentado en
  `2026-07-28-mention-review-design.md`).
- Resolución de threads que el propio autor humano marcó como resueltos
  manualmente — el agente solo actúa sobre threads que abrió él mismo
  (filtro `author.login == config.githubLogin`).
