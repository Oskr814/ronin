# Diseño

## Problema

El flujo actual para implementar un spec es esencialmente manual más allá de la generación de código:

1. El spec se crea y depura a mano (bien que sea manual — requiere criterio humano).
2. La implementación se hace "one-shot": un agente ejecuta el spec completo en una sola sesión, produciendo PRs de +100 archivos y +1000 líneas — imposibles de revisar bien.
3. Cualquier corrección de diseño/estándar detectada en review vuelve a requerir iteración manual.
4. La parte visual (Claude Design → implementación) es la más difícil de monitorear y garantizar.
5. Si se agota la cuota de Claude, el trabajo se detiene hasta reanudar manualmente.

## Principios de diseño

- **Nunca una sesión continua.** Cada unidad de trabajo (plan, slice, fix de review) corre en una sesión de Claude nueva, para no degradar la ventana de contexto. La continuidad entre sesiones no vive en la memoria del agente, vive en estado externo verificable.
- **GitHub como máquina de estados.** No se construye una base de datos propia para trackear progreso. El estado real de un spec es el estado de su issue/PRs en GitHub. Esto hace que "reanudar tras un corte de cuota" no sea un caso especial — es simplemente la siguiente vuelta del loop leyendo el mismo estado.
- **Autonomía en el descubrimiento, no en el criterio de merge.** El agente decide solo cómo trocear un spec, pero **los PRs de slice los mergea un humano**: ronin no mergea uno por su cuenta, ni siquiera aprobado y con el CI en verde, y se entera del merge en el tick siguiente. Hay tres excepciones, y en ninguna decide ronin: el PR del spec, que se mergea al marcarlo *ready for review* porque es documentación (§1); el PR de exploración, al aprobarlo (§11.7); y un PR al que un humano le puso `ronin:auto-merge` (§13). Las dos últimas pasan por `mergePullRequest`, que lanza sin approval explícito. Este gate no es negociable.
- **La revisión humana se mantiene, pero en PRs pequeños.** El review sigue siendo manual (técnica de stacked PRs), la mejora es que cada PR sea revisable en minutos, no horas.

## Arquitectura

### 1. Descubrimiento de specs

El spec se escribe como un **PR draft contra el repo del producto** (ej. `bmedical`), con el archivo `.md` en `docs/superpowers/specs/` — sin frontmatter, un doc markdown normal, igual que los specs ya existentes en el repo.

Flujo:

1. El humano escribe el spec, abre el PR **en draft** y lo asigna a la cuenta de ronin (`RONIN_GITHUB_LOGIN`) con el picker de Assignees de GitHub. Mientras está en draft, el agente lo ignora por completo: el humano puede seguir iterando el contenido sin que nada dispare.
2. Cuando el spec está listo, el humano lo marca **ready for review** (sin necesidad de aprobación — undraft es la señal de "andá"). Esta es la única señal que importa; no hace falta más.
3. El runner detecta el PR (abierto, no-draft, asignado a su cuenta y sin un label de estado `ronin:in-progress`/`done`/`blocked` — ver `listAssignedSpecPrs` en `github.ts`), lo marca `ronin:in-progress` antes de cualquier otra cosa, lo mergea (sin el gate de approval que aplica a PRs de implementación — es documentación, no código de producto, y el humano ya señaló que está listo con la asignación + el undraft), y a partir de ahí sigue el flujo normal: crear issue de tracking, plan, slicing.

Por qué asignación manual y no descubrimiento automático: nada arranca hasta que un humano asigna el PR y lo saca de draft, así que ronin nunca toma un spec a medio escribir ni uno que nadie le pidió. Lo que la asignación no resuelve es el caso de dos PRs que describen lo mismo: se procesan como dos specs distintos, y eso es un problema de proceso humano, no una condición de carrera en el código (§9).

**Variante: issues asignados directamente.** Cualquier issue ya existente en el
repo del producto, asignado a la cuenta `ronin` (Assignees nativo de GitHub —
ver `listAssignedIssues` en `github.ts`), se toma con la misma señal de
asignación manual que un spec PR, pero sin paso de draft/ready (un issue de
GitHub no tiene estado draft) y sin requerir ningún label en particular — ya
no hace falta la label `bugfix`, un humano puede asignar cualquier bug o
pedido de cambio chico. A diferencia de un spec, no se crea un issue de
tracking espejo — el issue pasa a ser directamente la unidad de tracking,
sembrado con un checklist mecánico de una sola slice para que el resto del
motor (merge gate, ciclos `fix-review`/`fix-e2e`) lo trate igual que la
tracking issue de un spec (ver `discoverAssignedIssues` y `agentTaskFor` en
`tick.ts`, que distinguen esta ruta de la de specs por la label interna
`ronin:issue-fix`, no por algo puesto por un humano).

Como ya no hay una label humana curando qué issues son "chicos y accionables",
el propio agente (tarea `fix-issue`, ver `agent-task.ts`) juzga la claridad del
issue como parte de la misma corrida: si no tiene contexto suficiente para
actuar sin adivinar, comenta en el issue pidiendo lo que falta y termina su
respuesta con la línea `RONIN_STATUS: needs-info` en vez de abrir un PR
(`RONIN_STATUS: done` si sí lo abrió). El supervisor lee ese marcador
(`needsMoreInfo` en `tick.ts`) y marca el issue `ronin:blocked` cuando el
agente se abstuvo — sin esto, el issue quedaría reintentándose sin límite en
cada tick. Ver
[`docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md`](superpowers/specs/2026-07-28-bug-issue-intake-design.md)
(diseño original, desde entonces generalizado de "solo bugs" a cualquier issue asignado).

### 2. Mapeo a GitHub

