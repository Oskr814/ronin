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
- **Autonomía en el descubrimiento, no en el criterio de merge.** El agente decide solo cómo trocear un spec, pero **un PR de slice no se mergea sin la aprobación de un humano**. Por defecto sale con `ronin:auto-merge` (§13), así que esa aprobación, con el CI en verde, es la que lo mergea. Sin el label (si alguien lo saca, o en un repo con `autoMerge: false`) lo mergea el humano, cuando le conviene, y ronin se entera en el tick siguiente. Fuera de las slices hay dos casos más: el PR del spec, que se mergea al aprobarlo (el de `/spec`) o al marcarlo *ready for review* (el de una persona), porque es documentación (§1), y el PR de exploración, al aprobarlo (§11.7). Las dos últimas pasan por `mergePullRequest`, que lanza sin approval explícito. Este gate no es negociable.
- **La revisión humana se mantiene, pero en PRs pequeños.** El review sigue siendo manual (técnica de stacked PRs), la mejora es que cada PR sea revisable en minutos, no horas.

## Arquitectura

Hacia dónde va la arquitectura del sistema (Postgres, cola de trabajos, Docker, API y frontend, y la proyección de runners) está en [`ARCHITECTURE.md`](ARCHITECTURE.md). Este documento sigue contando cada feature tal como está hoy.

### 1. Descubrimiento de specs

El spec es un **PR contra el repo del producto** (ej. `bmedical`), con el archivo `.md` en `docs/ronin/specs/` — sin frontmatter, un doc markdown normal, igual que los specs ya existentes en el repo.

Flujo:

1. **El PR.** Hay dos orígenes:
   - **Una persona** escribe el spec, abre el PR **en draft** y lo asigna a la cuenta de ronin (`RONIN_GITHUB_LOGIN`) con el picker de Assignees de GitHub. Mientras está en draft, el agente no lo implementa: puede seguir iterando el contenido sin que nada arranque.
   - **ronin** lo escribe con `/spec` desde un issue (rama `ronin/<issue>/spec`) y abre el PR asignado a su cuenta, sin draft. Se conversa en el PR (§1.1).
2. **La señal.** El spec de una persona arranca cuando lo marca **ready for review**. El de `/spec`, cuando una persona lo **aprueba** (*Aprobar* en el tablero, 15.15, o *Approve* en GitHub): con un solo archivo, el draft era un paso más sin nada que revisar en el medio. Un `/spec` viejo que siga en draft también arranca al aprobarlo. Es la única señal: ningún comentario la reemplaza. El evento `pull_request_review` corre el flujo `assign`, así que arranca en el momento.
3. **El arranque.** El runner detecta el PR (abierto, asignado a su cuenta, con su señal y sin un label de estado `ronin:in-progress`/`done`/`blocked` — `specPrsToStart` en `github.ts`), lo marca `ronin:in-progress` antes de cualquier otra cosa, lo saca de draft si hace falta y lo mergea (sin el gate de approval que aplica a PRs de implementación — es documentación, no código de producto). Después:
   - **El de `/spec`** sigue en **el issue de donde salió** (`adoptSpecOrigin` en `tick.ts`): su descripción queda como la escribió la persona, con una sección `## Spec` con los enlaces al final, y lleva `ronin`. El plan corre con `keepBody`: la acción `issue.update-body` agrega al final la sección `## Slices` en vez de reemplazar la descripción. Al ser el mismo issue, conserva su proyecto de Linear, y en un pedido del portal la persona se entera de que está resuelto recién cuando se cierra, con la última slice.
   - **El de una persona** abre un issue de tracking nuevo, `[spec] <título>`, con la plantilla, y el plan reemplaza su descripción.
   
   Cuando se mergea la última slice, el issue pasa a `done` y después se cierra como *completed* (en ese orden: cerrado mientras sigue `in-progress`, lo tomaría `finishClosedIssues`).

Por qué asignación manual y no descubrimiento automático: nada arranca hasta que un humano asigna el PR y lo saca de draft (o aprueba el de `/spec`), así que ronin nunca toma un spec a medio escribir ni uno que nadie le pidió. Lo que la asignación no resuelve es el caso de dos PRs que describen lo mismo: se procesan como dos specs distintos, y eso es un problema de proceso humano, no una condición de carrera en el código (§9).

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
el propio agente (tarea `fix-issue`, ver `domains/slices/prompts.ts`) juzga la claridad del
issue como parte de la misma corrida: si no tiene contexto suficiente para
actuar sin adivinar, comenta en el issue pidiendo lo que falta y termina su
respuesta con la línea `RONIN_STATUS: needs-info` en vez de abrir un PR
(`RONIN_STATUS: done` si sí lo abrió). El supervisor lee ese marcador
(`needsMoreInfo` en `tick.ts`) y marca el issue `ronin:blocked` cuando el
agente se abstuvo — sin esto, el issue quedaría reintentándose sin límite en
cada tick. Ver
[`docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md`](superpowers/specs/2026-07-28-bug-issue-intake-design.md)
(diseño original, desde entonces generalizado de "solo bugs" a cualquier issue asignado).


#### 1.1 Conversar un spec de ronin en su PR (#241, `domains/slices/spec-revise.ts`)

Mientras el PR de un spec que escribió ronin con `/spec` está abierto y no arrancó, mencionarlo ahí abre una conversación sobre el spec, en un comentario general, en una línea del archivo o en el texto de una revisión. *Ajustar* (15.15) es una de esas menciones.

- **Detección:** en el flujo `review`, del tick y del handler de un evento, los PRs de ronin abiertos con rama `ronin/<issue>/spec`, en draft o no. Se buscan las menciones sin procesar con `findUnprocessedMentions`, que antes contesta los meta-comandos.
- **Quién puede:** cualquiera con identidad de GitHub, igual que `/fix-comments` en los PRs externos.
- **Una corrida por PR:** la tarea `revise-spec` recibe juntas todas las menciones pendientes.
  - Corre en el worktree de la rama, puesto al día con `origin` antes de empezar, para que una edición a mano en GitHub no se pierda.
  - Si se pide un cambio, edita el spec para que siga siendo un documento coherente (alcance, diseño, decisiones, cómo se trocea, criterios) y lo sube en **un commit nuevo**, sin amend ni force-push.
  - Contesta cada mención en su hilo, o con un comentario en el PR si fue general: qué cambió, con el enlace al commit, la respuesta, o qué necesita saber.
  - Si dibuja un mockup nuevo, se publica como el de `/spec`.
- **Estado en el PR:** `ronin/spec`, pendiente mientras trabaja.
- **Si falla:** las menciones quedan sin procesar y se reintentan en el tick siguiente.
- **Lo que no cambia:** aprobarlo sigue siendo la única señal para mergearlo e implementarlo, y la tarea nunca lo hace. Los specs que escribe una persona se siguen editando a mano.

### 2. Mapeo a GitHub

