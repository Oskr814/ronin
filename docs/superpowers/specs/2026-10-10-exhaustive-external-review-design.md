# Review externa: exhaustiva en la primera pasada, incremental y verificable en las siguientes

## Contexto

La review automática de PRs externos (ver
`docs/superpowers/specs/2026-08-20-external-pr-review-design.md`) no converge:
la primera pasada postea un puñado de hallazgos, el autor corrige, el nuevo
`headRefOid` dispara otra corrida y aparecen hallazgos nuevos que podrían
haber salido antes. Además, los comentarios son caros de evaluar: aceptar o
descartar un hallazgo requiere leer prosa larga e investigar.

### Evidencia (PRs #746, #751, #753, #760 de `redmotos/shoppingcart`)

Rondas del bot con hallazgos: 7, 1, 5 y 6. De 35 hallazgos, 28 llegaron en la
ronda 2 o posterior. Clasificados por la línea anclada (±3) contra el delta
de cada ronda — heurística, aproximada cuando hay muchos desplazamientos:

| Hallazgo tardío | # | Ejemplos |
|---|---|---|
| Sobre código presente desde R1 (miss de la primera pasada) | 8 | límite de 200 filas sin paginar (#746), `CREATE INDEX` sin `CONCURRENTLY` (#753), `Task.Delay` en tests (#760) |
| Sobre código que entró después de R1, ya revisado en una ronda intermedia y no visto | 11 | 🔴 de R5/R6 (#760), `Update` devuelve 500 en vez de 400 (#753) |
| Sobre código cambiado en esa misma ronda | 9 | estado contradictorio tras el fix de R5 (#746) |

Patrones:

1. **La primera pasada no es exhaustiva** — un único `claude -p` con cinco
   dimensiones a la vez, sin exigencia de cobertura.
2. **Mecanismos revisados de a un agujero por ronda.** En #760, el lock +
   revalidación de crédito produjo un hallazgo distinto en R3, R4, R5 y R6,
   todos instancias de "no todo se revalida tras tomar el lock".
3. **Fixes que generan el próximo hallazgo, incluidos los de `/fix-comments`.**
   En #753, R2 sugirió extraer el nombre del índice a una constante;
   `/fix-comments` la usó también en la migración; R4 marcó como 🟠 que la
   migración no debe usar una constante, y `/fix-comments` volvió al literal:
   el bot se contradijo. En #746, el fix de `/fix-comments` a R5 introdujo el
   🟠 de R6.
4. **Re-levantar el mismo tema**: "200 filas" en R2 y R6 de #746.
5. **La regla de un commit no se cumple siempre**: #746 tiene 6 commits, #753
   mergea `odoo-main` dentro del branch (+25 líneas en `AuthService.cs`, +87
   en el XML vienen de main). Entre R4 y R5 de #760 el diff crudo era de 20
   archivos/+601 por un rebase; el cambio real del PR, 1 archivo/+4/−2.
6. **El cierre es engañoso y no deja SHA**: #751 recibió tres "LGTM 🚀", uno
   con un 🟠 todavía abierto; los LGTM son comentarios generales sin
   `commit_id`.

Sobre el formato de los 35 comentarios:

| Medida | Valor |
|---|---|
| Largo mediano | 3.100 caracteres |
| Porción que es el "Prompt para agentes de IA" | 52 % (repite explicación + sugerencia) |
| Visible sin expandir | solo título + línea de severidad |
| Sugerencias con código / con bloque `suggestion` | 0 / 0 |
| Sugerencias con alternativas ("Alternativamente…") | 5 |
| Mencionan que el comportamiento podría ser intencional, posteadas igual como defecto | 9 |
| Resueltos por un humano sin cambio de código, sin respuesta | 16 (46 %) |
| Aceptación según "Confianza" | Alta 59 %, Media 50 % — no predice nada |

Severidad inconsistente: un comentario con emoji 🟡 dice "Severidad:
Importante"; un bypass de validación de crédito figura como 🟠; un XML de
documentación mal formado, como 🟡.

## Objetivo

- Que la primera review saque en una sola corrida todo lo que razonablemente
  puede sacar, revisando mecanismos completos y no instancias sueltas.
- Que las re-reviews concentren el escrutinio en lo que cambió, y no levanten
  observaciones menores sobre código ya revisado.
- Que los fixes (de ronin o de quien sea) no generen la próxima ronda: las
  tareas de fix de ronin se revisan a sí mismas, y ninguna review contradice
  una sugerencia anterior del bot.
- Que cada hallazgo se pueda aceptar o descartar en segundos y con confianza:
  escenario concreto, evidencia enlazada, verificación ejecutada cuando es
  posible, fix aplicable con un clic.
- Que las reglas de convergencia vivan en código, no solo en el prompt.
- Que el criterio se pueda ajustar periódicamente sin tocar código, y que
  cada hallazgo deje datos para medir su utilidad.

## Decisiones

### Motor

- **El agente produce JSON; ronin valida y publica.** El agente de
  `external-review` deja de llamar `gh` para escribir: escribe un archivo
  `findings.json` (schema en §Diseño 4) en un directorio de salida fuera del
  worktree. El supervisor lo valida, aplica las reglas de alcance, renderiza
  los comentarios con un template fijo y publica la review, las resoluciones
  de threads y las respuestas a menciones. Mismo principio que el gate de
  `mergePullRequest`: la regla está en código. Esto reemplaza la decisión del
  spec anterior de que "quien publica es el propio `claude -p`".
- **Exhaustividad por subagentes, decidida en el prompt.** El agente lanza un
  subagente (tool `Agent`) por dimensión — correctitud/bugs,
  concurrencia/transacciones, seguridad, cobertura de tests,
  duplicación/smells —, luego consolida: deduplica, verifica contra el código
  y descarta lo que no se sostiene. El prompt exige enumerar todos los
  archivos del diff y no terminar sin cubrirlos. Cada subagente recibe la
  advertencia de contenido no confiable. Se descarta el fan-out de N
  `claude -p` desde el supervisor (más código, N× costo); se revisita si no
  alcanza.
- **Hallazgos sistémicos.** Cuando un hallazgo es instancia de una clase
  (carrera / check-then-act, validación que se puede saltear, input no
  revalidado tras un lock, chequeo de autorización faltante), el agente
  busca todas las instancias en el PR y reporta **un** hallazgo con todas las
  ubicaciones y el fix de fondo. Para un lock: enumerar todo lo que debe
  revalidarse tras tomarlo.

### Alcance y convergencia

- **Dos modos, decididos por el supervisor.** `full` cuando no hay review
  previa utilizable; `incremental` cuando la hay.
- **El último SHA revisado sale de GitHub.** Toda review del bot (incluido el
  cierre sin hallazgos) se publica como review formal con
  `commit_id = headSha`. El supervisor toma el `commit_id` de la última review
  del bot sobre el PR. `lastReviewedSha` en el local-state queda como caché.
  Si el commit no está localmente, `git fetch origin <sha>`; si falla,
  modo `full`.
- **El SHA revisado se ancla con un ref local** (`refs/ronin/reviewed/<n>`
  en `productRepoPath`) para que `git gc` no lo elimine tras un force-push;
  se borra cuando el PR deja de estar abierto.
- **Alcance por contenido, no por historial.** Para cada lado se calcula el
  diff del PR contra su propia base:
  `git diff $(git merge-base <baseRef> <sha>) <sha>`. Una línea agregada por
  el PR en `headSha` es **cambiada** si su contenido (normalizado: sin
  espacios al borde) no figuraba entre las líneas agregadas del mismo archivo
  en el diff del SHA revisado anterior; si figuraba, es **ya revisada**.
  Funciona igual con amend, varios commits, rebase o merges de main dentro
  del branch, y no se confunde con desplazamientos. Una línea del archivo que
  el PR no agrega (código de base) cuenta como ya revisada. Limitación: una
  línea idéntica movida a otro lugar cuenta como ya revisada aunque su
  contexto cambie — aceptable, el subagente de delta igual ve el contexto.
- **Regla de alcance, aplicada por el supervisor sobre el JSON.** Sobre
  líneas *ya revisadas* (y solo en modo `incremental`) se descartan los
  hallazgos 🟡 y todos los de tipo 🧹 Mejora. 🔴/🟠 de tipo 🐞 o ❓ pasan si
  traen escenario y evidencia (campos obligatorios). Recalculada sobre los
  cuatro PRs: elimina los 🟡 sobre código viejo y conserva todos los 🟠 que
  terminaron corregidos (`CONCURRENTLY`, límite de 200, regresión de
  `Update`). Se descartó "solo 🔴 sobre código ya revisado": habría ocultado
  esos tres. Se descartó también un tope de rondas: la regla anterior ya
  cubre el ruido que el tope buscaba cortar.
- **Escrutinio dirigido al delta.** En modo `incremental`, el supervisor pasa
  al agente la lista exacta de líneas cambiadas por archivo; el agente lanza
  un subagente dedicado a ese delta y a su interacción con el resto del
  código (funciones que lo contienen y sus callers).
- **Sin contradecirse.** El agente recibe todos sus threads previos en el PR
  — abiertos y resueltos —, con `path`, `line`, `originalLine`, `diffHunk`,
  `isOutdated`, cuerpo y, si existe, el motivo de descarte del humano. No
  re-levanta lo resuelto salvo regresión, y no propone lo contrario de una
  sugerencia anterior salvo 🔴 explicando por qué.
- **Dedupe mecánico.** El supervisor descarta un hallazgo nuevo con mismo
  `path`, misma categoría y línea a ≤5 de un thread abierto del bot.
- **Las menciones no tienen restricción de alcance.** Lo que una mención pide
  explícitamente se reporta aunque sea 🟡 sobre código ya revisado. Una
  corrida disparada solo por mención es `incremental` con delta vacío.

### Fixes que se revisan a sí mismos

- Las tareas que modifican código en respuesta a review — `fix-review`,
  `fix-comments`, `fix-comments-external` y `review-request` cuando aplica un
  cambio — reciben, después de aplicar sus cambios y antes de pushear, la
  instrucción de revisar su propio diff con el mismo archivo de criterio
  (`git diff` contra el HEAD previo a sus cambios): ¿introduce un bug?,
  ¿contradice el criterio o una sugerencia previa del bot en el PR? Si
  encuentra algo, lo corrige en el mismo pase; si no puede, lo dice en su
  respuesta al thread en lugar de pushear un fix que sabe incompleto.

### Formato del comentario

- **Lo necesario para decidir, visible sin expandir.** Título (el problema en
  una frase), Escenario ("dado X, cuando Y, pasa Z; se esperaba W"),
  Impacto (una línea), Evidencia (links a líneas exactas, incluidos tests o
  comentarios que lo contradigan), Verificación. Parte visible acotada a ~6
  líneas.
- **Tipo según la acción que pide**, en el título junto a la severidad:
  - 🐞 **Defecto** — escenario de falla concreto. Aceptar o descartar.
  - ❓ **Decisión** — el comportamiento puede ser intencional (un test, un
    comentario o el spec lo sugieren). Se redacta como pregunta sí/no, con
    "si es intencional, resolvé el hilo". Obligatorio cuando el agente
    encuentra evidencia de intencionalidad.
  - 🧹 **Mejora** — smell, duplicación, estilo. Opcional por definición.
- **"Confianza" se elimina; se reemplaza por "Verificación"**, observable:
  - **Comprobado** — el agente escribió un test, lo corrió sobre `headSha`, y
    falla mostrando el defecto. El test va en el comentario (colapsado) para
    que el autor lo incorpore.
  - **Razonado** — deducido leyendo el código.
- **Fix aplicable con un clic o nada.** Si el fix es local (≤10 líneas dentro
  del rango anclado), va como bloque ` ```suggestion `. Si no, un único fix
  concreto, sin alternativas; si hay más de un camino razonable, el hallazgo
  es ❓.
- **Prompt para IA compacto, al final y colapsado.** Se mantiene porque el
  bloque de código da botón de copiar, útil cuando no se usa
  `/fix-comments`. Lo renderiza el supervisor desde los mismos campos
  (ubicación, código afectado, escenario, fix) — no prosa nueva del modelo —,
  ~400–600 caracteres. Instruye al agente receptor a verificar el escenario
  antes de cambiar nada, y en un ❓, a preguntar antes.
- **Resumen en el cuerpo de la review** (hoy vacío): tabla
  tipo · severidad · título · link, y un único prompt copiable con todos los
  hallazgos de esa review, para atenderlos de una vez fuera de
  `/fix-comments`. Los hallazgos cuyo ancla no está en el diff del PR (la API
  los rechaza) se listan en el resumen en lugar de inline.
- **Severidad con pisos** definidos en el criterio: bypass de regla de
  negocio (crédito, permisos, precios) → 🔴; artefacto generado roto (XML,
  build) o cambio de contrato de API → ≥🟠. El supervisor fija el emoji desde
  el campo `severity`, sin posibilidad de inconsistencia.
- **Registro de la decisión, sin fricción.** 👍/👎 en el comentario, o
  resolver el thread; motivo opcional como respuesta de una línea. El
  supervisor lee reacciones y respuestas al construir el historial de
  threads (alimentan "no re-levantar" y el reporte periódico).
- **Cierre según el estado real**, siempre como review con `commit_id`:
  - sin hallazgos nuevos y sin threads del bot abiertos → "LGTM 🚀";
  - sin hallazgos nuevos, con threads abiertos → "Sin observaciones nuevas;
    quedan N abiertas" con links;
  - se resolvió algo y no queda nada abierto → "✅ Ajustes confirmados".

### Verificación con tests

- **Cuándo:** solo hallazgos 🐞 🔴/🟠, solo PRs que no son de un fork
  (`isCrossRepository === false`). El código de un PR de la misma org ya lo
  ejecuta CI, y su autor tiene push al repo — mismo criterio de confianza que
  `docs/superpowers/specs/2026-08-22-trusted-external-fix-comments-design.md`.
  En un fork nunca se ejecuta nada: todo queda como Razonado.
- **Cómo:** el agente escribe el test en el worktree (nunca se commitea ni se
  pushea), lo corre con el comando de tests del repo (el que documenten su
  README/AGENTS.md; los mismos que ya usan `implement-slice` y `fix-e2e`), y
  reporta el resultado en el campo `verification`.
- **Resultado:**
  - el test falla mostrando el defecto → **Comprobado**, test adjunto;
  - el test pasa → el hallazgo **se descarta** (el agente no lo incluye);
  - no es razonable escribir un test (p. ej. una carrera que requiere
    interleaving no determinista) o no se pudo correr → **Razonado**, con el
    motivo en una línea.
- **Presupuesto:** a lo sumo 3 verificaciones por corrida, priorizando 🔴,
  dentro de `agentTaskTimeoutMs`. Si se agota, el resto queda Razonado.
- El worktree ya se borra al final de cada `external-review`, así que los
  tests y artefactos de build no persisten.

### Criterio

- **Archivo versionado, solo en ronin**: `prompts/external-review-criteria.md`
  — dimensiones, definición de cada severidad con ejemplos, pisos de
  severidad, tipos, clases sistémicas a barrer, y "No marcar". Se lee en cada
  corrida desde `process.cwd()` (mismo patrón que
  `templates/tracking-issue.md`): cambiarlo no requiere `pnpm build`. Nunca
  se lee del repo destino. Lo usan tanto `external-review` como la
  auto-revisión de las tareas de fix.
- **El template del comentario no va en el criterio**: es contrato de salida,
  vive en código.
- **Marcador de metadata**, escrito por el supervisor (no por el modelo) al
  principio de cada comentario:

  ```html
  <!-- ronin:finding v=2 type=<bug|decision|improvement> severity=<critical|important|minor> category=<…> verification=<verified|reasoned> mode=<full|incremental> scope=<changed|reviewed> criteria=<blob hash> -->
  ```

  `criteria` es el hash de blob git del archivo de criterio usado.

## Diseño

### 1. `prompts/external-review-criteria.md` (nuevo)

Contenido inicial: el criterio que hoy está inline, migrado, más lo que este
spec agrega:

- **Dimensiones**: una sección por subagente (correctitud/bugs,
  concurrencia/transacciones, seguridad, cobertura de tests,
  duplicación/smells), con qué buscar.
- **Tipos** 🐞/❓/🧹 y cuándo usar cada uno (❓ obligatorio ante evidencia de
  intencionalidad).
- **Severidad** con ejemplos y pisos.
- **Clases sistémicas** a barrer completas.
- **No marcar**: arranca con lo aprendido de los cuatro PRs — p. ej. "no
  sugerir constantes compartidas dentro de migraciones: las migraciones son
  snapshots inmutables y usan literales".

### 2. `src/github.ts`

- `fetchReviewThreads(prNumber)` reemplaza a `fetchOpenReviewThreads`: trae
  todos los threads con `isResolved`, `isOutdated`, `path`, `line`,
  `originalLine`, `diffHunk`, comentarios (autor, cuerpo) y reacciones del
  primer comentario. `listBotOpenReviewThreads` /
  `listExternalOpenReviewThreads` filtran sobre eso, sin cambio de
  comportamiento. Nueva `listBotReviewThreads(prNumber, botLogin)` con todos
  (abiertos y resueltos) para el historial. `ReviewThread` suma los campos
  nuevos como opcionales.
- `getLastBotReviewSha(prNumber, botLogin)` — `commit_id` de la última review
  del bot.
- `postReview(prNumber, { commitId, body, comments[] })` — `POST
  pulls/{n}/reviews`, `event: COMMENT` hardcodeado (nunca otro valor), con
  `line`/`start_line`/`side` por comentario.
- `resolveReviewThread(threadId)`, `replyToReviewComment(commentId, body)` y
  reuso de lo existente para comentarios generales.

### 3. `src/review-scope.ts` (nuevo)

Lógica pura + `git`, separada de `tick.ts` y `github.ts` (mismo criterio que
`mentions.ts`):

- `prAddedLines(sha, baseRef): Map<path, Set<normalizedLine>>` y
  `prAddedLineNumbers(sha, baseRef): Map<path, Set<number>>` desde
  `git diff -U0 $(git merge-base baseRef sha) sha`.
- `classifyLines(prevSha, headSha, baseRef): Map<path, Set<number>>` — números
  de línea en `headSha` que son *cambiados* según la regla de contenido.
- `applyScopeRules(findings, changedLines, mode, mentionIds)` — devuelve los
  hallazgos a publicar y los descartados (con motivo, para el log y la
  métrica).
- `dedupeAgainstOpenThreads(findings, openThreads)`.
- `isAnchorInDiff(finding, prAddedLineNumbers, diffHunks)` — decide inline vs
  resumen.

### 4. Contrato `findings.json`

```ts
interface ExternalReviewOutput {
  findings: Array<{
    path: string;
    line: number;
    startLine?: number;            // multi-línea, para suggestion
    type: 'bug' | 'decision' | 'improvement';
    severity: 'critical' | 'important' | 'minor';
    category: string;
    title: string;                 // ≤ 120
    scenario: string;              // ≤ 400, obligatorio salvo improvement
    impact: string;                // ≤ 200
    evidence: Array<{ path: string; line: number; note: string }>;
    verification: { status: 'verified' | 'reasoned'; reason?: string; test?: { path: string; code: string; output: string } };
    suggestion?: { kind: 'replace'; code: string } | { kind: 'text'; text: string };
    affectedCode: string;          // snippet para el prompt de IA
    extraLocations?: Array<{ path: string; line: number }>; // hallazgos sistémicos
    detail?: string;               // ≤ 1500, colapsado
    mentionId?: number;            // si responde a lo que pidió una mención
  }>;
  resolveThreads: Array<{ threadId: string; reason: string }>;
  mentionReplies: Array<{ commentId: number; kind: 'issue' | 'review'; body: string }>;
}
```

Validación a mano (sin dependencia nueva): campos obligatorios, enums, largos
máximos (se truncan con "…"), `path` existente en el worktree, `line` dentro
del archivo, `suggestion.kind === 'replace'` solo si `line - startLine ≤ 10`
y el rango está en el diff. Un JSON inválido o ausente es un fallo de la
tarea (log, status `error`, reintento el próximo tick, igual que hoy). Un
hallazgo individual inválido se descarta con log, sin tirar el resto.

### 5. `src/agent-task.ts`

- `loadReviewCriteria(): Promise<{ text; blobHash }>` — lee el criterio,
  calcula el hash de blob git sin shell-out. Archivo ausente → la tarea
  falla.
- Variante `external-review` suma `mode`, `changedLines?`,
  `threadHistory: ReviewThread[]`, `canExecute: boolean`, `outputPath`.
- Prompt reescrito: criterio cargado; subagentes por dimensión con la
  advertencia de no confiable; cobertura obligatoria; hallazgos sistémicos;
  en `incremental`, la lista de líneas cambiadas y el subagente de delta; el
  historial de threads con la regla de no contradecir; verificación con
  tests solo si `canExecute`; el contrato de `findings.json` y la ruta donde
  escribirlo; prohibido escribir en GitHub (sin `gh pr comment`, `gh api
  …/reviews`, ni mutaciones GraphQL) — solo lectura.
- `renderFindingComment(finding, ctx)`, `renderReviewSummary(findings, ctx)`
  y `renderAgentPrompt(finding | findings[])` — templates fijos, con el
  marcador.
- Bloque de auto-revisión agregado a los prompts de `fix-review`,
  `fix-comments`, `fix-comments-external` y `review-request` (rama de
  aplicar cambios), con el criterio cargado.

### 6. `src/external-review.ts` y `src/worktree.ts`

- `ReviewCandidate` suma `previousSha?`, `threadHistory`, `isCrossRepository`.
  `findPrsNeedingReview` resuelve `previousSha` desde
  `getLastBotReviewSha` (caché: `lastReviewedSha`), asegura que el commit
  esté (`isCommitAvailable`, si no `git fetch origin <sha>`), y si no lo
  logra deja el candidato en modo `full` con un `log.info`.
- `worktree.ts`: `isCommitAvailable(sha)`, `fetchCommit(sha)`,
  `pinReviewedSha(n, sha)`, `unpinReviewedSha(n)`. El prune existente también
  desancla.

### 7. `src/tick.ts` — `processExternalReviewCandidate`

1. Calcula `mode` y, en `incremental`, `changedLines` (`review-scope.ts`).
2. `runAgentTask` con `outputPath` en un directorio propio de ronin, fuera
   del worktree.
3. Lee y valida `findings.json`.
4. `applyScopeRules` + `dedupeAgainstOpenThreads`; log de lo descartado.
5. Resuelve threads, publica la review (inline + resumen + cierre según
   estado), responde menciones.
6. `setLastReviewedSha` + `pinReviewedSha`. Un fallo de `pin` se loguea sin
   marcar la review como fallida.

Mismo aislamiento por candidato que hoy: nada de esto alcanza el catch de
`tick()`.

## Testing

- `review-scope.ts`: clasificación por contenido con fixtures que cubran
  amend, varios commits, rebase sobre main que avanzó, merge de main dentro
  del branch y líneas desplazadas; `applyScopeRules` (🟡 y 🧹 sobre
  ya-revisado descartados en `incremental`, conservados en `full` y cuando
  los pide una mención; 🔴/🟠 sin escenario descartados); dedupe; anclas
  fuera del diff → resumen.
- Validación de `findings.json`: JSON ausente/inválido → la tarea lanza;
  hallazgo individual inválido → descartado; truncado de largos;
  `suggestion` fuera de rango → degradada a texto.
- Render: snapshot del comentario para cada tipo/verificación; emoji
  derivado de `severity`; marcador correcto; prompt compacto con ubicación,
  código, escenario, fix e instrucción de verificar primero; resumen con
  tabla y prompt combinado; los tres cierres.
- `github.ts`: `postReview` siempre con `event: COMMENT`;
  `getLastBotReviewSha`; `fetchReviewThreads` y filtros sin cambio de
  comportamiento.
- `external-review.ts` / `tick.ts`: modo `full` sin review previa o sin el
  commit; `incremental` con él; `canExecute` false en forks; pin solo tras
  éxito.
- `agent-task.ts`: el prompt de `external-review` incluye criterio,
  contrato, ruta de salida y prohibición de escribir en GitHub; verificación
  con tests solo con `canExecute`; los cuatro prompts de fix incluyen la
  auto-revisión.

### Validación antes de activar (dry-run)

Flag `EXTERNAL_REVIEW_DRY_RUN=1`: corre todo hasta el paso 4 y escribe el
render en un archivo en vez de publicar. Corridas sobre los PRs analizados:

1. **Primera pasada**: `full` sobre `62b66af` (#746) y `be8d2ad` (#753).
   Éxito si aparecen el límite de 200 filas y `CONCURRENTLY` (ambos misses de
   R1 que terminaron corregidos).
2. **Mecanismo completo**: `full` sobre `6de59df` (#760). Éxito si un
   hallazgo sistémico cubre el lock + revalidación (cliente,
   `IgnoreCreditLimit`, líneas) en vez de uno solo.
3. **Alcance**: `incremental` sobre cada par de rondas consecutivas de los
   cuatro PRs; comparar contra la tabla de §Evidencia. Éxito si ningún 🟡
   sobre código ya revisado se publica y los 🟠 corregidos siguen saliendo.
4. **Auto-revisión de fix**: re-ejecutar el fix de R2 de #753 en un worktree
   descartable. Éxito si no introduce la constante en la migración.
5. **Formato**: revisar a mano los comentarios renderizados — decidir cada
   uno sin expandir nada.

## Fuera de alcance

- La regla de un commit por PR y la estrategia de rebase de stacks
  (`--onto` / `--update-refs`, fixups) — follow-up en su propio spec.
- Criterio por repo destino — se revisita si un repo necesita convenciones
  propias.
- Reporte periódico de calidad (aceptados, descartados, ignorados, tardíos,
  👍/👎, por versión de criterio) — follow-up, con algunas semanas de datos
  del marcador.
- Ajuste asistido del criterio y set de regresión permanente (los dry-runs de
  arriba son la semilla).
- Correr el agente de `external-review` sin `GH_TOKEN` de escritura: este
  diseño lo habilita (el agente ya no escribe en GitHub), pero requiere
  plumbing de env en `runClaudeHeadless`.
- Modo incremental para `review-request` sobre PRs propios de ronin.
- Fan-out de N corridas desde el supervisor.
