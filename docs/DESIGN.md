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
| `webhooks/` | el servidor de webhooks, el dispatcher de eventos y el handler por evento (§14) |
| `changelog/` | publicación del changelog en cada release |

**Imports:** dentro de una carpeta se importa el archivo directo (`./flow.js`); entre features, por el barrel de la carpeta (`../review/index.js`), que reexporta todo lo que no es entrada. `core/` no tiene barrel y se importa por archivo (`../core/config.js`): `config.ts` falla al cargar si faltan env vars, y módulos como `webhooks/events.ts` tienen que poder cargarse sin ellas. Los workers (`*-worker.ts`, `*/worker.ts`) y `webhooks/server.ts` son procesos aparte: no van en los barrels y se lanzan por su ruta relativa a `src/` (`launchWorker('preview/worker', …)`). Los tests importan y mockean el archivo concreto, no el barrel.

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

- **Dispatcher** (`webhooks/events.ts`, `scopeForEvent`): traduce el evento a un *scope*: los flujos que ese evento puede mover y los recursos que toca. Por ejemplo, un comentario en un PR mueve `issues`, `idle-commands`, `review` y `exploration` sobre `pr-N`; el CI que termina mueve `auto-merge` e `issues` sobre cada PR de la suite; un PR en una rama `ronin/<issue>/…` suma `issue-<issue>`. Un evento que nada mueve se ignora.
- **Comandos directos**: un comando en un PR (`/help` y comandos mal escritos, `/preview`, `/resolve-conflicts`, `/auto-merge`) va solo al flujo `pr-commands`, que corre `findUnprocessedMentions` de ese PR y nada más: no lista issues ni PRs ni corre el pipeline. `/fix-comments` sí sigue por su flujo, porque lo atiende el pipeline del issue o la review. Como ese handler no toma el issue, el tick puede estar leyendo el mismo comando: cada comentario se toma con un lock propio y, una vez tomado, se vuelve a mirar si ya está procesado (`claimComment` en `mentions.ts`), así nunca se responde dos veces.
- **Lo propio no cuenta**: los comentarios y reviews de la cuenta de ronin no lanzan nada; sus PRs sí (uno recién abierto es parte del stack de un issue).
- **Servidor** (`webhooks/server.ts`): pone 👀 en un comentario que menciona a ronin apenas llega (`addAckReaction`), antes de procesarlo. Junta los eventos sobre lo mismo durante `WEBHOOK_DEBOUNCE_MS` (1 s: lo que llega después lo junta el handler que espera) y lanza un handler. Distintos PRs o issues tienen handlers propios, a la vez.
- **Handler** (`webhooks/handler.ts`): un proceso por evento, como los workers. Corre los mismos flujos que el tick (`runScoped` en `tick.ts`), pero solo los del scope y solo los jobs que tocan sus recursos, con un discovery acotado (`findPrsNeedingReview([N])`, `findIssueCommands([N])`). A un comentario en un PR, que llega sin rama, le busca el issue del PR. Si ya hay otro handler esperando para el mismo scope, no hace falta otro: el que espera va a leer todo cuando le toque.
- **Tick** (cron): sigue corriendo todos los flujos sobre todo, como conciliación. Levanta lo que ningún handler hizo (un webhook que no llegó, un runner apagado) y el trabajo periódico (entrevistas, exploración nocturna, poda de estado).

**Un solo emoji, "procesado" aparte** (`core/processed-comments.ts`): el 👀 de ronin solo dice "recibido" — lo pone el servidor al llegar el comentario, o el flujo que lo procesa si el webhook nunca llegó. Que un comentario ya está atendido se guarda en el estado local (`processedComments`, por repo), y solo cuando el trabajo salió bien: una falla no se anota y se reintenta, como antes. Un comentario de antes de este cambio cuenta como atendido si el 👀 de ronin es anterior a `ACK_EYES_SINCE` (el deploy en el runner, 2026-10-16T01:03:19Z), que es cuando el 👀 todavía significaba "procesado"; el 👀 de acuse, posterior, no cuenta. Es una fecha fija a propósito: tomarla de la primera lectura del estado dejaba afuera el acuse que el servidor pone segundos antes de esa lectura, y ese comentario se daba por atendido sin responderse. Uno de más de 180 días cuenta como atendido siempre, y por eso las entradas de más de 180 días se podan. Es estado de este runner: con un solo runner por repo (hoy `ronin-agent`) no hace falta compartirlo; varios runners sobre el mismo repo necesitarían volver a guardarlo en GitHub.