- 1 spec → 1 issue de tracking, con checklist de slices (generado por el paso de planning).
- 1 slice → 1 PR. Por default **secuencial**: la siguiente slice recién arranca cuando no queda ningún PR abierto del issue (la anterior ya mergeó). Con el label `ronin:stack-prs` en el issue de tracking, **apilado**: cada PR se abre con `--base` el branch de la slice anterior, sin esperar a que mergee — ver [`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`](superpowers/specs/2026-07-28-stacked-prs-design.md) para el rationale completo.
- **Linear (#101):** si el issue de tracking tiene el comentario de Linear (`<!-- linear-linkback -->`, de su bot), el supervisor agrega a la descripción de cada PR de slice `Part of RED-n`, o `Fixes RED-n` en la última slice, sobre la chuleta de comandos (`platform/linear/linear.ts`, en `processSlicePr`). Así Linear muestra los PRs en su issue y las automatizaciones del equipo lo mueven de estado. No necesita API key; un issue sin ese comentario no se toca. El tablero muestra `RED-n ↗` junto a *GitHub ↗* en la ficha. Con API key de Linear, además: proyecto y ciclo en el tablero (§15.13) y **prioridad por ciclo**: en el tick (no en los eventos), los issues del ciclo actual del equipo van primero en la cola de jobs (`cycleFirst` en `tick.ts`), así que si no alcanzan los lugares (`TICK_CONCURRENCY`) los toman antes; cada grupo en su orden de siempre. Si Linear falla, el orden queda como estaba.
- **Proyecto de los issues que abre ronin (#101, `platform/linear/linear-assign.ts`).** El issue se crea en GitHub como siempre y la asignación queda pendiente en el estado local (`linearPending`). Cada tick la aplica cuando la sincronización ya creó el issue en Linear, y la descarta si no aparece en un día.
  - **Desde la exploración** (las fichas aprobadas y "Pedir un issue aparte"): al proyecto de la app, que se configura en `repos.json` (`"linear": { …, "explorationProject": { "backoffice": "<nombre o id>" } }`).
  - **El issue de tracking de un spec:** el proyecto del issue del que salió el spec (la rama del PR es `ronin/<issue>/spec`).
  - En los dos casos, solo si el issue todavía no tiene proyecto en Linear. Un error se reintenta hasta 5 veces.
- Estado inferido de GitHub, no de memoria del agente:
  - branch existe → spec empezado
  - PR abierto → slice en curso (con `ronin:stack-prs`, pueden ser varios PRs de un mismo issue abiertos a la vez, cada uno una slice apilada sobre la anterior; sin el label, a lo sumo uno)
  - comentarios sin resolver → ciclo de fix
  - PR **approved** y en verde → espera a que un humano lo mergee; al tick siguiente ronin marca la slice como mergeada (`syncMergedSlices`), mueve a su base los PRs apilados encima y, si era la última, pasa el issue a `done`
  - issue **cerrado** con `in-progress` → el tick (`finishClosedIssues`) anota las slices que se mergearon y lo pasa a `done`, aunque le queden slices sin mergear (lo cerró una persona a mano), salvo que una de ellas tenga su PR abierto: entonces espera a ese PR. Un issue `done` que se reabre no se retoma solo
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
- `ronin:auto-merge` — en un PR: mergearlo apenas esté aprobado y en verde (§13). Lo pone ronin en sus PRs de slice, `/auto-merge` o un humano a mano.
- `ronin:propuesta` / `ronin:idea` — en los issues que abre la exploración (§11).

El body queda como contexto legible para el humano (qué slice va, qué PR corresponde, por qué está bloqueado); las labels son lo que el supervisor realmente lee para decidir la próxima acción.

### 3. Supervisor (homelab, cron)

`pnpm tick` corre y termina — no es un proceso long-running. La recurrencia la da **cron** (no un loop en tmux, que era la idea original): `scripts/setup-cron.sh <minutos>` instala una entrada de crontab que invoca el tick cada N minutos.

En producción (y en el cron) lo que se ejecuta es el build compilado en `dist/` vía `pnpm start`, generado por un paso explícito `pnpm build` — nunca se reconstruye solo, así que hay que correrlo antes de instalar el cron y de nuevo después de cada cambio de código. `pnpm tick` (que corre el código fuente directo con `tsx`, sin compilar) queda para desarrollo local y dry runs. Ver [`docs/superpowers/specs/2026-07-28-build-step-design.md`](superpowers/specs/2026-07-28-build-step-design.md) para el rationale completo.

En cada tick:

1. Escanea specs e issues asignados a la cuenta de ronin (§1) → mergea el spec, crea el issue de tracking (o, en un `/spec`, toma el issue de donde salió) y corre el plan; un issue asignado directamente pasa a ser su propio issue de tracking.
2. Barre lo que vive fuera de un issue: issues cerrados con todas sus slices mergeadas, previews de PRs cerrados o vencidas (§12) y PRs con `ronin:auto-merge` listos para mergear (§13).
3. Escanea issues abiertos `in-progress` → decide la próxima acción según el estado real del PR/CI/reviews (implementar siguiente slice, resolver comentarios de review, arreglar e2e, registrar las slices que un humano mergeó).
4. Junta el resto del trabajo: reviews de PRs de humanos y menciones en ellos, `/spike` y `/spec` en issues sin asignar, entradas de changelog, el PR de exploración y la exploración nocturna (§11.8).
5. Cada acción es una invocación de Claude no interactiva, aislada en su propio worktree, que termina al completar la unidad de trabajo — así nunca se acumula contexto entre tareas.
6. Manejo de cuota: si `claude` sale por el límite de uso de la cuenta (`ClaudeUsageLimitError` en `claude-runner.ts`), no es un bloqueo: el tick deja esa tarea como está y la retoma en un tick posterior, cuando vuelve la cuota. No hay backoff calculado a partir del reset time; el reintento es simplemente el tick siguiente. Un repo con `apiFallback` termina en el momento la corrida cortada con su API key (§19.12).
7. Bloqueo real (spec ambiguo, e2e fallando tras N intentos, feedback que no converge — ver `docs/BLOCKING.md`) → notificación por email, el loop deja ese issue en paz hasta recibir input humano.

**Un tick a la vez por host**: como un tick puede tardar (una invocación de `claude -p` puede llegar a `AGENT_TASK_TIMEOUT_MINUTES`), el wrapper que genera `setup-cron.sh` usa `flock` para que un disparo del cron mientras el anterior sigue corriendo no arranque otro tick en paralelo: deja una marca `.tick.pending` y el tick en curso, al terminar, corre otro. Los eventos de GitHub no pasan por acá: cada uno tiene su propio handler, que corre a la par del tick (§14). Esto es independiente del claim entre runners distintos (§9), que protege contra *otro host*.

Concurrencia entre issues: el trabajo de todos los flujos (issues, reviews externas, spikes, changelog, exploración) corre en un solo pool de hasta `concurrency` tareas a la vez por repo (su campo en `repos.json`, o `TICK_CONCURRENCY`), de las cuales a lo sumo `EXTERNAL_REVIEW_CONCURRENCY` son reviews externas. Cada repo es su propia cola: el tick procesa todos los repos de `repos.json` a la vez, y un repo con mucho asignado nunca deja esperando a otro (entre hosts, ver §9). *Dentro* de un mismo issue, el default es secuencial (una slice a la vez, se espera a que mergee para arrancar la siguiente); con el label `ronin:stack-prs` (§2.1) pueden estar en vuelo varias slices/PRs a la vez, cada una apilada sobre la anterior, sin esperar a que una mergee para arrancar la siguiente. Ver [`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`](superpowers/specs/2026-07-28-stacked-prs-design.md) para el rationale completo. Specs independientes sí pueden correr en paralelo en worktrees separados.

Convención de branches: `ronin/<issue>/slice-<n>` — así el supervisor encuentra el PR de la slice en curso de un issue por prefijo de branch, sin mantener un mapeo aparte.

**Setup**: `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) instala el cron; `pnpm cron:remove` lo saca. El script resuelve el `PATH` real de una shell de login (cron no fuentea `.bashrc`/`.profile`, así que `node`/`pnpm` instalados vía nvm u otro manager no estarían en el `PATH` mínimo de cron) y lo hornea en un wrapper generado (`scripts/run-tick.sh`, no versionado — específico de cada máquina).

**Logs**: `logs/tick-YYYY-MM-DD.log`, un archivo por día — la "rotación" es simplemente escribir a un path nuevo cuando cambia la fecha, sin `logrotate` ni dependencias externas. El wrapper poda archivos más viejos que el retention configurado en cada corrida. Cada línea lleva timestamp ISO (`src/platform/logger.ts`, usado en vez de `console.log` suelto) — incluye el output completo de cada invocación de `claude -p` (antes se descartaba entero; era la única pieza de "qué hizo el agente" que no quedaba en ningún lado, ni en logs ni en GitHub).

### 3.1 Implementación (`src/`)

Scaffold en TypeScript. `src/` tiene las apps y tres capas, con las dependencias en una sola dirección (`apps` → `domains` → `platform`); el detalle y las reglas están en `docs/ARCHITECTURE.md`, «Estructura del código»:

| Carpeta | Qué tiene |
|---|---|
| `apps/api/` | el servidor (`main.ts`): los dos listeners, el login y los estáticos (`http/`), el montaje de las rutas de cada dominio (`routes.ts`), la cola de trabajos (`jobs/`), el tick (`tick/`, el orquestador) y los webhooks (`webhooks/`, con el dispatcher de eventos y el handler por evento, §14) |
| `apps/dashboard/` | el tablero, en React: el marco (`src/shell/`) y sus páginas (`src/pages/`), con `public/` (el HTML, el CSS y las fuentes) tal cual (§15) |
| `apps/portal/` | el portal de pedidos, en React (§16) |
| `domains/` | un dominio por carpeta: `slices` (issues → PRs apilados), `review` (§4), `commands` (comandos por mención: `mentions.ts`, `/help`, `/auto-merge`, `/resolve-conflicts`, `/spike`, `/prototype`, pedidos en issues), `product-app` (levantar la app del producto y la rama de evidencia, §11.2, §11.5), `previews` (§12), `explorations` (§11), `portal`, `meetings`, `deploys`, `metrics`, `changelog`, `items` y `runs` (lo que lee el tablero), `settings`, `access` |
| `platform/` | lo compartido por todos: `config/`, `github/`, `linear/`, `git/` (worktrees), `claude/` (`claude -p`, cuentas y uso), `agents/` (cómo corre una tarea de agente, `agent-task.ts`, las reglas que comparten los prompts, `prompts.ts`, y el registro de corridas), `state/` (estado local, claim), `locks/`, `workers/` (el lanzador de workers), `notify/`, `db/`, los logs y las mediciones |

**Imports:** dentro de una carpeta se importa el archivo directo (`./flow.js`); entre features, por el barrel de la carpeta (`../review/index.js`), que reexporta todo lo que no es entrada. `platform/` no tiene barrels y se importa por archivo (`../../platform/config/config.js`): `config.ts` falla al cargar si faltan env vars, y módulos como `apps/api/webhooks/events.ts` tienen que poder cargarse sin ellas. Los workers (`*-worker.ts`, `*/worker.ts`), el handler por evento (`apps/api/webhooks/handler.ts`) y el servidor (`apps/api/main.ts`) son procesos aparte: no van en los barrels y se lanzan por su ruta relativa a `src/` (`launchWorker('domains/previews/worker', …)`). Los tests importan y mockean el archivo concreto, no el barrel.

Los módulos del núcleo (en `platform/` salvo que se indique otra carpeta); los de cada feature se describen en su sección:

- `config/config.ts` — env vars, labels, límites de reintento
- `github/github.ts` — wrappers sobre `gh` CLI (execFile con argv array, nunca shell string; `gh api`, con `fetch` desde #370, ver `gh-api.ts`) para issues/PRs/labels/merge/body/contador de intentos. El gate de approval está *en código*, no solo documentado: `mergePullRequest` (que usan el PR de exploración y el auto-merge) lanza si `reviewDecision !== 'APPROVED'`
- `domains/slices/checklist.ts` — parsea y edita el checklist de slices del body del issue (índice de próxima slice, marcar merged, registrar PR); es la fuente de verdad para "qué slice sigue", no un contador aparte
- `domains/slices/spec-revise.ts` — las menciones en el PR abierto de un spec de ronin: responde y edita el spec (§1.1)
- `domains/slices/spec-content.ts` — lee el contenido de un spec ya mergeado vía `git show origin/main:<path>` (nunca toca el working directory del checkout principal, así que no importa qué branch tenga el humano checked-out ahí)
- `notify/notifier.ts` — el notificador de bloqueos (nodemailer + Gmail SMTP)
- `logger.ts` — formato `[ISO_TIMESTAMP] LEVEL mensaje`, usado en vez de `console.log` suelto (ver `logs/tick-YYYY-MM-DD.log`, §3)
- `git/worktree.ts` — crea/reutiliza un git worktree desechable por branch de tarea, y los borra cuando su PR ya no está abierto (`sweepOrphanedWorktrees`)
- `claude/claude-runner.ts` — invoca `claude -p` con `--permission-mode bypassPermissions`, reenviando el PAT de la cuenta `ronin` como `GH_TOKEN` al proceso hijo (así los `gh` que el propio Claude headless corra también quedan a nombre de esa cuenta); una corrida con acciones corre con un entorno sellado (§7.3)
- `actions/` — las acciones que un agente le pide a ronin, validadas y ejecutadas con su token (§7.3)
- `agents/agent-task.ts` — corre una tarea de agente ya armada: su checkout (un worktree de su branch, un checkout que ya existe, la cabeza de un PR ajeno por SHA o la branch de un humano, separada), `claude -p` con el modelo y el esfuerzo de su tipo, el registro de la corrida, las métricas y la limpieza. No sabe de ningún tipo de tarea: cada feature arma los suyos en su `prompts.ts` (`slices/`: `plan`, `implement-slice`, `fix-issue`, `fix-e2e`, `write-spec`; `review/`: la review de PRs ajenos, `fix-review` y lo que responde a comentarios; `commands/`, `exploration/`, `portal/`, `preview/` y `changelog/`, los de sus comandos y flujos), en inglés (ver §8)
- `agents/prompts.ts` — lo que comparten los prompts: el cercado del texto que escribe la gente, las menciones con su hilo, la convención de commits y el recordatorio de las agent-notes, que llevan las tareas que cambian código para que el agente deje constancia de aprendizajes no-obvios en `docs/agent-notes/` del repo destino — ver [`docs/superpowers/specs/2026-08-18-agent-notes-design.md`](superpowers/specs/2026-08-18-agent-notes-design.md)
- `state/claim.ts` — lock por label (`ronin:runner-<runner-id>`) + cache local (`.ronin-state.json`) para que dos supervisores no procesen el mismo issue — ver §9
- `agents/run-record.ts` — el registro de cada corrida de agente en `logs/runs/`, que lee el tablero (§15.5)
- `claude/claude-usage.ts` — el uso de cada cuenta de Claude, del `rate_limit_event` de cada corrida (§15.6)
- `claude/claude-plans.ts` — el plan que paga cada cuenta de Claude, Max 5× si nadie lo eligió (§19.11)
- `claude/api-fallback.ts` — el respaldo por API de un repo: la key, el modelo y lo que le queda de su tope (§19.12)
- `apps/api/tick/tick.ts` — el loop de decisión: descubre specs asignados, y por cada issue `in-progress` decide la próxima acción leyendo el checklist y el contador de intentos por PR contra los límites de `docs/BLOCKING.md`

### 4. Testing y review externo

- El agente corre los e2e del repo del producto (p. ej. Playwright en `apps/webapp/e2e/` de bmedical) antes de abrir el PR — si la slice toca comportamiento de usuario, agrega o actualiza un spec y lo corre hasta que pase, en vez de dejárselo a CI.
- Pipelines: el agente monitorea CI y arregla lo que falla, pero el merge de un PR de slice lo hace siempre un humano.

- Review de GitHub Copilot: ronin no la pide. `REQUEST_COPILOT_REVIEW` se quitó el 2026-10-18: nunca se activó y no dio lo que se esperaba. Si alguien la pide a mano, sus comentarios se resuelven como los de una persona (`/fix-comments`).

### 5. Parte visual

Para flujos complejos, el spec incluye un link a un proyecto de Claude Design. El agente lo sincroniza vía MCP (`DesignSync` / skill `/design-sync`) para obtener la propuesta de componentes, en vez de improvisar el diseño visual.

### 6. Notificaciones

Los bloqueos se notifican por email solo cuando son reales, no en el progreso rutinario (para evitar fatiga de alertas): van a quien eligió *Bloqueos* del repo en Ajustes, o a `NOTIFY_TO` (§19.5). Las credenciales de Gmail van en variables de entorno (`GMAIL_USER`, `GMAIL_APP_PASSWORD`).

La misma cuenta manda otros dos correos, cada uno solo cuando alguien tiene algo que hacer:
- **Los del portal de pedidos** (§16.7): a la persona que pidió y al equipo del repo.
- **Los de las reuniones** (§17.5): al equipo del repo, cuando ronin propone trabajo que revisar.

Cada persona del equipo elige, repo por repo, qué le llega (Ajustes → Notificaciones, §19.5). Mientras no elige, vale la lista `portal.notifyTo` de `repos.json`; sin nadie, `NOTIFY_TO`. Un repo nunca recibe lo de otro.

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

La única contención real es que **cada tarea corre en su propio git worktree desechable** (`src/platform/git/worktree.ts`), nunca en el checkout principal (`productRepoPath` en `repos.json`) — así un comando destructivo lanzado por error solo puede arruinar ese worktree, que se puede recrear desde cero. Esto es una mitigación, no una garantía: un comando que apunte fuera del worktree (paths absolutos, `cd`, etc.) no está bloqueado por nada. Reconsiderar si en algún momento el blast radius observado no compensa la autonomía ganada.

Segunda limitación encontrada en el primer dry run: el prompt de una tarea puntual no acota lo que el agente puede decidir hacer con `gh`/`git` más allá de esa tarea — si lee contexto que contiene instrucciones para *otras* situaciones (ej. el propio template del issue), puede actuar sobre ellas aunque no vengan de su prompt. Mitigado parcialmente pasando solo la información mínima necesaria en cada prompt (ver §10) en vez de decirle al agente que lea documentos completos con instrucciones para roles que no son el suyo.

### 7.3 Acciones y skills (#257, `platform/actions/`, `plugin/`)

Lo que un agente cambia fuera de su checkout (responder, resolver un hilo, subir) deja de ir por `gh` y `git push` con el token de escritura y pasa por **acciones de ronin**: el agente las pide, ronin las valida y las ejecuta con su token. Las reglas que los prompts repetían («amend, nunca un commit nuevo», «nunca @nombre», «solo los hilos listados») quedan en código.

- **Catálogo** (`catalog.ts`): cada acción con su esquema en zod y las reglas del alcance de la corrida (`RunScope`): el PR, la rama, el commit con que empezó, los hilos y los comentarios que la dispararon, y qué acciones tiene. `git.push` solo acepta un amend del commit inicial sin cambios sin commitear. Una respuesta no puede mencionar a nadie (un scope de npm y lo que va entre comillas invertidas no cuentan).
- **Servidor** (`server.ts`): uno por corrida, HTTP en loopback, con una credencial al azar que vale para esa corrida. Atiende una acción a la vez, guarda cada llamada (las rechazadas también) y lo que dijo `result.report`. Un error de ronin no le llega al agente: solo que falló. La credencial sola no alcanza: desde que arranca el `claude` de la corrida, el servidor solo atiende a ese proceso y sus descendientes; mira en `/proc` quién tiene abierta la conexión (`peer.ts`, que necesita `SYS_PTRACE` en el runner para leer los procesos de otro usuario). Así, una corrida que le saque la credencial a otra del mismo repo no puede usarla.
- **Ejecutores** (`executors.ts`): con las funciones de `github.ts`, dentro del `withActiveRepo` de la corrida. El push va con `--force-with-lease` sobre el commit inicial: si alguien subió algo mientras, no se pisa y el agente se entera.
- **Cliente** (`bin/ronin-act`): un CLI sin dependencias ni secretos; la lista de acciones y sus argumentos se la pide al servidor. CLI y no MCP: en el spike de #257 costó lo mismo o menos, y con muchos hilos MCP gasta un turno por acción.
- **Skills** (`plugin/skills/`): lo que la corrida hace, cargado con `--plugin-dir` como `ronin:<skill>` en toda corrida de `runAgentTask`, sellada o no, con acciones o sin ellas. `--setting-sources user` deja afuera los settings, hooks y skills del `.claude/` del repo del producto; su CLAUDE.md sigue cargando. El prompt de una corrida con skill lleva solo lo de esa corrida (el repo, el PR o el pedido, sus datos, dónde escribir la salida) y qué skill usar; el comportamiento, las reglas y el formato de la salida están en la skill. Toda tarea tiene la suya (fase 4 de #257), salvo `commit-subject`, una llamada al modelo sin herramientas. Los datos de una preview (`prepare-preview-data`, `preview-seed-catalog`, `preview-data-triage` y `preview-data-delta`) comparten la skill `preview-data`, una sección por trabajo, y el prototipo del portal (`portal-prototype`) usa `prototype`. La review de un PR, de otra persona (`external-review`) o la interna de uno de ronin (`internal-review`), usa `review-pr`: el prompt dice de quién es el PR, si la ronda es completa o incremental y si puede correr su código, y trae los criterios, los hilos anteriores y la forma del JSON (`FINDINGS_JSON_CONTRACT`, de `review/output.ts`, la misma que valida ronin). Los revisores especializados no son la skill: siguen saliendo del archivo `--agents` que arma `reviewAgentDefinitions`. Las corridas del portal usan `read-request` (leer un pedido, `portal-request`, y las respuestas de su entrevista, `portal-interview`) y `reproduce-error` (`portal-reproduce`); el prompt dice en qué punto está el pedido y cuántas preguntas, rondas de entrevista, ajustes o reintentos le quedan. La lectura de una reunión (`meeting-read`) usa `read-meeting`, con el prompt diciendo si el repo usa Linear y el máximo de cada lista (`LIMITS`, `meetings/proposals.ts`). Las cinco tareas de una exploración comparten `explore`, una sección por trabajo, con los charters, las señales y la escala de gravedad; el prompt trae la función, el charter, la semilla, el conocimiento del equipo, los hallazgos que ya hay y la forma de la salida (`RESULT_JSON_CONTRACT` y `VERDICTS_JSON_CONTRACT`, de `explorations/output.ts`). `resolve-conflicts` y `update-changelog` usan la skill de su nombre; `update-changelog` sigue sin sellar, y su línea `RONIN_STATUS` va también en el prompt porque el tick la lee.
- **Entorno sellado** (`claude-runner.ts`, `sealedEnv`): una corrida con acciones no hereda el entorno de ronin (que trae todo `.env`), sino uno armado desde cero: lo que necesitan las herramientas (`AGENT_ENV_KEYS`), su cuenta de Claude, `GH_TOKEN` y las variables de las acciones.

- **Token de lectura** (`github/read-token.ts`): con la GitHub App de ronin configurada (`RONIN_GITHUB_APP_ID`, `RONIN_GITHUB_APP_KEY_PATH`), cada corrida con acciones recibe como `GH_TOKEN` un token de instalación de solo lectura, limitado al repo de la corrida y que vence en una hora; el de escritura queda en ronin. Si la App no lo puede dar, la corrida no arranca: nunca vuelve a leer con el de escritura. Sin App, el agente lee con el de escritura, como antes. La App solo lee: lo que escribe ronin sigue saliendo de su cuenta.

- **Usuario del agente** (`agents/agent-user.ts`): en la imagen, una corrida con acciones sobre la rama de un PR corre como el usuario de su cuenta de Claude (`agent-<cuenta>`, con un uid que sale del nombre de la cuenta y se crea cuando hace falta; hoy, uno por repo), no como root. No lee el entorno de ronin (`/proc` de sus procesos), `/data`, los certificados de Docker ni el socket de Tailscale: el entrypoint los cierra (`lock_down`). Tampoco los repos de otras cuentas: antes de la primera corrida, el directorio de cada repo de `repos.json` queda abierto solo a root y al usuario de su cuenta. No uno por corrida: las corridas de una cuenta comparten sus archivos, que Claude guarda como 600 y renueva en el lugar. Sin Docker en su entorno: los servicios de sus tests van por acciones. La cuenta de Claude pasa a ese usuario antes de cada corrida (`lendClaudeAccount`); root la sigue usando como antes. Fuera de la imagen (un runner a mano) no hay usuarios y todo corre como ronin.
- **Clon del agente** (`git/worktree.ts`, `ensureAgentClone`): esa corrida no usa un worktree del repo compartido, cuyo `.git` (config y hooks) root usa después, sino un clon propio del usuario `agent` (`--shared`: lee los objetos del compartido y guarda los suyos), con `origin` en GitHub. Root nunca corre git dentro de él: el estado del checkout lo lee como el agente, y `git.push` trae el commit por un bundle que escribe el agente, lo vuelve a comprobar en su repo y sube desde ahí.
- **Servicios de los tests** (`domains/product-app/services.ts`, acciones `services.up` y `services.run`): el agente no tiene Docker, así que ronin levanta por él los compose que nombra el `ronin.app.json` **de la rama base** (en un worktree propio de la corrida; nunca el compose del checkout, que el agente puede editar), con los puertos publicados movidos a puertos libres de localhost y los montajes del repo apuntando al clon del agente. `services.up` devuelve el puerto de cada servicio; `services.run` corre un comando dentro de uno (un SDK que solo está en el contenedor), con su salida y su código, y corta a los 9 minutos, bajo el máximo de una llamada a Bash del agente. Lo que el contenedor escribe en el clon vuelve a ser del agente. Un proyecto de compose por corrida, que se baja al terminar.
- **El stack de la app** (`appStack` en `domains/product-app/services.ts`, acción `app.exec`): una corrida sobre una app que ronin ya levantó (una preview, un prototipo, una reproducción) corre un comando en un servicio de su stack, como `psql` en su base de datos. Por defecto en el contenedor que ya corre (`compose exec`), y con `oneOff` en uno nuevo del servicio (`compose run --rm`), para tests que necesitan sus herramientas. El stack sale del estado que dejó `appUp`, nunca del checkout, y el servicio tiene que estar en él. Devuelve lo mismo que `services.run` y corta igual a los 9 minutos.
- **Implementar** (`implement-slice`, `fix-issue`, skill `implement`): la corrida trabaja en su propia rama, en un clon del agente (`ensureAgentBranchClone`: la rama como está en origin si ya existe, o nueva desde su base). `git.push` en modo `branch` acepta lo que haya construido sobre su base, con un lease sobre lo que la rama tenía en origin al empezar (nada, si no existía). `pr.create` abre el PR de esa rama: la base, si es borrador, a quién se asigna y el issue que tiene que cerrar (`Closes #N` en la primera línea, para `fix-issue`) los decide ronin. El PR de una slice no cierra nada (empieza con «Parte de #N»): mergeado, cerraría el issue con slices pendientes y ronin lo daría por terminado (le pasó al #515 de bmedical tras la slice 1 de 12). Por eso `pr.create` rechaza cualquier palabra de cierre de GitHub (`Closes`, `Fixes`, `Resolves` y sus formas) hacia otro issue que el que la corrida cierra, y `pr.update-body` una que la descripción actual no tenía. `fix-issue` puede preguntar en su issue con `issue.comment`, y su estado (`done` o `needs-info`) viaja en `result.report`, que `runAgentTask` deja como la línea `RONIN_STATUS` que el tick ya lee. Los otros modos de push: `amend` (los arreglos sobre un PR) y `fast-forward` (commits nuevos encima, sin reescribir lo que ya se revisa). `issue.update-body` reemplaza la descripción del issue o le agrega texto al final, según la corrida: `plan` (skill `plan-slices`) la reemplaza con el checklist de slices, y `spike` (skill `spike`) le agrega su sección y responde a quien lo pidió con `issue.comment`; ninguna de las dos sube nada. `fix-e2e` (skill `fix-ci`) arregla el CI de un PR de ronin con un amend, como los arreglos de review, sin escribir nada más en GitHub. `write-spec` (skill `write-spec`) trabaja en su propia rama y abre un PR borrador asignado a ronin, o pregunta en el issue; `revise-spec` (skill `revise-spec`) sube commits nuevos encima (`fast-forward`), porque el equipo revisa el spec commit por commit, y responde cada mención. Las dos dejan el mockup en su carpeta de salida, y ronin lo muestra en un navegador que solo abre la página misma y lo que trae en línea (`renderHtmlToPng`): otro `file:` metería en la imagen publicada un archivo que el agente no puede leer. `resolve-conflicts` hace el merge, el commit y el push en un clon del agente, con git corriendo como su usuario, y sube el merge como `git.push` en `fast-forward`; el agente, sellado, solo resuelve los archivos. Queda fuera `update-changelog`: trabaja en otro repo (el del changelog, con su clon y su `node_modules`), con datos de un release que escribió el equipo, y sigue corriendo como antes.
- **Corridas selladas de solo lectura** (`agent-task.ts`, `sealed`): las tareas que no escriben en GitHub y dejan su resultado en archivos —`external-review` e `internal-review`, `portal-request` y `portal-interview`, `meeting-read`— corren como el usuario de su cuenta, con el token de lectura y sin acciones de escritura, y sin los settings del `.claude/` del repo (`--setting-sources user`). Escriben solo en su carpeta de salida (`outputDir`), que reciben para la corrida con lo que ronin dejó ahí para leer (las notas de una reunión, las imágenes de un pedido, copiadas desde `/data`); al terminar, ronin la aparta de un solo paso y se queda solo con sus archivos normales (`reclaimOutput`): nunca con un enlace, que podría apuntar a un archivo que el agente no puede leer y que una review publicaría. La review de un PR corre en un clon del agente en el SHA del PR (`ensureAgentPrClone`), y si puede correr su código, pide los servicios con `services.*`.
- **Sin MCP de la cuenta** (`claude-runner.ts`): toda corrida va con `--strict-mcp-config`, así que los conectores de claude.ai y los MCP de la cuenta de Claude no entran; solo los que la corrida pasa.

Lo que queda: dos corridas del mismo repo pueden leer el entorno de la otra mientras viven, pero lo único que les sirve de ahí es el token de lectura de ese mismo repo. Corren así las menciones en un hilo de un PR ajeno (`thread-reply-external`) y en un PR de ronin (`review-request`), con la skill `answer-mentions` —cada mención respondida donde se dejó, ningún hilo resuelto—, y `/fix-comments` en un PR ajeno (`fix-comments-external`) y en uno de ronin (`fix-comments`), y los cambios que una persona pide en la review de un PR de ronin (`fix-review`, que cierra con un comentario de resumen porque no la disparó un comentario), con la skill `address-comments`; y lo que encontró la review interna de un PR de ronin (`fix-internal-review`), con la skill `fix-findings`, que no publica nada: sus únicas acciones son el push y la descripción, donde deja como preguntas los bloqueos reales; en un PR de ronin, la corrida además pone al día la descripción con `pr.update-body`, que rechaza una descripción sin su primera línea «Closes #N» o sin el pie de ayuda tal cual. Todas trabajan sobre la rama del PR desacoplada (`pr-branch`), en el clon del agente.

### 7.2 Usuario mencionable

A diferencia de un GitHub App (cuyo bot user no siempre es confiablemente @mencionable/notificable), `ronin` es una cuenta real — la misma que abre los PRs es la que se @menciona para pedirle una review puntual (ver [Comandos](https://oskr814.github.io/ronin/referencia/comandos/)). No hace falta ninguna cuenta ni setup adicional para esto.

### 8. Idioma

Lo que el agente headless lee como instrucción va en español desde #257: las skills de `plugin/skills/` y los prompts de cada corrida (el `prompts.ts` de cada feature). Quedan en inglés los contratos de salida de `output.ts`, los revisores especializados de la review (`prompts/review-agents`), las reglas compartidas que todavía no pasaron a una skill (`platform/agents/prompts.ts`) y el texto de `templates/tracking-issue.md`. Lo que es comunicación humana (esta doc, `docs/BLOCKING.md`, el cuerpo de los emails de `src/platform/notify/notifier.ts`, los motivos de bloqueo en `tick.ts`) se mantiene en español.

### 9. Concurrencia entre múltiples supervisores

Implementado en `src/platform/state/claim.ts`, siguiendo el mismo patrón de "GitHub como estado" que el resto del sistema — sin base de datos ni lock service aparte, y sin jitter ni timestamps: un label de claim por runner más un cache local que evita repreguntarle a GitHub por algo que este runner ya sabe que es suyo.

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
- `rerunOn` en cada paso (opcional): globs sobre las rutas del repo (`pnpm-lock.yaml`, `apps/api/src/migrations/**`) que dicen cuándo ese paso tiene que volver a correr si la app ya está arriba y el checkout pasa a otro commit. Una preview (§12) lo usa al actualizarse con un commit nuevo del PR: un `run` vuelve a correr su comando, `compose` corre `compose up -d --build`, `start` reinicia ese proceso y `wait` vuelve a esperar, en el orden del manifiesto. Un paso sin `rerunOn` no se repite, porque los dev servers recompilan solos lo que cambia en el código. Si ningún paso de la app lo declara, ronin no puede saber qué es seguro saltear y reconstruye todo (`stepsToRerun` en `domains/product-app/manifest.ts`). Los globs son los de `path.matchesGlob` de Node: `**` no entra en carpetas que empiezan con punto.

Lo que arranca la app (sus procesos y su stack de compose) queda anotado en `.ronin-app/` dentro del checkout, para que `appDown` lo baje desde otro proceso. Cuando el checkout es del agente (#257: un prototipo, una reproducción o una exploración, donde el agente edita el código con la app corriendo), la app corre distinto (`AppUpOptions.as`):

- **El estado queda fuera del checkout**, en `<worktrees>/.ronin-app/<checkout>`, de root y con permisos 700. Dice qué procesos para ronin y con qué archivo de compose baja el stack, así que el agente no tiene que poder escribirlo. Se borra junto con el checkout (`removeAppState`), nunca antes: con el checkout todavía ahí, el próximo `appDown` leería el estado que el agente hubiera dejado adentro.
- **El código de la app corre como el usuario del agente**: los `run` y los `start` (instalar, compilar, los dev servers), con un entorno armado desde cero (`AGENT_ENV_KEYS`) y sin nada del de ronin. Los dev servers siguen corriendo mientras el agente edita, así que lo que escriba lo corren ellos con sus permisos, no con los de root.
- **Los pasos que usan el stack (`{{compose}}`) corren como ronin**, porque necesitan Docker. Lo que dicen puede venir del agente (un `.env` que dejó en el checkout, un manifiesto que editó) o del head de un PR, así que se acotan (`domains/product-app/confine.ts`):
  - **Pasos:** un paso así es solo `{{compose}} exec [opciones] <servicio> <comando…>`, sin nada de sh. Las comillas se toman literales, cualquier cosa que sh expandiría o correría se rechaza, y se pasa a docker palabra por palabra. De las opciones de `exec`, solo `-T`, `-e`, `-u`, `-w` e `--index`: nada de `--privileged`. Un `start` no puede usar el stack.
  - **El stack:** cada bind mount tiene que quedar dentro del checkout, y ningún servicio puede pedir `privileged`, `cap_add`, `devices`, `security_opt` ni los namespaces del host (`pid`, `ipc`, `network_mode`, `userns_mode`, `uts`).
- ronin no corre git en ese checkout.

Siempre contra datos de seed, nunca contra producción. El seed tiene que incluir casos de volumen realista (un pedido de 3 líneas no muestra los problemas de uno de 80). La baja es un `docker compose down --volumes` del proyecto de la app (`appDown` en `domains/product-app/runtime.ts`). Si `app:up` falla, la corrida lo reporta como primer hallazgo en vez de bloquearse.

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

**Con foco** (#376). Una corrida también puede mirar donde dice una persona, en vez de seguir la selección de arriba (`ExploreFocus` en `domains/explorations/plan.ts`):

- **Funciones elegidas a mano** (*Explorar ahora → Estas funciones*): se exploran esas, en ese orden, con el charter que les sortea `pickCharter` (`planChosen`).
- **Un pedido en palabras:** lo que pide el issue de un `/explore` (título, descripción y comentarios de personas, sin los comandos a ronin, `issueRequest` en `flow.ts`) o el texto de *Explorar ahora*. Un agente de solo lectura, `explore-focus`, lee el pedido con las funciones entre las que elige (todo el inventario, o las elegidas a mano) y devuelve cuáles toca, el charter, el rol y un **encargo** por función. `parseFocusPlan` lo valida. Cada explorador recibe el pedido y su encargo, y el encargo manda sobre el charter. Si el pedido es de algo que el inventario no tiene, y nadie acotó la elección, el agente puede nombrar una función nueva, que se suma al inventario como en un refresco. Si nada encaja, la corrida no levanta la app y dice por qué.

Esto no es un archivo de objetivos (§11.1): el pedido dice *dónde* mirar, y la propuesta sigue saliendo de usar la app. Cada ficha de una corrida que salió de un issue guarda `origen: <issue>`. Al aprobar el PR (§11.7), el issue de la ficha lo enlaza y ronin comenta en el issue de origen la lista de los issues que quedaron. Asignar un issue sigue siendo implementarlo: para que proponga, se pide `/explore`.

Los datos concretos (cliente, productos, cantidades) también se eligen al azar dentro del seed. **Toda la aleatoriedad usa una semilla registrada en el run y en cada hallazgo**: un bug encontrado al azar que no se puede reproducir no sirve. No se hace monkey testing puro (clicks al azar), salvo como presupuesto chico para detectar crashes sin proponer nada.

#### 11.5 Antes y después: capturas en una rama huérfana

Cada propuesta lleva antes/después. El "antes" son las capturas que el explorador sacó usando la app (hasta 3 por ficha). El "después" se arma preferentemente aplicando un parche borrador en el worktree (sin pushear) y sacando screenshot de la app real, con el design system real; si no es viable, el explorador dibuja la pantalla en HTML y ronin la renderiza a PNG con Playwright, al viewport del hallazgo y sin red.

Las imágenes van a la rama huérfana **`ronin/evidence`** del repo del producto, que no se mergea nunca: un commit por corrida, armado con plumbing de git sobre un índice temporal (sin worktree), en `<app>/<corrida>/<ficha>/antes-N.png|despues.png`. La ficha y el PR las muestran con `<img>` apuntando a `github.com/<repo>/blob/<sha>/…?raw=true`: GitHub no las pasa por su proxy, así que solo las ve quien tiene acceso al repo, y como el link apunta a un commit no se mueve. Si el push falla, la ficha se escribe igual con las capturas descritas en texto.

**Como el agente** (#257). En la imagen, el checkout de la exploración (`app-<app>`, `ensureAppWorktree`) es un clon del usuario del agente, que se conserva entre corridas por su `node_modules`, y la app corre como él (§11.2).

- **Los agentes de la exploración** corren sellados y como ese usuario: el inventario, el foco, cada función, el evaluador, el feedback del PR y rehacer un después. Cada uno escribe solo en su directorio de salida, y lo que leen sus navegadores (los logins) va ahí también.
- **El git de ronin:** lo que necesita de la historia del código (qué cambió, el riesgo, el último commit de la app) lo lee del repo compartido en la rama base. La evidencia también se commitea ahí, porque usa un índice temporal y no necesita checkout.
- **Revertir el parche borrador** entre funciones es git del usuario del agente.

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
revisor: persona          # quien la decidió en la review: su usuario de GitHub (rechazo, edición o aprobación)
revisado: 2026-10-20T05:30:00Z
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

   **Desarrollar ya** (#379) no pasa por esa clasificación: un comentario en la ficha que empieza con `Desarrollar ya` lo lee el código (`developNow` en `flow.ts`), no el agente. ronin abre en ese momento el issue de la ficha, asignado a sí mismo y con la clave `ronin-ficha:` de siempre (`ensureFindingIssue`), lo dice en el issue y responde en el hilo. Después marca la ficha `aprobado` con su issue y lo commitea al PR. Si una corrida está escribiendo la rama, el issue sale igual y el resto espera a que termine. Al aprobar el PR, la ficha ya está aprobada y su issue se encuentra por la clave, así que no se abre otro.

   Las mismas decisiones se pueden tomar desde el tablero, que comenta como quien entró (§15.12).

   Un comentario general del PR que menciona a ronin también se aplica: puede cubrir varias fichas a la vez ("los de mobile se resuelven con F-0003"), que se rechazan o corrigen como arriba, y dejar en `knowledge.md` lo que las exploraciones siguientes no deben volver a proponer. Se procesa antes del merge, así que no se abren issues de fichas que ese comentario descartó.
4. Approve + merge (mismo gate que el resto): al ver el PR aprobado, ronin marca como `aprobado` **las fichas que siguen en pie**, les crea su issue, commitea ambos al PR y recién entonces lo mergea (si sigue aprobado), así la base queda con el estado y el número de issue de cada ficha. La corrida siguiente abre el PR nuevo. Cada issue sale **asignado a ronin**, así que entra solo al flujo de `fix-issue` de siempre: aprobar la ficha es la decisión de hacerla. `fix-issue` lo reconoce por la clave `ronin-ficha:` del cuerpo y parte de lo que la ficha ya hizo, sin investigar de cero: confirma el diagnóstico contra el código e implementa la propuesta, con el cambio borrador del después como punto de partida y sin ampliar el alcance. Solo investiga más donde el código contradice la ficha. En el tablero, esa corrida se llama *Resolver issue*. Para no hacer una, se rechaza la ficha antes de aprobar el PR.
5. Ninguna ficha abre issue antes de la aprobación sin que una persona lo pida (con *Desarrollar ya*), ni siquiera un bug de gravedad `bug`. Así una ficha rechazada nunca deja un issue abierto. Los problemas del **entorno de desarrollo** (seed, stubs), que el evaluador marca con `entorno`, siguen el mismo camino.

#### 11.8 Programación nocturna

Sin cron aparte: el tick evalúa `es de noche (EXPLORE_NIGHT_WINDOW, en la hora de EXPLORE_TIMEZONE) && hay una app de "explore", fuera de "exploreNightlyOff", que todavía no arrancó esta noche → lanzar el worker` (`domains/explorations/schedule.ts`). Una app por vez por repo, y cada una arranca a lo sumo una vez por noche, salga bien o mal: qué noche arrancó cada app queda en `.ronin-state.json` (`nightlyExploration`). Una corrida que se corta no se retoma esa noche; la siguiente vuelve a elegir funciones desde el inventario.

- **Lo urgente primero**: un issue asignado o una mención que llega de noche se procesa antes; la exploración es la prioridad más baja y es interrumpible entre funciones.
- **Presupuesto por noche, no "usar todo"**: la noche aprovecha la ventana de 5 h de Claude que nadie usa, pero el límite **semanal** es compartido con el trabajo de día. Tope de tiempo y modelo de los workers configurables (como `EXTERNAL_REVIEW_WORKER_MODEL`).
- **Sin cuota de Claude** (#382): si un agente de la corrida choca con el límite de uso de la cuenta (el de gasto, el de la sesión de 5 h o el semanal: `USAGE_LIMIT_PATTERN` en `claude-runner.ts`), la corrida no arranca más funciones. Lo que ya encontró no se descarta: los candidatos que el evaluador no pudo ver quedan en `exploration-out/pending-<app>.json`, junto a las capturas y los parches de su corrida, y la próxima corrida de la app los evalúa con los suyos, cada uno con su semilla, charter, rol y origen. El archivo de la corrida, la respuesta al `/explore` y *Corridas* dicen cuántos esperan.
- **Prompt injection desde la app**: el contenido de páginas y datos se trata como dato, con los mismos marcadores `<<<…>>>` que los comentarios.
- **A pedido desde el tablero (#155)**: *Explorar ahora*, en la página de la app (§15.12), lanza el mismo worker sin esperar a la noche. Por defecto cuenta como la corrida de esa noche: guarda en `nightlyExploration` la noche que viene (`upcomingNight`: la que está en curso dentro de la ventana, o si no la próxima que abre), y el tick la salta. Así una corrida de la tarde no suma otra a la noche sobre el mismo límite semanal.
- **El registro de cada corrida** (`domains/explorations/run-log.ts`): el worker escribe `logs/exploration/<owner>-<repo>/<inicio>-<app>.json` al arrancar y lo cierra al terminar. Guarda quién la lanzó (de noche, `/explore` en un issue o el tablero, con el login), la semilla, cada función con su charter, su rol, el motivo y los viewports, las fichas, las descartadas y el error. Si el registro no se puede escribir, la corrida sigue igual. Uno que sigue en `running` cuando el lock del repo ya está libre es de un worker que murió: el tablero lo muestra como cortado.

#### 11.9 Preguntas por Remote Control (retiradas)

Hasta el 2026-10-18, una tarea que terminaba en `RONIN_STATUS: needs-info` abría además una sesión `claude --bg --remote-control` que entrevistaba a quien la abriera y escribía las respuestas en el issue. Se quitó (`REMOTE_INTERVIEWS`, `INTERVIEW_TIMEOUT_HOURS`): no funcionó como se esperaba, y solo la podía abrir la cuenta de Claude del runner. Ahora las preguntas quedan en el issue, el email avisa que las hay (docs/BLOCKING.md) y se responden comentando ahí.

#### 11.10 Etapas

0. ~~Spike: Artifacts desde headless, captura del link de Remote Control, quién puede abrir cada cosa~~ — hecho 2026-10-11 (resultados en §11.5 y §11.9)
1. ~~`app:up` para el backoffice de shoppingcart: manifiesto, override de compose, seed, login por rol, desktop + mobile~~ — hecho
2. ~~`/explore` a pedido (por mención): inventario, charters, hallazgos e ideas, antes/después en `ronin/evidence`, memoria en `docs/exploration/`~~ — hecho
3. ~~Programación nocturna + PR de exploración~~ — hecho
4. ~~Preguntas por Remote Control para `needs-info`~~ — hecho, y retirado el 2026-10-18 (§11.9)
5. ~~`/spec`: de un pedido en bruto (o una propuesta aprobada) a un PR draft de spec~~ — hecho

Pendiente: calibrar la calidad de las propuestas con varias corridas a mano (ver "Estado actual").

Piloto: el backoffice de shoppingcart (herramienta interna, se levanta entero con stubs de Odoo/GCP, usuarios con el mismo rol `Sales` pero dos usos distintos — vendedores en desktop y bodega en el teléfono). El mecanismo se evalúa por la calidad de lo que encuentra: ¿detecta lo que el equipo ya sabía?, ¿encuentra algo nuevo?, ¿cuántas propuestas se descartan?

#### 11.11 Menciones en un issue sin asignar

En un issue que ronin todavía no está trabajando (sin el label `ronin`), solo actúan los comandos: `/spike`, `/spec` y `/explore`. Una mención sin comando no hace nada más que responder con la lista de comandos (`mentions.ts`, sin Claude), igual que `/help`. Para que lo implemente, se le asigna el issue.

La app levantada con un navegador por rol y viewport sigue existiendo para el portal (§16.4): `runOnApp` en `domains/portal/app-run.ts` levanta la app desde la rama base en un worktree propio con una instancia de compose propia, corre el agente y le pasa al que llama lo que dejó. Después tira el worktree, así que no queda rama ni PR. `makePrototype` le suma el antes, el cambio borrador y el después. Una app a la vez por repo (`.prototype.lock`), y el worker espera su turno en lugar de descartar el pedido.

En la imagen, el checkout es un clon del usuario del agente (#257). Los pedidos llegan por el portal, de cualquiera, así que:

- **La app** corre como ese usuario (§11.2).
- **El agente** corre sellado y como él: escribe solo en su clon y en su directorio de salida.
- **Lo que lee** va en ese mismo directorio: los logins de sus navegadores (copias de los de la app) y las imágenes del pedido.
- **Los tests** de una reproducción llegan al stack con `app.exec` (`oneOff`, el `compose run --rm` de antes).
- **El diff** del borrador lo saca ronin con git del usuario del agente, nunca con el suyo.

### 12. Previews por PR en la tailnet (`/preview`)

Para probar un PR sin entrar al server, armar el worktree y levantar la app a mano. `@ronin-agent /preview [app]` en un PR (no fork) hace eso mismo con el código del head del PR y responde con una URL de la tailnet y los usuarios de seed. La app es opcional cuando el manifiesto define una sola, o cuando el PR cambia archivos en la carpeta (`path`) de una sola de sus apps (`appsTouched`): un cambio en `apps/backoffice` y `packages/ui` es del backoffice. Una app con `path` en la raíz no cuenta, porque las tocaría todas.

- **Qué manifiesto.** El `ronin.app.json` (§11.2) de la rama base del PR, salvo que el PR lo modifique: en ese caso, el del PR. Un PR que salió de la base antes de un arreglo al manifiesto (como #367 de bmedical, de antes de `ALLOWED_DEV_ORIGINS`) levantaría la app rota, y ronin no pone al día sus propios PRs con la base.
- **Dónde corre.** Un worker aparte (`domains/previews/worker.ts`), como el de exploración: levantar la app tarda minutos y no puede retener el tick. El comando se intercepta en `findUnprocessedMentions`, así que nunca llega a la review ni a fix-comments. El comando queda como procesado al lanzar el worker, y el worker contesta en el mismo lugar del comentario. Hay un lock por PR, así que dos `/preview` seguidos no se pisan.
- **Aislamiento.** Checkout `preview-pr-<n>` detached en el SHA del head (vía `refs/pull/<n>/head`) y proyecto compose `ronin-app-<repo>-<app>-pr-<n>`, que corre al lado del de exploración y del de otros PRs. Los puertos siguen en `127.0.0.1`.
- **Como el agente** (#257). En la imagen, el checkout es un clon del usuario del agente, y la app corre como él (§11.2: su estado, junto con `preview.json`, queda fuera del checkout).
  - **Git:** ronin no corre git en ese checkout. Lo que necesita de los commits del PR (el merge-base, el diff, el `ronin.app.json` del head, los seeds) lo lee del repo compartido, por SHA. Mover el checkout a otro commit, o limpiarlo después de los agentes, es git del usuario del agente.
  - **Los agentes de la preview** (el catálogo, si alcanzan los seeds, los datos, el delta) corren sellados, como ese usuario. Cada uno escribe solo en un directorio de salida propio (`preview-out/`), del que ronin toma lo que guarda. Los que tocan la base llegan al stack solo con `app.exec`.
  - **Migración:** una preview que se levantó antes como worktree de ronin se rehace como clon la próxima vez que se levanta o se actualiza.
- **Publicación.** `tailscale serve --https=<puerto público>` → `http://127.0.0.1:<puerto local>`, solo en la tailnet, nunca `funnel`. Se publica el puerto del `baseUrl` más los que la página usa (ver abajo). Los puertos públicos salen de un rango fijo, `PREVIEW_PORT_RANGE` (por defecto 20000-20999), que es lo único que una política de Tailscale le abre a alguien de afuera:

  ```json
  { "src": ["persona@gmail.com"], "dst": ["tag:media"], "ip": ["tcp:20000-20999"] }
  ```

  El rango queda fuera del rango efímero del kernel (32768-60999), porque ahí caen los puertos aleatorios de Docker. Por ejemplo, los Postgres de las slices se publican en `0.0.0.0:<efímero>`. Si un rango abierto a externos se solapara con el efímero, cualquiera de esos podría quedar adentro. Cada puerto se reserva con un archivo exclusivo en `.preview-reservations/ports/` (`O_EXCL`, compartido por todos los repos y workers), así que dos previews nunca toman el mismo. Un puerto en el que ya escucha otro proceso se saltea. Una reserva cuyo worktree ya no existe se reclama.
- **Límite.** Hay como máximo `PREVIEW_MAX_PER_REPO` previews activas por repo (por defecto 2), sin importar la app: en un repo con varias apps, contar por app confundiría. Los cupos son archivos exclusivos en `.preview-reservations/slots/`. Un `/preview` nuevo en el mismo PR conserva su cupo. Cuando no queda cupo, ronin responde nombrando los PRs que los tienen y borra el worktree que acababa de crear. El cupo se libera con `/preview stop`, al mergear o cerrar el PR, cuando la preview vence (ver abajo), o si falla al levantar.
- **Lo que llama el navegador.** Un frontend que le pega a `http://127.0.0.1:<api>` no funciona desde otra máquina. Lo resuelve el boot, sin tocar el manifiesto: toda URL `http://127.0.0.1:{{…}}` o `http://localhost:{{…}}` en el `env` de un paso `start` se rinde como la URL pública de ese puerto (`https://<host>.ts.net:<puerto>`), y el puerto se publica (`publicizeTemplate`). Los pasos `run`/`wait` quedan en loopback, porque hablan con la app desde el host y corren antes de que haya nada publicado. Fuera de una preview, la URL pública es la misma de loopback, así que la exploración no cambia. Para lo que esa regla no cubre, el manifiesto puede usar `{{public.ports.<servicio>.<puerto>}}` o `{{public.port.<nombre>}}` explícitos, y `{{publicHost}}` para un dev server que valida el header `Host` (Vite ≥5.4.12: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`). Al revés, `{{local.port.<nombre>}}` y `{{local.ports.…}}` dejan en loopback una URL que llama el servidor de la app y no el navegador (la API de una server action de Next.js): desde el contenedor del runner, la URL de la tailnet no se alcanza, porque Tailscale corre en modo userspace.
- **Se baja con el PR.** `sweepPreviews` corre en cada tick: si hay worktrees de preview cuyo PR ya no está abierto, despublica los puertos, baja la app y borra el worktree. Con `pull_request.closed` arranca un handler (§14) que barre previews y worktrees, así que esto pasa apenas se mergea o se cierra el PR. Lo mismo vale para el worktree de la slice mergeada (`sweepOrphanedWorktrees`) y para el retarget del stack. `/preview stop` la baja antes.
- **Vencimiento.** Una preview que nadie bajó tampoco retiene su stack y su cupo para siempre en un PR que sigue abierto: pasados `PREVIEW_TTL_MINUTES` (por defecto 60) desde que se levantó (`startedAt` en `preview.json`), `sweepPreviews` la baja igual que con `/preview stop` y comenta en el PR que `/preview` la vuelve a levantar. Un `/preview` nuevo empieza la cuenta de nuevo; una actualización por un commit nuevo, no (ver abajo). Como el sweep corre en cada tick, se baja dentro del intervalo del cron después de vencer. Una preview levantada antes de que existiera el vencimiento no tiene `startedAt`: el primer sweep se lo pone, y la cuenta arranca ahí. Con `PREVIEW_TTL_MINUTES=0` no vence.
- **Datos para probar el PR.** Los seeds base casi nunca alcanzan para lo que cambia un PR (el #818 necesitaba un cliente con más de 12 catálogos, algunos vencidos). Con la app arriba y publicada, una tarea de agente (`prepare-preview-data`, sonnet por defecto) corre en el worktree de la preview. Deja lo que pide el *Cómo probar* de la descripción (#193), sus datos y lo que necesitan sus pasos, sin deducir por su cuenta qué más haría falta, más lo que se haya escrito después del comando (`/preview un cliente con 40 catálogos`). El diff contra la base lo lee para ver cómo crear esos datos, y para deducirlos solo si el PR no trae *Cómo probar* (uno viejo, o uno que escribió una persona). Prefiere la API de la app (logueándose con un usuario de seed) y cae a SQL por el stack de compose para lo que la API no permite, como fechas vencidas. Si el cambio está detrás de un feature flag u otro interruptor (por tenant, por usuario, de configuración), lo deja encendido para los usuarios de seed aunque los pasos arranquen con él apagado: quien abre la preview quiere ver el cambio (el #516 de bmedical arrancó apagado y se veía igual). La respuesta dice cómo apagarlo. Un interruptor que solo vive en el entorno o en la configuración (una variable, un `.env`) no es un dato: no lo toca, y lo anota en lo que no pudo preparar. Por lo mismo, `preview-data-triage` nunca da por suficientes los seeds si el flag no está encendido en ellos. Después verifica leyendo de vuelta todo lo que dejó, con el flag incluido, como lo lee la app. La respuesta con la URL lista lo que quedó listo y dónde encontrarlo, y lo que no pudo preparar. Si falla, la preview se entrega igual, con un aviso. No toca código: al terminar, ronin devuelve el checkout al SHA del PR. Se apaga con `PREVIEW_PREPARE_DATA=false`.
- **Catálogo de los seeds base (#202).** Para no redescubrir la base en cada preview, ronin guarda qué trae la app recién sembrada y lo reusa:
  - **El hash.** Con la app arriba, ronin calcula un hash de lo que define los datos base en el commit de la preview: los archivos de seed y de migraciones (sus blobs en `git ls-tree`) y los pasos `run` del manifiesto. Los archivos los declara `seedPaths` en la app del manifiesto (rutas a directorios o archivos, p. ej. `["db/seeds", "db/migrations"]`). Si no lo declara, entra todo archivo bajo un directorio `seeds`, `migrations`, `dumps` o `fixtures`, o con `seed` en el nombre. Que sobre solo cuesta un catálogo de más cada tanto.
  - **Dónde vive.** En `SEED_CATALOG_DATA_DIR` (por defecto `seed-catalog-data/`, fuera de git): `<repo>/<app>/<hash>.yaml`. Nunca en el repo del producto, porque nombra clientes y usuarios del seed y lo mantiene ronin solo. No hace falta respaldarlo: se regenera.
  - **Quién lo escribe.** Si no hay catálogo para ese hash, una tarea de agente (`preview-seed-catalog`, sonnet por defecto) lo escribe antes que nada: recorre los seeds, las migraciones y la base recién sembrada, sin escribir en ella, y anota por entidad su tabla, cuántos registros hay, los casos que cubren (estados, roles, vencidos, relaciones) y cómo encontrarlos en la app. Bloquea a la preview que lo dispara, que tarda más esa vez: en paralelo, el agente que prepara los datos cambiaría la base mientras se cataloga. Las previews siguientes con el mismo hash lo leen sin explorar. Si falla, la preview prepara los datos como sin catálogo.
  - **El paso previo.** Con el catálogo, el PR, su diff y lo pedido junto al comando, un modelo chico (`preview-data-triage`, haiku por defecto) decide si los seeds base alcanzan. Ante la duda, no alcanzan. Si alcanzan, no corre `prepare-preview-data`: la respuesta dice "No hizo falta preparar datos" y lista los registros del seed con los que probarlo. Si no alcanzan, `prepare-preview-data` recibe el catálogo y crea solo lo que falta.
  - **Si no cuadra.** Los agentes confían en el catálogo. Si alguien nota que dice algo que la base no tiene, abre un issue para revisarlo, y borrar el archivo hace que la próxima preview lo regenere.
- **Commits nuevos (#204).** La preview sigue al PR: un commit nuevo (ronin aplicando un pedido, o el push de quien sea) la actualiza sin que nadie lo pida.
  - **Disparo.** `pull_request.synchronize` suma el flujo `previews`. El handler (§14) lanza el worker con la acción `update` (`launchPreviewUpdates`) antes de esperar ningún recurso, porque el push suele venir del job del issue de ronin, que todavía tiene el issue tomado. Un PR sin preview o con su worker ocupado se saltea. El sweep queda de respaldo: si ve una preview en un SHA que no es el head del PR, lanza la actualización.
  - **En el lugar** (`updatePreview`, `planInPlaceUpdate`). El worker trae el commit, mueve el worktree con `checkout --detach --force` y calcula los archivos que cambiaron entre el SHA de la preview y el nuevo (`git diff --name-only`, que sirve también después de un force-push, porque el commit viejo sigue en el repo). Después vuelve a correr solo los pasos cuyo `rerunOn` (§11.2) toca alguno de esos archivos (`appRerun` en `domains/product-app/runtime.ts`), con los puertos y el stack de compose del `appUp` original. Lo demás lo recompilan los dev servers. La URL, los puertos, la base y su cupo se conservan.
  - **De cero** cuando no se puede en el lugar, igual que un `/preview`, con lo que se escribió después del comando:
    - cambió el `ronin.app.json` que se usa (el del PR o el de la base, ver arriba; ronin guarda el de la preview en `.ronin-app/preview-manifest.json`);
    - cambió un archivo de compose de la app, porque `appUp` lo resolvió una sola vez al levantar;
    - ningún paso de la app declara `rerunOn`, así que un manifiesto que todavía no lo adoptó tampoco queda a medias;
    - falló algún paso de la actualización.

    La URL puede cambiar, porque los puertos se vuelven a pedir.
  - **Los datos.** Con `PREVIEW_PREPARE_DATA` activo, después de una actualización en el lugar una tarea barata (`preview-data-delta`, haiku por defecto) lee el diff entre el commit viejo y el nuevo, el PR y lo que dejó la preparación anterior (`.ronin-app/preview-data.json`), y decide si los commits nuevos cambian lo que hay que probar. Si lo cambian, `prepare-preview-data` corre solo sobre ese diff, a partir de los datos que ya están y sin borrar nada, y lo que agrega se suma a `preview-data.json` para la próxima. Mientras tanto el tablero muestra "preparando datos". Si la preparación anterior falló o no corrió, no hay sobre qué construir y no pregunta nada. Si la decisión falla, quedan los datos que había. Ni el catálogo de seeds ni `preview-data-triage` corren al actualizar: la base ya no es la de los seeds, y la decisión ya la tomó `preview-data-delta`.
  - **Aviso.** Cada actualización deja un comentario corto en el PR: los dos commits y qué pasos volvieron a correr, o por qué se levantó de cero. Si se completaron datos, también qué quedó listo, y si no, por qué los que había siguen sirviendo. El tablero muestra el SHA de la preview y "actualizando" mientras dura (`updating` en `preview.json`, que se ignora si el worker murió).
  - **Dos pushes seguidos.** El segundo encuentra el lock del worker tomado y no lanza otro. Al terminar, el worker vuelve a leer el head del PR y, si se movió, hace una pasada más, hasta 3. Lo que quede atrás lo toma el sweep.
  - **Vencimiento.** Una actualización, en el lugar o de cero, no reinicia la cuenta de `PREVIEW_TTL_MINUTES`: sigue desde que la preview se levantó por primera vez (`startedAt`).
  - **`/preview` a mano** sigue levantando todo de cero. Es la salida cuando algo quedó raro.

### 13. Auto-merge por PR (`/auto-merge`, label `ronin:auto-merge`)

Lo mismo que el auto-merge de GitHub, que es de los planes pagos: el PR se mergea solo apenas está aprobado y con los checks en verde, sin que alguien tenga que volver a apretar el botón.

- **El label es el estado.** `ronin:auto-merge` en el PR significa "mergealo cuando se pueda". `@ronin-agent /auto-merge` lo pone y `/auto-merge off` (o `stop`, `cancel`, `/auto-merge-off`) lo saca. También se puede poner o sacar a mano. El comando se intercepta en `findUnprocessedMentions`, como `/preview`, y contesta en el mismo lugar con lo que falta para el merge. Si el PR ya tiene conflictos, no lo activa y explica por qué. ronin solo lee comandos en sus propios PRs y en los PRs de humanos que no son draft. En el resto (un draft de un humano, por ejemplo), el label a mano funciona igual.
- **Cuándo mergea.** `sweepAutoMerge` corre en cada tick, antes de los flujos, así que un merge no espera detrás de una review larga. Lee todos los PRs abiertos con un solo `gh pr list` y mergea los que tienen el label y cumplen todo esto:
  - no es draft;
  - `reviewDecision` es `APPROVED`, que exige que el repo pida reviews en la protección de la rama;
  - los checks terminaron y ninguno falló (el mismo criterio que `checksPassing`, así que un PR sin ningún check espera);
  - GitHub lo da por mergeable;
  - su base no es la rama de otro PR abierto. Un PR de un stack espera a que se mergee el de abajo, para no terminar mergeado en esa rama en vez de en la raíz;
  - si es un PR de slice: la review interna (#194, abajo) terminó sobre su commit de punta, y su descripción no tiene preguntas en `## Preguntas` (`openQuestions`, `platform/github/pr-body.ts`).

  Mergea con `mergePullRequest`, que vuelve a exigir la aprobación y reacomoda los PRs que dependían de la rama mergeada. Mientras espera, solo lo anota en el log. En el PR comenta únicamente el merge o la desactivación.
- **Cuándo se desactiva.** Igual que en GitHub: si el PR tiene conflictos con su base, o si el merge falla. ronin saca el label y comenta el motivo, así no lo reintenta en cada tick. Para volver a activarlo hay que pedir otra vez `/auto-merge`.
- **Por defecto en las slices.** Cada PR de slice (rama `ronin/<issue>/slice-N`) recibe el label la primera vez que el barrido lo ve abierto (`labelNewSlicePrs`), también con el webhook del PR recién abierto. Aprobarlo es entonces pedir el merge. Lo pone una sola vez: los que ya lo recibieron quedan en el estado local (`autoMergeDefaulted`), así que sacarlo a mano o con `/auto-merge off` es definitivo. Un PR que ya nace con conflictos no lo recibe, igual que con el comando. La primera vez que corre solo anota los PRs abiertos, para que activarlo no mergee lo que ya esperaba review. Los PRs del spec y de exploración no lo llevan, porque tienen su propio merge (§1, §11.7). Se apaga por repo con `"autoMerge": false` en `repos.json`, que se cambia desde *Ajustes → Repos → Merge* (§19.6). También lo pone en el PR de un pedido del portal que la persona aprobó (§16.5). En todos los casos tiene que aprobarlo un dev.
- **Rapidez.** Arranca un handler (§14) cuando se pone el label (`pull_request.labeled`, solo con `ronin:auto-merge`), cuando termina el CI de un PR (`check_suite.completed`), con una aprobación (`pull_request_review.submitted`), cuando se mergea el PR de abajo del stack y cuando termina bien la review interna de una slice: su status (`ronin/review-interna`) no despierta ningún webhook, y el paso de auto-merge de ese evento ya corrió antes que ella. Así el merge sale casi en el momento, sin esperar al cron ni a que termine otro trabajo. `check_suite` hay que sumarlo a los webhooks ya creados volviendo a correr `scripts/init-webhooks.sh`.

- **La review interna de los PRs de ronin (#194).** Todo el código de un PR de slice lo escribió la IA, así que antes de que una persona lo revise pasa por la misma review que ronin hace a los PRs de las personas (§4), sin publicar nada (`domains/review/internal.ts`). Corre en `processSlicePr`, en el PR del fondo, cuando el CI está en verde sobre un commit de punta que todavía no revisó, esté aprobado o no: la tarea `internal-review` (la skill `review-pr` de `external-review`, en modo propio: sin hilos y sin los menores) y, si encontró algo, `fix-internal-review` en la rama del PR. Esa tarea corrige los críticos e importantes (amend y force-push, con su auto-review), deja los menores y lo que ya existía, toma ella misma las decisiones que no son un bloqueo real (las anota en *Decisiones propias*), y escribe solo los bloqueos reales (su definición está en la skill `fix-findings`, `plugin/skills/`) como preguntas en `## Preguntas` de la descripción, antes de *Fuera de alcance*, cada una con sus respuestas sugeridas en un comentario HTML oculto, `<!-- ronin:opciones ["…"] -->` (`prQuestions`, `platform/github/pr-body.ts`). El commit en que termina queda como revisado (`internalReviewedSha` en el estado local, con el commit fijado), así que su propio push no dispara otra vuelta, y el próximo commit (una respuesta, un ajuste pedido) se revisa solo en lo que cambió. Las preguntas se contestan mencionando a ronin en el PR, o desde la ficha del tablero, que las trae en el detalle (`questions`) y las manda como la decisión `answer` (`domains/items/decision.ts`): al poner al día la descripción (la regla está en las skills, y la guarda la acción `pr.update-body`), saca las que quedaron resueltas. Los PRs de slice que ya estaban abiertos cuando llegó quedaron como revisados en su commit de entonces (`seedInternalReviews`, una sola vez, como `autoMergeDefaulted`): la review interna empieza con el trabajo nuevo, sin volver sobre PRs que alguien ya podía estar revisando. Mientras corre, el PR muestra el status `ronin/review-interna`; si falla, lo dice ahí, no se reintenta sobre ese mismo commit y el auto-merge sigue esperando, así que lo mergea una persona.
- **La autorrevisión (#442).** Las corridas que cambian código para atender una review se revisan antes de subir con un subagente (`answer-mentions`, `address-comments`, `fix-findings`, con el modelo de `reviewWorkerModel`). En un PR de ronin sin cambios pedidos, la review interna va a revisar ese push, sobre lo que cambió, así que `review-request` y `fix-comments` no la hacen: el prompt lo dice (`selfReviewLine`, `selfReviewsOwnPr`).
  - **Donde sigue:** `fix-review` y cualquier PR con `CHANGES_REQUESTED` (la review interna espera la aprobación), `fix-internal-review` (su propio commit queda como revisado) y los PRs de otras personas.
  - **Cómo es:** el subagente recibe lo que la corrida ya leyó (las menciones, los hilos o los hallazgos, y los comentarios anteriores), se queda en el diff y en el código que lo llama o al que llama, y no corre tests ni lee specs que el cambio no toca. Un cambio solo de documentación o de textos lo revisa la corrida misma, sin subagente.
  - **Por qué:** medido entre el 23 y el 24/10, se llevaba de 1 a 5 minutos de las corridas largas, y en `review-request` corría además de la review interna.

### 14. Reacción por evento; el tick como conciliación

Antes, cada evento de GitHub que importaba despertaba un tick completo (todos los repos, todos los flujos), y el tick es *single-flight*: un evento que llegaba durante un tick esperaba a que ese terminara y después a otro entero. Medido en 419 corridas (13–15 de octubre de 2026): p50 0.9 min, p90 4.9 min, máximo 31 min, y más de la mitad de los disparos llegaban con un tick en curso. Una aprobación o un `/preview` podían esperar media hora detrás de una review larga.

Ahora cada evento tiene su handler:

- **Dispatcher** (`apps/api/webhooks/events.ts`, `scopeForEvent`): traduce el evento a un *scope*: los flujos que ese evento puede mover y los recursos que toca. Por ejemplo, un comentario en un PR mueve `issues`, `idle-commands`, `review` y `exploration` sobre `pr-N`; el CI que termina mueve `auto-merge` e `issues` sobre cada PR de la suite; un PR en una rama `ronin/<issue>/…` suma `issue-<issue>`. Un evento que nada mueve se ignora.
- **Comandos directos**: un comando en un PR (`/help` y comandos mal escritos, `/preview`, `/resolve-conflicts`, `/auto-merge`) va solo al flujo `pr-commands`, que corre `findUnprocessedMentions` de ese PR y nada más: no lista issues ni PRs ni corre el pipeline. `/fix-comments` sí sigue por su flujo, porque lo atiende el pipeline del issue o la review. Como ese handler no toma el issue, el tick puede estar leyendo el mismo comando: cada comentario se toma con un lock propio y, una vez tomado, se vuelve a mirar si ya está procesado (`claimComment` en `mentions.ts`), así nunca se responde dos veces.
- **Lo propio no cuenta**: los comentarios y reviews de la cuenta de ronin no lanzan nada; sus PRs sí (uno recién abierto es parte del stack de un issue). Tampoco los comentarios de otra app que no mencionan a ronin (#370), como los del bot de Linear al vincular un issue, que eran una corrida de cuatro flujos sin nada que hacer: ronin lee ese vínculo después, en la corrida del issue. La review de un bot sí cuenta, porque puede importar al auto-merge.
- **Servidor** (`apps/api/webhooks/github.ts`, en el servidor de ronin, §15.2): recibe los eventos en `POST /api/webhooks/github`, pone 👀 en un comentario que menciona a ronin apenas llega (`addAckReaction`), antes de procesarlo. Junta los eventos sobre lo mismo y lanza un handler (`webhooks/debounce.ts`). La espera depende del evento (#370): `check_suite` y `workflow_run`, que llegan en ráfaga, uno por workflow y casi siempre con 5 a 15 s entre uno y otro, esperan `WEBHOOK_BURST_DEBOUNCE_MS` (15 s). Todo lo demás, que es una persona esperando a ronin (un comentario, un comando, una mención, una aprobación, un label), espera `WEBHOOK_DEBOUNCE_MS` (1 s). Un evento de espera corta adelanta la ventana que ya estaba abierta para ese PR, así que nadie espera detrás de un check que llegó antes. Si para esos issues o PRs ya hay uno esperando en la cola, el nuevo le suma sus flujos en vez de encolar otra corrida (`enqueueEvent`: la clave es el repo y sus recursos, sin los flujos). Distintos PRs o issues tienen handlers propios, a la vez.
- **Handler** (`apps/api/webhooks/handler.ts`): un proceso por evento, como los workers. Corre los mismos flujos que el tick (`runScoped` en `tick.ts`), pero solo los del scope y solo los jobs que tocan sus recursos, con un discovery acotado (`findPrsNeedingReview([N])`, `findIssueCommands([N])`). A un comentario en un PR, que llega sin rama, le busca el issue del PR. Si ya hay otro handler esperando para el mismo scope, no hace falta otro: el que espera va a leer todo cuando le toque.
  - **Reiniciar el servidor no lo corta:** el servicio tiene `KillMode=process`, así que un deploy detiene solo el servidor, y cada handler termina su evento y sale solo.
  - **Tope:** tiene `EVENT_HANDLER_TIMEOUT_MINUTES` (120 por defecto) para todo el evento: esperar su turno y un cupo, y cada agente que lance. Pasado ese tiempo se corta junto con su grupo de procesos, que incluye el `claude -p` que esté corriendo. Los workers que lanzó tienen su propio grupo y siguen. Sus locks llevan su pid, así que el siguiente proceso los toma, y el tablero muestra la corrida como cortada.
- **Tick** (el planificador del servidor con `DATABASE_URL`, o el cron sin ella): sigue corriendo todos los flujos sobre todo, como conciliación. Levanta lo que ningún handler hizo (un webhook que no llegó, un runner apagado) y el trabajo periódico (exploración nocturna, poda de estado).

**Un solo emoji, "procesado" aparte** (`platform/state/processed-comments.ts`): el 👀 de ronin solo dice "recibido" — lo pone el servidor al llegar el comentario, o el flujo que lo procesa si el webhook nunca llegó. Que un comentario ya está atendido se guarda en el estado local (`processedComments`, por repo), y solo cuando el trabajo salió bien: una falla no se anota y se reintenta, como antes. Un comentario de antes de este cambio cuenta como atendido si el 👀 de ronin es anterior a `ACK_EYES_SINCE` (el deploy en el runner, 2026-10-16T01:03:19Z), que es cuando el 👀 todavía significaba "procesado"; el 👀 de acuse, posterior, no cuenta, y lo que se encontró así queda anotado como atendido, para no volver a preguntarlo en cada tick. Es una fecha fija a propósito: tomarla de la primera lectura del estado dejaba afuera el acuse que el servidor pone segundos antes de esa lectura, y ese comentario se daba por atendido sin responderse. Uno de más de 180 días cuenta como atendido siempre, y por eso las entradas de más de 180 días se podan. Es estado de este runner: con un solo runner por repo (hoy `ronin-agent`) no hace falta compartirlo; varios runners sobre el mismo repo necesitarían volver a guardarlo en GitHub.

**Dónde se buscan las menciones (#370).** En una corrida del tick (`withGithubMemo`), `findUnprocessedMentions` no lee los comentarios de cada PR por su cuenta, con 3 llamadas por PR. Se queda con lo de ese PR entre los comentarios de todo el repo actualizados en los últimos 3 días (`RECENT_COMMENTS_MS`): los de la conversación de issues y PRs (`issues/comments?since=`) y los de review (`pulls/comments?since=`), unas pocas páginas por corrida (`listRecentPrComments`). Los reviews, que REST no lista por repo, salen de una consulta GraphQL con los de todos los PRs abiertos (`readOpenPrReviews`); solo un PR que no estaba abierto al leerla pide los suyos (`/reviews`). Las menciones en un issue (`findUnprocessedIssueMentions`, de los comandos `/spike`, `/explore` y `/spec`) salen de esos mismos comentarios, sin llamada propia. En la corrida de un evento sobre un comentario, ni eso: el webhook trae el comentario (o el texto de la review) y la corrida busca las menciones de ese PR o issue solo en él, sin ninguna llamada (`scope.comments`, `commentOf` en `webhooks/events.ts`). Lo que dice un comentario no cambia, y una edición es otro evento. Si el debounce o la cola juntan varios eventos, sus comentarios se suman. Una mención más vieja todavía por atender en ese PR la ve el tick siguiente. Una mención en línea por atender toma su hilo entero del PR, porque el que vino en la ventana, o en el evento, puede no traer el comienzo. Una mención que falla se reintenta mientras esté en la ventana: tres días, mucho más que un tick. Fuera de una corrida (el tablero), cada PR se lee como antes.

**Quién trabaja en qué** (`platform/locks/locks.ts`): cada job declara el recurso que toma (`issue-N` para todo el stack de un issue y sus worktrees `ronin/N/*`, `pr-N` para un PR ajeno o de exploración, `changelog`), y los pasos de todo el repo (`assign`, `sweeps`, `auto-merge`) tienen su propio lock. Son archivos con el pid del proceso en `<worktreeBasePath>/.locks/`, así que uno que dejó un proceso muerto se toma.
- El **tick** saltea lo que está tomado: quien lo tiene ya lo está atendiendo.
- El **handler** toma todos los recursos de su scope antes de leer nada de GitHub, esperando a quien los tenga, en orden (no hay deadlock entre handlers). Lo que lee después es el estado posterior a lo que hizo el otro, nunca el de antes. Un job suyo con un recurso que no estaba en el scope (el issue que acaba de crear una asignación) lo toma sin esperar.
- `sweepOrphanedWorktrees` solo borra el worktree de un issue que nadie tiene tomado: un handler puede estar implementando una slice que todavía no tiene PR. El `plan` de un spec toma su issue mientras corre por lo mismo.

**Con `DATABASE_URL`** (#235, etapa 3.2; `platform/locks/locks-db.ts`), los locks de recursos y los cupos son filas de la tabla `locks` en vez de archivos con pid: cada una la tiene un proceso (`host:pid`) con un lease que renueva cada 30 s. Una cuyo lease venció se toma; una de un proceso de esta máquina que ya no existe, en el momento, como con los archivos. Lo que espera un cupo es una fila de `lock_waits`, y el tablero lee de ahí los cupos ocupados y la cola. Las reglas son las mismas.

**Cupo por repo**: la `concurrency` del repo (o `TICK_CONCURRENCY`) y los topes por tipo (`EXTERNAL_REVIEW_CONCURRENCY`, changelog y exploración de a uno) valen para el runner entero, no por proceso, pero cada repo tiene los suyos: cada job toma un slot de `.ronin-slots/` de su repo (`<repo>~all-<i>.lock`, y el de su tipo) antes de correr, y espera si no hay. Así, con 15 issues asignados en un repo y 5 en otro, los dos avanzan a la vez; antes el cupo era uno solo y el repo con más trabajo lo ocupaba entero. Cada repo suele usar su propia cuenta de Claude (`claudeConfigDir`), que es la cuota que este cupo protege. El tablero muestra los lugares ocupados de cada repo. Los jobs que nunca corren un agente (comandos, lanzar un worker) no toman slot: un `/help` no espera detrás de tres `claude -p`.

**Estado local entre procesos**: `.ronin-state.json` se escribe con un lock de archivo además de la cola en memoria, y atómicamente (se escribe aparte y se renombra), así nadie lee un archivo a medio escribir y lo toma por vacío.

**La cola de trabajos** (#235, etapa 3; `jobs/`, solo con `DATABASE_URL`). El tick y cada handler son trabajos en la tabla `jobs`, en vez de lanzarlos el cron y el servidor:
- **El planificador** (`apps/api/jobs/scheduler.ts`), dentro del servidor, pone en cola el tick a sus horas: cada `TICK_INTERVAL_MINUTES` (30, editable en Ajustes) contados desde la hora en punto, así que :00 y :30. Uno ya en cola no se vuelve a encolar: un tick que sigue corriendo cuando llega la hora tiene exactamente uno detrás, como hacía `.tick.pending`. Cada 6 horas borra los logs y las corridas de más de 14 días y los trabajos terminados, lo que hacía el script del cron.
- **El webhook** encola su handler (tipo `event`) después de juntar la ráfaga; uno idéntico ya en cola no se duplica.
- **El runner local** (`apps/api/jobs/runner.ts`) toma los trabajos cada 2 s, con `FOR UPDATE SKIP LOCKED` y un tope por tipo (un tick, 20 handlers), y arranca cada uno en su proceso, como `launchWorker`, con `RONIN_JOB_ID`.
- **El proceso del trabajo** (`apps/api/jobs/child.ts`, `runAsJob`) renueva su lease cada 30 s y marca cómo terminó (`done`, `failed`, o cortado por una señal). Por eso un reinicio del servidor no lo corta ni lo duplica. Uno que deja de renovar el lease (su proceso murió) queda `lost`: no se reintenta, el próximo tick concilia.
- **El cron sobra:** `pnpm cron:remove`. El script que instala sale sin hacer nada si encuentra `DATABASE_URL`, por si quedó.

**Métricas**: el handler loguea `event_start` con `delayMs` (desde que llegó el evento hasta que tiene sus recursos) y `event_complete` al terminar, junto al `tick_complete` del tick.

### 15. Tablero web (#65, #85, #93, #111, #155, #158, #195)

Una página para ver qué está haciendo ronin sin recorrer GitHub issue por issue ni leer el log: qué agentes corren y qué hacen paso a paso, qué issues esperan a alguien y por qué, cómo va cada stack de slices, qué previews están arriba y cuánto le queda a cada cuenta de Claude. Cada issue o PR tiene su ficha, con lo que dice en GitHub, y desde ahí se le pueden pedir a ronin los comandos más usados (15.11). Cada app que ronin explora tiene su página, con las fichas de su PR de exploración para revisarlas una por una, sus corridas y su inventario, y desde ahí se la explora a pedido (15.12). Cualquier PR se revisa archivo por archivo, con su revisión (15.14); uno de ronin se decide desde su encabezado: aprobar y mergear, pedir un ajuste o cerrar (15.15). Los admins publican los despliegues de cada repo (§18). Lo que se hace desde la página sale en GitHub a nombre de quien entró (15.3). Se ve solo por la tailnet.

#### 15.1 Qué muestra

- **Barra lateral: solo issues (#100).** Arriba, *Hoy*, *Corriendo ahora*, *En cola* y las páginas propias, entre ellas *Exploraciones* (15.12), con cuántas fichas esperan una decisión, y *Despliegues* (§18), solo para admins, que dice *en curso* mientras corre el workflow de un release. Después, *Exploraciones*, con cada app de `explore` y su estado (explorando, fichas por decidir, esperando a ronin o sin PR), que se busca por el nombre de la app o el número de su PR; y cada repo de `repos.json` con:
  - **Sin buscar,** el trabajo pendiente: los issues de ronin (label `ronin`), aunque no haya corrido un agente, y los issues sobre los que ronin trabajó en los últimos 3 días (un pedido, una review del PR de una persona) mientras sigan abiertos. Uno cerrado (completado o no planeado, según `listRecentlyClosed`) sale de la lista salvo que sea el que está abierto en la ficha; se encuentra buscándolo por su número.
  - **Buscando** (título, número, `RED-n` o el número de un PR), o filtrando por un ciclo o un proyecto de Linear (15.13), todos los issues abiertos del repo (`listOpenIssues`, en la misma lectura cacheada).

  **Los PRs viven en su issue** (`linkPrs` en `items/github.ts`): una slice de ronin en el suyo; si no, el issue abierto que cierra (`closingIssuesReferences`, por GraphQL); si no, el issue abierto cuyo número lleva la rama (`feat/405-…`, `valeria/228/slice-12`). Las corridas sobre esos PRs cuentan como del issue. Buscar el número de un PR muestra su issue con la slice resaltada.

  **Lo que no tiene issue:** un PR sin issue ni número en la rama, o el changelog, solo aparece mientras corre (*Corriendo ahora*) y en *Hoy*. Un número que no está en la lista ofrece *Abrir #N*: el servidor le pregunta a GitHub si es issue o PR (`itemKindOf`) y abre la ficha aunque esté cerrado.

  **El punto y el ícono (#129).** El punto de color dice lo que hace ronin: corriendo, esperando, bloqueado o un error. Un issue bloqueado queda en su lugar de la lista, con el punto rojo: no tiene grupo propio. El ícono junto al número dice cómo está el ítem en GitHub, con los íconos y colores de GitHub (Octicons, en `web/vendor/octicons.js`, MIT):
  - **Issues:** abierto (verde), cerrado como completado (check morado) y cerrado como no planeado (círculo gris tachado).
  - **PRs:** abierto (verde), draft (gris), mergeado (morado) y cerrado sin mergear (rojo).
  - **Dónde aparece:** en la barra lateral, en las slices (la pendiente, que todavía no tiene PR, sigue con su punto) y en *Necesitan tu atención*. En la ficha va además como la pastilla de GitHub ("Abierto", "Cerrado", "Mergeado"…).
  - **De dónde sale:** los abiertos, de la lectura cacheada del repo. Los cerrados, de una sola consulta GraphQL por lectura (`listRecentlyClosed`: los últimos 100 issues y PRs cerrados, con `stateReason`, que el `gh` 2.45 no trae). Uno más viejo, abierto con *Abrir #N*, toma el estado de su ficha.
  - **Accesibilidad:** cada ícono lleva el estado en palabras (`aria-label` y `title`).

  Cada fila lleva un punto de estado, el número, la preview si el issue tiene una (*preview* en verde cuando está lista, *preview…* mientras prepara los datos o se actualiza), cuántas slices van mergeadas (o el PR de una persona: "PR #910 de dev-ejemplo"), el `RED-n` y el proyecto si hay Linear, la última línea del agente (o lo que espera: "esperando review en #881", "conflictos en #904", "aprobado, falta el merge de #401") y hace cuánto. Un issue elegido, corriendo o bloqueado se despliega en sus slices.

  **El orden es fijo:** dentro de cada grupo, el número más nuevo primero. Que un agente arranque sobre un issue no lo mueve; lo dice su punto.
- **Centro: la ficha del ítem.** Pestañas, una por ítem abierto; al cargar se abren las de los agentes que corren. Cada una muestra la ficha del issue o PR, tenga corridas o no:
  - **Encabezado.** Título, repo y el botón *Acciones* (15.11). Los links a GitHub y a Linear están en el contexto, a la derecha. En un PR de ronin, también *Cerrar*, *Ajustar* y *Aprobar* (15.15); en el de una persona, *Revisar* (15.14). Debajo, chips con su estado. El PR del ítem (o, en un issue, el de la slice que avanza) suma si tiene conflictos con su base, sus checks, la review y si es draft. Un issue suma cuántas slices van mergeadas y qué espera.
  - **Actividad.** Una línea con la última corrida (estado, hace cuánto, duración, costo y el error si falló) y las dos anteriores, cada una con su transcript; si hay más, *Historial (N)* las lista todas, las de los últimos 14 días, por día y con lo que suman (#363). Si hay una en curso, una tarjeta con lo último que dijo el agente, sus últimos cuatro pasos y el reloj, que se sigue en vivo.
  - **Pestañas *Fichas*, *Corridas* e *Inventario*,** solo en un PR de exploración, que es la página de su app (15.12). *Fichas* va primera: las propuestas que trae, para revisarlas y decidir. Mientras está abierta, la columna de contexto se oculta para dejarle lugar.
  - **Pestaña *Archivos*,** en un PR y en un issue con un PR que avanza: el diff con sus hilos, para comentar y revisar (15.14). Como *Fichas*, ocupa también la columna de contexto.
  - **Pestañas *Issue* y *PR*.** La descripción del issue y la de su PR (o la del PR y la de su issue de tracking), cada una con su conversación debajo: los comentarios del issue en *Issue*; los comentarios, las reviews y los hilos del PR en *PR*, con los de ronin marcados. Un issue con un PR abierto abre en la pestaña del PR, que dice qué se hizo (y, en *Qué se pidió*, qué se pidió). Es el markdown de GitHub, saneado (15.3). La de un PR de ronin se muestra por secciones, con *Decisiones propias* destacada (15.15). Un `#123` abre ese ítem en el tablero si está en la barra lateral, y si no, en GitHub.
  - **El transcript de una corrida** se abre desde la actividad, con "← Ficha" para volver: los textos del agente y sus pasos (leyó, buscó, editó, corrió), arriba las corridas del ítem y abajo el estado, el reloj, el modelo y el worktree. Los agentes de una misma preview (catálogo de seeds, *Revisión de los seeds*, datos de preview, datos al actualizarse) son **una corrida, *Preview***: cada uno se guarda con el mismo `group` (`platform/agents/run-group.ts`: `preview:<pr>:<cuándo>`, puesto con `withRunGroup` alrededor de la preparación de datos en `preview.ts`), y el tablero los junta. En la actividad y en la lista de corridas va una sola, con su duración y su costo sumados, que está corriendo mientras corra un paso y, si no, termina como su último paso (o como el primero que falló); en el transcript, una fila *Pasos* abre cada uno. *Hoy*, la barra lateral y el contexto dicen "Preview: Revisión de los seeds". Las corridas anteriores a esto no tienen grupo y siguen sueltas. Una corrida en curso se sigue en vivo, y si arranca una nueva sobre el ítem abierto, aparece sola. Lo que no es un issue ni un PR (el changelog) abre directo en el transcript, igual que una corrida elegida en *Hoy*.
- **Contexto, a la derecha.**
  - El link al issue o PR en GitHub y, si tiene, al issue de Linear con su estado, proyecto y ciclo. Si el issue de Linear no está entre los que lee el tablero, solo su `RED-n` con el link, del comentario de su bot.
  - El motivo de un bloqueo y cómo destrabarlo.
  - El árbol de slices con sus PRs, checks y reviews.
  - Los checks del PR que está avanzando.
  - La preview, con su URL y cuánto le queda. Mientras ronin prepara los datos que piden los pasos de prueba, lo dice y todavía no ofrece la URL para abrir.
  - Los datos de la corrida: tarea, modelo, cuenta, duración, costo y worktree.
- **Barra de estado.** El uso de cada cuenta de Claude en la ventana de 5 horas y en la semanal, los cupos de agentes ocupados, la cola, las previews, el último tick y si GitHub no responde.
- ***Hoy*, la vista de inicio.**
  - **Los números del día:** corridas, cuántas terminaron bien, duración mediana y p90, costo y errores, con los de ayer al lado y una mini línea de los últimos 7 días.
  - ***Necesitan tu atención*:** los issues bloqueados con su motivo, los PRs de ronin que esperan review o merge (el que más espera primero, desde la última corrida), el PR de exploración y las previews arriba. Cada fila abre su ítem; la del PR de exploración, la página de su app.
  - **Con Linear (§15.13), el ciclo actual:** una barra por estado y un gráfico de issues en el ciclo contra hechos, día por día. Debajo, el desglose por proyecto (un clic filtra la barra lateral) y quién tiene lo que falta.
  - **Las últimas 12 horas:** un carril por repo y cada corrida como una barra. Al hacerle clic, se abre esa corrida.
- **Teclado (#195).** En la ficha, mientras no se escribe: `1`–`9` van a una pestaña; `j`/`k` a la siguiente o anterior unidad de la pestaña (sección de la descripción, comentario, archivo en *Archivos*, ficha en *Fichas*); `d`/`u` media página; `gg`/`G` al inicio o al final; `]p`/`[p` al siguiente o anterior PR de ronin que espera una decisión (listado, no draft, sin aprobar y sin un agente corriendo). `?` abre la ayuda con todos, también desde el botón junto a las pistas de la barra de pestañas. `Ctrl/Cmd + número` no se usa: el navegador lo reserva.
- **Celular.** La barra lateral es la lista principal, y un ítem abre su ficha con el contexto debajo.
- **Movimiento.** Poco y rápido (120–200 ms): lo que se señala cambia de color suave, y lo que aparece (una página, el cuerpo de una pestaña, un menú, un panel, un diálogo, un aviso, las slices de la barra lateral) entra con un fundido o un desplazamiento corto en vez de aparecer de golpe. Nada se anima al irse. En el celular, los paneles que suben desde abajo entran desde abajo. La página y el cuerpo de una pestaña solo cambian de opacidad, para que un hijo fijo (el árbol de archivos en el celular) no se mueva mientras entran. Con *reducir movimiento* en el sistema no hay animaciones ni transiciones, y el punto de una corrida en curso queda quieto, como antes.
  - **Lo que cambia solo se nota** (#372). Cuando un ítem de la barra lateral pasa a corriendo, bloqueado o esperando, su fila se ilumina un segundo y se apaga. Un paso nuevo del transcript de una corrida en curso entra con el mismo fundido que el resto.
  - **Al saltar a algo** (`j`/`k`, un comentario o un archivo en *Archivos*, una línea citada de las notas de una reunión), el destino queda remarcado un momento.
  - **Cargas sin saltos.** La ficha, el transcript de una corrida, la lista de pedidos y el historial de corridas muestran un esqueleto con su forma mientras llegan, en vez de «Cargando…».
  - **Los botones que mandan algo** quedan desactivados y dicen qué hacen («Enviando…», «Aprobando…», «Cerrando…») mientras esperan al servidor; no se puede mandar dos veces. El aviso de abajo (toast) trae un check cuando salió bien, y es lo único que se va con un fundido; todo lo demás se cierra al instante.
  - **Lo que gira:** la flecha de lo plegable (los pasos del historial, los archivos, las citas de una reunión) gira en vez de cambiar de carácter.
  - **Para lectores de pantalla:** un ítem que pasa a bloqueado se anuncia en una región `aria-live`, y el toast es un `status` (o un `alert`, si algo no se pudo).
  - **Con *reducir movimiento*,** los resaltados se ven el mismo tiempo pero sin desvanecerse, y los esqueletos quedan quietos.
- **Actualización.** La página pide el snapshot cada 5 segundos mientras está visible, y el transcript de una corrida en curso le llega por *server-sent events*. La ficha se vuelve a pedir cada 30 segundos (el servidor la tiene en caché, 15.8). El centro solo se redibuja si algo cambió, así que leer, seleccionar texto o tener el menú abierto no se interrumpe. No hace falta recargar.

#### 15.2 El servidor de ronin: API y aplicación web

El servidor que recibía los webhooks pasó a ser el servidor web de ronin (`src/server/`, servicio `ronin-server`), con una **API** en `/api/*` y la **aplicación web** del tablero en todo lo demás. Los webhooks son parte de la API.

```
src/server/
  index.ts             el proceso: los dos listeners
  public.ts            lo que atiende el listener público: los webhooks y el portal de pedidos (§16)
  portal.ts            el portal: su página y su API
  tailnet.ts           lo que atiende el de la tailnet: la app y toda la API
  api/
    webhooks/          POST /api/webhooks/github: github.ts, events.ts, handler.ts (§14)
    apps/api/http/auth.ts            /api/auth/login, /callback, /logout y /me
    dashboard*.ts      los datos del tablero
    portal*.ts         la API del portal y su administración (§16)
src/apps/dashboard/     el tablero, en React: Vite lo arma en dist/public/dashboard/dashboard.js
  public/              index.html, el CSS, theme.js y las fuentes, tal cual
  vendor/              marked, DOMPurify y los íconos de GitHub, copiados como vienen
  src/shell/           el marco: la barra lateral, la columna de contexto, la barra de estado, las rutas y lo que lee para ellas;
                       hooks.ts, lo que las páginas leen del marco (hooks) y le piden (useShell)
  src/pages/           una por archivo, o una carpeta cuando tiene varios (deploys/: la página, el diálogo, lo que comparten)
  src/lib/             lo que no dibuja (las fechas, el markdown de GitHub, las pestañas de un ítem)
src/apps/portal/        la página del portal de pedidos
```

- **Listener público** (`SERVER_PORT`, 3939; `WEBHOOK_PORT` se sigue leyendo si no está). Es al que llega `https://ronin-agent.redmotoshn.com`, por el túnel de Cloudflare y nginx-proxy-manager. Atiende `POST /api/webhooks/github`, más el alias `/webhook` de la ruta anterior, y, con el portal configurado, el portal de pedidos (§16): su página y `/api/portal/*`. Cualquier otra ruta responde 404: el tablero y su API nunca se sirven ahí. La restricción está en el código, así que no depende de cómo esté configurado el proxy.
- **Listener de la tailnet** (`127.0.0.1:SERVER_TAILNET_PORT`, 3940).
  - **Solo en `127.0.0.1`:** no se ve desde la LAN ni desde otra interfaz.
  - **Publicación:** `pnpm server:setup` lo publica con `tailscale serve --bg --https=8443` (`DASHBOARD_TAILNET_HTTPS_PORT`), nunca con `funnel`.
  - **Quién lo ve:** el 8443 queda fuera de `PREVIEW_PORT_RANGE`, lo único que la política de Tailscale les abre a externos (§12), así que solo lo ve el dueño, que tiene `*` sobre `tag:media`.
  - **HTTPS y LAN:** `tailscale serve` pone el HTTPS que necesita la cookie de sesión. Desde la LAN se entra por la misma URL, con Tailscale en el equipo.
  - **Solo con login configurado:** arranca solo si están las variables del login (15.3); sin ellas, el servidor atiende únicamente los webhooks.
- **La aplicación** son archivos estáticos sin datos adentro: todo lo pide a la API. Se sirve sin sesión, y cuando la API responde 401 muestra *Entrar con GitHub*, con el motivo si la sesión venció mientras se usaba. Si en ese momento hay algo escrito (un diálogo abierto, un comentario a medias), la página se queda: un aviso arriba abre el login en otra pestaña y el diálogo vuelve a dejar enviar. Una ruta que no es un archivo devuelve la app. Un issue o un PR se abre en el mismo camino que en GitHub (`/<owner>/<repo>/issues/<n>`, `/<owner>/<repo>/pull/<n>`), así que se pasa de uno a otro cambiando solo el dominio. Los enlaces viejos (`/i/<owner>%2F<repo>%23<n>`) siguen abriendo y la barra toma la ruta nueva. `pnpm build` arma el tablero con Vite en `dist/public/dashboard/` (`dashboard.js`, junto a lo que hay en `src/apps/dashboard/public/`).
- **Errores aislados.** Un pedido que tira un error responde 500 y se loguea, sin tirar el proceso que recibe los webhooks. Si igual se cae, systemd lo reinicia y el tick levanta lo que llegó mientras tanto.
- **La ruta de los webhooks.** Pasó de `/webhook` a `/api/webhooks/github`. `scripts/init-webhooks.sh <url>` busca el hook de ronin por la URL nueva o por la vieja del mismo dominio y le cambia la URL, en vez de crear un segundo hook que entregaría todo dos veces. El alias `/webhook` se puede sacar cuando ningún hook apunte ahí.

#### 15.3 Login con GitHub

La tailnet ya limita quién llega. El login suma una segunda barrera, y el token con el que el tablero escribe en GitHub a nombre de quien entró (15.11, 15.12).

- **OAuth App de la cuenta del dueño, con el scope `repo`:** sirve para comentar y aprobar como la persona. Se configura con `DASHBOARD_GITHUB_CLIENT_ID` y `DASHBOARD_GITHUB_CLIENT_SECRET`, y su callback es `<DASHBOARD_URL>/api/auth/callback`. Funciona aunque esa URL solo se vea en la tailnet, porque la redirección la sigue el navegador.
- **Por qué `repo`:** el token puede escribir en todos los repos de la persona. Se aceptó porque el tablero solo se ve por la tailnet y solo para los logins de `DASHBOARD_ALLOWED_USERS` (#93). Una GitHub App acotaría mejor los permisos, pero hay que registrarla e instalarla en cada organización.
- **Flujo.** `/api/auth/login` redirige a GitHub con el scope y con un `state` al azar en una cookie de corta vida. `/api/auth/callback` verifica el `state`, canjea el código desde el servidor y lee `GET /user`. Si la persona destildó el scope en la pantalla de GitHub, el login se rechaza explicando por qué.
- **Quién entra.** La *Entrada* de Ajustes → Usuarios (§19.3): quien tenga acceso en GitHub, o solo la lista. Mientras nadie la elija, los logins de `DASHBOARD_ALLOWED_USERS`, separados por coma. Se vuelve a mirar en cada pedido, así que sacar a alguien lo deja afuera en el momento. Un login rechazado (fuera de la lista o sin el scope) revoca su token en GitHub.
- **Sesión.** Es una cookie con el login, el vencimiento (`DASHBOARD_SESSION_DAYS`, 7) y el token de GitHub, cifrada con AES-256-GCM con una clave derivada de `DASHBOARD_SESSION_SECRET`. GCM oculta el token y rechaza una cookie cambiada a mano, y no hay estado de sesión en el servidor. Es `HttpOnly`, `Secure` y `SameSite=Lax`. Cambiar el secreto cierra todas las sesiones, y una cookie del formato anterior (firmada, sin token) pide volver a entrar.
- **Salir** revoca el token en GitHub (`DELETE /applications/{client_id}/token`) y borra la cookie, aunque GitHub falle.
- **Volver a entrar** revoca el token de la sesión que tenía el navegador, aunque haya vencido: GitHub guarda diez tokens por persona y app y, al pasar de diez, revoca el más viejo, que podía ser el de otro equipo todavía en uso. Así cada navegador tiene uno. El login lleva `?next=<ruta>` y vuelve a esa página del tablero (solo rutas propias).
- **Organizaciones.** Si una organización restringe las OAuth Apps de terceros, un admin tiene que aprobar el tablero para que el token vea sus repos. Hasta entonces, GitHub responde 403 o 404 al comentar, y la página lo explica.
- **Lo demás:**
  - Un pedido que no es `GET` y trae un `Origin` de otro sitio recibe 403. Las acciones además solo aceptan JSON, que un formulario de otro sitio no puede mandar.
  - La app se sirve con una CSP que solo permite scripts propios (`script-src 'self'`, `frame-ancestors 'none'`). Por eso las fuentes van en `src/apps/dashboard/public/fonts/` y no se cargan de Google Fonts.
  - Todo lo que viene de los agentes se escapa antes de insertarse en la página, y además ya pasó por `redact()` al escribirse.
  - El markdown de GitHub (la descripción de un PR de cualquiera, un comentario) no es confiable: lo interpreta `marked` y lo limpia `DOMPurify`, copiados en `src/apps/dashboard/public/vendor/` porque la CSP no deja cargar scripts de afuera. Se descartan estilos, formularios e iframes, y cualquier link que no sea `http(s)`, `mailto` o `#`. Las imágenes pasan a ser links, porque la CSP tampoco las cargaría.

**Qué repos ve cada sesión (#106, `domains/access/access.ts`).**
- **Administradores:** los de `DASHBOARD_ADMINS` y los que se hagan administradores en Ajustes (§19.3) ven todos los repos. Sin definir, no hay ninguno: estar en `DASHBOARD_ALLOWED_USERS` deja entrar, pero no hace administrador. El arranque dice en el log quiénes son.
- **El resto:** ve los repos de `repos.json` en los que tiene al menos `triage` según GitHub. Se consulta con el token de la sesión: `GET /repos/{owner}/{repo}` y su campo `permissions`, donde un 404 es sin acceso. El resultado se guarda en memoria por sesión 10 minutos. Si GitHub falla, queda la última respuesta, y sin ninguna no se ve nada. Un 401 cierra la sesión.
- **Quién entra:** un administrador, o alguien con al menos un repo que ver. La *Entrada* de Ajustes (o `DASHBOARD_ALLOWED_USERS`) es además la lista de quién entra.
- **Qué puede hacer en cada repo, y qué repos se le ocultan:** Ajustes → Usuarios (§19.3), aplicado en `teamAccess`.
- **Dónde se aplica:** en el servidor. `tailnet.ts` calcula el acceso en cada pedido y `handleDashboard` lo guarda para todo el pedido (`AsyncLocalStorage`). Todas las lecturas de `apps/api/http/dashboard.ts` pasan por `visibleRepos()` y `listRuns()`, que solo devuelven lo de esos repos, y fuera de un pedido no devuelven nada. El snapshot, *Hoy*, la cola y el uso de las cuentas de Claude salen filtrados. Pedir por nombre algo de otro repo (una ficha, un transcript, una captura, una acción, *Nuevo issue*) responde 404.

#### 15.4 De dónde sale cada dato

| Dato | Fuente |
|---|---|
| Corridas, transcripts, *Hoy* | El registro por corrida, `logs/runs/` (15.5) |
| Uso de cada cuenta de Claude | `logs/usage/<cuenta>.json`, y su historial en `logs/usage/history/<cuenta>.jsonl` (15.6) |
| Motivo de un bloqueo | `blocks` en el estado local del repo (15.7) |
| Lo que espera un cupo | `.ronin-slots/waiting/` (15.7) |
| Cupos ocupados | `.ronin-slots/all-*.lock` con un pid vivo |
| Issues, slices, PRs, checks | GitHub, dos llamadas por repo (15.8) |
| Descripción y comentarios de un issue o PR | GitHub, al abrir su ficha (15.8) |
| Archivos de un PR y sus hilos de review | GitHub, al abrir *Archivos* (15.14) |
| Lo visto y la revisión pendiente de la persona | GitHub, con su token, al abrir *Archivos* (15.14) |
| Corridas de exploración | El registro de cada corrida (`logs/exploration/`, §11.8) y el de sus agentes (15.5) |
| Fichas e inventario de una app | El clon del repo de producto, en la rama del PR de exploración o en la base (15.12) |
| Previews | El `preview.json` de cada worktree de preview |
| Último tick y último evento | `tick_complete` y `event_complete` en `logs/tick-*.log` |

#### 15.5 Registro por corrida (`platform/agents/run-record.ts`)

Cada corrida de agente escribe `logs/runs/<día>/<runId>.jsonl`, con una línea JSON por evento:

- **`run_start`:** repo, tipo de tarea, issue o PR, slice, modelo, effort, cuenta, worktree, `pid` y hora de inicio. Lo escribe `runAgentTask`.
- **`text`, `tool` y `tool_error`,** a medida que pasan. Es lo mismo que va al log diario, con la misma truncación y sin el contenido de los `tool_result`. `runClaudeHeadless` se los pasa al registro además de loguearlos.
- **`run_end`:** el resultado (`ok`, `error`, `timeout` o `usage_limit`), la duración y los totales del evento `result` de `claude -p` (costo, tokens, turnos, `session_id`).

Cada campo pasa por `redact()` antes de escribirse. Una corrida sin `run_end` cuyo `pid` ya no vive se muestra como cortada. Si el registro no se puede escribir, la corrida sigue igual. `run-tick.sh` (generado por `scripts/setup-cron.sh`) borra las carpetas de más de 14 días, como los `tick-*.log`. El transcript completo que Claude Code guarda en `<claudeConfigDir>/projects/` no se usa, porque trae los `tool_result` enteros, sin redactar.

#### 15.6 Uso de cada cuenta (`platform/claude/claude-usage.ts`)

Cada corrida de `claude -p` emite en el stream un `rate_limit_event` con el uso de la cuenta en la ventana de 5 horas y en la semanal, y cuándo se reinicia cada una. `runClaudeHeadless` guarda el último en `logs/usage/<cuenta>.json`, con la hora en que se midió. La cuenta se nombra por su `claudeConfigDir` (`.claude-redmotos` → `redmotos`). Cuando una corrida termina por límite de uso, la cuenta queda marcada sin cuota (`limitHitAt`) hasta la próxima medición. Cada medición, y cada vez que se topa el límite (`limitHit`), se agrega además como una línea a `logs/usage/history/<cuenta>.jsonl`: es lo que permite ver cuánto se llenó cada ventana antes de reiniciarse, para el aprovechamiento de la suscripción en Métricas.

Una cuenta sin corridas recientes muestra un dato viejo, con su antigüedad a la vista. No se usa el endpoint que lee `/usage` de Claude Code (`/api/oauth/usage`): no está documentado, y con un token vencido habría que refrescarlo, compitiendo con Claude Code por el mismo `.credentials.json`.

#### 15.7 Motivo de bloqueo y cola

- **Motivo.** `notifyBlocker`, por donde pasan todos los bloqueos, lo guarda en el estado local del repo antes del email: `blocks[<número>] = { reason, url, prUrl, excerpt, at }`, con el número sacado de la URL del issue o PR. El tablero lo muestra solo mientras el ítem tenga `ronin:blocked`, así que no hace falta borrarlo al destrabar. Las entradas de más de 180 días se podan. Un bloqueo de un release (el changelog) no se guarda, porque no lleva label.
- **Cola.** Mientras un job espera un cupo, `withSlots` (`platform/locks/locks.ts`) deja `.ronin-slots/waiting/<pid>-<n>.json` con el tipo de job, su etiqueta, el repo y desde cuándo. Lo borra apenas consigue el cupo. Una marca de un pid muerto se ignora.

#### 15.8 Datos de GitHub (`domains/items/github.ts`)

Por repo, dos llamadas:
- Los issues abiertos con el label `ronin`, con su descripción, de donde salen las slices (`parseSlices`).
- Todos los PRs abiertos, con cada check (`listOpenPrsWithChecks`).

A eso se suman los motivos de bloqueo y las previews arriba.

El servidor hace la primera lectura de cada repo (GitHub y Linear) al arrancar (`warmDashboard`), para que la primera visita después de un reinicio no la espere. Cada repo se vuelve a leer a los `DASHBOARD_GITHUB_TTL_SECONDS` (60), o antes si una corrida suya empezó o terminó después de la última lectura. Mientras tanto se muestra la lectura anterior, así que varias pestañas abiertas no multiplican las llamadas. La barra lateral nunca espera una lectura entera del repo, salvo la primera (ver «Después de escribir», más abajo). Si GitHub falla, se conserva la última lectura con el error, que la página muestra, y las corridas locales se siguen viendo. Las previews no entran en esa caché: son archivos de esta máquina y se leen en cada pedido, así que una preview que terminó de preparar sus datos ofrece su URL en el siguiente refresco.

`items/list.ts` arma los ítems de la barra lateral con eso y con las corridas: estado, lo que espera cada issue, slices, el PR que avanza y su preview.

**La ficha** (`items/detail.ts`) se lee aparte, solo cuando alguien abre un ítem: la descripción del issue y la del PR, con los labels y, en un PR, sus ramas y si tiene conflictos. Los dos salen de una sola consulta GraphQL (`getItemDiscussions`, #368), con lo mismo que `getDiscussion`, que antes eran `gh issue view`, `gh pr view`, los hilos y, en un issue cerrado, cómo se cerró. Trae los últimos 50 comentarios del ítem, sin los comentarios de review de línea. Qué es cada número sale de la lectura del repo en caché:
- **Un issue** trae el PR de su slice que avanza.
- **Un PR de una slice** trae su issue de tracking, por el checklist o por la rama `ronin/<issue>/…`.
- **Lo que GitHub no lista** (el PR de una persona, un issue cerrado) usa lo que dicen sus corridas.

La caché es la misma idea que la de los repos: `DASHBOARD_GITHUB_TTL_SECONDS`, o antes si una corrida del ítem empezó o terminó después. Una ficha que nadie abre en 30 minutos se olvida.

**Después de escribir (#368).** Las cachés del tablero (el repo, la ficha, los archivos de un PR, lo de cada persona en Archivos y la exploración) son una sola pieza, `platform/cache/read-cache.ts`. Cada entrada lleva etiquetas: el repo y `<repo>#<número>` de cada issue o PR que muestra. Después de una acción del tablero, lo que cambió no se borra:
- **La ficha y los archivos del ítem** se vuelven a leer en el momento de escribir. El siguiente pedido de la persona espera esa lectura, que ya está en camino, así que ve lo que hizo. Los otros ítems del repo no se tocan.
- **Un comentario** entra en la ficha tal como se publicó (`addDetailComment`), y la lectura que lo confirma corre sin que nadie la espere.
- **El repo** se vuelve a leer en segundo plano, y la barra lateral sirve la lectura anterior mientras tanto. Un issue creado desde el tablero entra antes en la lista (`updateGithub`), así se puede abrir enseguida. Aprobar una reunión espera su lectura, porque crea issues que se abren después.
- **Lo de cada persona en Archivos** (`/files/mine`: los archivos vistos y su revisión pendiente) se guarda por persona y PR, y se vuelve a leer cuando esa persona escribe algo en el PR.

Una lectura que ya estaba en camino cuando se escribió nunca queda como la última: puede haber empezado antes del cambio.

**Los webhooks también (#368).** El servidor de webhooks y el tablero son el mismo proceso. Un `issues`, `pull_request`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` o `check_suite` vence lo que el tablero tiene de ese issue o PR (`items/freshness.ts`). Lo que alguien tiene abierto (pedido en los últimos 2 minutos) se vuelve a leer en el momento, sin que nadie lo espere; lo demás queda vencido para su próximo pedido. Si llega una ráfaga mientras una lectura está en camino, se suma una sola lectura más, no una por webhook.

**Optimista en el tablero (#368).** Lo que se hace desde el tablero se ve en el momento, como algo en camino, y se deshace si GitHub no lo toma:
- **Comentar**, en la conversación o en una ficha, y **una acción** que comenta: el comentario aparece al final, con *enviando…*, y queda hasta que una lectura del ítem lo trae (por su URL, o por quién escribió qué; `shell/pending.ts`). Si falla, sale de la conversación y el texto vuelve al cuadro o al diálogo, con el motivo.
- **Una decisión** (aprobar, ajustar, cerrar) y **una revisión**: el panel se cierra, la ficha dice que va en camino y, al aprobar o pedir cambios, los chips del PR ya lo muestran. Los botones de decisión esperan hasta que GitHub responde. Si falla, se deshace y el panel vuelve con el texto.
- **En Archivos**, comentar ya, responder, resolver o reabrir, y borrar un comentario de la revisión pendiente cambian lo leído en el momento (`setQueryData`) y vuelven a como estaba si falla. Sumar o editar comentarios de la revisión pendiente espera, como antes: solo los ve la persona.

Lo que sigue esperando: las acciones de una ficha en su diálogo (desarrollar, finalizar la revisión), cuyo comentario arma el servidor, y crear un issue.

#### 15.9 API

Todo, salvo los webhooks y `/api/auth/*`, pide sesión. Las rutas pasan a Hono de a un grupo (#235, etapa 6): cada grupo vive con su dominio (`domains/portal/routes-dashboard.ts`, `domains/meetings/routes.ts`, `domains/deploys/routes.ts`, `domains/metrics/routes.ts`, `domains/explorations/routes.ts`, `domains/settings/routes.ts`, `domains/runs/routes.ts` e `domains/items/routes.ts`, con lo que leen en `domains/items/service.ts`) y `apps/api/routes.ts` los monta; `apps/api/http/dashboard.ts` solo le entrega cada pedido. Las rutas y lo que devuelven no cambian:

| Ruta | Qué devuelve |
|---|---|
| `GET /api/snapshot` | Los ítems, las apps que se exploran (con su PR y si se están explorando), si la sesión puede desplegar (`despliegues`), el uso de cada cuenta, los cupos, la cola, el último tick, las previews y el estado de la lectura de GitHub |
| `GET /api/today` | Las corridas de las últimas 12 horas y los totales de hoy y de ayer |
| `GET /api/items/<id>` | Las corridas de un ítem en los últimos 14 días |
| `GET /api/items/<id>/detail` | Su ficha: el issue y el PR con los comentarios del ítem, y las acciones que se le pueden pedir, cada una con el comentario que dejaría |
| `POST /api/items/<id>/actions` | Pide una de esas acciones: `{ action, text?, app? }` (15.11) |
| `POST /api/repos/<owner>/<repo>/issues` | Crea un issue a nombre de la persona y, si se pide, lo asigna a ronin o le comenta `/spike` o `/spec`: `{ title, body, after, app?, instruction? }` (15.11.1) |
| `GET /api/explorations` | Cada app que se explora, con las fichas de su PR contadas, la última corrida y la próxima de la noche (15.12) |
| `GET /api/explorations/<owner>/<repo>/<app>/runs` | Sus corridas de los últimos 14 días, cada una con sus agentes |
| `GET /api/explorations/<owner>/<repo>/<app>/inventory` | Sus funciones y qué charters ya se les aplicaron, de `inventory.yml` |
| `POST /api/explorations/<owner>/<repo>/<app>/run` | La explora ahora: `{ maxFunctions, hours, tonight }`; 409 si el repo ya está explorando (15.12) |
| `GET /api/items/<id>/exploration` | Las fichas de un PR de exploración abierto, leídas en partes, con su hilo (15.12) |
| `POST /api/items/<id>/exploration/actions` | Comenta en una ficha: `{ action, ficha, text, redo? }` (15.12) |
| `POST /api/items/<id>/exploration/general` | Un comentario general en el PR: `{ text }` (15.12) |
| `POST /api/items/<id>/exploration/approve` | Aprueba el PR: `{ text? }` (15.12) |
| `GET /api/items/<id>/files` | Los archivos del PR del ítem con su patch, y sus hilos de review (15.14) |
| `GET /api/items/<id>/files/content?path=` | Uno de esos archivos en el head del PR, para mostrar más líneas |
| `GET /api/items/<id>/files/mine` | Lo que la persona marcó como visto y su revisión pendiente |
| `POST /api/items/<id>/files/actions` | Comenta, responde, resuelve, marca visto o maneja la revisión: `{ action, … }` (15.14) |
| `POST /api/items/<id>/decision` | En un PR abierto de ronin que no es draft (o en su spec, aunque lo sea): `{ decision: approve \| adjust \| close, text?, closeIssue? }` (15.15) |
| `GET /api/runs/<runId>` | El transcript de una corrida |
| `GET /api/runs/<runId>/stream` | Lo que se le agrega, por *server-sent events*, hasta que termina |
| `GET /api/requests` | Los pedidos del portal de los repos que ve la sesión, con a quién espera cada uno (§16.11) |
| `GET /api/requests/<n>` | Uno: la conversación, el veredicto, los prototipos, su actividad y sus corridas |
| `GET /api/requests/<n>/img/<archivo>`, `/prototipo/<ronda>` | Una imagen del pedido, por el nombre que tiene en él, y el diff de un prototipo |
| `GET /api/deploys` | Solo admins: cada repo con `deploy`, con lo mergeado sin desplegar (un cambio por PR) y sus últimos releases con el estado de su workflow (§18) |
| `POST /api/deploys/<owner>/<repo>/plan` | Solo admins: qué llevaría un release, sin publicarlo: `{ tag, prs: 'all' \| [n…], prerelease? }`, con sus problemas en palabras y su `fingerprint` |
| `POST /api/deploys/<owner>/<repo>/publish` | Solo admins: lo publica: lo mismo, más `{ title?, notes?, fingerprint? }`; 409 con el plan nuevo si algo cambió o no se puede |
| `GET /api/meetings` | Las reuniones de los repos que ve la sesión, con lo que ronin propuso de cada una (§17) |
| `POST /api/meetings` | Sube las notas de una reunión: `{ repo, title?, at?, link?, text? \| file: { name, data } }`, el archivo como data URL; ronin la lee en seguida |
| `GET /api/meetings/<n>` | Una: el texto de sus notas, sus propuestas, lo creado, su actividad y sus corridas |
| `GET /api/meetings/<n>/original` | El archivo tal como se subió, siempre como descarga |
| `POST /api/meetings/<n>/retry` | La lee de nuevo, después de una lectura que falló |
| `POST /api/meetings/<n>/approve` | Crea lo que la persona eligió, con sus cambios: `{ items: [{ id, title?, body?, lead?, project?, cycle? }] }` (§17.4) |
| `POST /api/meetings/<n>/discard` | Descarta lo que queda de ella |
| `GET /api/portal-admin` | Solo admins: las cuentas del portal de pedidos y las aplicaciones que se pueden dar (§16.2) |
| `POST /api/portal-admin/users`, `/users/<id>`, `/users/<id>/link` | Solo admins: crea una cuenta y manda la invitación, la cambia o manda otro enlace para la contraseña |
| `GET /api/evidence/<owner>/<repo>/<sha>/<ruta>` | Una captura que publicó ronin (§11.5), leída del clon del repo de producto |

En la ficha, las imágenes de los comentarios son enlaces, salvo las capturas que publicó ronin. El enlace de GitHub de una captura (`evidenceUrl`) solo carga con sesión de GitHub, y un `<img>` del tablero no la lleva. Por eso el servidor la lee de su propio clon con `git cat-file`: `publishEvidence` la commitea ahí antes del push. Solo sirve imágenes y solo de commits de la rama `ronin/evidence`. Si el sha no está, hace un `fetch` de esa rama, como mucho uno por minuto por repo. Si la imagen no carga, vuelve a ser el enlace `[imagen]`.

#### 15.10 Activarlo

1. Crear una OAuth App en GitHub (*Settings → Developer settings → OAuth Apps*) con callback `<DASHBOARD_URL>/api/auth/callback`.
2. Completar en `.env` `DASHBOARD_GITHUB_CLIENT_ID`, `DASHBOARD_GITHUB_CLIENT_SECRET`, `DASHBOARD_SESSION_SECRET` (`openssl rand -hex 32`), `DASHBOARD_ADMINS`, `DASHBOARD_ALLOWED_USERS` y `DASHBOARD_URL` (por ejemplo `https://<host>.<tailnet>.ts.net:8443`).
3. `pnpm build && pnpm server:setup`. `server:setup` instala `ronin-server` (y desinstala el `ronin-webhook` de antes si lo encuentra) y publica el 8443 en la tailnet.

#### 15.11 Acciones (`domains/items/actions.ts`)

Desde la ficha se le piden a ronin los comandos que hoy se piden comentando en GitHub. El botón *Acciones* muestra solo los que aplican al ítem en ese momento:

| Acción | Igual que | Cuándo aparece |
|---|---|---|
| Resolver conflictos | `/resolve-conflicts` | PR abierto. Se destaca si tiene conflictos con su base |
| Levantar o actualizar la preview | `/preview [app] <qué preparar>` | PR abierto. Lleva un texto opcional. Con varias apps en el manifiesto, se elige la app: viene marcada la que está arriba o, si no hay ninguna, la única que cambia el PR |
| Bajar la preview | `/preview stop` | Hay una preview arriba |
| Activar o desactivar el auto-merge | `/auto-merge`, `/auto-merge off` | Según si el PR tiene `ronin:auto-merge` |
| Responder y destrabar | Comentar y volver a `ronin:in-progress` | Issue con `ronin:blocked`. Lleva un texto obligatorio, la respuesta |
| Asignar a ronin | Asignarle el issue a `@ronin-agent` | Issue abierto que ronin no gestiona (sin el label `ronin`). Se destaca. Lleva un contexto opcional |
| Investigar (spike) | `/spike <app> <qué investigar>` | Igual que *Asignar*, en un repo con `ronin.app.json`. Se elige la app y lleva un texto opcional |
| Cerrar el issue | *Close as not planned* | Cualquier issue abierto, al final de la lista. Lleva un motivo opcional |

En un issue, las acciones de PR van al PR de su slice que avanza ("Resolver conflictos en #849").

**Con el teclado.** `M` abre y cierra el menú, con el foco en la primera acción. Con el menú abierto, `1`–`9` piden esa acción, `j`/`k` (o `↓`/`↑`) se mueven y `↵` pide la que tiene el foco; `Esc` lo cierra. Cada acción muestra su número, y `?` las lista.

**Cómo corre.** El tablero escribe el comando como la persona, con su token (`platform/github/github-as-user.ts`): `@ronin-agent /resolve-conflicts`, o `@ronin-agent /preview` con lo que hay que preparar en las líneas de abajo, que el parser de `/preview` también lee. Desde ahí es un comentario como cualquiera: llega su webhook, ronin le pone 👀 y lanza el worker, que lo responde. GitHub muestra quién lo pidió. Responder y destrabar comenta la respuesta como la persona, y ronin le pone `ronin:in-progress` al issue; si GitHub rechazó el comentario, el label no se toca.

*Asignar a ronin* deja el contexto, si lo hay, como un comentario común de la persona, sin mencionar a ronin (una mención se leería como un pedido aparte). Después le asigna el issue a `@ronin-agent` con el token de la persona. Desde ahí es lo de siempre (`discoverAssignedIssues`): ronin lo toma en el próximo tick y `fix-issue` lee el issue con sus comentarios. Si no queda claro qué hacer, pregunta en el issue y lo bloquea sin tocar código. *Investigar* y *Prototipar* comentan el comando con la app y el texto en una sola línea, como *Nuevo issue* (15.11.1). La preview, con la app en la línea del comando y el texto abajo.

*Cerrar el issue* deja el motivo, si lo hay, como un comentario común de la persona, y después lo cierra como *not planned* con su token (`closeIssue`, el mismo de *Cerrar* en un PR, 15.15). Si GitHub rechaza el comentario, no lo cierra. Si es el issue de un pedido del portal abierto, el motivo se guarda antes en el pedido (`noteClosing`, 16.6) y le llega a la persona como cuando se cierra su PR; si el cierre falla, se quita. El PR abierto del issue, si tiene, no se toca: para cerrar los dos está *Cerrar* en el PR. Un issue de ronin cerrado así pasa a `done` en el próximo tick (`finishClosedIssues`, §2), salvo que siga abierto el PR de una de sus slices.

**Las apps** salen del `ronin.app.json` de la rama base del repo (`worktreeBaseRef`), no del checkout, que puede estar en cualquier rama; si git no lo encuentra ahí, del checkout (`repoAppPaths`). Para la preview, el detalle de un PR trae sus archivos (`gh pr view --json files`, los primeros 100) y `appsTouched` dice qué apps cambia por su `path`, la misma regla que usa `/preview` sin app (§12).

Antes de #93, ronin comentaba *"**<login>** pidió `/x` desde el tablero"* y lanzaba el worker en el momento. Ahora el worker espera al webhook, como cuando alguien escribe en GitHub, y si no llega lo levanta el tick.

**Antes de pedirla,** un diálogo muestra el comentario que va a quedar ("Comentás en #849 como oskr814"), renderizado y actualizado mientras se escribe. Abre con el foco en su texto, si lo lleva, y `Ctrl`/`⌘` + `↵` comenta. El servidor la valida contra la misma lista, armada con lo que leyó de GitHub. Si la acción ya no aplica, o le falta o le sobra el texto, responde 409 sin comentar nada. Si GitHub ya no acepta el token de la persona, responde 401 y la página pide volver a entrar.

**No están** `/fix-comments` (va con la revisión de un PR, 15.14), `/spec` ni `/explore` en un issue, aunque ahora que las acciones son comentarios sumarlos es agregarlos a la lista. Tampoco cancelar o reintentar una corrida, que necesitan coordinarse con los locks del tick.

**Pendiente:** cancelar y reintentar corridas, una vista de varios runners juntos y sacar el alias `/webhook`.

#### 15.11.1 Nuevo issue (#100, `domains/items/new-issue.ts`)

Cada repo de la barra lateral tiene un botón **+** que abre *Nuevo issue*: título y descripción (markdown, con vista previa) y qué hacer después.

- **Cómo se crea:** en GitHub, a nombre de quien entró y con su token (`createIssue` en `platform/github/github-as-user.ts`, como las acciones de 15.11). No pasa por Linear: con la sincronización bidireccional aparece allá solo, y el botón sigue andando si se deja Linear.
- **Después de crearlo**, una de cuatro:
  - **Solo crearlo.**
  - **Asignárselo a ronin:** el issue se crea ya asignado a la cuenta de ronin, que lo toma como cualquier issue asignado (`discoverAssignedIssues`).
  - **Pedir `/spike <app>`** o **`/spec <app>`:** un comentario a nombre de la persona, con una de las apps del `ronin.app.json` del repo (`repoApps`, que el snapshot manda en `apps`) y una instrucción opcional. Le llega a ronin por su webhook, como uno escrito en GitHub.
- **Con Linear,** dos selectores opcionales: el proyecto (los activos del equipo) y el ciclo (el actual y los que vienen). Salen de `teamPlanning`, que va con la lectura de Linear (15.13). El issue se crea igual en GitHub. La elección queda pendiente (`platform/linear/linear-assign.ts`) y el servidor la aplica en cuanto la sincronización crea el issue en Linear: reintenta durante 5 minutos, y lo que quede lo aplica el tick.
- **Al terminar:** la lectura del repo se descarta (`forgetGithub`), así el snapshot siguiente lista el issue, y la página abre su ficha.

`POST /api/repos/<owner>/<repo>/issues` con `{ title, body, after, app?, instruction? }`. Pasa por las mismas defensas que cualquier POST del tablero (origen, sesión, JSON). Un rechazo de GitHub (un 401 con la sesión vencida, o un 403/404 cuando la organización restringe las apps OAuth) se explica igual que en 15.11.

#### 15.12 Exploraciones (#93, #155)

La página *Exploraciones* junta lo que antes estaba repartido entre el PR fijo en cada repo, `/explore` en un issue y la corrida de la noche, que no se veía hasta que actualizaba el PR.

- **La lista (`/exploraciones`).** Cada app de `explore` en `repos.json` con:
  - su estado: explorando ahora (con la función), fichas por decidir, esperando a ronin o sin PR;
  - el PR de su repo y cuántas fichas trae;
  - la última corrida y la próxima de la noche, o «solo a mano» para una app de `exploreNightlyOff` (#426): apagar la noche no la saca de la página.

  El PR es uno por repo (§11.7), así que un repo con dos apps muestra el mismo en las dos, aunque las fichas se cuentan por app. "Explorando" sale del agente en curso y, antes de que arranque el primero (la app tarda en levantarse), del registro de la corrida mientras el lock del repo está tomado (`liveRuns`).
- **La página de una app (`/exploraciones/<owner>/<repo>/<app>`).**
  - **Con un PR abierto,** es la página de ese PR con el encabezado de la app: la miga *Exploraciones / repo*, el PR, *Comentario general*, *Finalizar…*, *Explorar ahora* y la próxima corrida. *Hoy*, *Abrir #N* y las URLs del PR (`/<owner>/<repo>/pull/<n>`) llevan aquí.
  - **Sin PR,** una página que lo explica, con sus corridas y su inventario, y que pasa sola al PR cuando ronin lo abre.
- **Corridas.** Cada corrida de la app, de su registro (§11.8), con los agentes que corrieron durante ella:
  - quién la lanzó y cómo terminó: bien, falló o se cortó, con el error;
  - la duración y el costo, sumado de sus agentes;
  - las funciones con su charter y sus viewports, las fichas, las descartadas, el PR y la semilla;
  - el transcript de cada agente, que se abre ahí mismo.

  Solo cuentan los agentes de inventario, explorar y evaluar; rehacer un después o responder comentarios no es una corrida. Las de antes del registro se arman agrupando los agentes separados por menos de 30 minutos, sin quién la lanzó, semilla ni fichas.
- **Inventario.** Solo lectura, de `inventory.yml` en la rama del PR abierto (que cada corrida actualiza) o en la base: cada función con sus rutas y su prioridad (alta, excluida, retirada o nunca explorada), la última vez que se exploró y en qué viewports, una matriz con los 8 charters y la fecha de cada uno, y cuántas fichas tiene. Se edita en el repo.
- **Explorar ahora.** Un diálogo con:
  - la cantidad de funciones (de 1 a 10);
  - un tope de tiempo (1, 2 o 4 horas, o ninguno), que llega al worker como `until`;
  - *Cuenta como la de esta noche*, marcada por defecto (§11.8).

  Las funciones y los charters los sigue eligiendo ronin, como de noche (§11.4): elegirlos convertiría la exploración en una prueba dirigida (§11.1). La lanza cualquiera que vea el repo. El servidor llama a `launchExploreWorker` sin `trigger`, con el login en `by`, y responde 409 mientras el lock del repo está tomado o durante el minuto después de lanzar una, que es lo que tarda el worker en tomarlo. La app dice "arrancando…" hasta que el snapshot la ve explorando, y la corrida queda en *Corridas* "a pedido de <login>". `/explore <app>` en un issue sigue funcionando.

**Las fichas.** En GitHub, un PR de exploración (§11.7) cuesta revisarlo: "Files changed" muestra cada ficha como diff de markdown, así que las capturas se ven abriendo archivo por archivo; `inventory.yml`, `knowledge.md` y `runs/` aparecen en el medio; y para decidir hay que comentar el archivo de cada ficha. La pestaña *Fichas* de la página de la app es para eso.

- **La lista.** Las fichas que trae el PR (`findingsAddedOverBase`, como el digest), agrupadas por cómo están:
  - **Por decidir:** nadie la comentó.
  - **Esperando a ronin:** el último comentario es de una persona, y es nuevo o es una respuesta que lo menciona; los mismos que toma `pendingFeedback`.
  - **Respondidas por ronin.**
  - **Listas para aprobar.**
  - **Aprobadas** y **rechazadas,** según su archivo.

  Arriba, "Revisadas X de N" y filtros por tipo y por viewport. Abajo, las corridas del PR.
- **La ficha.** Leída en partes con `parseFindingBody` (`domains/explorations/output.ts`, el inverso de `renderFindingBody`):
  - Qué pasa y qué se esperaba.
  - El antes y el después lado a lado, con miniaturas si hay varias capturas del antes y una vista en grande (←/→ recorre las del antes). Si ronin rehízo el después, *ver la anterior* muestra la que reemplazó, buscada en la historia del archivo aunque el título y el nombre hayan cambiado.
  - La propuesta.
  - Plegados: los pasos, la evidencia y el cambio borrador.
  - Su hilo, con una caja para comentar.
- **Navegación.** `j`/`k` pasa de ficha y la ficha abierta queda en la URL (`?f=backoffice/F-0017`). En el celular, primero la lista y después la ficha.
- **Decidir.** Cada acción es un comentario sobre el archivo de la ficha (`subject_type: file`), escrito como la persona: lo que escribiría en "Files changed". `domains/explorations/flow.ts` lo lee como cualquier comentario en una ficha y no necesita la mención, porque un comentario nuevo en una ficha ya es feedback.

  | Botón | Lo que queda comentado |
  |---|---|
  | Rechazar (`r`), con motivos rápidos | `Rechazo esta ficha: <motivo>` |
  | Pedir cambios (`c`) | el texto; con *Rehacer la captura del después*, suma `También hay que rehacer la captura del después.` |
  | Pedir un issue aparte | `Abrí un issue aparte: <texto>` (sale asignado a ronin, como el de una ficha) |
  | Preguntar, o la caja del hilo | el texto tal cual |
  | Aprobar (`a`) | nada todavía: es una marca del navegador (`localStorage`) que la pasa a *Listas para aprobar* y cuenta para el progreso; la ficha se aprueba de verdad al aprobar el PR |

  En una ficha ya rechazada o aprobada solo se puede preguntar o comentar. Mientras alguna espera a ronin, la página vuelve a leer las fichas cada 10 s en vez de cada 30.
- **Comentario general.** `@ronin-agent <texto>` en el PR, como la persona, para decidir sobre varias fichas a la vez o dejar en `knowledge.md` lo que no hay que volver a proponer (lo lee `pendingGeneralFeedback`).
- **Aprobar.** Antes de enviar, el diálogo muestra qué fichas abren issue, cuáles quedan rechazadas y cuáles nadie revisó. Lo que envía es una review *Approve* a nombre de la persona, con un comentario opcional. Desde ahí sigue el gate de siempre: `approveAndMerge` marca las fichas, abre sus issues asignados a ronin y mergea. No se puede aprobar mientras ronin esté aplicando un comentario, que podría rechazar alguna ficha.
- **De dónde sale.** `GET /api/items/<id>/exploration` (`domains/explorations/review.ts`) lee las fichas del clon del repo de producto, en la rama del PR, como `runs/evidence.ts` lee las capturas. Antes trae la rama y su base con un `fetch`, como mucho uno por minuto. Los hilos salen de `listFileReviewComments`, agrupados por app e id de ficha. Usa la misma caché que la ficha (15.8), y se descarta después de comentar desde la página.

#### 15.13 Linear en el tablero (#101)

Para un repo con `"linear": { "apiKeyEnv": "…" }` en `repos.json` y esa key en `.env`, el tablero lee de Linear (`domains/items/linear.ts`, sobre `platform/linear/linear-api.ts`), con la misma caché y el mismo manejo de errores que la lectura de GitHub (§15.8). Dos consultas GraphQL por repo:

- **Los issues de ronin:** el issue de Linear de cada issue abierto que gestiona ronin, buscado por la URL del issue de GitHub (el *attachment* que deja la sincronización). Trae identificador, estado, proyecto, ciclo y asignado. Va en cada ítem del snapshot (`item.linear`).
- **El ciclo actual del equipo:** el equipo es el de cualquier issue del repo en Linear, así que `repos.json` no lo nombra. Trae fechas, el historial diario de issues en el ciclo y hechos (el mismo que usa el gráfico de Linear) y sus issues. Va en `/api/today` (`cycles`). Cada issue del ciclo cae en un estado (`cycleView`): los de ronin según GitHub (bloqueado, PR abierto = en review, si no ronin trabaja) y los del equipo según su estado en Linear (completed = hecho, started = en curso o en review si el estado se llama así, el resto sin empezar).

En la página:
- **Barra lateral:** un filtro *Ciclo N / Todos* y otro por proyecto, recordados en el navegador. Cada ítem muestra su `RED-n` y su proyecto.
- **Ficha:** chips de proyecto y ciclo, y una sección *Linear* en el panel de contexto.
- ***Hoy*:** el ciclo actual (§15.1).

Los colores de los proyectos siguen al proyecto: los conocidos en orden alfabético, los cuatro primeros con un color de la paleta (`--proj-*`, validada para daltonismo) y el resto en gris. Sin key, nada de esto aparece y el tablero funciona como antes.

#### 15.14 Revisar un PR (#111)

La pestaña *Archivos* de la ficha de un PR (o de un issue, con los archivos de su PR que avanza) es "Files changed" en el tablero, y desde ahí se revisa: comentarios por línea, sugerencias, respuestas y la revisión con Comentar, Aprobar o Pedir cambios. Todo lo que escribe sale a nombre de quien entró, con su token (`platform/github/github-as-user.ts`, 15.3). Llega a ronin como si se hubiera escrito en GitHub.

- **Leer** (`domains/items/files.ts`):
  - **Los archivos** de `pulls/<n>/files`, paginado, con su patch. GitHub lista como mucho 3000, y deja sin patch a los binarios y a los muy grandes, que la página muestra con un link a GitHub.
  - **Los hilos de review** por GraphQL (`getDiffThreads`), con su lado, su línea o rango, si son sobre el archivo, si están resueltos o desactualizados y los ids que hacen falta para responderlos y resolverlos.
  - Se leen con el token de ronin y usan la misma caché que la ficha (15.8).
  - **"Mostrar más líneas"** lee el archivo en el head del PR (`/files/content`, solo archivos que el PR cambia, hasta 1 MB, en caché por commit).
- **La pestaña:**
  - el árbol de archivos con filtro, estado, +/−, los hilos sin resolver y "N de M vistos";
  - el diff unificado o lado a lado (en el celular, unificado);
  - cada hilo bajo su línea. Los resueltos van plegados; los que son sobre el archivo, o sobre código que ya cambió, van arriba del archivo;
  - los diffs de más de 400 líneas y los archivos vistos empiezan plegados;
  - `j`/`k` pasan de archivo, `v` marca visto y salta al siguiente sin ver, `r` abre la revisión (en un PR de ronin no: sus comentarios pendientes los lleva *Ajustar*, 15.15).
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
- ***Revisar*** / ***Terminar revisión***, en un PR de una persona o en un draft de ronin que no es un spec, en la cabecera de la ficha (en un issue, *Revisar PR #N*, para su PR que avanza), en la barra de *Archivos* o con `r`:
  - **El panel:** un resumen, Comentar / Aprobar / Pedir cambios y la lista de lo pendiente.
  - **Se cierra** con la ×, con Escape o con un clic fuera de él, salvo mientras se manda.
  - **Mandar:** `submitPullRequestReview`. Sin nada pendiente, va una revisión con solo el resumen (aprobar sin comentarios).
  - **Descartar:** `deletePullRequestReview`.
  - **En un PR propio,** aprobar y pedir cambios no se ofrecen y el servidor los rechaza, como GitHub.
  - **En un PR de exploración** el panel no aparece: se aprueba con su propio gate (15.12).
- **Que ronin la atienda.** ronin no lee el resumen de una review (`findUnprocessedMentions` lee los comentarios sueltos y los de review), y sus comentarios solos no disparan `/fix-comments`. Por eso, en un draft de ronin con comentarios pendientes o pidiendo cambios, el panel ofrece *Que ronin los atienda ahora* (en un PR de ronin listo para revisar, eso es *Ajustar*, 15.15): después de mandar la revisión comenta `@ronin-agent /fix-comments` a nombre de la persona.
- **Aprobar y mergear.** Al aprobar cualquier PR, de ronin o de otra persona, el panel ofrece *Mergear apenas pasen los checks*, marcada por defecto: después de la aprobación comenta `@ronin-agent /auto-merge` a nombre de la persona, y ronin contesta qué falta (§13). No aparece si el PR ya tiene `ronin:auto-merge`, si es draft (ronin no lee comandos en el draft de un humano) o si tiene conflictos (el comando lo rechazaría). Junto con *Que ronin los atienda ahora* queda deshabilitada: el PR se mergearía antes de que ronin atienda los comentarios.
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

#### 15.15 Decidir un PR de ronin (#195)

Ante un PR de ronin casi siempre se decide una de tres cosas, y se decide leyendo su descripción: mergearlo, pedirle un ajuste o descartarlo. Por eso su ficha no ofrece la revisión de GitHub (15.14), cuyo "Pedir cambios" ronin no lee, sino esas tres decisiones.

- **La descripción.** `implement-slice` y `fix-issue` escriben el cuerpo del PR siempre con las mismas secciones, en este orden y con estos títulos (`PR_BODY_RULE` y `PR_BODY_SECTIONS` en `platform/agents/prompts.ts`): *Qué se pidió*, *Qué cambió* (con las capturas), *Cómo se verificó* (lo que corrió y lo que no probó, y al final, plegado en un `<details>`, *Cómo probar*: los **Datos** que tienen que existir y los **Pasos**, cada uno con rol, pantalla, acción y lo que se debería ver; #193), *Decisiones propias* (lo que el pedido no definía, con el porqué) y *Fuera de alcance*. En la primera línea va `Closes #N` (`fix-issue`) o `Parte de #N` (`implement-slice`). La plantilla de PR del repo no se usa. La pestaña *Descripción* (o *PR #N* en un issue) las muestra por separado, con *Decisiones propias* destacada, que es lo que más vale revisar. Un cuerpo sin esas secciones (un PR viejo) se muestra tal cual. Cuando ronin cambia el código del PR después de abrirlo (`fix-review`, un pedido mencionándolo, `/fix-comments`), también pone al día la descripción (`prBodyUpdateRule`): reescribe lo que su cambio dejó viejo, casi siempre *Qué cambió* y *Cómo se verificó* (con su *Cómo probar*), con las mismas secciones, y no toca lo que va desde el pie de comandos (`<!-- ronin:help -->`). Lo guarda por la API REST, porque `gh pr edit` falla en los repos que alguna vez usaron Projects classic.
- **Dónde.** En el encabezado de la ficha, así están en todas las pestañas: *Cerrar*, *Ajustar* y *Aprobar*, con `X`, `P` y `A`. Los botones son cortos: el alcance lo dice su panel. Solo en un PR de ronin abierto que no es draft, o en su spec aunque lo sea (`decidable`); en un issue, para su PR que avanza. Cada una abre un panel debajo de los botones que dice qué se va a mandar; se cierra con Escape o con un clic fuera, salvo mientras se manda.
- **El teclado en el panel.** El texto que se está escribiendo sobrevive a los redibujos del tablero (el refresco, la carga de *Archivos*), como los otros cuadros de texto. Con el foco fuera del texto, `1`–`3` suman una frase rápida al ajuste, `I` marca o desmarca *Cerrar también el issue* y `Ctrl ↵` manda igual; cualquier otra tecla vuelve al texto y se escribe ahí, así nada de lo tecleado abre otra decisión.
- **Aprobar** (`↵` confirma) aprueba y mergea: la aprobación (`submitPullRequestReview`, con la revisión pendiente si hay: GitHub admite una sola por persona) y `@ronin-agent /auto-merge`, salvo que el PR ya tenga `ronin:auto-merge` o conflictos. El panel dice si los checks pasaron, corren o fallan, y que los comentarios pendientes van con la aprobación sin que ronin los atienda.
- **Ajustar** (`Ctrl ↵` manda): un texto, con frases rápidas. Sin comentarios pendientes, se comenta `@ronin-agent <texto>`: el flujo `review-request` (§7.2), que aplica lo pedido y responde. Con comentarios pendientes, se manda la revisión como COMMENT y después `@ronin-agent /fix-comments` con el texto, que llega al prompt de `fix-comments` como su comentario disparador. Un texto que empieza con `/` se rechaza: se leería como un comando (para eso está *Acciones*). En *Archivos*, la barra dice cuántos comentarios pendientes hay y que los lleva *Ajustar*.
- **En el spec de `/spec`** (rama `ronin/<issue>/spec`, `isSpecPr`): *Aprobar* solo aprueba, sin `/auto-merge`, porque la aprobación es la señal de arranque (§1). *Ajustar* con comentarios pendientes los manda como una revisión COMMENT cuyo texto menciona a ronin, que lee la conversación del spec (§1.1) en vez de `/fix-comments`; sin pendientes, la mención de siempre. Las frases rápidas, que son sobre código, no aparecen. *Cerrar* trae *Cerrar también el issue* desmarcada, porque cerrar un spec suele descartar ese spec y no el pedido; el issue abierto queda como estaba y nada lo bloquea.
- **Cerrar** (`Ctrl ↵` confirma): el motivo, opcional, como comentario; se descarta la revisión pendiente y se cierra el PR (`closePr`). *Cerrar también el issue* viene marcada y lo cierra como no planeado (`closeIssue`); en el PR de un pedido del portal, el motivo también le llega a quien lo pidió (§16). Si queda abierto, `processIssue` lo bloquea y avisa: una slice sin PR abierto ni mergeado.
- **Después de decidir,** una línea bajo el encabezado dice qué se hizo durante unos minutos, mientras GitHub lo refleja, y se descartan las cachés de archivos, de la ficha y de la lectura del repo.
- **Servidor:** `POST /api/items/<id>/decision` (`domains/items/decision.ts`), a nombre de quien entró (`platform/github/github-as-user.ts`, 15.3) y con el permiso `acciones`. Rechaza con 400 lo que no es un PR abierto de ronin fuera de draft (salvo su spec), una decisión que no existe y un ajuste vacío.

### 16. Portal de pedidos (#114)

Una página pública, `https://ronin-agent.redmotoshn.com`, para que la gente que usa las aplicaciones pida ajustes chicos sin cuenta de GitHub. Entra con email y contraseña, elige la aplicación, le cuenta a ronin qué necesita (texto y capturas) y conversa con él. Si es un ajuste chico, ronin le muestra un prototipo; si lo aprueba, un dev decide si se hace (#353) y ronin hace el cambio en un PR que se mergea con la aprobación de un dev, y le avisa a la persona que sale en la próxima actualización. Si reporta un error, ronin lo reproduce en una copia de la app con un test que falla y, si el arreglo es pequeño, lo corrige él (16.12). Lo que es más que un ajuste, o lo que la persona no aprueba, pasa al equipo de desarrollo en un issue, y la persona se entera cuando se cierra.

```
src/domains/portal/    el dominio: cuentas, pedidos, la conversación, el prototipo y los issues
  accounts.ts          las cuentas (tabla portal_users, o accounts.json), sus permisos y los enlaces para la contraseña
  password.ts          scrypt, y el chequeo de mentira que iguala los tiempos
  session.ts           la cookie firmada del portal
  requests.ts          los pedidos: tabla portal_requests (o requests/<n>/request.json), y img/ y proto/
  classify.ts          ronin lee el pedido: preguntar, responder, menor, error, grande o entrevistar
  prototype.ts         el prototipo de un ajuste chico, y aprobar o "No me sirve"
  interview.ts         la entrevista de un pedido grande: las respuestas, el resumen y saltarla (#225)
  reproduce.ts         la reproducción de un error reportado, con su test (#137)
  issue.ts             el issue en el repo del producto: para ronin (aprobado, o el arreglo de un error) o para el equipo
  cancel.ts            la persona cancela un pedido que nadie tomó
  team-close.ts        el equipo cierra desde el tablero un pedido sin issue (#404), o uno grande con su issue
  expire.ts            el recordatorio y el vencimiento de un pedido que espera a la persona (#404)
  follow.ts            el tick sigue esos issues y sus PRs
  worker.ts, launch.ts el worker por pedido y su relanzamiento
  mail.ts, notify.ts   los correos
  routes.ts            la API del portal en Hono: la sesión y la cuenta (/api/portal/*)
  routes-requests.ts   los pedidos de la persona (/api/portal/requests/*)
  http.ts              lo que comparten: la configuración y quién pregunta
  routes-dashboard.ts  el portal desde el tablero, en Hono: los pedidos (/api/requests/*) y las cuentas (/api/portal-admin/*)
  admin.ts             la administración de las cuentas: crear, reenviar el enlace, editar
  board.ts             los pedidos en el tablero: la lista, la ficha y su actividad
src/apps/api/http/portal.ts  lo que el listener público atiende del portal, y monta su API
src/apps/portal/        la página, en React con Vite (`pnpm build` la arma en dist/public/portal, `pnpm portal:dev` para trabajarla):
  src/api.ts           el cliente de la API, tipado desde domains/portal/routes.ts, y la versión de la página
  src/App.tsx          las rutas (/, /p/<n>, /contrasena) y la sesión
  src/pages/           Gate (entrar, la contraseña olvidada y la del enlace), NewRequest, RequestView (un pedido: la conversación y lo que se puede hacer ahora)
  src/components/      Side, Composer, Interview (la entrevista: el formulario, el progreso y lo que se envía), Chip, MenuButton
  src/lib/             busy (si hay algo a medio escribir), images, text
  public/              el CSS, el tema antes de pintar y el ícono, tal cual
```

#### 16.1 El recorrido de un pedido

| Estado | Qué pasa | Quién sigue |
|---|---|---|
| `thinking` | ronin lee el pedido y revisa el código (16.3) | ronin |
| `asking` | ronin le hizo una pregunta | la persona |
| `answered` | ronin respondió: no había nada que cambiar | la persona, si quiere escribir de nuevo |
| `interviewing` | es grande: ronin le dejó preguntas en un formulario (16.13) | la persona: responder, o enviarlo sin responder |
| `confirming` | después de la entrevista, ronin muestra lo que entendió (16.13) | la persona: confirmarlo o corregirlo |
| `minor` | es un ajuste chico: ronin arma el prototipo (16.4) | ronin |
| `proposed` | el prototipo, o la propuesta sin prototipo (#409), está en pantalla | la persona: aprobar, pedir un ajuste o "No me sirve" |
| `awaiting-dev` | la persona aprobó el prototipo, o el arreglo de un error es pequeño: un dev decide antes de que ronin lo haga (16.5) | un dev: aprobar y desplegar, aprobar con revisión o no hacerlo |
| `approved` | aprobado por la persona y por un dev: ronin hace el cambio en un PR (16.5) | ronin, y un dev que apruebe el PR (o ronin a nombre de quien decidió desplegarlo) |
| `reproducing` | es un error: ronin lo reproduce con un test (16.12) | ronin |
| `fixing` | lo reprodujo, el arreglo es pequeño y un dev lo aprobó: ronin lo hace en un PR, como uno aprobado (16.12) | ronin, y un dev que apruebe el PR |
| `done` | el PR se mergeó: sale en la próxima actualización | — |
| `big` | es del equipo, en un issue (16.6) | el equipo |
| `resolved` / `declined` | el equipo cerró el issue como completado / no planeado, un dev decidió no hacerlo (16.5) o alguien del equipo lo cerró desde el tablero (16.15) | — |
| `cancelled` | la persona lo canceló (16.10), o venció sin respuesta (16.15) | — |

Cada paso que hace ronin corre en un **worker por pedido** (`domains/portal/worker.ts`, lanzado con `launchWorker` desde el servidor cuando la persona escribe o decide). Toma el lock `portal-<n>`, así que dos workers nunca trabajan el mismo pedido, y anota su pid en el pedido. Al empezar cada tick, `sweepPortalRequests` relanza los pedidos que esperan a ronin (`thinking`, `minor`, `reproducing`, o aprobados, en `fixing` o del equipo sin issue todavía) cuyo worker murió, con 2 minutos de gracia para uno recién lanzado.

#### 16.2 Cuentas, sesión y seguridad

- **Las cuentas las crea un admin del tablero**, en Ajustes → Usuarios, con el rol *Usuario* (§19.4), que solo ven los admins: nombre, email, las aplicaciones que puede pedir y, si se quiere, un tope diario propio. La persona recibe un correo con un enlace para crear su contraseña. Desde ahí también se cambian sus aplicaciones, se deshabilita la cuenta o se manda otro enlace. Si el correo falla, el tablero muestra el enlace para pasárselo por otro lado.
- **Qué aplicaciones hay:** cada repo de `repos.json` con un bloque `portal: { name, apps: { <app de ronin.app.json>: { name, description? } } }`. El login no nombra ninguna: la persona elige entre las que tiene después de entrar.
- **Contraseñas:** scrypt (N=2^15, r=8, p=1), mínimo 10 caracteres. Un email que no existe responde igual y tarda lo mismo que una contraseña mal puesta (`burnPasswordCheck`).
- **Sesión:** la cookie `ronin_portal`, firmada con HMAC (`PORTAL_SESSION_SECRET`), por `PORTAL_SESSION_DAYS` días. Lleva una versión de la cuenta: cambiar la contraseña o deshabilitarla cierra todas sus sesiones.
- **Enlaces para la contraseña:** de un uso, vencen a las 24 horas, se guardan solo como su sha256 y viajan en el fragmento de la URL (`/contrasena#t=…`), que no llega a los logs ni al `Referer`.
- **Límites, en memoria:** el login, 5 fallos por email y 30 por IP cada 15 minutos; "olvidé mi contraseña", 3 por email y 10 por IP por hora; los enlaces, 20 chequeos por IP cada 15 minutos. La IP es la de `cf-connecting-ip`. Pedidos nuevos: `PORTAL_DAILY_LIMIT` por persona y por día, en la zona de `EXPLORE_TIMEZONE`.
- **Lo demás:** los POST solo aceptan JSON y del mismo origen; CSP, `Referrer-Policy: no-referrer` y HSTS. Cada persona ve solo sus pedidos: uno ajeno responde 404, igual que uno que no existe. Nunca ve el resumen técnico, la instrucción del prototipo ni su diff.
- **Dónde queda:** con `DATABASE_URL`, las cuentas y los pedidos en Postgres (#235): `portal_users` (una fila por cuenta, su registro como `jsonb` y el correo como columna única; un cambio toma un lock de Postgres y escribe solo las cuentas que cambiaron) y `portal_requests` (un documento por pedido, con persona, repo y estado como columnas; el número nuevo y la fila en una transacción, con las imágenes escritas antes de confirmar). Sin ella, `PORTAL_DATA_DIR` (`portal-data/`, fuera de git), con modo 0600: las escrituras toman un lock entre procesos y reemplazan el archivo de forma atómica (`json-store.ts`). Las imágenes y los diffs de los prototipos son archivos en los dos casos. Es la única copia de las cuentas: hay que respaldarla.

**Una página abierta antes de un despliegue:** cada respuesta de la API del portal lleva `X-Portal-Version`, una huella de `index.html` (que nombra el JS por su hash) y `portal.css` (`portalVersion`). La página guarda la primera que ve. Si cambia, corre código viejo contra un servidor nuevo (por ejemplo, no conoce un estado nuevo y deja de consultar), así que se recarga sola. Si la persona está escribiendo o enviando algo, en cambio, muestra *Hay una versión nueva del portal* con *Recargar*, y recarga en la próxima consulta cuando ya no hay nada a medio escribir. Al volver a la pestaña, consulta enseguida en vez de esperar su turno (TanStack Query: mientras ronin trabaja en el pedido, cada 2 s y al volver).

**Movimiento,** como en el tablero (§15.1): lo que se señala cambia de color suave, y lo que aparece (un pedido, un mensaje nuevo, ronin trabajando, un formulario, un aviso) entra con un fundido o un desplazamiento corto, de 120 a 200 ms. Los mensajes que ya estaban no se vuelven a animar. Con *reducir movimiento* en el sistema no hay animaciones, salvo el giro lento de ronin trabajando.

Lo que cambia mientras la persona mira (#372):
- **Un mensaje nuevo** mientras lee más arriba no mueve lo que lee: aparece un aviso «Mensaje nuevo ↓» que la lleva al final. Un mensaje nuevo de ronin se anuncia a los lectores de pantalla (`aria-live`).
- **Las imágenes:** mientras se preparan (la página achica las grandes) y mientras viajan con el mensaje, la caja dice «Preparando…» o «Subiendo N imágenes…».
- **Enviar:** el botón dice «Enviando…» mientras espera y «✓ Enviado» un momento al terminar.
- **El menú en el celular** oscurece la página de atrás, y tocarla lo cierra.

#### 16.3 La conversación (`classify.ts`)

La persona escribe y adjunta hasta 4 capturas (png, jpg, webp o gif, validadas por sus primeros bytes, hasta 5 MB cada una; la página achica las grandes antes de mandarlas). Un agente de solo lectura (`portal-request`) lee la conversación y las imágenes en un checkout aparte de la rama base (`portal-P-<n>`, sin rama, que se borra al terminar), revisa el código de esa app y decide una de seis cosas (la sexta, `entrevistar`, en 16.13):

- **preguntar**, hasta 3 veces por pedido;
- **responder**, cuando no hay nada que cambiar (una duda, algo que ya existe);
- **menor**, un ajuste chico sobre algo que existe en esa app: deja la propuesta en palabras simples, un resumen técnico para el equipo y si hace falta un prototipo (`prototipo`, #409). Con prototipo, deja también su instrucción (16.4). Deja además dónde lo encontró en el código (`hallazgos`, #411: la pantalla, los endpoints, los archivos y sus líneas), guardado en `verdict.findings`: el prototipo lo recibe cercado en el prompt y lee esos archivos para confirmar, en lugar de volver a buscar lo que la lectura ya encontró. Sin él, cuando la propuesta en palabras basta (una regla, un filtro, un cálculo, un texto exacto, las opciones de una lista), el pedido pasa directo a `proposed`, con `verdict.prototype: false`: la persona decide sobre la propuesta como sobre un prototipo, y le llega por correo;
- **error**, algo que no funciona como debería en esa app: deja los pasos para reproducirlo y sigue 16.12. Si no sabe cómo reproducirlo, primero pregunta;
- **grande**: lo nuevo, el esquema de datos, dependencias, permisos, integraciones, varias apps, una regla que nadie definió o algo cuya causa no encontró. Ante la duda, grande.

Lo que escribe la persona va cercado como dato, nunca como instrucción. El supervisor escribe la respuesta: un "menor" sin propuesta, o con prototipo y sin instrucción, un "error" sin pasos o pasado de sus intentos, o una pregunta pasada del límite, se convierte en "grande". La primera respuesta le pone título al pedido. La persona recibe cada respuesta también por correo, salvo la de un ajuste chico o un error, porque el correo siguiente es el del prototipo o el de la reproducción. Si el agente falla, ronin se lo dice y la persona puede volver a escribir.

#### 16.4 El prototipo (`prototype.ts`)

Es `makePrototype` (§11.11), en `domains/portal/app-run.ts`: levanta la app desde la rama base, con instancia `portal-p-<n>`, y el agente (`portal-prototype`) saca el antes, hace el cambio borrador y saca el después, en desktop y mobile si hace falta. Las capturas salen de un guion (#411): el agente escribe en JSON los pasos para llegar a cada pantalla (ir, clic, escribir, esperar, ver) y los corre con `bin/ronin-shots.mjs`, una vez antes y otra después del borrador, en lugar de manejar el navegador llamada por llamada. `runOnApp` le deja `browsers.json` con los mismos navegadores que el MCP (login, viewport, orígenes permitidos). Si un paso falla, el comando devuelve el árbol de accesibilidad de la página para corregir el selector. El MCP sigue para descubrir una pantalla o medir el diseño. El guion queda con el pedido, junto al diff (`proto/<ronda>.guion.json`, `prototypes[].script`), para que un prototipo siguiente lo reuse (#412). Lo único que cambia es la entrega:

- **Las capturas quedan con el pedido** (`img/p<ronda>-antes-1.png`…), detrás del login de la persona, en pares con su leyenda ("Antes: …", "Después: …"). El agente escribe además un mensaje para la persona, en palabras simples.
- **El diff queda en el runner** (`proto/<ronda>.diff`), para el equipo. No incluye lo que el arranque de la app ya había cambiado: el build puede regenerar archivos versionados, como el XML de documentación de una API .NET.
- **Pares que valgan** (#409): la skill pide un par por cada cosa que cambia a la vista, sin pares de «sigue igual» ni el mismo cambio en varias pantallas. Al entregarlo, ronin descarta un par con el antes y el después idénticos byte a byte y un par repetido, y numera los que quedan (`distinctPairs`). Si todos son iguales, queda el primero.
- **Un prototipo a la vez por repo:** espera el lock de la app (`.prototype.lock`), el mismo que la reproducción (16.12).
- **Si falla dos veces,** o el agente dice que no hay prototipo posible (`PrototypeDeclined`, sin reintento), el pedido pasa al equipo.

La persona tiene tres salidas:
- **Aprobar.** Con confirmación; sigue 16.5.
- **Pedir un ajuste.** Escribe qué cambiaría. Ese mensaje vuelve a `classify.ts` con el contexto del prototipo y su instrucción (o de la propuesta sin prototipo), y si sigue siendo chico sale otra propuesta, con o sin prototipo. Son hasta 3 propuestas por pedido, contando las que fueron sin prototipo (`proposals`, `proposalRounds`). Si solo pregunta algo, la propuesta queda en pantalla.
- **No me sirve.** Con una nota opcional, pasa al equipo (16.6).

#### 16.5 Aprobado: la decisión del dev, issue, PR y merge (`dev-decision.ts`, `issue.ts`, `follow.ts`)

0. **Un dev decide antes de que ronin lo haga** (#353). El prototipo aprobado, y el arreglo chico de un error (16.12), dejan el pedido en `awaiting-dev`, sin issue. Al equipo del repo le llega un correo (el aviso `pedido-revisar`, el mismo del PR que espera aprobación) con el enlace al pedido en el tablero. La persona ve que el equipo revisa su pedido y lo puede cancelar. En *Ahora*, con el permiso `acciones` del repo, un dev elige (`POST /api/requests/<n>/decision`):
   - **Aprobar y desplegar** (además `desplegar`): el pedido pasa a `approved` (o `fixing`) y guarda su token de GitHub cifrado con AES-256-GCM, con una clave derivada de `DASHBOARD_SESSION_SECRET` (`platform/crypto/sealed.ts`). Cuando ronin abre el PR, `followPortalIssues` lo aprueba a su nombre y borra el token. Si el token ya no sirve, el PR espera una aprobación como cualquier otro, y la actividad lo dice (`pr-approved` con `ok: false`). El merge sigue siendo el de `ronin:auto-merge`: `mergePullRequest` nunca mergea sin una aprobación.
   - **Aprobar con revisión:** pasa a `approved` (o `fixing`), sin token. El PR espera la aprobación de un dev.
   - **No hacerlo:** con un motivo obligatorio. El pedido se cierra en `declined`, sin issue, y la persona recibe el motivo con esas palabras (`closeNote`), en la conversación y por correo.

   La decisión queda en `devDecision` (quién, cuándo, el motivo) y en la actividad (`dev-decided`). El token nunca sale en lo que lee el tablero ni el portal.

   **Prioritario (#430, `priority.ts`).** Al aprobar, la persona puede mandar `priority: { impact: blocks|customers|deadline, reason, deadline? }` en `POST /<n>/decision`. Es obligatorio el motivo (hasta 500 caracteres) y, con `deadline`, una fecha `YYYY-MM-DD` que no haya pasado. Queda en `priority` con `at`, y en la actividad (`priority`). El tope es `portal.priorityDailyLimit` (Ajustes → General, 1 por defecto, 0 lo apaga) por persona y por día (`prioritizedToday`, con el reloj de `EXPLORE_TIMEZONE`): cuenta los que marcó ese día aunque después se los quitaran. Pasado el tope responde 429 y el pedido no se aprueba. `/me` trae `priorityUsed` y `priorityLimit` para que el portal apague la casilla. Mientras el pedido no termina (`ENDED`) y nadie le quitó la prioridad (`activePriority`), va primero en `GET /api/requests` y en la lista de la persona (`byPriority`: primero la fecha límite más cercana, después el más viejo). El correo de `awaitingDevMail` sale con «Prioritario» en el asunto y el motivo, a la unión de `pedido-revisar` y `pedido-prioritario`. Con `acciones`, `POST /api/requests/<n>/priority/remove { reason }` guarda `priority.removed` (quién, por qué, cuándo), deja el motivo como un mensaje del equipo (con su correo, `teamWroteMail`) y anota `priority-removed`. El pedido sigue igual, como uno normal.

   **Lo que ve el dev para decidir (#406).** En la lista, `awaiting-dev` dice «Decidir si se hace» («Decidir el arreglo» para un error) con un color propio, no el naranja de «espera a alguien», y *Espera a* dice «Tú: aprobar o no hacerlo» a quien tiene `acciones`. *Ahora* muestra solo lo que hace falta para decidir: qué cambia (`verdict.proposal`, o los pasos del error) con las capturas en miniatura por par (#407), lo que hay que decidir antes de aprobar, y una línea con el alcance y las pruebas. El resto va plegado en *Detalles*: lo que pidió la persona, los cambios, cada prueba, los riesgos, los archivos y el diff.

   **Responder antes de aprobar (#413).** Cada punto de «Antes de aprobar» (`team.decide`) tiene un campo de respuesta, opcional. Al aprobar (`deploy` o `review`), las respondidas van en el cuerpo como `answers: [{ question, answer }]` (hasta 10, de hasta 2000 caracteres) y quedan en `devDecision.answers`. El issue que abre el worker las trae en **«Lo que decidió el equipo»**, antes de *Para implementarlo*, y le dice a `fix-issue` que, si no coinciden con el borrador o su diff, manda la respuesta. La actividad las muestra bajo la decisión. Al no hacerlo, no se guardan. Al confirmar la aprobación, el dev puede escribir además una nota libre, opcional (`note`, hasta 2000 caracteres, en `devDecision.note`): va en la misma sección del issue, citada, con la misma regla de que manda sobre el borrador, y la actividad la muestra bajo las respuestas.
   - **Las notas del agente** van en `equipo` (`cambios`, `pruebas` con `ok` y `texto`, `decidir`, `riesgos`), en la salida de `prototype` y de `reproduce-error`, además del `resumen` libre. Se guardan en el prototipo o la reproducción como `team` (`team-notes.ts`). Los pedidos anteriores solo tienen el `resumen`: *Detalles* lo muestra partido en párrafos y viene desplegado.
   - **El alcance** sale del diff, no del agente (`decisionScope`, solo mientras espera la decisión): cada archivo con sus líneas agregadas y quitadas, y las áreas que toca. En un monorepo, el nombre de cada app o paquete (`apps/<x>`, `packages/<x>`); si no, la carpeta de arriba.
   - **Las pruebas:** las del agente y, en un error, el test de la reproducción. Las que no se corrieron o no pasaron van en color de aviso en la línea de arriba, aunque *Detalles* esté plegado.
1. El worker publica las capturas en la rama de evidencia (§11.5) y abre un **issue en el repo del producto, asignado a ronin**, con label `ronin:portal` y un marcador (`<!-- ronin:portal P-n -->`) que evita abrir otro si el worker muere justo después. El issue lleva el cambio aprobado, el prototipo, el análisis de ronin, el diff y la conversación, con lo que escribió la persona citado y sin `@`. Las capturas se llaman `antes-N` y `despues-N`, así `fix-issue` muestra en el PR, y en el changelog, solo los después.
2. ronin lo toma como cualquier issue asignado (`discoverAssignedIssues` → `fix-issue`), partiendo del diff del prototipo sin ampliar el alcance, y abre el PR con "Closes #n".
3. `followPortalIssues`, un paso del tick que también corre con el webhook de un PR abierto (flujo `portal`), encuentra ese PR (`closingIssuesReferences`) y le pone **`ronin:auto-merge`**. Además le avisa al equipo del repo (§16.7) que espera su aprobación, y la persona ve en la conversación que el cambio está hecho y lo revisa el equipo.
4. Con la aprobación de un dev y CI en verde, `sweepAutoMerge` lo mergea (§13). Con el webhook del PR cerrado o el tick siguiente, el pedido queda en `done` y la persona recibe "Listo, sale en la próxima actualización".

Un PR cerrado sin merge se olvida hasta que otro cierre el issue. Si `fix-issue` necesita información, el issue queda bloqueado con las preguntas y el email, como con cualquier issue asignado. Siempre aprueba una persona: la que decidió *Aprobar y desplegar*, a través de ronin, o un dev que revisa el PR.

#### 16.6 Del equipo: pedidos grandes y "No me sirve"

- **Al pasar al equipo,** la persona recibe un correo enseguida. El worker abre un **issue sin asignar** con label `ronin:portal`: lo que pide, por qué es del equipo, el análisis de ronin, el último prototipo y su diff si hubo, y la conversación. Al equipo le llega el correo con el enlace.
- **Al cerrarse el issue** (con el webhook `issues.closed` o en el tick), la persona recibe un correo y un mensaje en la conversación. Completado: `resolved`, "el equipo resolvió tu pedido". No planeado: `declined`, "decidió no hacerlo por ahora". Un pedido aprobado cuyo issue se cierra como no planeado sin PR también termina en `declined`. Si el equipo cerró el PR desde el tablero con un motivo y *Cerrar también el issue* (15.15), o el issue con *Cerrar el issue* y un motivo (15.11), ese motivo va en el mensaje y en el correo, con las mismas palabras que el comentario en GitHub: el tablero lo guarda en el pedido (`closeNote`, `noteClosing`) antes de cerrar el issue, así que ya está cuando el webhook o el tick lo ven cerrado, y lo quita si GitHub rechaza el cierre.
- **El motivo del cierre** se lee por la API REST (`state_reason`), porque el `gh` 2.45 del runner no lo trae en `issue view`. Para saber cuáles se cerraron, el tick hace una sola consulta por pasada: los issues con `ronin:portal`.

#### 16.7 Correos

Todos salen de la misma cuenta, `GMAIL_USER` / `GMAIL_APP_PASSWORD` (la de los bloqueos), con el nombre "ronin · Pedidos de ajustes", para todos los repos. A la persona: la invitación, el cambio de contraseña, cada respuesta de ronin, el prototipo listo, el paso al equipo, el recordatorio y el vencimiento de un pedido que espera su respuesta (16.15), el merge, el cierre del issue (o del pedido, desde el tablero) y, cuando el release que lo lleva termina de desplegarse, *Ya está en la aplicación* (§18.6). Al equipo: el issue de un pedido que es suyo y el PR que espera aprobación, a quien eligió esos avisos del repo en Ajustes → Notificaciones (§19.5). Mientras nadie elige, vale la lista `notifyTo` del bloque `portal` en `repos.json`, y sin nadie, `NOTIFY_TO`. Nunca recibe los pedidos de otro repo. Las imágenes nunca van en el correo: el enlace lleva al portal. Un correo que falla queda en el log y no frena el pedido.

#### 16.8 API

En el listener público, solo con `PORTAL_URL` y `PORTAL_SESSION_SECRET` configurados:

| Ruta | Qué hace |
|---|---|
| `POST /api/portal/login`, `/logout` | Entrar y salir: `{ email, password }` |
| `GET /api/portal/me` | La persona, sus aplicaciones y cuántos pedidos le quedan hoy |
| `POST /api/portal/forgot` | Manda el enlace para cambiar la contraseña: `{ email }` |
| `POST /api/portal/link`, `/password` | Revisa un enlace y crea la contraseña con él: `{ token, password? }` |
| `GET /api/portal/requests` | Sus pedidos, el más nuevo primero |
| `POST /api/portal/requests` | Uno nuevo: `{ repo, app, text, images? }` (imágenes como data URLs) |
| `GET /api/portal/requests/<n>` | Uno, con la conversación |
| `POST /api/portal/requests/<n>/messages` | Su respuesta, o un ajuste al prototipo: `{ text, images? }` |
| `POST /api/portal/requests/<n>/decision` | Sobre el prototipo: `{ decision: 'aprobar' \| 'rechazar', text? }` |
| `POST /api/portal/requests/<n>/interview` | Las respuestas de la entrevista: `{ answers, note?, images? }` (16.13) |
| `POST /api/portal/requests/<n>/skip` | Lo pasa al equipo sin responder la entrevista o sin confirmar el resumen |
| `POST /api/portal/requests/<n>/understood` | Sobre el resumen: `{ ok: true }` lo confirma; `{ ok: false, text, images? }` lo corrige |
| `POST /api/portal/requests/<n>/cancel` | Lo cancela, mientras nadie lo tomó (16.10) |
| `GET /api/portal/requests/<n>/images/<archivo>` | Una imagen de la conversación |

La administración está en la API del tablero, solo para sus admins (la página es Ajustes → Usuarios, §19.4): `GET /api/portal-admin`, `POST /api/portal-admin/users`, `/users/<id>` y `/users/<id>/link` (15.9).

#### 16.9 Activarlo

1. En `.env`: `PORTAL_URL` (`https://ronin-agent.redmotoshn.com`) y `PORTAL_SESSION_SECRET` (`openssl rand -hex 32`, distinto del del tablero). Opcionales: `PORTAL_SESSION_DAYS` (30), `PORTAL_DAILY_LIMIT` (5), `PORTAL_REMIND_HOURS` (12), `PORTAL_EXPIRE_HOURS` (24) y `PORTAL_DATA_DIR` (`portal-data`).
2. En `repos.json` (o desde Ajustes → Repos, §19.6), el bloque `portal` de cada repo que se ofrece, con sus aplicaciones. Quién del equipo recibe sus correos lo elige cada uno en Ajustes → Notificaciones; `notifyTo` queda como lista de respaldo.
3. nginx-proxy-manager tiene que pasarle al 3939 todas las rutas del dominio, no solo la de los webhooks.
4. `pnpm build` y reiniciar `ronin-server`. Las cuentas se crean desde el tablero.

#### 16.10 Cancelar un pedido (`cancel.ts`)

La persona puede cancelar un pedido mientras nadie lo tomó, con *Cancelar pedido* en la cabecera y una confirmación:

- **Se puede:**
  - mientras ronin lo lee o espera su respuesta (`thinking`, `asking`, `answered`), también en la entrevista (`interviewing`, `confirming`);
  - alrededor del prototipo (`minor`, `proposed`);
  - mientras ronin reproduce un error (`reproducing`);
  - mientras espera la decisión de un dev (`awaiting-dev`, 16.5);
  - ya en manos del equipo (`big`), si su issue sigue sin asignar. Lo comprueba en GitHub al momento, y el issue se cierra como no planeado con un comentario que dice que la persona lo canceló. El cierre va después de contestar (#411): la persona no espera las tres llamadas a GitHub, y si falla queda en el log y el pedido sigue cancelado.
- **No se puede:**
  - aprobado o en `fixing`, porque su issue es de ronin;
  - del equipo, con el issue ya asignado a alguien;
  - terminado.
- **Un worker que seguía trabajando** en el pedido termina y lo deja cancelado (`updateUnlessClosed`, que también respeta un pedido que el equipo cerró, 16.15): no escribe su respuesta ni su prototipo y no manda correos. Si el issue del equipo se estaba abriendo justo entonces, lo cierra.
- **Cuenta para el tope diario:** cancelar no devuelve el pedido del día.


#### 16.11 Los pedidos en el tablero (#132)

Un pedido no tiene issue hasta que ronin lo abre, y algunos no lo tienen nunca. Por eso el tablero les da una página propia, *Pedidos del portal*, que ve cualquiera que vea el repo del pedido (§15, #106). Las cuentas son la otra pestaña de esa página, *Usuarios*, solo para admins.

- **La lista** (`/pedidos`) dice a quién espera cada pedido (`waitsOn`): la persona (`asking`, `proposed`), ronin (leerlo, el prototipo, abrir su issue, hacer el cambio), el equipo (su issue, o aprobar el PR) o nadie. En la barra lateral no tienen grupo propio: el issue de un pedido abierto lleva su número (`P-n`), y uno sin issue solo está en la lista.
  - **Los filtros (#158):** *Pendientes* (los abiertos, el de entrada) | *Esperan a la persona* · *ronin trabajando* · *Esperan al equipo* | *Cerrados* · *Todos*. Los cerrados solo se ven en los dos últimos.
  - **De 25 en 25,** paginada en el navegador: con pocas decenas de pedidos alcanza, y `/api/requests` sigue trayéndolos todos. Cambiar de filtro vuelve a la primera página.
- **La ficha** (`/pedidos/<n>`):
  - las siete etapas (Pedido, Conversación, Prototipo, Aprobación, Issue, PR, Listo);
  - una tarjeta *Ahora* con qué falta y quién lo hace, o la corrida en vivo;
  - la actividad;
  - la conversación como la ve la persona;
  - las capturas de un prototipo o de una reproducción, en pares de antes y después (la imagen `p<n>-antes-<i>` con `p<n>-despues-<i>`, `r<n>-error-<i>` con `r<n>-arreglo-<i>`). Se ven chicas y con un clic se abren en un comparador a pantalla completa (`ui/components/Compare.tsx`, #407): lado a lado o una a la vez, ← → entre pares y Esc para cerrar. El portal usa el mismo comparador;
  - lo que vio ronin para el equipo, con el diff de cada prototipo;
  - las corridas, incluidas las del issue y el PR que salieron del pedido;
  - **la pestaña *Issue y PR* (#158),** cuando ya tiene issue (*Issue* mientras no hay PR): lo mismo que la ficha del ítem (estado, labels, checks, review, slices, la descripción y la conversación, de `GET /api/items/<id>/detail`), con un selector entre el issue y el PR. *Revisar el PR* abre su ficha en *Archivos*; comentar y las acciones siguen en la ficha;
  - en el encabezado, *en la app desde <tag>* cuando el release que lo llevó terminó de desplegarse (§18.6).
- **La ficha de ese issue o PR** dice "del pedido P-n", con enlace al pedido. En *Hoy*, una corrida de un pedido abre su ficha, en esa corrida.
- **La actividad** junta tres cosas por hora:
  - **los mensajes**;
  - **los `events` del pedido.** `request.json` gana un registro al que solo se le agregan entradas, con tope de 200: cada worker lanzado (por el servidor o el tick), cada falla con la primera línea del error, la espera del turno de prototipo, la clasificación, la decisión, cada correo (a quién, el asunto y si salió), el issue, el PR, su cierre, la cancelación y el release que lo lleva: publicado, desplegado o fallado (§18.6). `noteEvent` nunca falla: una línea perdida no frena el pedido;
  - **las corridas.** El registro de cada corrida lleva `portalRequest` y su runId dice `p<n>`; las de antes se reconocen por su etiqueta, "pedido P-n". Las del issue y el PR del pedido se suman por su número.

  Los pedidos de antes de #132 no tienen eventos. Su actividad se arma con el veredicto y la decisión, y su issue va al final, sin hora.
- **Un reporte de error** (16.12) lo dice en la lista y en la ficha, tiene sus propias etapas (Pedido, Error, Reproducción, Issue, PR, Listo) y una pestaña *Reproducción*: cada intento con su resultado, lo que hizo ronin, la causa o lo que sospecha, las capturas, el test con su salida en rojo y en verde, y el diff (`GET /api/requests/<n>/reproduction/<intento>`).

#### 16.12 Reportes de error (`reproduce.ts`, #137)

Cuando la persona reporta algo que no funciona, `classify.ts` lo lee como **error** y deja los pasos para reproducirlo como los entendió. El pedido pasa a `reproducing` y el worker lo reproduce:

1. **En una copia de la app.** `runOnApp` en `domains/portal/app-run.ts`, la parte de `makePrototype` que levanta la app desde la rama base, con instancia `portal-r-<n>` y un navegador por rol y tamaño de pantalla. Espera el mismo lock que los prototipos (`.prototype.lock`): una app a la vez por repo.
2. **El agente (`portal-reproduce`)** sigue los pasos y captura el error (`error-N.png`). Después escribe un test que falla por ese error, antes de cualquier arreglo, como en TDD: directo en la capa donde está el problema si sabe cuál es (por ejemplo, un test solo sobre la API), o un e2e que sigue los pasos de la persona si no. Lo corre con los comandos del CLAUDE.md del repo, dentro del stack de la app (le pasa el `docker compose -p …` de esa instancia), y comprueba que falla por la razón que vio la persona.
3. **El arreglo, solo si es pequeño** (los mismos criterios que un "menor": sin esquema ni migraciones, dependencias, configuración, permisos ni otras apps). Lo hace, vuelve a correr el test (tiene que pasar a verde) y los de alrededor, y captura la pantalla con el arreglo (`arreglo-N.png`) si se ve.
4. **El supervisor guarda el intento** en `request.bug.reproductions`: si se reprodujo, los pasos, el test (`red`, y `green` solo si antes fue rojo) con el final de su salida, el arreglo (`small` o `big`, con su motivo), el resumen para el equipo y el diff (`proto/r<intento>.diff`, el test y el arreglo). Las capturas van a la conversación (`img/r<intento>-error-1.png`…) con su leyenda.

Según lo que salió:

| Resultado | Estado | Qué pasa |
|---|---|---|
| Reproducido, arreglo pequeño, test de rojo a verde y con diff | `awaiting-dev`, y `fixing` cuando un dev lo aprueba (16.5) | Un issue **asignado a ronin** con la reproducción y el diff, sin prototipo ni aprobación de la persona. `fix-issue` parte del test y el diff, y `follow.ts` lo sigue como uno aprobado (16.5): `ronin:auto-merge`, aprobación de un dev y `done` |
| Reproducido, cualquier otro caso (arreglo grande, test que no pasó a verde, sin test) | `big` | Issue del equipo (16.6), con los pasos, la causa, el test que falla y su diff |
| No reproducido, y puede preguntar | `asking` | Le pregunta a la persona lo que necesita (cuenta para las 3 preguntas). Su respuesta vuelve a `classify.ts`, que lo intenta de nuevo: hasta 2 intentos |
| No reproducido, sin preguntas ni intentos | `big` | Al equipo, diciendo que **no se pudo reproducir con datos de prueba**. Nunca se cierra como "no es un error": puede depender de datos reales. Un test que no falla va en el issue como lo que se intentó, no como prueba |
| La corrida falla dos veces, o la app no deja ni intentarlo | `big` | Al equipo, con el motivo |

La persona ve en el portal "Reproduciendo el error", luego lo que encontró ronin con las capturas, y recibe cada paso por correo. Los eventos `reproduced` (intento, si se reprodujo y si el test quedó en rojo, verde o sin test) y `failed` con paso `reproduce` quedan en la actividad.

#### 16.13 La entrevista de un pedido grande (`interview.ts`, #225)

Antes de pasar un pedido grande al equipo, ronin le hace a la persona las preguntas que el equipo le tendría que hacer, en un formulario: quién puede hacerlo, qué pasa en tal caso, qué queda fuera. Así el issue llega con las decisiones tomadas.

- **El agente decide** (`classify.ts`, la sexta acción, `entrevistar`): es grande, pero faltan decisiones que solo la persona puede tomar. Elige cuántas preguntas hacer (de una a cinco, lo mínimo que haga falta), las de negocio y nunca las técnicas, con opciones sacadas del código y de la app. Si no falta nada, `grande` directo. Con `entrevistar` deja también el motivo y el resumen técnico, así que el pedido ya es grande si la persona no responde. `parseQuestions` pasa las preguntas a la forma del portal: se queda con las primeras cinco, descarta una sin texto o con menos de dos opciones, recorta textos y hace los `id` únicos. Sin preguntas válidas, o pasado de las rondas, se vuelve `grande`.
- **Rápido después de la primera lectura:** las respuestas y las correcciones del resumen no vuelven a leer el código. Las lee otra tarea, `portal-interview` (`followUpRequest`), contra el análisis que ya hizo la primera lectura (`verdict.summary`, el motivo y la conversación). Corre en un directorio vacío, sin checkout ni `git fetch`, con sonnet y esfuerzo `low` por defecto (se cambian en Ajustes → Agentes), y no espera turno en la cola del runner (`withSlots`). Tarda unos 10 s, contra ~50 s de una lectura completa. Puede decidir `grande` con el resumen, `entrevistar` (una segunda ronda, de hasta tres preguntas) o `revisar`: las respuestas cambiaron el pedido (resultó chico, o es otra pantalla), y entonces sigue la lectura completa. También sigue la lectura completa si esta falla. La página del portal consulta cada 2 s y, mientras tanto, dice «Suele tardar unos segundos».
- **Si sigue la lectura completa**, la conversación le llega con el formulario que dejó y las respuestas en palabras (`interviewText`), y «No sé» significa que esa decisión es del equipo. Decide `grande` con el resumen ya escrito con las respuestas, `menor` si resultó chico, o una segunda ronda solo si las respuestas abrieron una decisión nueva.
- **El portal** muestra el formulario debajo del mensaje de ronin: una opción, varias o texto, con «Otra» y «No sé». Abajo, el progreso, *Enviar sin responder* y el cuadro de siempre para agregar algo con capturas. La persona recibe el correo «ronin te dejó unas preguntas».

- **Las preguntas** van en el mensaje de ronin (`questions`), cada una con su `id`, su tipo (`one`, `many` o `text`), el texto, una ayuda opcional, las opciones, si acepta «Otra» y si es opcional. Las de opciones siempre aceptan **«No sé, que lo decida el equipo»**. El pedido queda en `interviewing`.
- **Las respuestas** llegan como índices de opciones, el texto de «Otra», el de una pregunta de texto o «No sé». `readAnswers` las pasa a palabras contra las preguntas abiertas: rechaza una opción que no existe, «Otra» donde no se ofrece, dos respuestas a una de una opción y una pregunta obligatoria sin responder. La persona nunca escribe el texto de una opción. Se guardan en su mensaje (`answers`, cada una con su pregunta) junto a una nota y hasta 4 imágenes opcionales. El pedido vuelve a `thinking` y ronin lo lee de nuevo.
- **El resumen** lo escribe el agente con `grande` después de una entrevista (`entendido`: decisiones como tema → decisión, lo que queda fuera y lo que la persona dejó al equipo, como cada «No sé»). `parseUnderstood` lo valida; sin una sola decisión, o si la persona saltó las preguntas, el pedido pasa al equipo sin mostrarlo. Va en un mensaje de ronin (`understood`) y el pedido queda en `confirming`, con el correo «Revisa lo que entendí». Si la persona lo confirma, pasa a `big`, con el correo de siempre y el issue del equipo (16.6). Si lo corrige (con texto y, si quiere, capturas), su mensaje vuelve a `thinking` y el agente escribe el resumen entero otra vez con la corrección. Sin correcciones restantes, el portal solo ofrece confirmarlo.
- **Saltarla:** *Enviar sin responder* lo pasa a `big` tal como llegó, con el veredicto que ya tenía. Desde el resumen, lo pasa con las respuestas.
- **Los topes son del servidor, no del agente:** 2 rondas de preguntas (`MAX_ROUNDS`), 5 preguntas por ronda (`MAX_INTERVIEW_QUESTIONS`) y 2 correcciones del resumen (`MAX_CORRECTIONS`). `request.interview` lleva las rondas, las correcciones y cómo terminó (`skipped` o `confirmed`).
- **Actividad:** el evento `interview`, con su paso (`asked`, `answered`, `summary`, `corrected`, `confirmed` o `skipped`) y la ronda.
- **Para el equipo:** `interviewRecord` junta las respuestas de cada ronda, el último resumen y cómo terminó (`confirmed`, `answered` o `skipped`). El issue del equipo (16.6) trae **«Lo que definió la persona»** después de «Lo que pide»: la tabla del resumen (o la de las respuestas si no hubo resumen), si la persona lo confirmó, lo que queda fuera, lo que decide el equipo y las preguntas y respuestas tal cual. Si saltó las preguntas, lo dice. El correo al equipo trae lo mismo en texto.
- **En el tablero** (16.11): la conversación y la actividad muestran las preguntas, las respuestas y el resumen; *Para el equipo* muestra lo que definió la persona. Los eventos `interview` van como líneas cortas en la actividad.

#### 16.14 El equipo le escribe a la persona (`team-conversation.ts`, #353)

Antes, la conversación del portal era solo entre la persona y ronin. Mientras el pedido está en manos del equipo (`TEAM_HELD`: `awaiting-dev`, `approved`, `fixing` y `big`) y hasta que se cierra, el equipo y la persona se escriben sin que el pedido vuelva a ronin ni cambie de estado.

- **El equipo escribe** desde la pestaña *Conversación* del pedido (`POST /api/requests/<n>/messages`, con texto e imágenes), con el permiso `acciones` del repo. El mensaje queda con `from: 'team'` y `by` (el login de quien escribió), y en la actividad (`team-message`).
- **La persona lo ve firmado «Equipo de desarrollo»:** quién escribió no sale del tablero. Le llega un correo («El equipo te escribió sobre tu pedido P-n») y, mientras el equipo tiene el pedido, la página se relee cada 15 segundos.
- **La persona contesta desde el mismo pedido,** pero solo después de que el equipo le escribió. La respuesta va con `to: 'team'`, la registra `person-reply` y **no la lee ronin**: el pedido no vuelve a `thinking`. Al equipo le llega un correo con el aviso `pedido-equipo`, y el pedido queda con `personReplied`: la lista dice «Ana respondió: leerlo» y espera al equipo hasta que alguien del equipo lo abre o le contesta. Al revés, mientras el último mensaje entre los dos es del equipo y el pedido sigue en `TEAM_HELD`, la fila trae `teamWrote: { by, at }` (`board.ts`), y el chip de estado dice «Respondido por el equipo»: reemplaza a «En el equipo» en un `big` y va debajo del estado en los demás.
- **Con GitHub:** si el pedido ya tiene issue, cada mensaje se copia como comentario de ronin («Equipo → persona» o «Persona → equipo»), con lo escrito citado y sin `@`. Así quien trabaja desde GitHub (ronin también, cuando implementa o atiende comentarios) tiene el contexto. Si todavía no tiene issue, la conversación entra en su cuerpo cuando se abre, con cada mensaje marcado igual.
#### 16.15 Cerrar desde el tablero y vencer sin respuesta (`team-close.ts`, `expire.ts`, #404)

Antes, un pedido que esperaba a la persona no vencía nunca, y el equipo no lo podía cerrar desde el tablero: solo decidía en `awaiting-dev` o cerrando el issue de un pedido que ya era suyo.

- **Cerrar pedido.** En *Ahora*, en la ficha de un pedido abierto sin issue que espera a la persona (`asking`, `interviewing`, `confirming`, `proposed`), que ronin respondió (`answered`) o que ronin está leyendo (`thinking`): `TEAM_CLOSABLE`. Con el permiso `acciones` del repo, el mismo que escribirle a la persona (16.14), y un motivo obligatorio (`POST /api/requests/<n>/close`, `{ reason }`). También uno grande con su issue (`big` con `issue`): primero guarda el motivo en `closeNote`, después comenta el motivo en el issue y lo cierra como `not_planned` con el token de quien lo cierra (`github-as-user.ts`), y recién entonces lo pasa a `declined`. Si GitHub falla, borra el motivo y el pedido queda como estaba. Si el webhook del issue cerrado llega primero, `follow.ts` lo declina con el mismo motivo, y `teamClose` no lo vuelve a declinar.
  - Queda `declined`, con el motivo en `closeNote` y un evento `closed` con `by` (quién lo cerró).
  - La persona recibe el motivo con esas palabras, en la conversación y por correo (`closedReply('declined', motivo)`, `closedMail`), como cuando un dev decide no hacerlo.
  - Un worker que seguía trabajando termina y no escribe nada (`updateUnlessClosed`). Los demás pedidos con issue se siguen cerrando desde el issue.
- **Vencimiento.** Los pedidos que esperan a la persona y los respondidos (`EXPIRING`). El tick, al empezar y para todos los repos a la vez, corre `expirePortalRequests` después de `sweepPortalRequests`:
  - **El reloj** corre desde el último mensaje de ronin, el que dejó el pedido esperando: la pregunta, el formulario, el resumen o el prototipo. Si la persona escribe, aprueba o pide un ajuste, el pedido sale de la espera. Si ronin vuelve a preguntar, empieza una espera nueva.
  - **A las `PORTAL_REMIND_HOURS` (12):** un correo de recordatorio, uno por espera (el evento `reminded`), con el enlace y la hora en que se cancela, en el reloj del equipo (`EXPLORE_TIMEZONE`).
  - **A las `PORTAL_EXPIRE_HOURS` (24):** queda `cancelled`, con el evento `expired` (distinto del `cancelled` que pone la persona), un mensaje y un correo: «Cancelamos este pedido porque no tuvimos respuesta en 24 horas. Si todavía lo necesitas, puedes enviar uno nuevo.» En el portal, la barra de abajo lo dice en lugar de «Cancelaste este pedido».
  - **`answered`** se cierra a las mismas horas, sin recordatorio, porque nadie espera nada. Queda `cancelled` con `expired` (`answered: true`), y su mensaje no habla de falta de respuesta: «Cerramos este pedido. Si necesitas algo más, puedes enviar uno nuevo.»
  - **El recordatorio cumple lo que promete:** la cancelación es a las 24 h, o 12 h después del recordatorio si salió tarde, lo que sea más tarde. Así, un pedido que ya llevaba días esperando cuando esto se desplegó, o un tick que no corrió, recibe primero el recordatorio y nunca se cancela sin aviso. Con el tick cada 30 minutos, todo llega con hasta media hora de atraso.
  - **Las horas** se cambian en `.env` o en Ajustes → General (§19). Si el recordatorio quedara igual o después del vencimiento, no hay recordatorio.
  - **En el tablero,** *Ahora* dice cuándo vence y si ya salió el recordatorio (`expiry` en la ficha).

#### 16.16 La bitácora de cada app (`domains/knowledge/knowledge.ts`, #412)

Los agentes del portal exploraban el repo de cero en cada pedido. La memoria de Claude Code se guarda según la carpeta de trabajo, y cada pedido usa un checkout nuevo, así que se perdía. La bitácora es lo que aprendieron, guardado por repo y app en el directorio de datos de ronin (`KNOWLEDGE_DATA_DIR`, un `bitacora.json` por app, con `withJson`). No va en este repo ni en el de producto, y no necesita PRs.

- **Qué guarda:**
  - **Pantallas** (`S1`, `S2`…): ruta, nombre, componentes, endpoints, entidades y cómo llegar (rol, viewport, pasos y el tramo del guion de capturas de #411 que llegó a ella).
  - **Trampas** (`T1`…): lo que costó y cómo se resuelve.
  - **Pedidos resueltos:** número, título, archivos y PR.
- **Quién escribe:**
  - `portal-request` y `portal-prototype` dejan `bitacora` en su JSON (`usadas`, `pantallas`, `trampas`, `borrar`), y `parseLearned` se queda con lo que tiene forma usable. `mergeLearned` junta una pantalla por su id o por su ruta y una trampa por su id, y las marca con el commit de la rama base del que salió el checkout (`baseCommit`).
  - Una pantalla del prototipo con `captura` guarda ese tramo de su guion (`guion.json`).
  - Los resueltos los anota `follow.ts` al mergearse el PR del pedido, con sus archivos (`getPrFileNames`), sin agente.
  - Si guardar falla, el pedido sigue igual.
- **Quién lee:** `portal-request`, `portal-prototype` y `portal-reproduce` reciben en el prompt un índice cercado (`knowledgeIndex`, hasta 4 KB) y el detalle en `bitacora.json` dentro de su carpeta de salida, porque corren sellados y no leen los datos de ronin (#257). La entrevista recibe solo el índice. Qué hacer con ella lo dice cada skill, en «La bitácora de la app».
- **Que no envejezca:** `staleIds` hace un `git diff --name-only <commit> <rama base>` por commit, sobre los archivos de sus entradas. Lo que cambió, o lo que se basa en un commit que el repo ya no tiene, va marcado *a verificar* (`verificar: true` en el detalle). El agente lo confirma en el código antes de usarlo y, si sigue valiendo, lo vuelve a escribir.
- **Que no crezca:** `prune` borra lo que nadie usó en 30 días y deja como mucho 80 pantallas, 40 trampas y 50 resueltos por app (`LIMITS`), los usados más recientes.
- **Privacidad:** describe el código y la app. Las skills prohíben guardar el texto de un pedido o datos de personas. El resumen de un resuelto es el título del pedido.

**En las previews (#437).** Los tres trabajos de datos de una preview (§12) también la usan:
- **Qué reciben:** `preview-data-triage` y `preview-data-delta` reciben el índice. `prepare-preview-data` recibe además el detalle en su carpeta de salida y deja `bitacora` en su JSON.
- **El commit de lo que escriben:** el de la cabeza del PR (`saveLearned` con `commit`), no el de la rama base. `staleIds` compara los archivos de cada entrada entre su commit y la rama base. Lo que el PR cambió queda *a verificar* mientras la rama base tenga otros archivos. Cuando el PR se mergea, aunque sea con squash, son los mismos y la entrada vale sin que nadie la toque. Si el PR nunca se mergea, sigue *a verificar* hasta que se borra por falta de uso.
- **El catálogo de seeds sigue aparte:** describe los datos del seed y se invalida por su hash. La bitácora describe la app y el código.

**Encendido por app:** `knowledge` en `repos.json` (`knowledgeOn`), con sus interruptores en Ajustes → Repos.
- `portalOff` apaga los pedidos de una app: el portal la usa por defecto.
- `previews` la prende en las previews de una app: apagada por defecto.
- Apagada, la corrida no la recibe y lo que aprende no se guarda.

### 17. Reuniones: de las notas al trabajo planificado (#62)

Las reuniones ya dejan notas escritas (las de Gemini en Meet, u otro agente), pero pasar de las notas a trabajo planificado era manual y muchas veces no pasaba. En la página *Reuniones* del tablero, alguien sube las notas de una reunión y ronin propone el trabajo que sale de ellas: proyectos nuevos de Linear con sus issues, issues, y comentarios en issues que ya existen. **Nada se crea hasta que alguien lo apruebe ahí**: no hay borradores en Linear, y GitHub sigue siendo la fuente de verdad (§15.13).

```
src/domains/meetings/    el dominio: las reuniones, sus notas y lo que ronin propone
  extract.ts             el texto de un PDF (unpdf), un .docx (mammoth), texto o lo pegado
  meetings.ts            las reuniones: tabla meetings (o meeting.json), y meetings/<n>/ con notes.txt y el original
  prompts.ts             lo que se le dice al agente que las lee
  proposals.ts           lo que propone, contrastado con las notas, los issues y Linear
  read.ts                la lectura: el contexto, el agente, las propuestas y el correo
  mail.ts                el correo al equipo
  worker.ts, launch.ts   el worker por reunión, su relanzamiento y reintentar
  routes.ts              sus rutas en el tablero, en Hono (/api/meetings/*)
  board.ts               la subida, la lista y la ficha
  approve.ts             aprobar (como la persona) y descartar
```

#### 17.1 El recorrido de una reunión

Cada reunión es de **un** repo y se numera entre todos los repos (R-1, R-2…). Sus estados:

- `pending`: se subió; su worker la lee apenas haya un lugar.
- `reading`: ronin la está leyendo.
- `review`: propuso algo y espera que alguien lo revise.
- `empty`: no salió trabajo nuevo. No hay correo.
- `failed`: la lectura falló (por ejemplo, Linear no respondió). Desde la ficha se pide de nuevo.
- `done`: alguien aprobó una parte y se creó todo lo aprobado.
- `discarded`: alguien la descartó. Lo que ya se había creado queda creado.

#### 17.2 Subir las notas

- **Qué se acepta:** un PDF, un Word `.docx`, texto o Markdown (hasta 10 MB), o el texto pegado. De Google Docs se bajan como PDF o `.docx`. El tipo sale de los primeros bytes, nunca del nombre. Un PDF escaneado no tiene texto y se rechaza explicando por qué.
- **El archivo** viaja como data URL dentro del JSON, como las imágenes del portal: solo JSON pasa las defensas del tablero.
- **Dónde queda:** en `MEETINGS_DATA_DIR/meetings/<n>/` se guardan `notes.txt` (el texto extraído) y el original, con permisos 0600 y 0700. El registro de la reunión (sus propuestas, lo creado, su actividad) es la tabla `meetings` de Postgres con `DATABASE_URL` (un documento `jsonb` por reunión, con `repo`, `hash` y `status` como columnas; el número y el control de notas repetidas van en una transacción con un lock de Postgres, #235), o si no `meeting.json` en esa misma carpeta, numerado con `counter.json`. Es la única copia y **nunca va al repo del producto ni a GitHub**: las notas de una reunión dicen más de lo que debería decir un issue.
- **Sin duplicados:** se guarda un hash del texto normalizado, sin espacios ni mayúsculas. Las mismas notas en el mismo repo se rechazan, diciendo qué reunión las tiene. El control va bajo el mismo lock que el contador, así que dos subidas a la vez no pasan las dos.
- **Quién:** cualquiera que vea el repo en el tablero (#106) sube y ve sus reuniones. Una reunión de un repo que no ve no existe para esa sesión. La configuración fina (quién sube, quién aprueba) es #145.

#### 17.3 La lectura (`read.ts`)

El servidor lanza un worker por reunión al subirla. El worker espera un lugar como cualquier corrida (`withSlots`) y toma el lock de la reunión. El tick relanza las reuniones que quedaron en `pending` o `reading` sin worker vivo (`sweepMeetings`), igual que con los pedidos del portal.

El agente (`meeting-read`) es de solo lectura y corre en un checkout detached de la rama base. Tiene:

- **las notas**, con las líneas numeradas, en un archivo;
- **el contexto**, en otro archivo:
  - los issues abiertos de GitHub;
  - con Linear, **todos** los proyectos del equipo (también los completados y los planificados), sus ciclos y sus personas (`teamContext`);
  - lo que otras reuniones del mismo repo propusieron y nadie revisó todavía;
- **el código.**

El prompt marca ambos archivos como datos, nunca como instrucciones.

El agente responde con proyectos (cada uno con sus issues), issues, comentarios y lo descartado, cada uno con el motivo. Cada propuesta cita las líneas de las notas que la justifican.

`proposals.ts` contrasta la respuesta con lo que realmente existe y deja fuera, con un registro en el log, lo que no se sostiene. Nunca adivina un arreglo:
- una propuesta sin citas válidas;
- un comentario en un issue que no está abierto;
- un proyecto que ya existe en Linear;
- un proyecto de Linear o un líder que no son del equipo.

Sin Linear no hay proyectos, y sus issues quedan sueltos. Lo que es de otro repo se descarta: una reunión nunca cruza información entre clientes.

#### 17.4 Revisar y crear (`meetings/approve.ts`)

En la ficha, quien revisa marca qué propuestas quiere y puede cambiar:
- el título y la descripción;
- el líder de un proyecto;
- el proyecto y el ciclo de un issue;
- a qué ciclo pasa un issue comentado.

Desmarcar un proyecto desmarca sus issues, y los issues de un proyecto nuevo no se crean sin él.

*Crear seleccionados* crea:

- **Proyectos** en Linear, con la key del repo (`createProject`): en el equipo, en el primer estado *Backlog* del workspace y con su líder. Quedan a nombre del dueño de la key.
- **Issues y comentarios** en GitHub, **a nombre de quien aprueba** y con su sesión, como *Nuevo issue* (§15.11.1). Los issues se crean sin asignar.
- **El proyecto y el ciclo** de cada issue, y el ciclo de un issue comentado: se encolan en `linear-assign` y se aplican cuando la sincronización los lleva a Linear (`applyLinearSoon`, y el tick para lo que quede).

Al final de lo creado va de dónde salió: la reunión, su fecha y quién lo aprobó. Nunca el texto de las notas.

El resultado de cada propuesta se guarda apenas se conoce:
- reintentar después de una falla parcial nunca crea dos veces lo mismo;
- una sesión de GitHub vencida corta todo, sin perder lo hecho, y la página pide entrar de nuevo;
- un lock por reunión evita dos aprobaciones a la vez.

La reunión pasa a `done` cuando se creó todo lo marcado. *Descartar* la deja en `discarded`.

#### 17.5 Correos

Cuando ronin propone algo, le llega un correo a quien eligió *Propuestas de una reunión* del repo en Ajustes → Notificaciones (`teamTo('reunion')`, §19.5; mientras nadie elige, `portal.notifyTo` o `NOTIFY_TO`). Nunca va a los participantes de la reunión. Lleva lo propuesto, lo descartado y el link a la ficha (`DASHBOARD_URL`), y **nunca el texto de las notas**. Sale de la cuenta de `GMAIL_USER` con el nombre "ronin · Reuniones". Un correo que falla queda en la actividad y no frena nada.

#### 17.6 API

Ver la tabla de 15.9: `GET|POST /api/meetings`, `GET /api/meetings/<n>`, `GET /api/meetings/<n>/original` y `POST /api/meetings/<n>/retry | aprobar | descartar`. Todas filtran por los repos que ve la sesión.

#### 17.7 Activarlo

- `MEETINGS_DATA_DIR` en `.env` (por defecto `meetings-data`). Es la única copia: hay que respaldarlo, como `PORTAL_DATA_DIR`.
- Para proyectos y ciclos, la key de Linear del repo (§15.13) con permiso de escritura. Sin ella, ronin propone solo issues y comentarios.
- Para el correo, `GMAIL_USER` y `GMAIL_APP_PASSWORD`, y quién del equipo recibe el aviso, en Ajustes → Notificaciones (§19.5). Para que el correo traiga el link, `DASHBOARD_URL`.

#### 17.8 Pendiente

- **Una fuente automática:** una carpeta de Drive o un correo reenviado, que entre por la misma puerta que la subida. Antes hay que probar si Gemini comparte las notas con una cuenta de fuera de la organización.
- **Configurar quién sube y quién aprueba:** la administración de usuarios de ronin (#145).

### 18. Despliegues (#158)

Los repos de producto despliegan publicando un release de GitHub: su workflow corre con el tag o con el release. Hasta ahora eso se hacía a mano en GitHub, y un pedido del portal terminado le decía a la persona "sale en la próxima actualización", sin saber cuándo. En la página *Despliegues* del tablero, un admin publica el release de un repo, con todo lo mergeado o solo con los PRs que elija, y ronin sigue su workflow hasta el final.

**ronin no despliega nada por su cuenta:** sube el tag y crea el release. Construir y desplegar es del workflow de cada repo.

```
src/domains/deploys/  el dominio: deploy.ts no sabe quién lo llama
  deploy.ts          lo pendiente, el plan (con la prueba del cherry-pick) y la publicación
  follow.ts          el seguimiento del workflow y el aviso a los pedidos
  store.ts           el registro: tabla deploys, o deploys-data/deploys.json
  routes.ts          sus rutas en el tablero, en Hono (/api/deploys/*)
  board.ts           la página, el plan y la publicación del tablero
```

#### 18.1 Configuración

Un bloque `deploy` por repo en `repos.json`. Un repo sin él no aparece en *Despliegues* y no se despliega desde ronin:

```json
"deploy": { "prerelease": true, "selective": true }
```

- **`prerelease`:** el repo despliega pre-releases a otro lado (QA). El diálogo ofrece la casilla, y un pre-release se compara con el último pre-release.
- **`selective`:** un release puede llevar solo algunos de los PRs sin desplegar (18.3). Hace falta que el workflow del repo despliegue el commit al que apunta el tag aunque no esté en la rama. Un workflow que solo acepta commits de la rama lo rechazaría: ese repo va sin `selective`.
- **`auto`:** `{ "tag": "<patrón>" }`, los pedidos del portal se despliegan solos (18.9). Solo con `selective`: Ajustes → Repos no lo deja prender sin él.

La rama es la de `worktreeBaseRef`. `DEPLOYS_DATA_DIR` (por defecto `deploys-data`) guarda el registro de lo que se publicó.

#### 18.2 Lo que falta desplegar (`pendingChanges`)

Un cambio por PR, del más viejo al más nuevo:

- **Los commits de la rama por primer padre** desde donde la dejó el último release del mismo tipo (su `merge-base` con la rama): un merge commit o un squash por PR, nunca los commits sueltos de adentro de un PR.
- **El número de PR** es el que da GitHub: el `mergeCommit` de cada PR mergeado en la rama (`listMergedPrs`). Hace falta porque un merge commit puede llevar solo el título del PR. Si GitHub no lo tiene, el `(#n)` del asunto o el `Merge pull request #n`.
- **Quedan afuera:**
  - lo que el release ya tiene por parche (`git cherry`), por ejemplo un PR que alguien aplicó a mano;
  - los PRs que llevó un release de *Solo elegidos*, siguiendo la cadena de registros (18.5) hasta un release cortado de la rama. Su commit en la rama no está en el release, pero el cambio sí.
- **De cada cambio:** sus archivos (el diff contra su primer padre), sus apps (por los `path` de `ronin.app.json`) y los pedidos del portal cuyo PR es.

#### 18.3 El plan (`planRelease`)

Lo que haría publicar, sin publicar nada:

- **El tag:** se escribe a mano. Letras, números, puntos, guiones y guiones bajos, y que no exista en el origen.
- **Todo:** el release va en la punta de la rama. Sin release anterior, va todo lo de la rama.
- **Solo lo elegido** (con `selective`):
  - los commits de esos PRs se aplican con cherry-pick sobre el último release, en el orden en que se mergearon; un merge commit, con `-m 1`;
  - se prueba en un worktree descartable (`.deploy-…` en el directorio de worktrees, que el barrido del tick no toca), que se borra al terminar. El commit que queda es el que se va a publicar;
  - si un PR no se aplica, el plan dice qué archivos chocan y qué PR sin elegir los cambió antes: *elige también #n*.
- **Devuelve** las apps, las notas (*Qué entra*, con los pedidos) y un `fingerprint`: el release base y la punta de la rama, o los commits elegidos.

#### 18.4 Publicar (`publishRelease`)

- **Uno por repo a la vez** (lock `deploy-publish`): dos a la vez se compararían con el mismo release anterior.
- **Vuelve a planear,** y rechaza si el `fingerprint` cambió desde el que se vio (se mergeó algo, o salió otro release). El tablero muestra el plan nuevo para revisarlo otra vez.
- **Empuja solo el tag** (`<sha>:refs/tags/<tag>`) y crea el release con `gh release create --verify-tag`. El título es el tag si no se escribió otro, y las notas, las del plan si se dejaron vacías.
- **Lo registra (18.5) y lo anota en sus pedidos.** Si el tag subió pero el release falló, el registro queda igual, porque un workflow que corre con el tag puede estar desplegando ya, y el error lo dice.

#### 18.5 El registro (`store.ts`)

La tabla `deploys` de Postgres con `DATABASE_URL` (#235: los cambios y los pedidos van en el mismo registro, como `jsonb` e `integer[]`; un cambio de estado toma la fila con `FOR UPDATE`), o si no `deploys-data/deploys.json`, con tope de 500. Es la única copia: respaldarla. Por cada release que publicó ronin: el repo y el tag, si es pre-release, si lleva todo o lo elegido, el release base, el sha, la URL, sus cambios (PR y asunto), sus pedidos, quién lo publicó y cuándo, y cómo terminó su workflow. GitHub tiene los releases; solo esto dice qué pedidos llevó cada uno.

#### 18.6 El seguimiento (`followDeploys`) y los pedidos

- **Quién lo sigue:**
  - **el tick,** con el paso `deploys`, solo en los repos con `deploy`;
  - **el webhook `workflow_run` (`completed`),** de un `push` o un `release`. El CI de un PR no cuenta. `scripts/init-webhooks.sh` suscribe el evento;
  - **la página *Despliegues*,** al leerla si hay uno en curso.
- **Cómo se decide el estado:** sigue los runs del tag que tienen el sha del release.
  - todos terminaron bien (`success`, `skipped` o `neutral`): *desplegado*;
  - alguno falló: *falló*;
  - ninguno apareció en 2 horas: *sin workflow* (el repo no despliega con ese tag).
- **Cada pedido que entró en el release** suma el evento `deploy` (*publicado*, *desplegado* o *falló*). Si se desplegó y no es un pre-release, el pedido gana `deployed: { tag, at }` y su persona recibe *Ya está en la aplicación*. Un pre-release (QA) solo se anota: nadie recibe un correo por algo que no está en producción.

#### 18.7 La página (`/despliegues`)

Para los admins, y para quien tenga *Desplegar* en ese repo (Ajustes → Usuarios, §19.3); la API responde 403 a cualquier otra sesión.

- **Una tarjeta por repo con `deploy`:**
  - lo mergeado sin desplegar, con sus apps y "del pedido P-n". Con `selective`, cada PR tiene *Desplegar solo este*;
  - si el repo tiene `auto` y su última pasada no publicó por algo que lo impide, por qué (18.9);
  - los últimos 8 releases: *Latest*, *Pre-release*, *Solo elegidos* y *Pedidos, automático*, cuándo, el estado de su workflow con un enlace a cada run, quién lo publicó y qué pedidos llevó;
  - un release publicado fuera de ronin dice *publicado en GitHub*.
- **El diálogo *Nuevo despliegue*,** como *Draft a new release*:
  - el tag a mano, con el último release (y el último pre-release) a la vista;
  - la casilla *Pre-release* si el repo los usa;
  - *Todo lo de `<rama>`* o *Solo lo que elijas*, con una casilla por PR;
  - el título y las notas, con *Generar notas*.

  Mientras se escribe, el servidor planea (`POST …/plan`, con 450 ms de espera): el tag, la prueba del cherry-pick ("✓ se aplica limpio sobre v…", o el PR que choca y el que falta) y las apps que cambian. *Publicar* se habilita solo con un plan vigente y sin problemas, y manda su `fingerprint`.
- **Se relee cada 30 segundos,** o cada 10 mientras corre un workflow, y no mientras el diálogo está abierto.
- **Lo que lee de GitHub se guarda en caché:** el `fetch`, los releases y los PRs mergeados (`readRepo`) se vuelven a leer a los `DASHBOARD_GITHUB_TTL_SECONDS` (60) y, mientras tanto, la página sirve la lectura anterior (como 15.8). Publicar la descarta. El plan y la publicación leen siempre de nuevo, y el workflow en curso se sigue en cada lectura.

#### 18.8 Activarlo

1. `deploy` en el bloque de cada repo en `repos.json` (18.1).
2. `DEPLOYS_DATA_DIR` en `.env`, si no sirve el de por defecto. Hay que respaldarlo.
3. `scripts/init-webhooks.sh <url-pública>/api/webhooks/github`, para que llegue `workflow_run`. Sin el evento, el tick lo sigue igual, cada 30 minutos.

#### 18.9 Los pedidos se despliegan solos (`auto.ts`, #353)

Un paso del tick para cada repo con `deploy.auto`, solo en la pasada del cron, no con cada evento: así lo que se mergea entre ticks sale junto.

1. **Sin nada que desplegar no cuesta nada.** Primero mira los pedidos del repo: si ninguno está `done` con su PR, sin `deployed` y sin un release (no pre-release) anotado, termina ahí, sin `fetch` ni GitHub.
2. **El lote:** de `pendingChanges`, los cambios con pedidos. Lo que no es de un pedido no entra: sale en los releases a mano.
3. **El tag** (`tag-pattern.ts`): `{major}`, `{minor}` y `{patch}` se leen del último release (no pre-release) con el mismo patrón, y `{patch+1}` les suma. `{yyyy}`, `{mm}` y `{dd}` son la fecha del lote con el reloj del equipo (`EXPLORE_TIMEZONE`), y `{n}` el primer número que no es un tag existente. Si el último tag no encaja, o el repo no tiene releases, no publica.
4. **El plan** es el de *Solo lo que elijas* (`planRelease`, 18.3). Un PR que choca sale del lote y el plan se repite con el resto. Su pedido anota `deploy-skipped` con la base, los archivos y lo que le falta, y al equipo le llega un correo (`pedido-revisar`), una vez por base. El tick siguiente lo vuelve a intentar.
5. **Publica** con `publishRelease`, como release (nunca pre-release: un dev ya aprobó cada pedido), con `by` igual a la cuenta de ronin. El lock `deploy-publish` hace que salga uno a la vez por repo; si está tomado, lo intenta el tick siguiente. De ahí en adelante es un despliegue como cualquier otro (18.6).

Lo que impidió publicar queda en el estado del repo (`autoDeploy` en `repo_state`), y la tarjeta de *Despliegues* lo muestra. Se borra cuando un lote sale o ya no hay nada que desplegar.

#### 18.10 Más adelante

- ***Desplegar solo este*** desde la ficha del pedido y desde la del PR mergeado.

### 19. Ajustes (#174)

Una página del tablero para cambiar la configuración de ronin sin tocar `.env` ni `repos.json` en el servidor, y sin reiniciar: los usuarios, sus permisos, sus correos, los repos y los valores que antes solo cambiaban en `.env`. Reemplaza a #145.

#### 19.1 Qué es

El engranaje junto a *ronin*, arriba de la barra lateral, abre `/ajustes/<sección>`. La barra lateral cambia por la de Ajustes, con *Volver al tablero*:

- **Tu cuenta**, para todos: *Perfil* (nombre, correo, quién eres en cada equipo de Linear, tema) y *Notificaciones* (19.5).
- **Administración**, solo admins: *General*, *Usuarios* (19.3, 19.4), *Repos* (19.6) con una entrada por repo, *Agentes*, *Cuentas de Claude* (19.11), *Exploración*, *Previews*, *Conexiones* (19.7) y *Registro* (19.8).

Cada campo se guarda al salir de él. Lo que ronin necesita del servidor (secretos, rutas, puertos, `RUNNER_ID`, `PREVIEW_PORT_RANGE`) solo se ve.

Las rutas (`/api/settings/*`) están en `domains/settings/routes.ts`, en Hono: quién puede qué, el JSON y los errores. Lo que valida y guarda cada sección está en la misma carpeta: `settings.ts`, `users.ts`, `repos.ts` y `claude-accounts.ts`.

#### 19.2 Valores: el del tablero, después `.env`, después el de por defecto

`platform/config/settings.ts` lista los ajustes que se cambian desde el tablero, cada uno con su variable de `.env`, su campo en `config`, su tipo (número con su rango, sí/no, una lista de opciones, texto con su chequeo) y su valor por defecto:

- *General*: `DASHBOARD_SESSION_DAYS`, `DASHBOARD_GITHUB_TTL_SECONDS`, `PORTAL_DAILY_LIMIT`, `PORTAL_SESSION_DAYS`.
- *Agentes*: `AGENT_MODEL`, `AGENT_EFFORT`, `EXTERNAL_REVIEW_WORKER_MODEL`, `AGENT_TASK_TIMEOUT_MINUTES`, `EVENT_HANDLER_TIMEOUT_MINUTES`, `TICK_INTERVAL_MINUTES`, `TICK_CONCURRENCY`, `EXTERNAL_REVIEW_CONCURRENCY` y los seis límites de reintentos (`docs/BLOCKING.md`). Además, un modelo y un esfuerzo por tipo de tarea: ganan sobre `AGENT_MODEL_<TIPO>` / `AGENT_EFFORT_<TIPO>` y pierden ante el bloque `agent` del repo (`agentModelFor`, `agentEffortFor`).
- *Exploración*: `EXPLORE_TIMEZONE`, `EXPLORE_NIGHT_WINDOW`, `EXPLORE_FUNCTIONS_PER_NIGHT`, `EXPLORE_FUNCTIONS_PER_RUN`, `EXPLORE_FINDINGS_PER_RUN`, `EXPLORE_IDEAS_PER_RUN`, `EXPLORE_PUBLISH_EVIDENCE`.
- *Previews*: `PREVIEW_PREPARE_DATA`, `PREVIEW_TTL_MINUTES`, `PREVIEW_MAX_PER_REPO`.

Lo que se cambia lo guarda `platform/config/settings-store.ts`: en Postgres con `DATABASE_URL` (tablas `settings`, `task_settings` y `claude_account_plans`, con quién y cuándo, #235), o si no en `<SETTINGS_DATA_DIR>/settings.json`. Cada fila dice de dónde viene su valor (`.env`, *Por defecto* o *Cambiado en el tablero*) y ofrece *Volver al de .env*.

- **Cómo llega a cada proceso:** `config.ts` los lee (con `await`, al cargarse) y los aplica sobre lo que dice `.env`, así el tick, cada handler de webhook y cada worker arrancan con los valores del tablero. El servidor los vuelve a aplicar sobre el mismo `config` después de guardar uno: como `apps/api/http/auth.ts`, el portal y las lecturas de GitHub usan `config.dashboard` y `config.portal`, el cambio vale al momento.
- **Un archivo editado a mano o una base que no responde:** un `settings.json` que no se lee, una base caída o un valor fuera de rango se ignoran con un aviso en el log y vale el de `.env`. Nunca tumba un proceso.
- **De a un cambio por vez:** con archivos, el lock de `withJson`; en la base, una transacción con un lock de Postgres (`pg_advisory_xact_lock`) que escribe solo lo que cambió.

#### 19.3 Usuarios del equipo y permisos (`domains/access/team.ts`, `domains/settings/users.ts`)

El equipo entra con GitHub (15.3). GitHub sigue diciendo qué repos ve cada uno (triage o más, #106); Ajustes solo le quita repos y limita qué hace en ellos, nunca le da más. Vive en `<SETTINGS_DATA_DIR>/people.json`, junto al perfil de cada login.

- **Rol:** Administrador o Miembro. Los de `DASHBOARD_ADMINS` son administradores de respaldo: no se les quita el rol desde la página, para que nadie quede afuera por un error. Nadie se quita el rol a sí mismo ni se saca de la lista.
- **Entrada:** "quien tenga acceso en GitHub" o "solo la lista" (las personas de *Usuarios* y los admins). Mientras nadie la elija, la decide `DASHBOARD_ALLOWED_USERS`, como antes; con "solo la lista", esos logins siguen entrando.
- **Permisos de un miembro, repo por repo:** subir notas de reuniones; aprobar lo que propone una reunión; las acciones del tablero (asignar a ronin, comandos, Archivos, fichas de exploración, nuevo issue, *Explorar ahora*); y desplegar. Los tres primeros salen de un conjunto (*Todo*, que es como antes y el valor por defecto; *Reuniones y pedidos*; *Solo lectura*) o de una elección propia (*Personalizado*). **Desplegar se da aparte**, repo por repo: era solo de admins (§18) y ningún conjunto lo prende. Un repo también se le puede ocultar.
- **Dónde se aplica:** `teamAccess` reemplaza a `sessionAccess` en el listener del tablero: los admins de `.env` y del panel, sin los repos ocultos, con los permisos de cada repo. Cada ruta que cambia algo pregunta `can(access, repo, permiso)` y responde 403 si no; la página además esconde lo que no se puede. `applyTeam` reescribe `config.dashboard.admins` y `allowedUsers` (lo que lee `apps/api/http/auth.ts`) al arrancar y después de cada cambio.
- **La lista:** quien entró alguna vez (el snapshot anota `lastSeenAt`, como mucho cada 10 minutos) o agregó un admin con *Agregar persona*. Para cada uno, qué le da GitHub en cada repo, leído con el token de ronin (`collaborators/<login>/permission`).

#### 19.4 Usuarios del portal

Las cuentas del portal de pedidos (§16.2) están en la misma lista, con el rol **Usuario**, y un filtro *Todos · Equipo · Portal*. La página de una cuenta tiene lo que antes estaba en *Pedidos del portal → Usuarios*: nombre, apps donde puede pedir, pedidos por día, el enlace de la contraseña y desactivar. *Agregar persona* pregunta si es del equipo o del portal. Usa la API de siempre (`/api/portal-admin`), que anota cada cambio en el Registro. `/portal` lleva a Ajustes.

#### 19.5 Notificaciones (`platform/notify/notifications.ts`)

Cada persona del equipo elige, repo por repo, qué correos de ronin le llegan, al correo de su Perfil. Nadie más los cambia; un admin los ve en la página de la persona. Son los cuatro correos al equipo:

| Aviso | De dónde sale |
|---|---|
| Pedido para el equipo | `domains/portal/issue.ts`: un pedido o un error que pasa al equipo |
| Pedido para revisar | `domains/portal/follow.ts`: el PR de un pedido espera aprobación |
| Propuestas de una reunión | `domains/meetings/read.ts` (§17.5) |
| Bloqueos | `notifier.ts`, el repo de la URL del issue |

`recipientsFor(repo, entry, aviso)` lo resuelve desde cualquier proceso:
- quien eligió el aviso para el repo;
- mientras alguien no elige, lo de antes: si su correo está en `portal.notifyTo` del repo (o en `NOTIFY_TO`, para los bloqueos), cuenta como suscrito;
- las direcciones de esas listas que no son de nadie del equipo siguen recibiendo;
- si con eso no queda nadie, `NOTIFY_TO`. Un correo nunca se pierde, y un repo nunca recibe lo de otro.

Cuando cada uno tiene su correo en el perfil, `portal.notifyTo` se puede vaciar desde *Repos*.

#### 19.6 Repos (`domains/settings/repos.ts`)

`repos.json` sigue siendo donde vive cada repo; lo que se cambia aquí se escribe ahí. Por repo: nombre en el portal, rama base, las apps de `ronin.app.json` (en el portal o no, nombre y descripción, exploración nocturna, proyecto de Linear de sus issues), la key de Linear (el nombre de la variable de `.env`; la key nunca pasa por el tablero), el respaldo por API (§19.12: la variable `ANTHROPIC_API_KEY_*` de `.env`, el modelo y el tope, que empieza en $20), auto-merge en los PRs de ronin (`autoMerge`, §13; solo se escribe `false`), tareas en paralelo (`concurrency`, de 1 a 10; vacío: `TICK_CONCURRENCY`), despliegues (prendido, pre-release, PRs elegidos), modelo y esfuerzo de los agentes del repo, y quitar correos de `portal.notifyTo`.

- Solo cambia el campo pedido, en la entrada tal como está en el archivo: lo demás queda igual.
- La lista entera pasa por las mismas reglas que la leen (`validateRepos`, de `loadRepos`) antes de escribirse; lo que no pasa no se escribe. Además: el portal nunca queda sin apps, no se agrega al portal una app que ya no está en `ronin.app.json`, y de `portal.notifyTo` solo se quitan correos.
- Antes de escribir, una copia del anterior va a `<SETTINGS_DATA_DIR>/repos-json/` (las últimas 30). El archivo se reescribe con 2 espacios.
- Agregar o quitar un repo, su checkout, su cuenta de Claude y su changelog (rutas del servidor) se siguen haciendo en el archivo.

#### 19.7 Conexiones

Si cada credencial de `.env` está, nunca su valor: el token de ronin (si GitHub responde, y cuándo vence, del header `github-authentication-token-expiration`), la OAuth App del tablero, el secreto de los webhooks, Gmail y las firmas de sesión. *Mandar prueba* manda un correo al de tu Perfil. Linear se ve en cada repo.

#### 19.8 Registro

Cada cambio en Ajustes, del perfil propio a un repo, queda en el registro: la tabla `settings_log` con `DATABASE_URL`, o `<SETTINGS_DATA_DIR>/registro.jsonl`. Cuándo, quién, qué, de qué a qué. Una línea por cambio, que nunca se reescribe; la página muestra las últimas 300.

#### 19.9 API

| Ruta | Quién | Qué |
|---|---|---|
| `GET /api/settings` | todos | el perfil, las notificaciones y los equipos de Linear de la persona; a un admin, además los valores y los modelos por tarea |
| `POST /api/settings/profile` | todos | `{ name?, email?, linear?: { repo, id } }`, el propio |
| `POST /api/settings/notifications` | todos | `{ repo, event, on }`, las propias, de un repo que ve |
| `POST /api/settings/values` | admins | `{ key, value }`; `null` vuelve al de `.env` |
| `POST /api/settings/tasks` | admins | `{ task, model?, effort? }` |
| `GET\|POST /api/settings/users[/<login>[/quitar]]`, `POST /api/settings/team` | admins | el equipo (19.3) |
| `GET /api/settings/repos`, `POST /api/settings/repos/<owner>/<repo>` | admins | los repos (19.6) |
| `GET /api/settings/connections`, `POST /api/settings/connections/mail` | admins | 19.7 |
| `GET /api/settings/accounts`, `POST /api/settings/accounts/<cuenta>` | admins | `{ plan?, priceUsd? }`; `plan: null` vuelve a Max 5× (19.11) |
| `POST /api/settings/api-budget/<owner>/<repo>/reset` | admins | lo gastado por API del repo vuelve a cero (19.12) |
| `GET /api/settings/log` | admins | 19.8 |

#### 19.10 Activarlo

Nada: sin `SETTINGS_DATA_DIR`, usa `settings-data/` en el checkout del runner (fuera de git). Con `DATABASE_URL`, los valores, las tareas, las cuentas y el registro van a Postgres (`pnpm db:import-settings` los copia de los archivos); el equipo y las copias de `repos.json` siguen ahí. Es la única copia de lo que se cambió en el tablero, del equipo y del registro: hay que respaldarlo, como `portal-data/`.

#### 19.11 Cuentas de Claude (#234, `platform/claude/claude-plans.ts`, `domains/settings/claude-accounts.ts`)

El plan que paga cada cuenta de Claude, para calcular en Métricas cuánto se aprovecha (#234).

- **Las cuentas:** una por `claudeConfigDir` de `repos.json`, con el nombre que le da `accountName` (`.claude-redmotos` → `redmotos`; un repo sin `claudeConfigDir` usa `default`). También aparecen las que tienen uso registrado en `logs/usage/`, aunque ya ningún repo las use.
- **Por cuenta:** los repos que la usan, el plan, el precio al mes, el uso de ahora (la última medición, §15.6) y el directorio de configuración, que solo se ve.
- **Planes:** Pro ($20), Max 5× ($100), Max 20× ($200), Team, Enterprise y Otro. Elegir un plan pone su precio de lista; los tres últimos no tienen y conservan el que había. El precio se puede cambiar a mano.
- **Una cuenta sin elegir cuenta como Max 5× ($100).**
- **Dónde queda:** con el resto de Ajustes (tabla `claude_account_plans`, o `settings.json` bajo `accounts.<cuenta>`): `{ plan, priceUsd? }`, con el precio solo si no es el de lista. Una entrada editada a mano que no se lee cuenta como sin elegir. Cada cambio queda en el Registro.
- **Respaldo por API:** debajo de cada cuenta, sus repos con `apiFallback` (19.12), con lo gastado y el botón para reiniciarlo.

#### 19.12 Respaldo por API (#421, `platform/claude/api-fallback.ts`)

Una API key de la consola de Anthropic por repo, para terminar lo que la cuota de la suscripción cortó a mitad de camino.

- **Configuración:** `apiFallback` en la entrada de `repos.json`: `{ apiKeyEnv, model?, maxUsd }`, desde Ajustes → Repos (19.6) o a mano. La key está en `.env` con ese nombre, que no puede ser `ANTHROPIC_API_KEY`. `model` por defecto es `sonnet`.
- **Cuándo:** `runAgentTask` atrapa el `ClaudeUsageLimitError` de una corrida que ya usó alguna herramienta. Una que se cortó sin hacer nada es trabajo nuevo y espera a la cuota, como antes. Tampoco se retoma si el repo no tiene la key en `.env` o le queda menos de `MIN_LEFT_USD` ($0,50).
- **Cómo:** cierra el registro de la corrida cortada como `usage_limit` y abre otro con `billing: 'api'` y el modelo del respaldo. Corre `claude -p --resume <session_id>` (el `session_id` llega en el `system/init`) con `ANTHROPIC_API_KEY` solo en el entorno de esa corrida, `--model` del respaldo y `--max-budget-usd` con lo que le queda al repo. Si la sesión no está (`ClaudeNoSessionError`), empieza la tarea de nuevo con la key. El mismo worktree, el mismo servidor de acciones (que se vuelve a atar al pid nuevo).
- **El tope:** `claude -p` corta con `error_max_budget_usd` al terminar el turno que lo pasa, y eso se lee como el límite de uso: la tarea espera. Lo mismo con el límite del workspace o «credit balance is too low». Una corrida por API no toca el uso de la cuenta (`rate_limit_event`, `limitHitAt`).
- **Lo gastado:** un contador por repo (tabla `api_budgets`, o `<SETTINGS_DATA_DIR>/api-budget.json`), al que se suma el `total_cost_usd` de cada corrida por API al terminar, haya salido bien o no. Ajustes lo reinicia. Una corrida que muere antes del `result` no suma, y dos a la vez reciben cada una lo que quedaba al empezar: el tope que se cumple siempre es el del workspace de la key en la consola.
- **Dónde se ve:** la columna `billing` de `runs`, «por API» en el historial y en la ficha, la barra de abajo desde el 80 % del tope (`apiBudgets` del snapshot), y Ajustes. Métricas → Suscripción no cuenta esas corridas.

### 20. Métricas (#222)

Una sección del tablero, solo para admins, para entender cómo se mueve el trabajo en los repos: cuánto entra y cuánto sale, cuánto tarda, quién lo lleva y dónde se traba. Sirve para mirar la carga y los cuellos de botella, no para rankear personas.

#### 20.1 Qué se cuenta

- **Resuelto:** un issue cerrado como completado. Uno cerrado como *not planned* (o duplicado) se cuenta aparte y no entra en ningún tiempo.
- **Tiempos en días corridos:** un fin de semana cuenta.
- **Tiempo de resolución:** de que se abre el issue a que se cierra como completado.
- **Hasta la primera review:** desde el primer pedido de review, pero no antes de que el PR salga de draft; sin pedido, desde que estuvo listo. Una review del propio autor no cuenta.
- **Por persona:** cada persona asignada a un issue se lleva el crédito. Lo que se cuenta:
  - lo que tiene abierto, y cuánto de eso lleva 14 días sin moverse;
  - lo resuelto y su mediana;
  - sus PRs mergeados;
  - las rondas de review: cuántas reviews pidieron cambios por PR;
  - las reviews que hizo y cuánto tardó en hacerlas, desde que se las pidieron;
  - los PRs que esperan su review.

  Las cuentas `[bot]` quedan afuera. ronin tiene su propia fila, sin las columnas de quien revisa.
- **Despliegues:** los releases publicados que no son *prerelease*. Un PR mergeado sale con el primero que viene después de su merge.
- **ronin:**
  - qué parte de lo resuelto es suyo;
  - cuánto terminó sin que le pusieran `ronin:blocked`;
  - sus PRs mergeados sin pedido de cambios;
  - sus intentos de fix, contados como los labels `ronin:attempts-<n>` que recibió;
  - por qué se bloqueó, agrupado como en `docs/BLOCKING.md`.

Todo se calcula en `domains/metrics/compute.ts`, que es puro: los números se prueban ahí, sin GitHub. Las rutas (`/api/metrics`, `/api/metrics/subscription`, solo administradores) están en `domains/metrics/routes.ts`, en Hono.

#### 20.2 De dónde salen los datos (`domains/metrics/collect.ts`)

- **De GitHub, por GraphQL:**
  - de los issues: cuándo se abrieron y cerraron y cómo, a quién están asignados, sus labels, cuándo se reabrieron y cada vez que recibieron `ronin:blocked`;
  - de los PRs: los pedidos de review, las reviews enviadas, cuándo salieron de draft, los labels de intentos y los issues que cierran;
  - los releases.
- **Dónde se guarda:** cada repo en `<METRICS_DATA_DIR>/repos/<owner>__<repo>.json`.
- **Por incrementos:** cada lectura pide, de la más reciente a la más vieja por `updatedAt`, solo lo que cambió desde la anterior, con 5 minutos de solapamiento.
- **La primera lectura:** trae 180 días, más todo lo abierto aunque sea más viejo. En un repo con cientos de issues y PRs tarda unos 20 s; las siguientes, un par de segundos.
- **Cada cuánto:** el servidor lee GitHub como mucho cada 10 minutos por repo, lo pida quien lo pida. Mientras lee, sirve la lectura anterior. Si falla, se queda con la anterior y con el error, que la página muestra.

#### 20.3 Los bloqueos (`domains/metrics/blocks.ts`)

El estado local guarda solo el último bloqueo de cada ítem, y solo mientras es reciente, así que con eso no alcanza para saber por qué se bloqueó ronin hace dos meses. Por eso `notifyBlocker` también agrega cada bloqueo a `<METRICS_DATA_DIR>/bloqueos.json`, con su repo, su ítem, su motivo y la hora. Ese archivo no se poda hasta los 5000 bloqueos.

Un `ronin:blocked` de GitHub sin su par en el registro, como los de antes de #222, se cuenta igual, como *Sin motivo registrado*.

#### 20.4 API

| Ruta | Quién | Qué |
|---|---|---|
| `GET /api/metrics?days=7\|30\|90&repo=<owner>/<repo>` | admins | el período (30 por defecto) comparado con el anterior, de todos los repos o de uno: los totales, las barras por día o por semana, la distribución de los tiempos, la tabla por persona, la salud del flujo, los despliegues y lo de ronin; en `sources`, de cuándo es la lectura de cada repo y su error |
| `GET /api/metrics/subscription?account=<account>` | admins | el aprovechamiento de cada cuenta de Claude, o de una (20.7) |

#### 20.5 La página (`/metricas`)

La entrada *Métricas* de la barra lateral, solo para admins (`access.admin` del snapshot), abre `/metricas`. Lleva el período (7, 30 o 90 días) y el repo. Se vuelve a pedir cada 5 minutos mientras está abierta. Ocupa también la columna del contexto.

Está en cinco bloques:
- **El resumen:** seis números, cada uno con su variación y su tendencia.
- **Movimiento:** los issues nuevos y resueltos con la línea del backlog, y la distribución de los tiempos de resolución.
- **Por persona:** una tabla ordenable. Al tocar una fila se abren sus resueltos por barra y sus issues abiertos, el más quieto primero, cada uno con un enlace a su ficha.
- **Salud del flujo.**
- **ronin.**

La página no calcula nada: solo dibuja la respuesta de la API.

Una segunda pestaña, *Suscripción* (`/metricas/suscripcion`), dibuja `GET /api/metrics/subscription` (20.7), con un filtro de cuenta:
- **Por cuenta:** su plan con un enlace a Ajustes → Cuentas de Claude, y cinco números: esta semana partida en ronin y otros, la proyección, el aprovechamiento, las ventanas de 5 h y el rinde.
- **Cuatro tarjetas:**
  - el uso acumulado de la semana, con ronin y otros apilados, la proyección punteada y la última medición;
  - el cierre de las últimas semanas;
  - el gasto por tarea y por repo;
  - el costo por resultado.
- **Colores:** ronin en `--repo-0` y otros en `--repo-1`, el par validado para daltonismo y contraste en los dos temas. Sin estimado de ronin todavía, el uso va entero en `--faint`, como *Toda la cuenta*.
- **Hover y tabla:** cada gráfico tiene hover y *Ver como tabla*.
- **En el teléfono:** los gráficos usan otro ancho, con menos marcas en los ejes y texto más grande, y las tarjetas van apiladas.

#### 20.6 Activarlo

Nada: sin `METRICS_DATA_DIR`, usa `metrics-data/` en el checkout del runner (fuera de git). Lo de GitHub se vuelve a traer solo si se pierde; el registro de bloqueos no, así que hay que respaldarlo.

#### 20.6b Pedidos (#428, `domains/metrics/requests.ts`)

La pestaña **Pedidos** (`/metricas/pedidos`, `GET /api/metrics/requests?days=&repo=`, solo admins) calcula, con funciones puras como `compute.ts`, cómo se atienden los pedidos del portal de los repos que se ven. Usa los pedidos (`listRequests`), los nombres de las cuentas (`listUsers`) y, para el dueño de un pedido grande, los asignados de su issue en el caché de GitHub de Métricas (`repoDataOf`). No hay una acción para «tomar» un pedido: el dueño es el asignado, y en un pedido chico, el dev que decidió.

- **Cómo termina** (`ending`): `closed` con `done` es *entregado* (`resolved` también llega como `closed`), `closed` con `declined` es *declinado*, `expired` es *vencido* o, con `answered`, *respondido por ronin*, y `cancelled` es *cancelado*. Sin ninguno sigue abierto.
- **Los tramos** (`stretches`), cada uno con de quién es la espera: *leer* (creado → primer `classified`), *prototipo* (`classified` minor → primer prototipo), *reproducir* (`classified` error → primer `reproduced`), *aprobar* (el último mensaje de ronin antes de la decisión → `decision`), *decidir* (la aprobación, o la última reproducción, → `devDecision`), *hacer* (`devDecision` → `closed` done), *grande* (su issue del equipo → `closed`) y *desplegar* (`closed` done → `deployed`). Cada tramo cuenta en el período en que termina.
- **El equipo:** decisiones por `devDecision.by`, grandes por asignado, mensajes por `team-message`, prioridades quitadas por `priority-removed` y cierres desde el tablero por `closed.by`.
- **Las cuentas:** pedidos, entregados, prioritarios (por `priority.at`), quitados y cancelados o vencidos.
- **Ahora** (no por período): los que esperan a un dev hace más de 24 h, los grandes sin asignado y los que tienen `personReplied`, los más viejos primero, hasta 10 de cada uno.

#### 20.7 Suscripción (#234, `domains/metrics/subscription.ts`)

Cuánto se aprovecha el plan de cada cuenta de Claude (19.11), contando todo lo que usa la cuenta, sea ronin o no, y qué parte es de ronin. `domains/metrics/subscription-view.ts` lee los archivos y `computeSubscription` calcula, sin tocar nada más: los tests le pasan historiales y corridas inventados.

- **La cuota:** cada medición de `logs/usage/history/<cuenta>.jsonl` (§15.6) trae el % usado de la ventana semanal y de la de 5 h, y cuándo se reinicia cada una.
  - Las mediciones se agrupan por semana según su `resetsAt`. Dos que difieren en menos de 2 h son la misma semana.
  - Una semana cerró cuando su `resetsAt` ya pasó. Su cierre es la medición más alta, porque el uso es acumulado.
  - Sin corridas de ronin no hay mediciones, así que el uso de otros entre dos corridas aparece recién en la siguiente. La respuesta dice de cuándo es la última (`lastMeasuredAt`).
- **Esta semana:**
  - el % usado;
  - la serie acumulada, una entrada por medición;
  - la proyección: el ritmo desde la medición más cercana a 48 h antes de la última (o desde el inicio de la semana, en 0), llevado hasta el reinicio, y qué día se agota si llega al 100 %;
  - las ventanas de 5 h que pasaron del 90 % y las veces que se topó el límite.
- **Las semanas cerradas:** las últimas 8, cada una con su cierre, la parte de ronin, la de otros y lo que quedó sin usar. El aprovechamiento es el promedio de los cierres de las últimas 4.
- **La parte de ronin es un estimado:**
  - Entre dos mediciones, ronin sabe cuánto gastó: el `costUsd` de cada corrida, repartido parejo en su duración.
  - Los intervalos se juntan hasta que ronin gastó al menos $1 en ellos, porque la cuota viene en % enteros.
  - Cuando solo ronin usa la cuenta, cada intervalo da cuánta cuota mueve un dólar; si alguien más la usa a la vez, ese número solo sube. Por eso se toma el percentil 25 de las últimas 4 semanas como la tasa de ronin, por cuenta y no por modelo, porque `costUsd` ya pesa el modelo igual que la cuota. Hacen falta al menos 4 intervalos; antes, `ronin` y `others` vienen en `null`.
  - En cada intervalo, ronin se lleva la subida hasta lo que explica su gasto, y el resto va a otros.
  - El primer tramo de una semana cuyo historial empieza a mitad de semana no entra en la tasa: tiene uso de antes de que ronin midiera nada.
- **Rinde:** lo que habrían costado en la API las corridas de ronin de los últimos 30 días, dividido por el precio del plan. Solo cuenta ronin. Sin precio, `ratio` es `null`.
- **En qué se va:** el `costUsd` de los últimos 30 días, por tipo de tarea y por repo.
- **Cuánto cuesta cada resultado**, en los últimos 30 días y solo con lo que ronin trabajó:
  - un issue resuelto: sus corridas y las de los PRs que lo cierran, con sus reviews;
  - un PR mergeado: las suyas y las de los issues que cierra;
  - un pedido del portal: las suyas.

  Cuentan también las corridas que fallaron. Los issues y los PRs salen de lo que Métricas ya leyó de GitHub (20.2).

### 21. Tiempos (#235, etapa 1)

Antes de optimizar nada se mide. `platform/timing.ts` abre una medición (`measure`, un `AsyncLocalStorage`) y cualquier código que corre adentro suma sus tramos con `timed(nombre, fn)` sin que se lo pasen. El tramo `github` suma las llamadas con `gh` de `platform/github/github.ts` y las de `fetch` del tablero (como la persona, sus permisos, los usuarios). Desde #370, cada llamada cuenta también en `github:<operación>`, con la función de ronin que la hizo (`listAllOpenRoninPrs`, `getIssueBody`…). La función sale del stack (`githubCaller`, salteando los envoltorios `gh`, `ghApi`, `githubFetch`…), así que ninguna llamada tiene que nombrarse. Los tramos que corren a la vez se suman, así que el de GitHub dice cuánto se gastó ahí, no cuánto se esperó.

- **Cada request de `/api/*`** (`apps/api/http/timing.ts`, en los dos listeners):
  - responde con `Server-Timing`, con el total hasta la cabecera y cada tramo con sus llamadas;
  - si pasa de `SLOW_REQUEST_MS` (500), deja una línea `slow_request` con la ruta (sin números ni ids: `/api/portal/requests/:n/interview`), el estado y los tramos.

  Quedan afuera los archivos de la web y los streams en vivo (`text/event-stream`).
- **Resumen por ruta:** cada 10 minutos, una línea por ruta en `logs/timings/<día>.jsonl` con la cantidad, los errores 5xx, el total, el máximo, el tiempo en GitHub, el de cada operación (`githubOps`) y cuántos requests cayeron en cada tramo (`≤25, 50, 100, 250, 500 ms, 1, 2.5, 5, 10 s` y más). Se guardan tramos y no percentiles para poder juntar ventanas sin perder exactitud. Un reinicio pierde a lo sumo los últimos 10 minutos.
- **El clic (#368):** el tablero mide cuánto pasa desde un clic hasta que muestra su resultado, que ningún request dice solo: la escritura y lo que se vuelve a leer después. Lo mide al comentar, en una acción, en una decisión, al mandar una revisión y en Archivos (`lib/click-timing.ts`), y lo manda a `POST /api/timings`. Se suma al resumen como una ruta más: `CLIC comentar`, `CLIC accion`, `CLIC decision`, `CLIC review`, `CLIC archivos`.
- **El tick:** `tick_complete` (y `event_complete`) suma `steps` (cuánto tardó cada paso: `assign`, `sweeps`, `auto-merge`, `portal`, `deploys`, `nightly`), `discoveryMs`, `jobsMs`, `githubMs`, `githubCalls` y `githubOps` (el tiempo y las llamadas de cada operación).
- **`pnpm timings [días]`** (`scripts/timings.ts`, la cuenta en `platform/timing-report.ts`) arma la tabla: por ruta, la cantidad, el promedio, los percentiles por tramo, el máximo y GitHub por request, con sus tres operaciones más pesadas; por repo, los ticks con su p50, p90 y máximo, la mediana de cada paso y GitHub por operación (el promedio por tick de su tiempo y sus llamadas, las 15 más pesadas). Lee también los `tick_complete` de antes de esta medición, que solo traen el total.

**Leer una vez por corrida (#370).** Cada corrida del tick para un repo (`tickOneRepo`, también la de un evento) corre dentro de `withGithubMemo` (`platform/github/run-memo.ts`). Ahí, los listados de PRs abiertos que cada paso hacía por su cuenta (`listAllOpenRoninPrs`, dos veces; `listOpenPrHeads`, `listOpenPrsForAutoMerge`, `listAllOpenExternalPrs` y `listOpenPrsByHeadPrefix`) comparten una sola lectura, `readOpenPrs`, con la unión de sus campos, y cada uno filtra lo suyo como antes. Fuera de una corrida (el tablero), cada uno sigue pidiendo solo sus campos.

La lectura compartida no queda vieja por lo que la corrida misma escribe: cualquier escritura a GitHub la vacía (`ghWrites`: todo `gh pr`/`gh issue` salvo `list`, `view`, `status`, `checks` y `diff`; `gh api` con un método distinto de GET o con campos; una mutación de GraphQL). La excepción es `gh label create`, que no cambia ningún PR y que `ensureLabel` corre en cada tick. Tampoco dura más de 2 minutos, porque los trabajos de una corrida pueden seguir por varios.

El cuerpo y las etiquetas de un issue (`getIssueBody`, `getIssueLabels`) también se leen una vez por issue en la corrida: los pasos de un issue en curso los releían cada uno (sus slices, sus PRs, lo que queda). El listado de los issues en curso (`issuesByLabel`) ya los trae, así que los deja en el memo (`remember`), y la primera lectura tampoco va a GitHub. Las etiquetas, solo si vinieron todas (`labels(first: 50)`). Como el resto del memo, una escritura lo vacía: después de `setIssueBody` el cuerpo se vuelve a leer.

**`gh api` sin un proceso por llamada (#370).** Cada `gh` arrancaba un proceso y abría su propia conexión: ~250–300 ms antes de que GitHub contestara nada. Ahora `ghApi` manda la misma llamada con `fetch` (`platform/github/gh-api.ts`), con una conexión abierta a `api.github.com` para todo el proceso. `apiRequestOf` traduce los argumentos como lo hace `gh`:
- el método, que es GET sin campos y POST con ellos, salvo `-X`;
- `-f` y `-F`, con `-F` tipado (`true`, números…), y la sintaxis `clave[]` para las listas;
- los campos de un GET, que van en la URL;
- `--input` y `-H`;
- en GraphQL, la consulta y el resto como variables.

Los errores se escriben como los de `gh` («Not Found (HTTP 404)», «GraphQL: …»), así que un 404 sigue queriendo decir «no existe», y `isTransientGhError` reconoce los transitorios (5xx, `ECONNRESET`…). Lo que no entiende (`--jq`, `--paginate`, un campo leído de un archivo) sigue por `gh`. En este archivo no queda nada así: las lecturas por páginas usan `ghApiPages`, que sigue el `Link` de cada página, y cada página cuenta como una llamada en las métricas. `gh pr`, `gh issue`, `gh run` y `gh release` siguen siendo procesos.

### 22. Instalación con Docker Compose (#235, etapa 5)

Una instalación es `compose.yml` con cuatro servicios: `ronin` (la imagen del `Dockerfile`), `postgres`, `tailscale` (el sidecar) y `docker` (un Docker propio, DinD con TLS). El detalle y el porqué, en [`ARCHITECTURE.md`](ARCHITECTURE.md) («Docker»); cómo se usa, en el sitio: [Instalar con Docker](https://oskr814.github.io/ronin/operar/docker/) y [Respaldar y recuperar](https://oskr814.github.io/ronin/operar/respaldos/).

- **Una sola red para tres:** `ronin` y `docker` comparten la red de `tailscale`. El tablero sigue en `127.0.0.1`, los puertos de las previews también, y `tailscale serve` (el CLI en la imagen, el daemon en el sidecar, por su socket) los publica como en una instalación a mano. Nada del código de las previews cambia.
- **Las apps de prueba nunca tocan el Docker del host:** `DOCKER_HOST` apunta al servicio `docker`, y los worktrees están en un volumen montado en la misma ruta (`/repos`) en los dos.
- **Las rutas de datos son de `compose.yml`,** en el volumen `ronin-files` (`/data`), y pisan las del `.env`: un `.env` de una instalación a mano sirve tal cual, salvo `repos.json`, cuyas rutas pasan a `/repos/…` y `/claude/…`.
- **`ronin init`** (`apps/cli/init.ts`) pide lo que le falta al `.env`, genera los secretos, suma repos a `repos.json` y migra la base; se puede volver a correr. **`scripts/backup.sh` y `scripts/restore.sh`** respaldan y restauran la base y `ronin-files`, con 7 diarios y 4 semanales.
- **Al arrancar,** `docker/entrypoint.sh` configura git y `gh` con el token de ronin, clona los repos que falten y publica el tablero. Recrear el contenedor corta los trabajos que corrían (sin el `KillMode=process` de systemd): quedan `lost` y el tick siguiente concilia.

### 23. Lo que se pide desde ronin no pasa por GitHub (#446)

Lo que se pedía desde el tablero era un comentario en GitHub a nombre de la persona: su webhook, el trabajo que relee los comentarios y encuentra el comando, y la respuesta en otro comentario. Los PRs se llenaban de comentarios y cada pedido daba una vuelta por GitHub (unos 5 s del comentario al trabajo, medido en `/preview`). Ahora lo pedido desde ronin se queda en ronin; GitHub es para leer y para lo que es del código (commits, el PR, la review). Lo que se escribe en GitHub sigue igual, y ronin lo responde ahí.

- **Un pedido es una fila de `commands`** (`domains/commands/store.ts`): el ítem (repo y número), el tipo, los argumentos, quién y cuándo, el estado (`queued` → `running` → `done`/`failed`), las respuestas de ronin (`messages`) y la corrida. La acción del tablero la guarda y lanza su worker con el id (`items/actions.ts`, `askRonin`); el worker responde con `noteCommand` en vez de comentar y la cierra al terminar. Sin `DATABASE_URL`, las acciones siguen comentando en GitHub.
- **Pedido dos veces:** una clave por PR (`preview:<repo>#<n>`, un índice único parcial sobre los que esperan o corren) le devuelve al segundo el primero, con quién lo pidió.
- **Las respuestas siguen al pedido:** una preview pedida desde el tablero guarda `origin: 'tablero'` en su estado, y sus actualizaciones por un push quedan en un comando de ronin (`preview-update`) en vez de un comentario en el PR.
- **En vivo, para todos** (`platform/events/bus.ts`): quien cambia un comando lo avisa con `NOTIFY ronin_events` (la API o un worker del runner), y la API, que hace `LISTEN` con una conexión propia, se lo pasa a cada tablero abierto por `GET /api/events` (SSE), filtrado por los repos que ve la sesión. El evento solo nombra qué cambió; la página relee el ítem abierto (sus corridas y comandos) y, si el comando terminó, el snapshot. Si se corta, al volver relee lo abierto: no hay reenvío de lo perdido.
- **En el ítem** (`pages/item/Commands.tsx`), bajo la actividad: los pedidos en curso y los últimos del día, con su última respuesta; el pedido aparece al hacer clic, antes de que el servidor conteste.
- **Por fases:** el preview es el primero. Siguen las fichas (decisiones compartidas, escritas juntas al finalizar), ajustar desde la barra de decisión con el contexto de los dos lados para el agente, y el resto de las acciones; asignar y cerrar siguen en GitHub porque son su estado.

## Estado actual

- [x] Definir el esqueleto del supervisor (script + estructura de tick) — ver §3.1 y `src/`
- [x] Definir el template del issue de tracking (checklist de slices) — ver [`templates/tracking-issue.md`](../templates/tracking-issue.md) y §2.1
- [x] Definir el criterio exacto de "bloqueo" que dispara notificación — ver [`docs/BLOCKING.md`](BLOCKING.md)
- [x] Prototipo de la app de notificación por email — ver `src/platform/notify/notifier.ts`
- [x] `agent-task.ts`: invocación de `claude -p` en un worktree aislado (ciclo de vida básico, prompts por tipo de tarea, en inglés — ver §8) — ver `src/platform/git/worktree.ts`, `src/platform/claude/claude-runner.ts`, `src/platform/agents/agent-task.ts`, el `prompts.ts` de cada feature y §7.1
- [x] Estado persistente entre ticks: índice de slice actual (`src/domains/slices/checklist.ts`, parseado del propio checklist del issue) y contador de reintentos por PR (`ronin:attempts-N`, labels en `src/platform/github/github.ts`) — ver §3.1
- [x] Claim entre múltiples supervisores concurrentes — ver `src/platform/state/claim.ts` y §9
- [x] Descubrimiento por asignación manual vía PR (reemplaza el escaneo de frontmatter local) — ver §1, resuelve de paso el gap de descubrimiento duplicado que tenía la versión anterior de §9
- [x] Recurrencia vía cron (no tmux) — `scripts/setup-cron.sh`, con `flock` para que un host nunca corra dos ticks solapados
- [x] Límite de uso de Claude como estado transitorio, no como bloqueo — `ClaudeUsageLimitError` (§3)
- [x] Limpieza de worktrees cuando su PR ya no está abierto — `sweepOrphanedWorktrees` (§3.1)
- [x] Reacción por evento: un handler por evento de GitHub, el tick como conciliación — `apps/api/webhooks/handler.ts`, `platform/locks/locks.ts` (§14)
- [x] Tablero web en la tailnet, con login de GitHub, la ficha de cada ítem, acciones y la revisión de PRs (§15.14) — `server/`, `web/`, `platform/agents/run-record.ts`, `platform/claude/claude-usage.ts` (§15)
- [x] Despliegues desde el tablero: releases con todo lo mergeado o solo los PRs elegidos (cherry-pick probado), el seguimiento de su workflow y el aviso a los pedidos que llevan — `deploy/`, `domains/deploys/board.ts` (§18)
- [x] Reuniones: las notas que se suben al tablero, la lectura de ronin y la creación de lo aprobado en GitHub y Linear — `domains/meetings/` (§17)
- [x] Portal de pedidos en `ronin-agent.redmotoshn.com`: cuentas con email y contraseña, conversación con imágenes, prototipo, PR con `ronin:auto-merge` o issue para el equipo, y correos — `portal/`, `apps/portal/` (§16)
- [x] ~~Evidencia visual de e2e en el PR~~ — eliminado (el `src/evidence.ts` de entonces; el `evidence-store.ts` actual es el de la exploración, §11.5); no reemplazaba la supervisión humana y la calidad no era suficiente — ver [issue #4](https://github.com/Oskr814/ronin/issues/4)

**Pendiente, fuera de este scaffold:**

- Nunca se probó en vivo contra un PR real con specs de e2e afectados (el dry run de §10 usó un spec sin ningún componente de UI)
- Exploración y propuestas de mejora (§11): implementadas las etapas 1 a 5 (`app:up` y smoke, memoria, inventario y selección, exploración con navegadores y evaluador, PR de exploración rodante, ventana nocturna y `/spec`). Pendiente: calibrar la calidad de las propuestas con varias corridas a mano antes de activar la exploración nocturna (`explore` en `repos.json`)

- Slugs de slice legibles: hoy el branch de `implement-slice` usa el índice crudo (`slice-1`, `slice-2`); una vez que se valore la legibilidad de branches/PRs, debería derivar el slug del título real de la slice