- 1 spec → 1 issue de tracking, con checklist de slices (generado por el paso de planning).
- 1 slice → 1 PR. Por default **secuencial**: la siguiente slice recién arranca cuando no queda ningún PR abierto del issue (la anterior ya mergeó). Con el label `ronin:stack-prs` en el issue de tracking, **apilado**: cada PR se abre con `--base` el branch de la slice anterior, sin esperar a que mergee — ver [`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`](superpowers/specs/2026-07-28-stacked-prs-design.md) para el rationale completo.
- **Linear (#101):** si el issue de tracking tiene el comentario de Linear (`<!-- linear-linkback -->`, de su bot), el supervisor agrega a la descripción de cada PR de slice `Part of RED-n`, o `Fixes RED-n` en la última slice, sobre la chuleta de comandos (`core/linear.ts`, en `processSlicePr`). Así Linear muestra los PRs en su issue y las automatizaciones del equipo lo mueven de estado. No necesita API key; un issue sin ese comentario no se toca. El tablero muestra `RED-n ↗` junto a *GitHub ↗* en la ficha. Con API key de Linear, además: proyecto y ciclo en el tablero (§15.13) y **prioridad por ciclo**: en el tick (no en los eventos), los issues del ciclo actual del equipo van primero en la cola de jobs (`cycleFirst` en `tick.ts`), así que si no alcanzan los lugares (`TICK_CONCURRENCY`) los toman antes; cada grupo en su orden de siempre. Si Linear falla, el orden queda como estaba.
- **Proyecto de los issues que abre ronin (#101, `core/linear-assign.ts`).** El issue se crea en GitHub como siempre y la asignación queda pendiente en el estado local (`linearPending`). Cada tick la aplica cuando la sincronización ya creó el issue en Linear, y la descarta si no aparece en un día.
  - **Desde la exploración** (las fichas aprobadas y "Pedir un issue aparte"): al proyecto de la app, que se configura en `repos.json` (`"linear": { …, "explorationProject": { "backoffice": "<nombre o id>" } }`).
  - **El issue de tracking de un spec:** el proyecto del issue del que salió el spec (la rama del PR es `ronin/<issue>/spec`).
  - En los dos casos, solo si el issue todavía no tiene proyecto en Linear. Un error se reintenta hasta 5 veces.
- Estado inferido de GitHub, no de memoria del agente:
  - branch existe → spec empezado
  - PR abierto → slice en curso (con `ronin:stack-prs`, pueden ser varios PRs de un mismo issue abiertos a la vez, cada uno una slice apilada sobre la anterior; sin el label, a lo sumo uno)
  - comentarios sin resolver → ciclo de fix
  - PR **approved** y en verde → espera a que un humano lo mergee; al tick siguiente ronin marca la slice como mergeada (`syncMergedSlices`), mueve a su base los PRs apilados encima y, si era la última, pasa el issue a `done`
  - Sin `ronin:stack-prs`: la siguiente slice recién arranca cuando el stack queda vacío. Con `ronin:stack-prs`: un PR abierto (aunque no esté mergeado) ya dispara la siguiente slice apilada encima. ronin no rebasea ningún PR contra `main`: si hace falta ponerlo al día, lo hace el humano que mergea (p. ej. con "Update branch" de GitHub). Solo vigila que el PR de menor índice apunte a `main` después del retarget

### 2.1 Template del issue de tracking

El body lo genera el agente a partir de [`templates/tracking-issue.md`](../templates/tracking-issue.md): un link al spec, un checklist de slices (una línea por slice, con el PR asociado apenas se abre), y una sección de bloqueo que solo se llena cuando aplica.

El estado en sí **no se infiere parseando el body** — vive en labels, que son consultables directamente vía `gh issue list --label`:

- `ronin` — marca el issue como gestionado por el agente (para poder filtrar sin ambigüedad entre issues del repo).
- `ronin:ready | ronin:in-progress | ronin:blocked | ronin:done` — estado actual, mutuamente excluyente, la swap-ea el supervisor (`setIssueState`). El PR del spec usa los mismos labels mientras se procesa (§1).
- `ronin:stack-prs` — opt-in, la pone un humano a mano en el issue de tracking: habilita el modo apilado (§2) para ese issue. Sin ella, el default es secuencial.
- `ronin:issue-fix` — la pone el supervisor en un issue asignado directamente (§1, variante), para distinguirlo del issue de tracking de un spec.
- `ronin:runner-<RUNNER_ID>` — el claim de un runner sobre un issue (§9).
- `ronin:attempts-N` — en un PR, el contador de intentos contra los límites de `docs/BLOCKING.md`.
- `ronin:auto-merge` — en un PR, lo pone un humano (o `/auto-merge`): mergearlo apenas esté aprobado y en verde (§13).
- `ronin:propuesta` / `ronin:idea` — en los issues que abre la exploración (§11).

El body queda como contexto legible para el humano (qué slice va, qué PR corresponde, por qué está bloqueado); las labels son lo que el supervisor realmente lee para decidir la próxima acción.

### 3. Supervisor (homelab, cron)

`pnpm tick` corre y termina — no es un proceso long-running. La recurrencia la da **cron** (no un loop en tmux, que era la idea original): `scripts/setup-cron.sh <minutos>` instala una entrada de crontab que invoca el tick cada N minutos.

En producción (y en el cron) lo que se ejecuta es el build compilado en `dist/` vía `pnpm start`, generado por un paso explícito `pnpm build` — nunca se reconstruye solo, así que hay que correrlo antes de instalar el cron y de nuevo después de cada cambio de código. `pnpm tick` (que corre el código fuente directo con `tsx`, sin compilar) queda para desarrollo local y dry runs. Ver [`docs/superpowers/specs/2026-07-28-build-step-design.md`](superpowers/specs/2026-07-28-build-step-design.md) para el rationale completo.

En cada tick:

1. Escanea specs e issues asignados a la cuenta de ronin (§1) → mergea el spec, crea el issue de tracking y corre el plan; un issue asignado directamente pasa a ser su propio issue de tracking.
2. Barre lo que vive fuera de un issue: entrevistas de Remote Control terminadas (§11.9), issues cerrados con todas sus slices mergeadas, previews de PRs cerrados o vencidas (§12) y PRs con `ronin:auto-merge` listos para mergear (§13).
3. Escanea issues abiertos `in-progress` → decide la próxima acción según el estado real del PR/CI/reviews (implementar siguiente slice, resolver comentarios de review, arreglar e2e, registrar las slices que un humano mergeó).
4. Junta el resto del trabajo: reviews de PRs de humanos y menciones en ellos, `/spike`/`/spec`/`/prototype` y pedidos en issues sin asignar, entradas de changelog, el PR de exploración y la exploración nocturna (§11.8).
5. Cada acción es una invocación de Claude no interactiva, aislada en su propio worktree, que termina al completar la unidad de trabajo — así nunca se acumula contexto entre tareas.
6. Manejo de cuota: si `claude` sale por el límite de uso de la cuenta (`ClaudeUsageLimitError` en `claude-runner.ts`), no es un bloqueo: el tick deja esa tarea como está y la retoma en un tick posterior, cuando vuelve la cuota. No hay backoff calculado a partir del reset time; el reintento es simplemente el tick siguiente.
7. Bloqueo real (spec ambiguo, e2e fallando tras N intentos, feedback que no converge — ver `docs/BLOCKING.md`) → notificación por email, el loop deja ese issue en paz hasta recibir input humano.

**Un tick a la vez por host**: como un tick puede tardar (una invocación de `claude -p` puede llegar a `AGENT_TASK_TIMEOUT_MINUTES`), el wrapper que genera `setup-cron.sh` usa `flock` para que un disparo del cron mientras el anterior sigue corriendo no arranque otro tick en paralelo: deja una marca `.tick.pending` y el tick en curso, al terminar, corre otro. Los eventos de GitHub no pasan por acá: cada uno tiene su propio handler, que corre a la par del tick (§14). Esto es independiente del claim entre runners distintos (§9), que protege contra *otro host*.

Concurrencia entre issues: el trabajo de todos los flujos (issues, reviews externas, spikes, changelog, exploración) corre en un solo pool de hasta `TICK_CONCURRENCY` tareas a la vez por repo, de las cuales a lo sumo `EXTERNAL_REVIEW_CONCURRENCY` son reviews externas; los repos de `repos.json` se procesan uno detrás del otro (entre hosts, ver §9). *Dentro* de un mismo issue, el default es secuencial (una slice a la vez, se espera a que mergee para arrancar la siguiente); con el label `ronin:stack-prs` (§2.1) pueden estar en vuelo varias slices/PRs a la vez, cada una apilada sobre la anterior, sin esperar a que una mergee para arrancar la siguiente. Ver [`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`](superpowers/specs/2026-07-28-stacked-prs-design.md) para el rationale completo. Specs independientes sí pueden correr en paralelo en worktrees separados.

Convención de branches: `ronin/<issue>/slice-<n>` — así el supervisor encuentra el PR de la slice en curso de un issue por prefijo de branch, sin mantener un mapeo aparte.

**Setup**: `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) instala el cron; `pnpm cron:remove` lo saca. El script resuelve el `PATH` real de una shell de login (cron no fuentea `.bashrc`/`.profile`, así que `node`/`pnpm` instalados vía nvm u otro manager no estarían en el `PATH` mínimo de cron) y lo hornea en un wrapper generado (`scripts/run-tick.sh`, no versionado — específico de cada máquina).

**Logs**: `logs/tick-YYYY-MM-DD.log`, un archivo por día — la "rotación" es simplemente escribir a un path nuevo cuando cambia la fecha, sin `logrotate` ni dependencias externas. El wrapper poda archivos más viejos que el retention configurado en cada corrida. Cada línea lleva timestamp ISO (`src/core/logger.ts`, usado en vez de `console.log` suelto) — incluye el output completo de cada invocación de `claude -p` (antes se descartaba entero; era la única pieza de "qué hizo el agente" que no quedaba en ningún lado, ni en logs ni en GitHub).

### 3.1 Implementación (`src/`)

Scaffold en TypeScript (`pnpm tick` corre un tick y termina — lo invoca el cron, §3). `src/` está organizado por feature:

| Carpeta | Qué tiene |
|---|---|
| `src/` (raíz) | `index.ts` (entrada del cron) y `tick.ts` (el orquestador) |
| `core/` | lo compartido por todas las features: config, GitHub, worktrees, `claude -p`, estado local, claim, notificaciones, logs, el lanzador de workers y los prompts (`agent-task.ts`) |
| `slices/` | issues de tracking → PRs apilados: checklist, stack, specs, entrevistas |
| `review/` | review de PRs ajenos y su publicación (§4) |
| `commands/` | comandos por mención (`mentions.ts`, `/help`, `/auto-merge`, `/resolve-conflicts`, `/spike`, `/prototype`, pedidos en issues) |
| `app/` | levantar y manejar la app del producto, y la rama de evidencia (§11.2, §11.5) |
| `preview/` | `/preview` (§12) |
| `exploration/` | exploración y su PR rodante (§11) |
| `server/` | el servidor de ronin: su API (los webhooks, con el dispatcher de eventos y el handler por evento, §14; el login y los datos del tablero, §15) y los dos listeners |
| `web/` | la aplicación web del tablero, archivos estáticos sin build (§15) |
| `changelog/` | publicación del changelog en cada release |

**Imports:** dentro de una carpeta se importa el archivo directo (`./flow.js`); entre features, por el barrel de la carpeta (`../review/index.js`), que reexporta todo lo que no es entrada. `core/` no tiene barrel y se importa por archivo (`../core/config.js`): `config.ts` falla al cargar si faltan env vars, y módulos como `server/api/webhooks/events.ts` tienen que poder cargarse sin ellas. Los workers (`*-worker.ts`, `*/worker.ts`), el handler por evento (`server/api/webhooks/handler.ts`) y el servidor (`server/index.ts`) son procesos aparte: no van en los barrels y se lanzan por su ruta relativa a `src/` (`launchWorker('preview/worker', …)`). Los tests importan y mockean el archivo concreto, no el barrel.

Los módulos del núcleo (en `core/` salvo que se indique otra carpeta); los de cada feature se describen en su sección:

- `config.ts` — env vars, labels, límites de reintento
- `github.ts` — wrappers sobre `gh` CLI (execFile con argv array, nunca shell string) para issues/PRs/labels/merge/body/contador de intentos. El gate de approval está *en código*, no solo documentado: `mergePullRequest` (que usan el PR de exploración y el auto-merge) lanza si `reviewDecision !== 'APPROVED'`
- `slices/checklist.ts` — parsea y edita el checklist de slices del body del issue (índice de próxima slice, marcar merged, registrar PR); es la fuente de verdad para "qué slice sigue", no un contador aparte
- `slices/spec-content.ts` — lee el contenido de un spec ya mergeado vía `git show origin/main:<path>` (nunca toca el working directory del checkout principal, así que no importa qué branch tenga el humano checked-out ahí)
- `notifier.ts` — el notificador de bloqueos (nodemailer + Gmail SMTP)
- `logger.ts` — formato `[ISO_TIMESTAMP] LEVEL mensaje`, usado en vez de `console.log` suelto (ver `logs/tick-YYYY-MM-DD.log`, §3)
- `worktree.ts` — crea/reutiliza un git worktree desechable por branch de tarea, y los borra cuando su PR ya no está abierto (`sweepOrphanedWorktrees`)
- `claude-runner.ts` — invoca `claude -p` con `--permission-mode bypassPermissions`, reenviando el PAT de la cuenta `ronin` como `GH_TOKEN` al proceso hijo (así los `gh` que el propio Claude headless corra también quedan a nombre de esa cuenta)
- `agent-task.ts` — arma el prompt (en inglés, ver §8) según el tipo de tarea (`plan`, `implement-slice`, `fix-review`, `fix-e2e`, `fix-issue`, y los de cada feature: reviews, `fix-comments`, spikes, specs, exploración, previews, changelog) y orquesta worktree + invocación; salvo en `plan`, recuerda al agente dejar constancia de aprendizajes no-obvios en `docs/agent-notes/` del repo destino — ver [`docs/superpowers/specs/2026-08-18-agent-notes-design.md`](superpowers/specs/2026-08-18-agent-notes-design.md)
- `claim.ts` — lock por label (`ronin:runner-<runner-id>`) + cache local (`.ronin-state.json`) para que dos supervisores no procesen el mismo issue — ver §9
- `run-record.ts` — el registro de cada corrida de agente en `logs/runs/`, que lee el tablero (§15.5)
- `claude-usage.ts` — el uso de cada cuenta de Claude, del `rate_limit_event` de cada corrida (§15.6)
- `tick.ts` (raíz) — el loop de decisión: descubre specs asignados, y por cada issue `in-progress` decide la próxima acción leyendo el checklist y el contador de intentos por PR contra los límites de `docs/BLOCKING.md`

### 4. Testing y review externo

- El agente corre los e2e del repo del producto (p. ej. Playwright en `apps/webapp/e2e/` de bmedical) antes de abrir el PR — si la slice toca comportamiento de usuario, agrega o actualiza un spec y lo corre hasta que pase, en vez de dejárselo a CI.
- Pipelines: el agente monitorea CI y arregla lo que falla, pero el merge de un PR de slice lo hace siempre un humano.

- Review de GitHub Copilot: **fuera del loop core por ahora**, parametrizable vía `REQUEST_COPILOT_REVIEW` (default `false`). Si se activa, el agente solicita el review y monitorea/resuelve sus comentarios igual que los de un humano — pero no es una dependencia asumida del flujo.

### 5. Parte visual

Para flujos complejos, el spec incluye un link a un proyecto de Claude Design. El agente lo sincroniza vía MCP (`DesignSync` / skill `/design-sync`) para obtener la propuesta de componentes, en vez de improvisar el diseño visual.

### 6. Notificaciones

Solo se notifica por email en bloqueos reales, no en progreso rutinario (para evitar fatiga de alertas). Requiere una app pequeña con credenciales de Gmail vía variables de entorno, corriendo junto al supervisor.

### 7. Identidad del agente en GitHub

Los issues/PRs los abre la cuenta de GitHub dedicada `ronin` (no la cuenta personal de quien corre el supervisor) — así el historial de autoría es honesto sobre qué hizo un humano y qué hizo el agente, y el approval-gate del merge (§ Principios de diseño) tiene sentido: el aprobador y el autor nunca pueden ser la misma persona por accidente.

Se eligió un token de cuenta dedicada (fine-grained PAT) sobre un GitHub App — ver docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md para el detalle completo de la decisión — por simplicidad de setup: sin registrar un App, sin private key, sin installation ID, y sin necesitar una segunda cuenta separada solo para ser mencionable (a diferencia del diseño original de este documento). El costo aceptado: el token es estático (sin JWT ni refresh automático — se rota a mano antes de que expire), y si algún repo futuro viviera en una org con billing por seat, la cuenta colaboradora consumiría uno.

**Setup manual (no automatizable, pasos para el dueño de cada repo):**

1. Crear la cuenta de GitHub dedicada `ronin` (o el nombre que prefieras) e invitarla como colaboradora en cada repo de `repos.json`.
2. Generar un fine-grained PAT desde esa cuenta (Settings → Developer settings → Personal access tokens → Fine-grained tokens), scopeado a esos repos, permisos Contents/Issues/Pull requests en read-write, con expiración.
3. Setear `RONIN_GITHUB_TOKEN` (el token) y `RONIN_GITHUB_LOGIN` (el username de la cuenta) en el `.env` del supervisor — nunca commitear el `.env` (ya está en `.gitignore`).

**Verificación:** `pnpm smoke-test` confirma que el token autentica como `RONIN_GITHUB_LOGIN` y que puede leer cada repo de `repos.json` — correrlo después de cualquier cambio de credenciales antes de asumir que quedaron bien.

### 7.1 Permisos de las invocaciones headless

`claude -p` corre sin nadie mirando, así que el modo de permisos por defecto (confirmar cada tool call) se cuelga. Se decidió explícitamente `--permission-mode bypassPermissions` — sin ningún gate — en vez de una allowlist curada, priorizando autonomía sobre contención granular.

La única contención real es que **cada tarea corre en su propio git worktree desechable** (`src/core/worktree.ts`), nunca en el checkout principal (`productRepoPath` en `repos.json`) — así un comando destructivo lanzado por error solo puede arruinar ese worktree, que se puede recrear desde cero. Esto es una mitigación, no una garantía: un comando que apunte fuera del worktree (paths absolutos, `cd`, etc.) no está bloqueado por nada. Reconsiderar si en algún momento el blast radius observado no compensa la autonomía ganada.

Segunda limitación encontrada en el primer dry run: el prompt de una tarea puntual no acota lo que el agente puede decidir hacer con `gh`/`git` más allá de esa tarea — si lee contexto que contiene instrucciones para *otras* situaciones (ej. el propio template del issue), puede actuar sobre ellas aunque no vengan de su prompt. Mitigado parcialmente pasando solo la información mínima necesaria en cada prompt (ver §10) en vez de decirle al agente que lea documentos completos con instrucciones para roles que no son el suyo.

### 7.2 Usuario mencionable

A diferencia de un GitHub App (cuyo bot user no siempre es confiablemente @mencionable/notificable), `ronin` es una cuenta real — la misma que abre los PRs es la que se @menciona para pedirle una review puntual (ver la [wiki → Comandos](https://github.com/Oskr814/ronin/wiki/Comandos)). No hace falta ninguna cuenta ni setup adicional para esto.

### 8. Idioma

Todo lo que el agente headless lee o produce como instrucción — los prompts en `agent-task.ts`, el texto y comentarios de `templates/tracking-issue.md` — está en inglés, independientemente del idioma de esta documentación. Lo que es comunicación humana (esta doc, `docs/BLOCKING.md`, el cuerpo de los emails de `src/core/notifier.ts`, los motivos de bloqueo en `tick.ts`) se mantiene en español.

### 9. Concurrencia entre múltiples supervisores

Implementado en `src/core/claim.ts`, siguiendo el mismo patrón de "GitHub como estado" que el resto del sistema — sin base de datos ni lock service aparte, y sin jitter ni timestamps: un label de claim por runner más un cache local que evita repreguntarle a GitHub por algo que este runner ya sabe que es suyo.

La identidad del runner es `RUNNER_ID` (el usuario de GitHub de quien lo opera, ej. `oskr814`, requerido — no hay default de hostname porque no significaría nada para un humano leyendo el label) y el lock es el label `ronin:runner-<runner-id>`, que pone el propio `claim.ts` en el issue al procesarlo. Antes también servía para asignarle un spec a un runner; hoy eso se hace con Assignees (§1).

- **Estado local** (`.ronin-state.json`, gitignored, no compartido entre runners): cache de qué issues ya reclamó este runner. Si un issue ya está ahí, ni siquiera se consulta GitHub — se procesa directo. Es solo una optimización, no la fuente de verdad: si el archivo se pierde o es la primera corrida, se re-deriva todo desde las labels reales.
- Cuando el estado local no tiene el issue: si ya hay un `ronin:runner-*` de *otro* runner, se salta. Si no hay ninguno, agrega el propio y **relee** las labels — dos runners pueden pasar el chequeo y agregar su label en el mismo instante (`--add-label` no es compare-and-swap), así que el desempate es determinista: gana el `runner-id` alfabéticamente menor, sin esperar nada. El que pierde saca su propia label.
- El **descubrimiento de un spec asignado también reclama de inmediato** (`discoverAssignedSpecs` marca el spec PR `in-progress` apenas lo detecta, antes de mergearlo) — así nunca hay una ventana donde algo exista y esté sin dueño.
- El lock sobre un issue se **libera solo cuando deja de estar `in-progress`** (pasa a `blocked` o `done`) — mientras siga en curso, el mismo runner lo retiene sin volver a pelear por él en cada tick.

**Descubrimiento duplicado de un spec**: el PR del spec se marca `ronin:in-progress` antes de mergearlo, y `listAssignedSpecPrs` ignora los que ya tienen un label de estado, así que un tick siguiente (del mismo runner o de otro con la misma cuenta) no lo vuelve a tomar. Dos runners que lo lean en el mismo instante, antes de que el label exista, sí podrían crear dos issues: no hay compare-and-swap sobre el PR del spec. Lo que sigue siendo un problema de **proceso humano, no de concurrencia**: si alguien asigna dos PRs que describen el mismo trabajo, se procesan como dos specs distintos — no hay nada en el código que detecte esa duplicación de contenido.

### 10. Primer dry run (2026-07-28)

Corrida real de punta a punta contra `Bmedical/bmedical` (spec desechable, tarea trivial: agregar un comentario a `README.md` y abrir PR draft). Resultado: el pipeline funcionó — issue creado, plan generado, slice implementada, PR draft abierto, todo autorado como `ValerIA[bot]`/`app/valeria-agent`, checklist reconciliado correctamente. Se limpiaron todos los artefactos (issue, PR, branches, worktrees) después de verificar.

Encontrado y arreglado a partir de esta corrida:

- Los labels no existían en el repo destino y GitHub no los crea al aplicarlos (`--add-label` falla en seco) — `github.ts` ahora los crea con `--force` antes de usarlos (idempotente).
- `discoverNewSpecs` nunca transicionaba el issue de `valeria:ready` a `valeria:in-progress` — el issue hubiera quedado invisible para el supervisor en todo tick posterior.
- **Hallazgo de contención real**: durante `implement-slice`, el prompt le decía al agente "leé el checklist del issue completo" — eso lo exponía a las instrucciones para *otras* tareas embebidas en `templates/tracking-issue.md` (la sección de Bloqueo), y el agente se auto-aplicó la label `valeria:blocked` por su cuenta, sin que se lo pidiéramos y sin llenar la sección que la propia plantilla exige. Arreglado pasando el título de la slice directo en el prompt en vez de decirle que lea el issue entero, y agregando una instrucción explícita en los cuatro prompts de que la issue/labels son responsabilidad exclusiva del supervisor. Esto no es una garantía — con `bypassPermissions` el agente puede en principio ejecutar cualquier `gh`/`git` que decida — pero reduce la superficie de lo que razonablemente terminaría leyendo y actuando por su cuenta.
- Un PR draft tenía `checksPassing: false` sin que fuera una falla real — la lógica ahora trata `isDraft` como estado de espera normal, no como algo a arreglar.
- Efecto colateral no relacionado con el código: `bmedical` tiene integración con Linear, así que cada issue de tracking real va a generar un ticket enlazado automáticamente — no es un bug, pero vale saberlo.

### 11. Exploración: ronin usa la app y propone mejoras

Hasta acá ronin solo reacciona: implementa lo que se le asigna y revisa lo que se le pide. Esta sección le agrega la parte que hace un dev senior o un QA por iniciativa propia: **usar la app, encontrar dónde duele y proponer cómo mejorarlo**, con evidencia y el antes/después. El humano sigue decidiendo qué se hace, igual que en el resto del sistema.

#### 11.1 Principios

- **Autodescubrimiento anclado en tareas.** No hay un archivo de objetivos: definir el objetivo suele traer la solución adentro, y entonces no queda nada por descubrir. Una propuesta tiene que nacer de **fricción observada mientras se completaba una tarea real en la app** (crear un borrador, confirmar, surtir…), no de una opinión estética.
- **La evidencia sale de usar la app, no de leer el código.** El código y el historial de git sirven para decidir *dónde* mirar (dónde se concentran los fixes, qué cambió hace poco), pero no alcanzan para justificar una propuesta. En la exploración que llevó a este diseño, un análisis estático ("estas pantallas no tienen clases responsive") concluyó que el flujo de pedidos no funcionaba en mobile, y era falso.
- **Acotado por corrida.** La app crece; ronin nunca la prueba entera. Cada corrida explora como máximo N funciones, y la rotación (§11.4) cubre el resto con el tiempo.
- **Lo que ya se decidió no vuelve.** Cada rechazo, con su motivo, queda en la memoria (§11.6) y se tiene en cuenta en las corridas siguientes.

#### 11.2 Correr la app (`app:up`)

Requisito para todo lo demás. Un manifiesto por repo (`ronin.app.json` en la raíz del repo del producto) dice cómo levantar la app en un worktree aislado:

- archivo(s) de compose y override generado por ronin para no chocar con el stack de desarrollo de un humano (puertos y `container_name` fijos — p. ej. `web` / `postgres-ecommerce` / 5000 / 5434 en shoppingcart, mismo problema que ya resuelve `DB_PORT` en bmedical)
- paso de seed (en shoppingcart los seeds de `Dumps/postgres/` se montan pero no corren solos)
- URL base y healthcheck
- credenciales de prueba por rol — siempre de seed, nunca reales
- viewports: desktop y mobile

Siempre contra datos de seed, nunca contra producción. El seed tiene que incluir casos de volumen realista (un pedido de 3 líneas no muestra los problemas de uno de 80). La baja es un `docker compose down --volumes` del proyecto de la app (`appDown` en `app/runtime.ts`). Si `app:up` falla, la corrida lo reporta como primer hallazgo en vez de bloquearse.

#### 11.3 Qué se busca: las 7 señales

| # | Señal | Cómo se observa usando la app |
|---|---|---|
| 1 | Muchos pasos para completar una tarea | pasos, clicks/taps, pantallas y campos contados al completarla |
| 2 | Idas y vueltas | navegación atrás/adelante necesaria para terminar la tarea |
| 3 | Pantalla cargada | densidad, elementos fuera de pantalla, scroll excesivo, juicio visual del screenshot |
| 4 | Componente con bugs | errores de consola, 4xx/5xx, interacciones que fallan — se confirma con un test que lo reproduce (mismo criterio que la Etapa 4 de la review externa) |
| 5 | Mal patrón de UX global | el mismo problema en N pantallas → una sola propuesta transversal |
| 6 | UI inconsistente | la misma acción resuelta distinto en pantallas distintas |
| 7 | UI muerta | elementos que parecen interactivos y no hacen nada, rutas placeholder |

Además de **hallazgos** (fricción observada), ronin puede proponer **ideas**: oportunidades de mejorar un flujo ("repetir el último pedido del cliente", "escanear el código de barras al surtir"). Una idea tiene que estar atada a una función explorada en esa corrida, lleva imagen del después obligatoria, va con label propio (`ronin:idea`), tiene tope de 1–2 por corrida y nunca desplaza a un hallazgo con evidencia.

Gravedad, en orden: bug → fricción que bloquea la tarea → fricción que la hace más lenta → inconsistencia → pulido. Si una corrida no encuentra nada de los primeros niveles, publica menos; no rellena el cupo con pulido.

**Analítica real** (Clarity, GA4) queda como fuente de confirmación opcional, no como base: en apps internas con pocos usuarios los números son ruido, y en apps con datos de salud (bmedical) no se agrega analítica de terceros.

#### 11.4 Qué se explora en cada corrida

**Inventario de funciones** (`inventory.yml`, §11.6): cada corrida arranca comparando rutas y navegación de la app contra el inventario; lo nuevo se agrega solo, lo eliminado se marca retirado. El equipo puede editarlo para excluir funciones, subirles prioridad o anotar contexto que la app no muestra ("bodega la usa desde el teléfono").

**Selección** de hasta N funciones (p. ej. 3), cada una en desktop y mobile:

1. nueva, nunca explorada
2. cambiada desde su última exploración (`git log` sobre sus archivos desde esa fecha — lo recién mergeado se revisa pronto)
3. marcada `alta` por el equipo
4. la que hace más tiempo que no se explora

**Un cupo por corrida es aleatorio**, ponderado por riesgo (historial de fixes, cantidad de lógica), aunque no le toque por fecha — para encontrar lo que la rotación ordenada tardaría meses en cubrir.

**Charters** (técnica de exploratory testing): a cada función seleccionada se le sortea un ángulo, favoreciendo los que todavía no se le aplicaron, hasta cubrir la matriz función × charter:

| Charter | Qué hace |
|---|---|
| camino-feliz | completar la tarea con la menor cantidad de pasos |
| datos-hostiles | vacíos, límites, textos largos, caracteres raros que los usuarios sí escriben (acentos, ñ, símbolos), negativos |
| interrupciones | atrás, recargar, doble envío, red lenta, sesión vencida a mitad del flujo |
| concurrencia | dos sesiones sobre el mismo registro |
| volumen | registros con muchas líneas o mucho historial |
| primera-vez | usar la app solo con lo que dice la UI, sin conocer el dominio |
| recorrido-completo | la función como parte de un flujo de punta a punta |
| cambio-de-dispositivo | la misma tarea en desktop y mobile, comparando |

Los datos concretos (cliente, productos, cantidades) también se eligen al azar dentro del seed. **Toda la aleatoriedad usa una semilla registrada en el run y en cada hallazgo**: un bug encontrado al azar que no se puede reproducir no sirve. No se hace monkey testing puro (clicks al azar), salvo como presupuesto chico para detectar crashes sin proponer nada.

#### 11.5 Antes y después: capturas en una rama huérfana

Cada propuesta lleva antes/después. El "antes" son las capturas que el explorador sacó usando la app (hasta 3 por ficha). El "después" se arma preferentemente aplicando un parche borrador en el worktree (sin pushear) y sacando screenshot de la app real, con el design system real; si no es viable, el explorador dibuja la pantalla en HTML y ronin la renderiza a PNG con Playwright, al viewport del hallazgo y sin red.

Las imágenes van a la rama huérfana **`ronin/evidence`** del repo del producto, que no se mergea nunca: un commit por corrida, armado con plumbing de git sobre un índice temporal (sin worktree), en `<app>/<corrida>/<ficha>/antes-N.png|despues.png`. La ficha y el PR las muestran con `<img>` apuntando a `github.com/<repo>/blob/<sha>/…?raw=true`: GitHub no las pasa por su proxy, así que solo las ve quien tiene acceso al repo, y como el link apunta a un commit no se mueve. Si el push falla, la ficha se escribe igual con las capturas descritas en texto.

Primero se probaron Claude Artifacts (desde una sesión `claude --bg`, porque `claude -p` no tiene la herramienta): solo los veía la cuenta del runner, abrían un segundo canal de comentarios que ronin no lee y eran la parte más frágil del flujo. Se descartaron.

#### 11.6 Memoria en el repo del producto

```
docs/exploration/
├── README.md          # qué es esto y cómo leerlo
├── inventory.yml      # índice: funciones, cobertura y hallazgos
├── knowledge.md       # decisiones del equipo: "ya cubierto", "descartado", con motivo
├── findings/
│   └── F-0007-confirmar-doble-envio.md
└── runs/
    └── 2026-10-14.md  # plan (funciones, charters, semilla) y resumen de la corrida
```

`inventory.yml` — lo único que ronin lee entero en cada corrida:

```yaml
- id: pedidos.confirmar
  nombre: Confirmar pedido
  rutas: [/pedidos/:orderId/confirmar]
  roles: [Sales, Admin]
  archivos: [apps/backoffice/src/modules/pedidos/pages/orders/ConfirmOrderPage.tsx]
  notas: bodega también la usa desde el teléfono
  prioridad: normal                 # normal | alta | excluida
  cobertura:                        # charter → última fecha, por viewport
    desktop: { camino-feliz: 2026-10-14, datos-hostiles: 2026-10-21 }
    mobile:  { interrupciones: 2026-10-14 }
  hallazgos: [F-0007, F-0012]
```

`findings/F-NNNN-<slug>.md` — una ficha por hallazgo o idea:

```markdown
---
id: F-0007
tipo: hallazgo            # hallazgo | idea
funcion: pedidos.confirmar
señal: bug
gravedad: alta
charter: interrupciones
viewport: mobile
semilla: 83121
estado: propuesto         # propuesto | aprobado → issue #N | rechazado | resuelto
huella: confirmar|doble-click|pedido-duplicado
---
Qué pasó, cómo reproducirlo, evidencia (con las capturas del antes) y propuesta (con la del después).
```

- La **huella** es lo que evita repetir: antes de proponer, ronin compara contra las huellas de todas las fichas (incluidas las rechazadas) y `knowledge.md`, leyendo solo el frontmatter.
- `runs/` es para auditoría humana; ronin no lo lee para decidir, así la memoria no crece en tokens con cada corrida.
- Imágenes fuera de la rama principal: viven en `ronin/evidence` (§11.5) y la ficha las enlaza por sha.

#### 11.7 Flujo: un PR rodante

1. Hay **un solo PR de exploración abierto** por repo. Cada corrida commitea en su rama (run + fichas + inventario) y refresca su body, que es el digest. Si no hay ninguno abierto, la corrida abre uno nuevo en `ronin/exploration/<fecha>`.
2. El PR sale **listo para revisar** apenas termina la corrida, sin draft ni corte semanal: el humano revisa y mergea cuando le conviene, y mientras tanto las corridas de las noches siguientes se suman al mismo PR. Uno solo a la vez porque dos PRs abiertos editarían el mismo inventario y no verían los hallazgos del otro al deduplicar.
3. El humano revisa en el PR, comentando sobre las fichas. ronin clasifica cada comentario y aplica el cambio él mismo:
   - **rechazar**: estado `rechazado` + motivo, y el motivo a `knowledge.md`; si la ficha ya tenía issue (las de PRs anteriores a que los issues esperaran a la aprobación), ronin lo cierra como *not planned* con un comentario con el motivo, una vez commiteado el rechazo;
   - **editar**: nuevo título o propuesta; si la imagen del después está mal, el worker levanta la app, rehace la captura con un cambio borrador y la reemplaza en la ficha;
   - **crear un issue** aparte a partir del comentario;
   - **responder** una pregunta.

   Las mismas decisiones se pueden tomar desde el tablero, que comenta como quien entró (§15.12).

   Un comentario general del PR que menciona a ronin también se aplica: puede cubrir varias fichas a la vez ("los de mobile se resuelven con F-0003"), que se rechazan o corrigen como arriba, y dejar en `knowledge.md` lo que las exploraciones siguientes no deben volver a proponer. Se procesa antes del merge, así que no se abren issues de fichas que ese comentario descartó.
4. Approve + merge (mismo gate que el resto): al ver el PR aprobado, ronin marca como `aprobado` **las fichas que siguen en pie**, les crea su issue, commitea ambos al PR y recién entonces lo mergea (si sigue aprobado), así la base queda con el estado y el número de issue de cada ficha. La corrida siguiente abre el PR nuevo. Asignar ese issue a ronin lo mete en el flujo de `fix-issue` o de spec de siempre.
5. Sin excepciones: ninguna ficha abre issue antes de la aprobación, ni siquiera un bug de gravedad `bug`. Así una ficha rechazada nunca deja un issue abierto. Los problemas del **entorno de desarrollo** (seed, stubs), que el evaluador marca con `entorno`, siguen el mismo camino.

#### 11.8 Programación nocturna

Sin cron aparte: el tick evalúa `es de noche (EXPLORE_NIGHT_WINDOW, en la hora de EXPLORE_TIMEZONE) && hay una app de "explore" que todavía no arrancó esta noche → lanzar el worker` (`exploration/schedule.ts`). Una app por vez por repo, y cada una arranca a lo sumo una vez por noche, salga bien o mal: qué noche arrancó cada app queda en `.ronin-state.json` (`nightlyExploration`). Una corrida que se corta no se retoma esa noche; la siguiente vuelve a elegir funciones desde el inventario.

- **Lo urgente primero**: un issue asignado o una mención que llega de noche se procesa antes; la exploración es la prioridad más baja y es interrumpible entre funciones.
- **Presupuesto por noche, no "usar todo"**: la noche aprovecha la ventana de 5 h de Claude que nadie usa, pero el límite **semanal** es compartido con el trabajo de día. Tope de tiempo y modelo de los workers configurables (como `EXTERNAL_REVIEW_WORKER_MODEL`).
- **Prompt injection desde la app**: el contenido de páginas y datos se trata como dato, con los mismos marcadores `<<<…>>>` que los comentarios.

#### 11.9 Preguntas por Remote Control

Cuando cualquier tarea termina en `RONIN_STATUS: needs-info`, además de dejar las preguntas en el issue, el supervisor puede abrir una sesión `claude --bg --remote-control <nombre>` con el contexto (issue, lo investigado, las preguntas) cuyo único trabajo es entrevistar al humano y escribir `## Respuestas` en el issue. El link (`https://claude.ai/code/session_…`) se lee de `claude logs <id>` y se publica en el issue + email. Al terminar, o tras un timeout (p. ej. 24 h), `claude stop` + `claude rm`; el tick siguiente ve las respuestas y retoma con un worker nuevo.

- Es una sesión **aparte**, no el worker esperando: un worker bloqueado retendría el `flock` del tick, el worktree y el stack de docker.
- Sin `bypassPermissions`: corre con `--permission-mode default` y solo tiene preaprobado leer el repo y `gh issue view`/`gh issue comment` sobre ese issue, porque del otro lado hay una persona. Las respuestas siempre quedan en el issue, porque la sesión se borra.
- Debe correr desde un directorio con trust ya dado: sin TTY, `remote-control` no puede preguntarlo y falla con `Workspace not trusted` (los worktrees nuevos no lo tienen).
- **Solo sirve a la cuenta de claude.ai del runner** (Remote Control no se comparte entre cuentas), así que responder por comentario en el issue sigue siendo el canal para el resto del equipo.
- Sin verificar: si `claude rm` también archiva la sesión en claude.ai/code.

#### 11.10 Etapas

0. ~~Spike: Artifacts desde headless, captura del link de Remote Control, quién puede abrir cada cosa~~ — hecho 2026-10-11 (resultados en §11.5 y §11.9)
1. ~~`app:up` para el backoffice de shoppingcart: manifiesto, override de compose, seed, login por rol, desktop + mobile~~ — hecho
2. ~~`/explore` a pedido (por mención): inventario, charters, hallazgos e ideas, antes/después en `ronin/evidence`, memoria en `docs/exploration/`~~ — hecho
3. ~~Programación nocturna + PR de exploración~~ — hecho
4. ~~Preguntas por Remote Control para `needs-info`~~ — hecho
5. ~~`/spec`: de un pedido en bruto (o una propuesta aprobada) a un PR draft de spec~~ — hecho

Pendiente: calibrar la calidad de las propuestas con varias corridas a mano (ver "Estado actual").

Piloto: el backoffice de shoppingcart (herramienta interna, se levanta entero con stubs de Odoo/GCP, usuarios con el mismo rol `Sales` pero dos usos distintos — vendedores en desktop y bodega en el teléfono). El mecanismo se evalúa por la calidad de lo que encuentra: ¿detecta lo que el equipo ya sabía?, ¿encuentra algo nuevo?, ¿cuántas propuestas se descartan?

#### 11.11 Pedidos en un issue: alcance, investigación y prototipos

Antes de asignárselo a ronin, el issue se puede ir dando forma con él: cualquier mención sin comando en un issue sin el label `ronin` (es decir, que ronin todavía no está trabajando) es un pedido en palabras. Nunca termina en un PR. Para eso está asignar el issue o `/spec`.

- **Un agente de solo lectura decide, el supervisor escribe** (`issue-request.ts`). El agente lee el issue y el código y deja en un JSON lo que pide el comentario: un alcance nuevo, una investigación, un prototipo y/o la respuesta. El supervisor compone el cuerpo nuevo (`issue-sections.ts`), así la descripción original nunca cambia, diga lo que diga el agente.
- **Alcance:** la sección `## Alcance` (entre marcadores `<!-- ronin:alcance -->`) tiene el alcance vigente completo y se reemplaza en cada cambio. `## Cambios de alcance` suma una línea por cambio, con fecha y link al comentario que lo pidió. Cuando el cambio amplía el alcance ("aplica a otras vistas"), el agente nombra los lugares concretos.
- **Investigación:** se agrega al final como `## Contexto adicional (<fecha>)`, sin reemplazar las anteriores, igual que `/spike`.
- **Prototipo** (`/prototype <app> [instrucción]`, o pedido en palabras): corre en un worker aparte (`prototype-worker.ts`), uno a la vez por repo, que espera su turno en lugar de descartar el pedido. Levanta la app desde la rama base en un worktree propio (`prototype-issue-<n>`) con una instancia de compose propia. El agente tiene un navegador por rol y viewport. Saca el antes, hace un cambio borrador, saca el después (o un HTML si el cambio real no es práctico) y deja el cambio sin revertir. El supervisor toma el diff del checkout, sube las capturas a `ronin/evidence` (§11.5) y responde en el issue con antes, después y diff. Después tira el worktree: no queda rama ni PR.
- Cada comentario queda como procesado aunque falle, y la falla se responde. Así un pedido roto no se reintenta en cada tick. En un issue que ronin ya está implementando, estas menciones no se leen: el cambio se pide en el PR.

### 12. Previews por PR en la tailnet (`/preview`)

Para probar un PR sin entrar al server, armar el worktree y levantar la app a mano. `@ronin-agent /preview [app]` en un PR (no fork) hace eso mismo con el código del head del PR y responde con una URL de la tailnet y los usuarios de seed. La app es opcional cuando el manifiesto define una sola.

- **Qué manifiesto.** El `ronin.app.json` (§11.2) de la rama base del PR, salvo que el PR lo modifique: en ese caso, el del PR. Un PR que salió de la base antes de un arreglo al manifiesto (como #367 de bmedical, de antes de `ALLOWED_DEV_ORIGINS`) levantaría la app rota, y ronin no pone al día sus propios PRs con la base.
- **Dónde corre.** Un worker aparte (`preview/worker.ts`), como el de exploración: levantar la app tarda minutos y no puede retener el tick. El comando se intercepta en `findUnprocessedMentions`, así que nunca llega a la review ni a fix-comments. El comando queda como procesado al lanzar el worker, y el worker contesta en el mismo lugar del comentario. Hay un lock por PR, así que dos `/preview` seguidos no se pisan.
- **Aislamiento.** Worktree `preview-pr-<n>` detached en el SHA del head (vía `refs/pull/<n>/head`) y proyecto compose `ronin-app-<repo>-<app>-pr-<n>`, que corre al lado del de exploración y del de otros PRs. Los puertos siguen en `127.0.0.1`.
- **Publicación.** `tailscale serve --https=<puerto público>` → `http://127.0.0.1:<puerto local>`, solo en la tailnet, nunca `funnel`. Se publica el puerto del `baseUrl` más los que la página usa (ver abajo). Los puertos públicos salen de un rango fijo, `PREVIEW_PORT_RANGE` (por defecto 20000-20999), que es lo único que una política de Tailscale le abre a alguien de afuera:

  ```json
  { "src": ["persona@gmail.com"], "dst": ["tag:media"], "ip": ["tcp:20000-20999"] }
  ```

  El rango queda fuera del rango efímero del kernel (32768-60999), porque ahí caen los puertos aleatorios de Docker. Por ejemplo, los Postgres de las slices se publican en `0.0.0.0:<efímero>`. Si un rango abierto a externos se solapara con el efímero, cualquiera de esos podría quedar adentro. Cada puerto se reserva con un archivo exclusivo en `.preview-reservations/ports/` (`O_EXCL`, compartido por todos los repos y workers), así que dos previews nunca toman el mismo. Un puerto en el que ya escucha otro proceso se saltea. Una reserva cuyo worktree ya no existe se reclama.
- **Límite.** Hay como máximo `PREVIEW_MAX_PER_REPO` previews activas por repo (por defecto 2), sin importar la app: en un repo con varias apps, contar por app confundiría. Los cupos son archivos exclusivos en `.preview-reservations/slots/`. Un `/preview` nuevo en el mismo PR conserva su cupo. Cuando no queda cupo, ronin responde nombrando los PRs que los tienen y borra el worktree que acababa de crear. El cupo se libera con `/preview stop`, al mergear o cerrar el PR, cuando la preview vence (ver abajo), o si falla al levantar.
- **Lo que llama el navegador.** Un frontend que le pega a `http://127.0.0.1:<api>` no funciona desde otra máquina. Lo resuelve el boot, sin tocar el manifiesto: toda URL `http://127.0.0.1:{{…}}` o `http://localhost:{{…}}` en el `env` de un paso `start` se rinde como la URL pública de ese puerto (`https://<host>.ts.net:<puerto>`), y el puerto se publica (`publicizeTemplate`). Los pasos `run`/`wait` quedan en loopback, porque hablan con la app desde el host y corren antes de que haya nada publicado. Fuera de una preview, la URL pública es la misma de loopback, así que la exploración no cambia. Para lo que esa regla no cubre, el manifiesto puede usar `{{public.ports.<servicio>.<puerto>}}` o `{{public.port.<nombre>}}` explícitos, y `{{publicHost}}` para un dev server que valida el header `Host` (Vite ≥5.4.12: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`).
- **Se baja con el PR.** `sweepPreviews` corre en cada tick: si hay worktrees de preview cuyo PR ya no está abierto, despublica los puertos, baja la app y borra el worktree. Con `pull_request.closed` arranca un handler (§14) que barre previews y worktrees, así que esto pasa apenas se mergea o se cierra el PR. Lo mismo vale para el worktree de la slice mergeada (`sweepOrphanedWorktrees`) y para el retarget del stack. `/preview stop` la baja antes.
- **Vencimiento.** Una preview que nadie bajó tampoco retiene su stack y su cupo para siempre en un PR que sigue abierto: pasados `PREVIEW_TTL_MINUTES` (por defecto 60) desde que se levantó (`startedAt` en `preview.json`), `sweepPreviews` la baja igual que con `/preview stop` y comenta en el PR que `/preview` la vuelve a levantar. Un `/preview` nuevo empieza la cuenta de nuevo. Como el sweep corre en cada tick, se baja dentro del intervalo del cron después de vencer. Una preview levantada antes de que existiera el vencimiento no tiene `startedAt`: el primer sweep se lo pone, y la cuenta arranca ahí. Con `PREVIEW_TTL_MINUTES=0` no vence.
- **Datos para probar el PR.** Los seeds base casi nunca alcanzan para lo que cambia un PR (el #818 necesitaba un cliente con más de 12 catálogos, algunos vencidos). Con la app arriba y publicada, una tarea de agente (`prepare-preview-data`, sonnet por defecto) corre en el worktree de la preview. Lee el título y la descripción del PR (los pasos de "¿Cómo probar?"), su diff contra la base y lo que se haya escrito después del comando (`/preview un cliente con 40 catálogos`), y deja esos datos. Prefiere la API de la app (logueándose con un usuario de seed) y cae a SQL por el stack de compose para lo que la API no permite, como fechas vencidas. Después verifica leyendo de vuelta. La respuesta con la URL lista lo que quedó listo y dónde encontrarlo, y lo que no pudo preparar. Si falla, la preview se entrega igual, con un aviso. No toca código: al terminar, ronin devuelve el checkout al SHA del PR. Se apaga con `PREVIEW_PREPARE_DATA=false`.
- **Commits nuevos.** La preview no se actualiza sola, porque reinstalar en cada push sería caro. Un nuevo `/preview` la mueve al head actual y reusa los `node_modules` del worktree. Cuando el PR recibe commits después de la preview (ronin aplicando un pedido, o el push de quien sea), `sweepPreviews` lo nota en el próximo tick y comenta en el PR que la preview quedó en el commit anterior y que `/preview` la actualiza. El aviso sale una vez por preview (`staleNotified` en `preview.json`) y vuelve a estar disponible con el siguiente `/preview`.

### 13. Auto-merge por PR (`/auto-merge`, label `ronin:auto-merge`)

Lo mismo que el auto-merge de GitHub, que es de los planes pagos: el PR se mergea solo apenas está aprobado y con los checks en verde, sin que alguien tenga que volver a apretar el botón.

- **El label es el estado.** `ronin:auto-merge` en el PR significa "mergealo cuando se pueda". `@ronin-agent /auto-merge` lo pone y `/auto-merge off` (o `stop`, `cancel`, `/auto-merge-off`) lo saca. También se puede poner o sacar a mano. El comando se intercepta en `findUnprocessedMentions`, como `/preview`, y contesta en el mismo lugar con lo que falta para el merge. Si el PR ya tiene conflictos, no lo activa y explica por qué. ronin solo lee comandos en sus propios PRs y en los PRs de humanos que no son draft. En el resto (un draft de un humano, por ejemplo), el label a mano funciona igual.
- **Cuándo mergea.** `sweepAutoMerge` corre en cada tick, antes de los flujos, así que un merge no espera detrás de una review larga. Lee todos los PRs abiertos con un solo `gh pr list` y mergea los que tienen el label y cumplen todo esto:
  - no es draft;
  - `reviewDecision` es `APPROVED`, que exige que el repo pida reviews en la protección de la rama;
  - los checks terminaron y ninguno falló (el mismo criterio que `checksPassing`, así que un PR sin ningún check espera);
  - GitHub lo da por mergeable;
  - su base no es la rama de otro PR abierto. Un PR de un stack espera a que se mergee el de abajo, para no terminar mergeado en esa rama en vez de en la raíz.

  Mergea con `mergePullRequest`, que vuelve a exigir la aprobación y reacomoda los PRs que dependían de la rama mergeada. Mientras espera, solo lo anota en el log. En el PR comenta únicamente el merge o la desactivación.
- **Cuándo se desactiva.** Igual que en GitHub: si el PR tiene conflictos con su base, o si el merge falla. ronin saca el label y comenta el motivo, así no lo reintenta en cada tick. Para volver a activarlo hay que pedir otra vez `/auto-merge`.
- **Una excepción explícita.** ronin nunca mergea por su cuenta una slice aprobada: la mergea el humano que la aprobó, cuando le conviene. El auto-merge es ese mismo humano pidiéndolo de antemano para un PR puntual. ronin nunca pone el label por iniciativa propia.
- **Rapidez.** Arranca un handler (§14) cuando se pone el label (`pull_request.labeled`, solo con `ronin:auto-merge`), cuando termina el CI de un PR (`check_suite.completed`), con una aprobación (`pull_request_review.submitted`) y cuando se mergea el PR de abajo del stack. Así el merge sale casi en el momento, sin esperar al cron ni a que termine otro trabajo. `check_suite` hay que sumarlo a los webhooks ya creados volviendo a correr `scripts/init-webhooks.sh`.

### 14. Reacción por evento; el tick como conciliación

Antes, cada evento de GitHub que importaba despertaba un tick completo (todos los repos, todos los flujos), y el tick es *single-flight*: un evento que llegaba durante un tick esperaba a que ese terminara y después a otro entero. Medido en 419 corridas (13–15 de octubre de 2026): p50 0.9 min, p90 4.9 min, máximo 31 min, y más de la mitad de los disparos llegaban con un tick en curso. Una aprobación o un `/preview` podían esperar media hora detrás de una review larga.

Ahora cada evento tiene su handler:

- **Dispatcher** (`server/api/webhooks/events.ts`, `scopeForEvent`): traduce el evento a un *scope*: los flujos que ese evento puede mover y los recursos que toca. Por ejemplo, un comentario en un PR mueve `issues`, `idle-commands`, `review` y `exploration` sobre `pr-N`; el CI que termina mueve `auto-merge` e `issues` sobre cada PR de la suite; un PR en una rama `ronin/<issue>/…` suma `issue-<issue>`. Un evento que nada mueve se ignora.
- **Comandos directos**: un comando en un PR (`/help` y comandos mal escritos, `/preview`, `/resolve-conflicts`, `/auto-merge`) va solo al flujo `pr-commands`, que corre `findUnprocessedMentions` de ese PR y nada más: no lista issues ni PRs ni corre el pipeline. `/fix-comments` sí sigue por su flujo, porque lo atiende el pipeline del issue o la review. Como ese handler no toma el issue, el tick puede estar leyendo el mismo comando: cada comentario se toma con un lock propio y, una vez tomado, se vuelve a mirar si ya está procesado (`claimComment` en `mentions.ts`), así nunca se responde dos veces.
- **Lo propio no cuenta**: los comentarios y reviews de la cuenta de ronin no lanzan nada; sus PRs sí (uno recién abierto es parte del stack de un issue).
- **Servidor** (`server/api/webhooks/github.ts`, en el servidor de ronin, §15.2): recibe los eventos en `POST /api/webhooks/github`, pone 👀 en un comentario que menciona a ronin apenas llega (`addAckReaction`), antes de procesarlo. Junta los eventos sobre lo mismo durante `WEBHOOK_DEBOUNCE_MS` (1 s: lo que llega después lo junta el handler que espera) y lanza un handler. Distintos PRs o issues tienen handlers propios, a la vez.
- **Handler** (`server/api/webhooks/handler.ts`): un proceso por evento, como los workers. Corre los mismos flujos que el tick (`runScoped` en `tick.ts`), pero solo los del scope y solo los jobs que tocan sus recursos, con un discovery acotado (`findPrsNeedingReview([N])`, `findIssueCommands([N])`). A un comentario en un PR, que llega sin rama, le busca el issue del PR. Si ya hay otro handler esperando para el mismo scope, no hace falta otro: el que espera va a leer todo cuando le toque.
  - **Reiniciar el servidor no lo corta:** el servicio tiene `KillMode=process`, así que un deploy detiene solo el servidor, y cada handler termina su evento y sale solo.
  - **Tope:** tiene `EVENT_HANDLER_TIMEOUT_MINUTES` (120 por defecto) para todo el evento: esperar su turno y un cupo, y cada agente que lance. Pasado ese tiempo se corta junto con su grupo de procesos, que incluye el `claude -p` que esté corriendo. Los workers que lanzó tienen su propio grupo y siguen. Sus locks llevan su pid, así que el siguiente proceso los toma, y el tablero muestra la corrida como cortada.
- **Tick** (cron): sigue corriendo todos los flujos sobre todo, como conciliación. Levanta lo que ningún handler hizo (un webhook que no llegó, un runner apagado) y el trabajo periódico (entrevistas, exploración nocturna, poda de estado).

**Un solo emoji, "procesado" aparte** (`core/processed-comments.ts`): el 👀 de ronin solo dice "recibido" — lo pone el servidor al llegar el comentario, o el flujo que lo procesa si el webhook nunca llegó. Que un comentario ya está atendido se guarda en el estado local (`processedComments`, por repo), y solo cuando el trabajo salió bien: una falla no se anota y se reintenta, como antes. Un comentario de antes de este cambio cuenta como atendido si el 👀 de ronin es anterior a `ACK_EYES_SINCE` (el deploy en el runner, 2026-10-16T01:03:19Z), que es cuando el 👀 todavía significaba "procesado"; el 👀 de acuse, posterior, no cuenta. Es una fecha fija a propósito: tomarla de la primera lectura del estado dejaba afuera el acuse que el servidor pone segundos antes de esa lectura, y ese comentario se daba por atendido sin responderse. Uno de más de 180 días cuenta como atendido siempre, y por eso las entradas de más de 180 días se podan. Es estado de este runner: con un solo runner por repo (hoy `ronin-agent`) no hace falta compartirlo; varios runners sobre el mismo repo necesitarían volver a guardarlo en GitHub.

**Quién trabaja en qué** (`core/locks.ts`): cada job declara el recurso que toma (`issue-N` para todo el stack de un issue y sus worktrees `ronin/N/*`, `pr-N` para un PR ajeno o de exploración, `changelog`), y los pasos de todo el repo (`assign`, `sweeps`, `auto-merge`) tienen su propio lock. Son archivos con el pid del proceso en `<worktreeBasePath>/.locks/`, así que uno que dejó un proceso muerto se toma.
- El **tick** saltea lo que está tomado: quien lo tiene ya lo está atendiendo.
- El **handler** toma todos los recursos de su scope antes de leer nada de GitHub, esperando a quien los tenga, en orden (no hay deadlock entre handlers). Lo que lee después es el estado posterior a lo que hizo el otro, nunca el de antes. Un job suyo con un recurso que no estaba en el scope (el issue que acaba de crear una asignación) lo toma sin esperar.
- `sweepOrphanedWorktrees` solo borra el worktree de un issue que nadie tiene tomado: un handler puede estar implementando una slice que todavía no tiene PR. El `plan` de un spec toma su issue mientras corre por lo mismo.

**Cupo compartido**: `TICK_CONCURRENCY` y los topes por tipo (`EXTERNAL_REVIEW_CONCURRENCY`, changelog y exploración de a uno) valen para el runner entero, no por proceso: cada job toma un slot de `.ronin-slots/` (de su tipo y del total) antes de correr, y espera si no hay. Los jobs que nunca corren un agente (comandos, lanzar un worker) no toman slot: un `/help` no espera detrás de tres `claude -p`.

**Estado local entre procesos**: `.ronin-state.json` se escribe con un lock de archivo además de la cola en memoria, y atómicamente (se escribe aparte y se renombra), así nadie lee un archivo a medio escribir y lo toma por vacío.

**Métricas**: el handler loguea `event_start` con `delayMs` (desde que llegó el evento hasta que tiene sus recursos) y `event_complete` al terminar, junto al `tick_complete` del tick.

### 15. Tablero web (#65, #85, #93, #111)

Una página para ver qué está haciendo ronin sin recorrer GitHub issue por issue ni leer el log: qué agentes corren y qué hacen paso a paso, qué issues esperan a alguien y por qué, cómo va cada stack de slices, qué previews están arriba y cuánto le queda a cada cuenta de Claude. Cada issue o PR tiene su ficha, con lo que dice en GitHub, y desde ahí se le pueden pedir a ronin los comandos más usados (15.11). Un PR de exploración se revisa ahí mismo, ficha por ficha (15.12), y cualquier PR, archivo por archivo, con su revisión (15.14). Lo que se hace desde la página sale en GitHub a nombre de quien entró (15.3). Se ve solo por la tailnet.

#### 15.1 Qué muestra

- **Barra lateral: solo issues (#100).** Arriba, *Hoy*, *Corriendo ahora* y *En cola*. Después, *Necesitan a alguien* con los issues en `ronin:blocked`, y cada repo de `repos.json` con:
  - **Fijo arriba, el PR de exploración,** con su ícono: no tiene issue y es donde se revisan las fichas (15.12).
  - **Sin buscar,** los issues de ronin (label `ronin`), aunque no haya corrido un agente, y los issues sobre los que ronin trabajó en los últimos 3 días (un pedido, una review del PR de una persona).
  - **Buscando** (título, número, `RED-n` o el número de un PR), o filtrando por un ciclo o un proyecto de Linear (15.13), todos los issues abiertos del repo (`listOpenIssues`, en la misma lectura cacheada).

  **Los PRs viven en su issue** (`linkPrs` en `dashboard-github.ts`): una slice de ronin en el suyo; si no, el issue abierto que cierra (`closingIssuesReferences`, por GraphQL); si no, el issue abierto cuyo número lleva la rama (`feat/405-…`, `valeria/228/slice-12`). Las corridas sobre esos PRs cuentan como del issue. Buscar el número de un PR muestra su issue con la slice resaltada.

  **Lo que no tiene issue:** un PR sin issue ni número en la rama, o el changelog, solo aparece mientras corre (*Corriendo ahora*) y en *Hoy*. Un número que no está en la lista ofrece *Abrir #N*: el servidor le pregunta a GitHub si es issue o PR (`itemKindOf`) y abre la ficha aunque esté cerrado.

  Cada fila lleva un punto de estado, el número, cuántas slices van mergeadas (o el PR de una persona: "PR #910 de abdias98"), el `RED-n` y el proyecto si hay Linear, la última línea del agente (o lo que espera: "esperando review en #881", "conflictos en #904", "aprobado, falta el merge de #401") y hace cuánto. Un issue elegido, corriendo o bloqueado se despliega en sus slices.
- **Centro: la ficha del ítem.** Pestañas, una por ítem abierto; al cargar se abren las de los agentes que corren. Cada una muestra la ficha del issue o PR, tenga corridas o no:
  - **Encabezado.** Título, repo, el link a GitHub y el botón *Acciones* (15.11). Debajo, chips con su estado. El PR del ítem (o, en un issue, el de la slice que avanza) suma si tiene conflictos con su base, sus checks, la review y si es draft. Un issue suma cuántas slices van mergeadas y qué espera.
  - **Actividad.** Una línea con la última corrida (estado, hace cuánto, duración, costo y el error si falló) y las anteriores de los últimos 14 días, cada una con su transcript. Si hay una en curso, una tarjeta con lo último que dijo el agente, sus últimos cuatro pasos y el reloj, que se sigue en vivo.
  - **Pestaña *Fichas*,** solo en un PR de exploración, y la primera: las propuestas que trae, para revisarlas y decidir (15.12). Mientras está abierta, la columna de contexto se oculta para dejarle lugar.
  - **Pestaña *Archivos*,** en un PR y en un issue con un PR que avanza: el diff con sus hilos, para comentar y revisar (15.14). Como *Fichas*, ocupa también la columna de contexto.
  - **Pestañas *Issue*, *PR* y *Comentarios*.** La descripción del issue y la de su PR (o la del PR y la de su issue de tracking), y los comentarios del ítem, con los de ronin marcados. Es el markdown de GitHub, saneado (15.3). Un `#123` abre ese ítem en el tablero si está en la barra lateral, y si no, en GitHub.
  - **El transcript de una corrida** se abre desde la actividad, con "← Ficha" para volver: los textos del agente y sus pasos (leyó, buscó, editó, corrió), arriba las corridas del ítem y abajo el estado, el reloj, el modelo y el worktree. Una corrida en curso se sigue en vivo, y si arranca una nueva sobre el ítem abierto, aparece sola. Lo que no es un issue ni un PR (el changelog) abre directo en el transcript, igual que una corrida elegida en *Hoy*.
- **Contexto, a la derecha.**
  - El motivo de un bloqueo y cómo destrabarlo.
  - El árbol de slices con sus PRs, checks y reviews.
  - Los checks del PR que está avanzando.
  - La preview, con su URL y cuánto le queda. Mientras ronin prepara los datos que piden los pasos de prueba, lo dice y todavía no ofrece la URL para abrir.
  - Los datos de la corrida: tarea, modelo, cuenta, duración, costo y worktree.
- **Barra de estado.** El uso de cada cuenta de Claude en la ventana de 5 horas y en la semanal, los cupos de agentes ocupados, la cola, las previews, el último tick y si GitHub no responde.
- ***Hoy*, la vista de inicio.**
  - **Los números del día:** corridas, cuántas terminaron bien, duración mediana y p90, costo y errores, con los de ayer al lado y una mini línea de los últimos 7 días.
  - ***Necesitan tu atención*:** los issues bloqueados con su motivo, los PRs de ronin que esperan review o merge (el que más espera primero, desde la última corrida), el PR de exploración y las previews arriba. Cada fila abre su ítem.
  - **Con Linear (§15.13), el ciclo actual:** una barra por estado y un gráfico de issues en el ciclo contra hechos, día por día. Debajo, el desglose por proyecto (un clic filtra la barra lateral) y quién tiene lo que falta.
  - **Las últimas 12 horas:** un carril por repo y cada corrida como una barra. Al hacerle clic, se abre esa corrida.
- **Celular.** La barra lateral es la lista principal, y un ítem abre su ficha con el contexto debajo.
- **Actualización.** La página pide el snapshot cada 5 segundos mientras está visible, y el transcript de una corrida en curso le llega por *server-sent events*. La ficha se vuelve a pedir cada 30 segundos (el servidor la tiene en caché, 15.8). El centro solo se redibuja si algo cambió, así que leer, seleccionar texto o tener el menú abierto no se interrumpe. No hace falta recargar.

#### 15.2 El servidor de ronin: API y aplicación web

El servidor que recibía los webhooks pasó a ser el servidor web de ronin (`src/server/`, servicio `ronin-server`), con una **API** en `/api/*` y la **aplicación web** del tablero en todo lo demás. Los webhooks son parte de la API.

```
src/server/
  index.ts             el proceso: los dos listeners
  public.ts            lo que atiende el listener público: solo los webhooks
  tailnet.ts           lo que atiende el de la tailnet: la app y toda la API
  api/
    webhooks/          POST /api/webhooks/github: github.ts, events.ts, handler.ts (§14)
    auth.ts            /api/auth/login, /callback, /logout y /me
    dashboard*.ts      los datos del tablero
src/web/               la aplicación: HTML, CSS, JS y fuentes, sin build; marked y DOMPurify en vendor/
```

- **Listener público** (`SERVER_PORT`, 3939; `WEBHOOK_PORT` se sigue leyendo si no está). Es al que llega `https://ronin-agent.redmotoshn.com`, por el túnel de Cloudflare y nginx-proxy-manager. Atiende solo `POST /api/webhooks/github`, más el alias `/webhook` de la ruta anterior; cualquier otra ruta responde 404. La restricción está en el código, así que no depende de cómo esté configurado el proxy.
- **Listener de la tailnet** (`127.0.0.1:SERVER_TAILNET_PORT`, 3940).
  - **Solo en `127.0.0.1`:** no se ve desde la LAN ni desde otra interfaz.
  - **Publicación:** `pnpm server:setup` lo publica con `tailscale serve --bg --https=8443` (`DASHBOARD_TAILNET_HTTPS_PORT`), nunca con `funnel`.
  - **Quién lo ve:** el 8443 queda fuera de `PREVIEW_PORT_RANGE`, lo único que la política de Tailscale les abre a externos (§12), así que solo lo ve el dueño, que tiene `*` sobre `tag:media`.
  - **HTTPS y LAN:** `tailscale serve` pone el HTTPS que necesita la cookie de sesión. Desde la LAN se entra por la misma URL, con Tailscale en el equipo.
  - **Solo con login configurado:** arranca solo si están las variables del login (15.3); sin ellas, el servidor atiende únicamente los webhooks.
- **La aplicación** son archivos estáticos sin datos adentro: todo lo pide a la API. Se sirve sin sesión, y cuando la API responde 401 muestra *Entrar con GitHub*. Una ruta que no es un archivo (`/i/<ítem>`) devuelve la app. `pnpm build` copia `src/web/` a `dist/web/`.
- **Errores aislados.** Un pedido que tira un error responde 500 y se loguea, sin tirar el proceso que recibe los webhooks. Si igual se cae, systemd lo reinicia y el tick levanta lo que llegó mientras tanto.
- **La ruta de los webhooks.** Pasó de `/webhook` a `/api/webhooks/github`. `scripts/init-webhooks.sh <url>` busca el hook de ronin por la URL nueva o por la vieja del mismo dominio y le cambia la URL, en vez de crear un segundo hook que entregaría todo dos veces. El alias `/webhook` se puede sacar cuando ningún hook apunte ahí.

#### 15.3 Login con GitHub

La tailnet ya limita quién llega. El login suma una segunda barrera, y el token con el que el tablero escribe en GitHub a nombre de quien entró (15.11, 15.12).

- **OAuth App de la cuenta del dueño, con el scope `repo`:** sirve para comentar y aprobar como la persona. Se configura con `DASHBOARD_GITHUB_CLIENT_ID` y `DASHBOARD_GITHUB_CLIENT_SECRET`, y su callback es `<DASHBOARD_URL>/api/auth/callback`. Funciona aunque esa URL solo se vea en la tailnet, porque la redirección la sigue el navegador.
- **Por qué `repo`:** el token puede escribir en todos los repos de la persona. Se aceptó porque el tablero solo se ve por la tailnet y solo para los logins de `DASHBOARD_ALLOWED_USERS` (#93). Una GitHub App acotaría mejor los permisos, pero hay que registrarla e instalarla en cada organización.
- **Flujo.** `/api/auth/login` redirige a GitHub con el scope y con un `state` al azar en una cookie de corta vida. `/api/auth/callback` verifica el `state`, canjea el código desde el servidor y lee `GET /user`. Si la persona destildó el scope en la pantalla de GitHub, el login se rechaza explicando por qué.
- **Quién entra.** Solo los logins de `DASHBOARD_ALLOWED_USERS`, separados por coma. La lista se vuelve a mirar en cada pedido, así que sacar a alguien lo deja afuera en el momento. Un login rechazado (fuera de la lista o sin el scope) revoca su token en GitHub.
- **Sesión.** Es una cookie con el login, el vencimiento (`DASHBOARD_SESSION_DAYS`, 7) y el token de GitHub, cifrada con AES-256-GCM con una clave derivada de `DASHBOARD_SESSION_SECRET`. GCM oculta el token y rechaza una cookie cambiada a mano, y no hay estado de sesión en el servidor. Es `HttpOnly`, `Secure` y `SameSite=Lax`. Cambiar el secreto cierra todas las sesiones, y una cookie del formato anterior (firmada, sin token) pide volver a entrar.
- **Salir** revoca el token en GitHub (`DELETE /applications/{client_id}/token`) y borra la cookie, aunque GitHub falle.
- **Organizaciones.** Si una organización restringe las OAuth Apps de terceros, un admin tiene que aprobar el tablero para que el token vea sus repos. Hasta entonces, GitHub responde 403 o 404 al comentar, y la página lo explica.
- **Lo demás:**
  - Un pedido que no es `GET` y trae un `Origin` de otro sitio recibe 403. Las acciones además solo aceptan JSON, que un formulario de otro sitio no puede mandar.
  - La app se sirve con una CSP que solo permite scripts propios (`script-src 'self'`, `frame-ancestors 'none'`). Por eso las fuentes van en `src/web/fonts/` y no se cargan de Google Fonts.
  - Todo lo que viene de los agentes se escapa antes de insertarse en la página, y además ya pasó por `redact()` al escribirse.
  - El markdown de GitHub (la descripción de un PR de cualquiera, un comentario) no es confiable: lo interpreta `marked` y lo limpia `DOMPurify`, copiados en `src/web/vendor/` porque la CSP no deja cargar scripts de afuera. Se descartan estilos, formularios e iframes, y cualquier link que no sea `http(s)`, `mailto` o `#`. Las imágenes pasan a ser links, porque la CSP tampoco las cargaría.

**Qué repos ve cada sesión (#106, `server/api/access.ts`).**
- **Administradores:** los de `DASHBOARD_ADMINS` (sin definir, los de `DASHBOARD_ALLOWED_USERS`) ven todos los repos.
- **El resto:** ve los repos de `repos.json` en los que tiene al menos `triage` según GitHub. Se consulta con el token de la sesión: `GET /repos/{owner}/{repo}` y su campo `permissions`, donde un 404 es sin acceso. El resultado se guarda en memoria por sesión 10 minutos. Si GitHub falla, queda la última respuesta, y sin ninguna no se ve nada. Un 401 cierra la sesión.
- **Quién entra:** un administrador, o alguien con al menos un repo que ver. `DASHBOARD_ALLOWED_USERS`, si tiene logins, es además la lista de quién entra.
- **Dónde se aplica:** en el servidor. `tailnet.ts` calcula el acceso en cada pedido y `handleDashboard` lo guarda para todo el pedido (`AsyncLocalStorage`). Todas las lecturas de `dashboard.ts` pasan por `visibleRepos()` y `listRuns()`, que solo devuelven lo de esos repos, y fuera de un pedido no devuelven nada. El snapshot, *Hoy*, la cola y el uso de las cuentas de Claude salen filtrados. Pedir por nombre algo de otro repo (una ficha, un transcript, una captura, una acción, *Nuevo issue*) responde 404.

#### 15.4 De dónde sale cada dato

| Dato | Fuente |
|---|---|
| Corridas, transcripts, *Hoy* | El registro por corrida, `logs/runs/` (15.5) |
| Uso de cada cuenta de Claude | `logs/usage/<cuenta>.json` (15.6) |
| Motivo de un bloqueo | `blocks` en el estado local del repo (15.7) |
| Lo que espera un cupo | `.ronin-slots/waiting/` (15.7) |
| Cupos ocupados | `.ronin-slots/all-*.lock` con un pid vivo |
| Issues, slices, PRs, checks | GitHub, dos llamadas por repo (15.8) |
| Descripción y comentarios de un issue o PR | GitHub, al abrir su ficha (15.8) |
| Archivos de un PR y sus hilos de review | GitHub, al abrir *Archivos* (15.14) |
| Lo visto y la revisión pendiente de la persona | GitHub, con su token, al abrir *Archivos* (15.14) |
| Previews | El `preview.json` de cada worktree de preview |
| Último tick y último evento | `tick_complete` y `event_complete` en `logs/tick-*.log` |

#### 15.5 Registro por corrida (`core/run-record.ts`)

Cada corrida de agente escribe `logs/runs/<día>/<runId>.jsonl`, con una línea JSON por evento:

- **`run_start`:** repo, tipo de tarea, issue o PR, slice, modelo, effort, cuenta, worktree, `pid` y hora de inicio. Lo escribe `runAgentTask`.
- **`text`, `tool` y `tool_error`,** a medida que pasan. Es lo mismo que va al log diario, con la misma truncación y sin el contenido de los `tool_result`. `runClaudeHeadless` se los pasa al registro además de loguearlos.
- **`run_end`:** el resultado (`ok`, `error`, `timeout` o `usage_limit`), la duración y los totales del evento `result` de `claude -p` (costo, tokens, turnos, `session_id`).

Cada campo pasa por `redact()` antes de escribirse. Una corrida sin `run_end` cuyo `pid` ya no vive se muestra como cortada. Si el registro no se puede escribir, la corrida sigue igual. `run-tick.sh` (generado por `scripts/setup-cron.sh`) borra las carpetas de más de 14 días, como los `tick-*.log`. El transcript completo que Claude Code guarda en `<claudeConfigDir>/projects/` no se usa, porque trae los `tool_result` enteros, sin redactar.

#### 15.6 Uso de cada cuenta (`core/claude-usage.ts`)

Cada corrida de `claude -p` emite en el stream un `rate_limit_event` con el uso de la cuenta en la ventana de 5 horas y en la semanal, y cuándo se reinicia cada una. `runClaudeHeadless` guarda el último en `logs/usage/<cuenta>.json`, con la hora en que se midió. La cuenta se nombra por su `claudeConfigDir` (`.claude-redmotos` → `redmotos`). Cuando una corrida termina por límite de uso, la cuenta queda marcada sin cuota (`limitHitAt`) hasta la próxima medición.

Una cuenta sin corridas recientes muestra un dato viejo, con su antigüedad a la vista. No se usa el endpoint que lee `/usage` de Claude Code (`/api/oauth/usage`): no está documentado, y con un token vencido habría que refrescarlo, compitiendo con Claude Code por el mismo `.credentials.json`.

#### 15.7 Motivo de bloqueo y cola

- **Motivo.** `notifyBlocker`, por donde pasan todos los bloqueos, lo guarda en el estado local del repo antes del email: `blocks[<número>] = { reason, url, prUrl, excerpt, at }`, con el número sacado de la URL del issue o PR. El tablero lo muestra solo mientras el ítem tenga `ronin:blocked`, así que no hace falta borrarlo al destrabar. Las entradas de más de 180 días se podan. Un bloqueo de un release (el changelog) no se guarda, porque no lleva label.
- **Cola.** Mientras un job espera un cupo, `withSlots` (`core/locks.ts`) deja `.ronin-slots/waiting/<pid>-<n>.json` con el tipo de job, su etiqueta, el repo y desde cuándo. Lo borra apenas consigue el cupo. Una marca de un pid muerto se ignora.

#### 15.8 Datos de GitHub (`server/api/dashboard-github.ts`)

Por repo, dos llamadas:
- Los issues abiertos con el label `ronin`, con su descripción, de donde salen las slices (`parseSlices`).
- Todos los PRs abiertos, con cada check (`listOpenPrsWithChecks`).

A eso se suman los motivos de bloqueo y las previews arriba.

Cada repo se vuelve a leer a los `DASHBOARD_GITHUB_TTL_SECONDS` (60), o antes si una corrida suya empezó o terminó después de la última lectura. Mientras tanto se muestra la lectura anterior, así que varias pestañas abiertas no multiplican las llamadas. Si GitHub falla, se conserva la última lectura con el error, que la página muestra, y las corridas locales se siguen viendo. Las previews no entran en esa caché: son archivos de esta máquina y se leen en cada pedido, así que una preview que terminó de preparar sus datos ofrece su URL en el siguiente refresco.

`dashboard-items.ts` arma los ítems de la barra lateral con eso y con las corridas: estado, lo que espera cada issue, slices, el PR que avanza y su preview.

**La ficha** (`dashboard-detail.ts`) se lee aparte, solo cuando alguien abre un ítem: la descripción del issue y la del PR, con los labels y, en un PR, sus ramas y si tiene conflictos (`getDiscussion`, con `gh issue view` y `gh pr view`). Trae los últimos 50 comentarios del ítem, sin los comentarios de review de línea. Qué es cada número sale de la lectura del repo en caché:
- **Un issue** trae el PR de su slice que avanza.
- **Un PR de una slice** trae su issue de tracking, por el checklist o por la rama `ronin/<issue>/…`.
- **Lo que GitHub no lista** (el PR de una persona, un issue cerrado) usa lo que dicen sus corridas.

La caché es la misma idea que la de los repos: `DASHBOARD_GITHUB_TTL_SECONDS`, o antes si una corrida del ítem empezó o terminó después. Después de una acción se descarta la del repo, para que la próxima lectura ya traiga el comentario de ronin. Una ficha que nadie abre en 30 minutos se olvida.

#### 15.9 API

Todo, salvo los webhooks y `/api/auth/*`, pide sesión:

| Ruta | Qué devuelve |
|---|---|
| `GET /api/snapshot` | Los ítems, el uso de cada cuenta, los cupos, la cola, el último tick, las previews y el estado de la lectura de GitHub |
| `GET /api/today` | Las corridas de las últimas 12 horas y los totales de hoy y de ayer |
| `GET /api/items/<id>` | Las corridas de un ítem en los últimos 14 días |
| `GET /api/items/<id>/detail` | Su ficha: el issue y el PR con los comentarios del ítem, y las acciones que se le pueden pedir, cada una con el comentario que dejaría |
| `POST /api/items/<id>/actions` | Pide una de esas acciones: `{ action, text? }` (15.11) |
| `POST /api/repos/<owner>/<repo>/issues` | Crea un issue a nombre de la persona y, si se pide, lo asigna a ronin o le comenta `/spike` o `/spec`: `{ title, body, after, app?, instruction? }` (15.11.1) |
| `GET /api/items/<id>/exploration` | Las fichas de un PR de exploración abierto, leídas en partes, con su hilo (15.12) |
| `POST /api/items/<id>/exploration/actions` | Comenta en una ficha: `{ action, ficha, text, redo? }` (15.12) |
| `POST /api/items/<id>/exploration/general` | Un comentario general en el PR: `{ text }` (15.12) |
| `POST /api/items/<id>/exploration/approve` | Aprueba el PR: `{ text? }` (15.12) |
| `GET /api/items/<id>/files` | Los archivos del PR del ítem con su patch, y sus hilos de review (15.14) |
| `GET /api/items/<id>/files/content?path=` | Uno de esos archivos en el head del PR, para mostrar más líneas |
| `GET /api/items/<id>/files/mine` | Lo que la persona marcó como visto y su revisión pendiente |
| `POST /api/items/<id>/files/actions` | Comenta, responde, resuelve, marca visto o maneja la revisión: `{ action, … }` (15.14) |
| `GET /api/runs/<runId>` | El transcript de una corrida |
| `GET /api/runs/<runId>/stream` | Lo que se le agrega, por *server-sent events*, hasta que termina |
| `GET /api/evidence/<owner>/<repo>/<sha>/<ruta>` | Una captura que publicó ronin (§11.5), leída del clon del repo de producto |

En la ficha, las imágenes de los comentarios son enlaces, salvo las capturas que publicó ronin. El enlace de GitHub de una captura (`evidenceUrl`) solo carga con sesión de GitHub, y un `<img>` del tablero no la lleva. Por eso el servidor la lee de su propio clon con `git cat-file`: `publishEvidence` la commitea ahí antes del push. Solo sirve imágenes y solo de commits de la rama `ronin/evidence`. Si el sha no está, hace un `fetch` de esa rama, como mucho uno por minuto por repo. Si la imagen no carga, vuelve a ser el enlace `[imagen]`.

#### 15.10 Activarlo

1. Crear una OAuth App en GitHub (*Settings → Developer settings → OAuth Apps*) con callback `<DASHBOARD_URL>/api/auth/callback`.
2. Completar en `.env` `DASHBOARD_GITHUB_CLIENT_ID`, `DASHBOARD_GITHUB_CLIENT_SECRET`, `DASHBOARD_SESSION_SECRET` (`openssl rand -hex 32`), `DASHBOARD_ALLOWED_USERS` y `DASHBOARD_URL` (por ejemplo `https://<host>.<tailnet>.ts.net:8443`).
3. `pnpm build && pnpm server:setup`. `server:setup` instala `ronin-server` (y desinstala el `ronin-webhook` de antes si lo encuentra) y publica el 8443 en la tailnet.

#### 15.11 Acciones (`server/api/dashboard-actions.ts`)

Desde la ficha se le piden a ronin los comandos que hoy se piden comentando en GitHub. El botón *Acciones* muestra solo los que aplican al ítem en ese momento:

| Acción | Igual que | Cuándo aparece |
|---|---|---|
| Resolver conflictos | `/resolve-conflicts` | PR abierto. Se destaca si tiene conflictos con su base |
| Levantar o actualizar la preview | `/preview <qué preparar>` | PR abierto. Lleva un texto opcional |
| Bajar la preview | `/preview stop` | Hay una preview arriba |
| Activar o desactivar el auto-merge | `/auto-merge`, `/auto-merge off` | Según si el PR tiene `ronin:auto-merge` |
| Responder y destrabar | Comentar y volver a `ronin:in-progress` | Issue con `ronin:blocked`. Lleva un texto obligatorio, la respuesta |

En un issue, las acciones de PR van al PR de su slice que avanza ("Resolver conflictos en #849").

**Cómo corre.** El tablero escribe el comando como la persona, con su token (`server/api/github-as-user.ts`): `@ronin-agent /resolve-conflicts`, o `@ronin-agent /preview` con lo que hay que preparar en las líneas de abajo, que el parser de `/preview` también lee. Desde ahí es un comentario como cualquiera: llega su webhook, ronin le pone 👀 y lanza el worker, que lo responde. GitHub muestra quién lo pidió. Responder y destrabar comenta la respuesta como la persona, y ronin le pone `ronin:in-progress` al issue; si GitHub rechazó el comentario, el label no se toca.

Antes de #93, ronin comentaba *"**<login>** pidió `/x` desde el tablero"* y lanzaba el worker en el momento. Ahora el worker espera al webhook, como cuando alguien escribe en GitHub, y si no llega lo levanta el tick.

**Antes de pedirla,** un diálogo muestra el comentario que va a quedar ("Comentás en #849 como oskr814"), renderizado y actualizado mientras se escribe. El servidor la valida contra la misma lista, armada con lo que leyó de GitHub. Si la acción ya no aplica, o le falta o le sobra el texto, responde 409 sin comentar nada. Si GitHub ya no acepta el token de la persona, responde 401 y la página pide volver a entrar.

**No están** `/fix-comments` (va con la revisión de un PR, 15.14) ni `/spike`, aunque ahora que las acciones son comentarios sumarlos es agregarlos a la lista. Tampoco cancelar o reintentar una corrida, que necesitan coordinarse con los locks del tick.

**Pendiente:** cancelar y reintentar corridas, `/spike` desde la página, una vista de varios runners juntos y sacar el alias `/webhook`.

#### 15.11.1 Nuevo issue (#100, `server/api/dashboard-new-issue.ts`)

Cada repo de la barra lateral tiene un botón **+** que abre *Nuevo issue*: título y descripción (markdown, con vista previa) y qué hacer después.

- **Cómo se crea:** en GitHub, a nombre de quien entró y con su token (`createIssue` en `github-as-user.ts`, como las acciones de 15.11). No pasa por Linear: con la sincronización bidireccional aparece allá solo, y el botón sigue andando si se deja Linear.
- **Después de crearlo**, una de cuatro:
  - **Solo crearlo.**
  - **Asignárselo a ronin:** el issue se crea ya asignado a la cuenta de ronin, que lo toma como cualquier issue asignado (`discoverAssignedIssues`).
  - **Pedir `/spike <app>`** o **`/spec <app>`:** un comentario a nombre de la persona, con una de las apps del `ronin.app.json` del repo (`repoApps`, que el snapshot manda en `apps`) y una instrucción opcional. Le llega a ronin por su webhook, como uno escrito en GitHub.
- **Con Linear,** dos selectores opcionales: el proyecto (los activos del equipo) y el ciclo (el actual y los que vienen). Salen de `teamPlanning`, que va con la lectura de Linear (15.13). El issue se crea igual en GitHub. La elección queda pendiente (`core/linear-assign.ts`) y el servidor la aplica en cuanto la sincronización crea el issue en Linear: reintenta durante 5 minutos, y lo que quede lo aplica el tick.
- **Al terminar:** la lectura del repo se descarta (`forgetGithub`), así el snapshot siguiente lista el issue, y la página abre su ficha.

`POST /api/repos/<owner>/<repo>/issues` con `{ title, body, after, app?, instruction? }`. Pasa por las mismas defensas que cualquier POST del tablero (origen, sesión, JSON). Un rechazo de GitHub (un 401 con la sesión vencida, o un 403/404 cuando la organización restringe las apps OAuth) se explica igual que en 15.11.

#### 15.12 Revisar una exploración (#93)

En GitHub, un PR de exploración (§11.7) cuesta revisarlo: "Files changed" muestra cada ficha como diff de markdown, así que las capturas se ven abriendo archivo por archivo; `inventory.yml`, `knowledge.md` y `runs/` aparecen en el medio; y para decidir hay que comentar el archivo de cada ficha. La pestaña *Fichas* de su ficha en el tablero es para eso.

- **La lista.** Las fichas que trae el PR (`findingsAddedOverBase`, como el digest), agrupadas por cómo están:
  - **Por decidir:** nadie la comentó.
  - **Esperando a ronin:** el último comentario es de una persona, y es nuevo o es una respuesta que lo menciona; los mismos que toma `pendingFeedback`.
  - **Respondidas por ronin.**
  - **Listas para aprobar.**
  - **Aprobadas** y **rechazadas,** según su archivo.

  Arriba, "Revisadas X de N" y filtros por tipo y por viewport. Abajo, las corridas del PR.
- **La ficha.** Leída en partes con `parseFindingBody` (`exploration/output.ts`, el inverso de `renderFindingBody`):
  - Qué pasa y qué se esperaba.
  - El antes y el después lado a lado, con miniaturas si hay varias capturas del antes y una vista en grande (←/→ recorre las del antes). Si ronin rehízo el después, *ver la anterior* muestra la que reemplazó, buscada en la historia del archivo aunque el título y el nombre hayan cambiado.
  - La propuesta.
  - Plegados: los pasos, la evidencia y el cambio borrador.
  - Su hilo, con una caja para comentar.
- **Navegación.** `j`/`k` pasa de ficha y la ficha abierta queda en la URL (`?f=backoffice/F-0017`). En el celular, primero la lista y después la ficha.
- **Decidir.** Cada acción es un comentario sobre el archivo de la ficha (`subject_type: file`), escrito como la persona: lo que escribiría en "Files changed". `exploration/flow.ts` lo lee como cualquier comentario en una ficha y no necesita la mención, porque un comentario nuevo en una ficha ya es feedback.

  | Botón | Lo que queda comentado |
  |---|---|
  | Rechazar (`r`), con motivos rápidos | `Rechazo esta ficha: <motivo>` |
  | Pedir cambios (`c`) | el texto; con *Rehacer la captura del después*, suma `También hay que rehacer la captura del después.` |
  | Pedir un issue aparte | `Abrí un issue aparte: <texto>` |
  | Preguntar, o la caja del hilo | el texto tal cual |
  | Aprobar (`a`) | nada todavía: es una marca del navegador (`localStorage`) que la pasa a *Listas para aprobar* y cuenta para el progreso; la ficha se aprueba de verdad al aprobar el PR |

  En una ficha ya rechazada o aprobada solo se puede preguntar o comentar. Mientras alguna espera a ronin, la página vuelve a leer las fichas cada 10 s en vez de cada 30.
- **Comentario general.** `@ronin-agent <texto>` en el PR, como la persona, para decidir sobre varias fichas a la vez o dejar en `knowledge.md` lo que no hay que volver a proponer (lo lee `pendingGeneralFeedback`).
- **Aprobar.** Antes de enviar, el diálogo muestra qué fichas abren issue, cuáles quedan rechazadas y cuáles nadie revisó. Lo que envía es una review *Approve* a nombre de la persona, con un comentario opcional. Desde ahí sigue el gate de siempre: `approveAndMerge` marca las fichas, abre sus issues y mergea. No se puede aprobar mientras ronin esté aplicando un comentario, que podría rechazar alguna ficha.
- **De dónde sale.** `GET /api/items/<id>/exploration` (`server/api/dashboard-exploration.ts`) lee las fichas del clon del repo de producto, en la rama del PR, como `dashboard-evidence.ts` lee las capturas. Antes trae la rama y su base con un `fetch`, como mucho uno por minuto. Los hilos salen de `listFileReviewComments`, agrupados por app e id de ficha. Usa la misma caché que la ficha (15.8), y se descarta después de comentar desde la página.

#### 15.13 Linear en el tablero (#101)

Para un repo con `"linear": { "apiKeyEnv": "…" }` en `repos.json` y esa key en `.env`, el tablero lee de Linear (`server/api/dashboard-linear.ts`, sobre `core/linear-api.ts`), con la misma caché y el mismo manejo de errores que la lectura de GitHub (§15.8). Dos consultas GraphQL por repo:

- **Los issues de ronin:** el issue de Linear de cada issue abierto que gestiona ronin, buscado por la URL del issue de GitHub (el *attachment* que deja la sincronización). Trae identificador, estado, proyecto, ciclo y asignado. Va en cada ítem del snapshot (`item.linear`).
- **El ciclo actual del equipo:** el equipo es el de cualquier issue del repo en Linear, así que `repos.json` no lo nombra. Trae fechas, el historial diario de issues en el ciclo y hechos (el mismo que usa el gráfico de Linear) y sus issues. Va en `/api/today` (`cycles`). Cada issue del ciclo cae en un estado (`cycleView`): los de ronin según GitHub (bloqueado, PR abierto = en review, si no ronin trabaja) y los del equipo según su estado en Linear (completed = hecho, started = en curso o en review si el estado se llama así, el resto sin empezar).

En la página:
- **Barra lateral:** un filtro *Ciclo N / Todos* y otro por proyecto, recordados en el navegador. Cada ítem muestra su `RED-n` y su proyecto.
- **Ficha:** chips de proyecto y ciclo, y una sección *Linear* en el panel de contexto.
- ***Hoy*:** el ciclo actual (§15.1).

Los colores de los proyectos siguen al proyecto: los conocidos en orden alfabético, los cuatro primeros con un color de la paleta (`--proj-*`, validada para daltonismo) y el resto en gris. Sin key, nada de esto aparece y el tablero funciona como antes.

#### 15.14 Revisar un PR (#111)

La pestaña *Archivos* de la ficha de un PR (o de un issue, con los archivos de su PR que avanza) es "Files changed" en el tablero, y desde ahí se revisa: comentarios por línea, sugerencias, respuestas y la revisión con Comentar, Aprobar o Pedir cambios. Todo lo que escribe sale a nombre de quien entró, con su token (`github-as-user.ts`, 15.3). Llega a ronin como si se hubiera escrito en GitHub.

- **Leer** (`server/api/dashboard-files.ts`):
  - **Los archivos** de `pulls/<n>/files`, paginado, con su patch. GitHub lista como mucho 3000, y deja sin patch a los binarios y a los muy grandes, que la página muestra con un link a GitHub.
  - **Los hilos de review** por GraphQL (`getDiffThreads`), con su lado, su línea o rango, si son sobre el archivo, si están resueltos o desactualizados y los ids que hacen falta para responderlos y resolverlos.
  - Se leen con el token de ronin y usan la misma caché que la ficha (15.8).
  - **"Mostrar más líneas"** lee el archivo en el head del PR (`/files/content`, solo archivos que el PR cambia, hasta 1 MB, en caché por commit).
- **La pestaña:**
  - el árbol de archivos con filtro, estado, +/−, los hilos sin resolver y "N de M vistos";
  - el diff unificado o lado a lado (en el celular, unificado);
  - cada hilo bajo su línea. Los resueltos van plegados; los que son sobre el archivo, o sobre código que ya cambió, van arriba del archivo;
  - los diffs de más de 400 líneas y los archivos vistos empiezan plegados;
  - `j`/`k` pasan de archivo, `v` marca visto y salta al siguiente sin ver, `r` abre la revisión.
- **Comentar:**
  - **Una línea:** clic en su número, del lado viejo o del nuevo. Shift+clic elige un rango del mismo lado y del mismo hunk. Las líneas de contexto que se agregan con "mostrar más" no se pueden comentar, porque GitHub solo acepta líneas del diff.
  - **El archivo entero:** "Comentar archivo".
  - **El editor:** markdown con vista previa. "± Sugerir cambio" agrega un bloque `suggestion` con esas líneas.
  - **El commit:** el comentario va sobre el commit que se está viendo, así las líneas son las del diff que se vio.
  - **En los hilos,** "Responder…" (al último comentario, como en GitHub) y "Resolver conversación" o "Reabrir".
- **Visto** es el "Viewed" de GitHub (`viewerViewedState`, `markFileAsViewed`): se lee y se marca con el token de la persona, y GitHub lo quita solo cuando el archivo cambia.
- **La revisión es la revisión pendiente de GitHub,** no un borrador del navegador:
  - sigue ahí al recargar o al cambiar de dispositivo, se ve en github.com, y una empezada allá aparece en el tablero;
  - "Empezar una revisión" la crea sobre el commit a la vista (`addPullRequestReview`). Desde ahí, cada comentario o respuesta "Se suma a la revisión" (`addPullRequestReviewThread`, `addPullRequestReviewThreadReply`);
  - lo pendiente se ve en el diff como *Pendiente*, con editar y borrar, y solo lo ve su autor;
  - se lee de los hilos del PR con el token de la persona: cada comentario dice si está `PENDING`, y los pendientes de otros no aparecen.
- ***Revisar*** / ***Terminar revisión***, en la cabecera de la ficha (en un issue, *Revisar PR #N*, para su PR que avanza), en la barra de *Archivos* o con `r`:
  - **El panel:** un resumen, Comentar / Aprobar / Pedir cambios y la lista de lo pendiente.
  - **Se cierra** con la ×, con Escape o con un clic fuera de él, salvo mientras se manda.
  - **Mandar:** `submitPullRequestReview`. Sin nada pendiente, va una revisión con solo el resumen (aprobar sin comentarios).
  - **Descartar:** `deletePullRequestReview`.
  - **En un PR propio,** aprobar y pedir cambios no se ofrecen y el servidor los rechaza, como GitHub.
  - **En un PR de exploración** el panel no aparece: se aprueba con su propio gate (15.12).
- **Que ronin la atienda.** ronin no lee el resumen de una review (`findUnprocessedMentions` lee los comentarios sueltos y los de review), y sus comentarios solos no disparan `/fix-comments`. Por eso, en un PR de ronin con comentarios pendientes o pidiendo cambios, el panel ofrece *Que ronin los atienda ahora*: después de mandar la revisión comenta `@ronin-agent /fix-comments` a nombre de la persona.
- **API** (15.9):
  - `GET /api/items/<id>/files`, `/files/content?path=` y `/files/mine`. Este último trae lo visto y la revisión pendiente de la persona, sin caché.
  - `POST /api/items/<id>/files/actions` con `action`:
    - `comment` y `reply`, con `review: true` para que vayan a la revisión;
    - `resolve`, `viewed`;
    - `pending-edit` y `pending-delete`;
    - `discard`;
    - `submit` (`event`, `text`, `commitId`, `fixComments`).
  - Cada pedido se valida contra el PR leído: un archivo que cambia, un hilo o comentario suyo, un comentario de la revisión de la persona. Si no pasa, responde 400; lo demás lo decide GitHub y la página muestra su mensaje.
  - Después de escribir algo público se descartan las cachés de archivos y de la ficha. Lo pendiente y lo visto no las tocan.

## Estado actual

- [x] Definir el esqueleto del supervisor (script + estructura de tick) — ver §3.1 y `src/`
- [x] Definir el template del issue de tracking (checklist de slices) — ver [`templates/tracking-issue.md`](../templates/tracking-issue.md) y §2.1
- [x] Definir el criterio exacto de "bloqueo" que dispara notificación — ver [`docs/BLOCKING.md`](BLOCKING.md)
- [x] Prototipo de la app de notificación por email — ver `src/core/notifier.ts`
- [x] `agent-task.ts`: invocación de `claude -p` en un worktree aislado (ciclo de vida básico, prompts por tipo de tarea, en inglés — ver §8) — ver `src/core/worktree.ts`, `src/core/claude-runner.ts`, `src/core/agent-task.ts` y §7.1
- [x] Estado persistente entre ticks: índice de slice actual (`src/slices/checklist.ts`, parseado del propio checklist del issue) y contador de reintentos por PR (`ronin:attempts-N`, labels en `src/core/github.ts`) — ver §3.1
- [x] Claim entre múltiples supervisores concurrentes — ver `src/core/claim.ts` y §9
- [x] Descubrimiento por asignación manual vía PR (reemplaza el escaneo de frontmatter local) — ver §1, resuelve de paso el gap de descubrimiento duplicado que tenía la versión anterior de §9
- [x] Recurrencia vía cron (no tmux) — `scripts/setup-cron.sh`, con `flock` para que un host nunca corra dos ticks solapados
- [x] Límite de uso de Claude como estado transitorio, no como bloqueo — `ClaudeUsageLimitError` (§3)
- [x] Limpieza de worktrees cuando su PR ya no está abierto — `sweepOrphanedWorktrees` (§3.1)
- [x] Reacción por evento: un handler por evento de GitHub, el tick como conciliación — `server/api/webhooks/handler.ts`, `core/locks.ts` (§14)
- [x] Tablero web en la tailnet, con login de GitHub, la ficha de cada ítem, acciones y la revisión de PRs (§15.14) — `server/`, `web/`, `core/run-record.ts`, `core/claude-usage.ts` (§15)
- [x] ~~Evidencia visual de e2e en el PR~~ — eliminado (el `src/evidence.ts` de entonces; el `evidence-store.ts` actual es el de la exploración, §11.5); no reemplazaba la supervisión humana y la calidad no era suficiente — ver [issue #4](https://github.com/Oskr814/ronin/issues/4)

**Pendiente, fuera de este scaffold:**

- Nunca se probó en vivo contra un PR real con specs de e2e afectados (el dry run de §10 usó un spec sin ningún componente de UI)
- Exploración y propuestas de mejora (§11): implementadas las etapas 1 a 5 (`app:up` y smoke, memoria, inventario y selección, exploración con navegadores y evaluador, PR de exploración rodante, ventana nocturna, entrevistas por Remote Control y `/spec`). Pendiente: calibrar la calidad de las propuestas con varias corridas a mano antes de activar la exploración nocturna (`explore` en `repos.json`)

- Slugs de slice legibles: hoy el branch de `implement-slice` usa el índice crudo (`slice-1`, `slice-2`); una vez que se valore la legibilidad de branches/PRs, debería derivar el slug del título real de la slice
- Decidir si Copilot review se activa (`REQUEST_COPILOT_REVIEW`) y cómo se resuelven sus comentarios automáticamente