**Quién trabaja en qué** (`core/locks.ts`): cada job declara el recurso que toma (`issue-N` para todo el stack de un issue y sus worktrees `ronin/N/*`, `pr-N` para un PR ajeno o de exploración, `changelog`), y los pasos de todo el repo (`assign`, `sweeps`, `auto-merge`) tienen su propio lock. Son archivos con el pid del proceso en `<worktreeBasePath>/.locks/`, así que uno que dejó un proceso muerto se toma.
- El **tick** saltea lo que está tomado: quien lo tiene ya lo está atendiendo.
- El **handler** toma todos los recursos de su scope antes de leer nada de GitHub, esperando a quien los tenga, en orden (no hay deadlock entre handlers). Lo que lee después es el estado posterior a lo que hizo el otro, nunca el de antes. Un job suyo con un recurso que no estaba en el scope (el issue que acaba de crear una asignación) lo toma sin esperar.
- `sweepOrphanedWorktrees` solo borra el worktree de un issue que nadie tiene tomado: un handler puede estar implementando una slice que todavía no tiene PR. El `plan` de un spec toma su issue mientras corre por lo mismo.

**Cupo compartido**: `TICK_CONCURRENCY` y los topes por tipo (`EXTERNAL_REVIEW_CONCURRENCY`, changelog y exploración de a uno) valen para el runner entero, no por proceso: cada job toma un slot de `.ronin-slots/` (de su tipo y del total) antes de correr, y espera si no hay. Los jobs que nunca corren un agente (comandos, lanzar un worker) no toman slot: un `/help` no espera detrás de tres `claude -p`.

**Estado local entre procesos**: `.ronin-state.json` se escribe con un lock de archivo además de la cola en memoria, y atómicamente (se escribe aparte y se renombra), así nadie lee un archivo a medio escribir y lo toma por vacío.

**Métricas**: el handler loguea `event_start` con `delayMs` (desde que llegó el evento hasta que tiene sus recursos) y `event_complete` al terminar, junto al `tick_complete` del tick.

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
- [x] Reacción por evento: un handler por evento de GitHub, el tick como conciliación — `webhooks/handler.ts`, `core/locks.ts` (§14)
- [x] ~~Evidencia visual de e2e en el PR~~ — eliminado (el `src/evidence.ts` de entonces; el `evidence-store.ts` actual es el de la exploración, §11.5); no reemplazaba la supervisión humana y la calidad no era suficiente — ver [issue #4](https://github.com/Oskr814/ronin/issues/4)

**Pendiente, fuera de este scaffold:**

- Nunca se probó en vivo contra un PR real con specs de e2e afectados (el dry run de §10 usó un spec sin ningún componente de UI)
- Exploración y propuestas de mejora (§11): implementadas las etapas 1 a 5 (`app:up` y smoke, memoria, inventario y selección, exploración con navegadores y evaluador, PR de exploración rodante, ventana nocturna, entrevistas por Remote Control y `/spec`). Pendiente: calibrar la calidad de las propuestas con varias corridas a mano antes de activar la exploración nocturna (`explore` en `repos.json`)

- Slugs de slice legibles: hoy el branch de `implement-slice` usa el índice crudo (`slice-1`, `slice-2`); una vez que se valore la legibilidad de branches/PRs, debería derivar el slug del título real de la slice
- Decidir si Copilot review se activa (`REQUEST_COPILOT_REVIEW`) y cómo se resuelven sus comentarios automáticamente
