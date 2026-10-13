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
- **Autonomía en el descubrimiento, no en el criterio de merge.** El agente decide solo qué spec trabajar y cómo trocearlo, pero **los PRs de slice los mergea un humano**: ronin nunca mergea uno, ni siquiera aprobado y con el CI en verde, y se entera del merge en el tick siguiente. El PR de exploración sí lo mergea ronin, y solo con approval explícito (`mergePullRequest` lanza sin él). Este gate no es negociable.
- **La revisión humana se mantiene, pero en PRs pequeños.** El review sigue siendo manual (técnica de stacked PRs), la mejora es que cada PR sea revisable en minutos, no horas.

## Arquitectura

### 1. Descubrimiento de specs

El spec se escribe como un **PR draft contra el repo del producto** (ej. `bmedical`), con el archivo `.md` en `docs/superpowers/specs/` — sin frontmatter, un doc markdown normal, igual que los specs ya existentes en el repo.

Flujo:

1. El humano escribe el spec, abre el PR **en draft**, y le pone la label `ronin:runner-<su-usuario-de-github>` (ej. `ronin:runner-oskr814`) — así asigna qué runner lo va a procesar. Mientras está en draft, el agente lo ignora por completo: el humano puede seguir iterando el contenido sin que nada dispare.
2. Cuando el spec está listo, el humano lo marca **ready for review** (sin necesidad de aprobación — undraft es la señal de "andá"). Esta es la única señal que importa; no hace falta más.
3. El runner cuyo label coincide detecta el PR (abierto, no-draft, con su label, sin haber sido ya procesado — ver `listAssignedSpecPrs` en `github.ts`), lo mergea (sin el gate de approval que aplica a PRs de implementación — es documentación, no código de producto, y el humano ya señaló que está listo con la label + el undraft), y a partir de ahí sigue el flujo normal: crear issue de tracking, plan, slicing.

Por qué asignación manual y no descubrimiento automático: dos runners corriendo en paralelo no pueden competir por "quién vio primero" un spec si solo uno de ellos tiene la label puesta — la decisión de quién lo procesa la toma un humano una sola vez, no una carrera entre máquinas. Ver §9 para el gap que esto todavía no resuelve (dos specs *distintos* asignados sin querer al mismo runner no es un problema; el problema real sería un humano poniendo la misma label en dos PRs que describen lo mismo — eso es un problema de proceso humano, no una condición de carrera en el código).

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
  - Sin `ronin:stack-prs`: la siguiente slice recién arranca cuando el stack queda vacío. Con `ronin:stack-prs`: un PR abierto (aunque no esté mergeado) ya dispara la siguiente slice apilada encima; solo el PR de menor índice del stack se mantiene al día con `main` para que se pueda mergear

### 2.1 Template del issue de tracking

El body lo genera el agente a partir de [`templates/tracking-issue.md`](../templates/tracking-issue.md): un link al spec, un checklist de slices (una línea por slice, con el PR asociado apenas se abre), y una sección de bloqueo que solo se llena cuando aplica.

El estado en sí **no se infiere parseando el body** — vive en labels, que son consultables directamente vía `gh issue list --label`:

- `ronin` — marca el issue como gestionado por el agente (para poder filtrar sin ambigüedad entre issues del repo).
- `ronin:ready | ronin:in-progress | ronin:blocked | ronin:done` — estado actual, mutuamente excluyente, la swap-ea el agente. Espejo 1:1 del `status` del frontmatter del spec.
- `ronin:stack-prs` — opt-in, la pone un humano a mano en el issue de tracking: habilita el modo apilado (§2) para ese issue. Sin ella, el default es secuencial.

El body queda como contexto legible para el humano (qué slice va, qué PR corresponde, por qué está bloqueado); las labels son lo que el supervisor realmente lee para decidir la próxima acción.

### 3. Supervisor (honelab, cron)

`pnpm tick` corre y termina — no es un proceso long-running. La recurrencia la da **cron** (no un loop en tmux, que era la idea original): `scripts/setup-cron.sh <minutos>` instala una entrada de crontab que invoca el tick cada N minutos.

En producción (y en el cron) lo que se ejecuta es el build compilado en `dist/` vía `pnpm start`, generado por un paso explícito `pnpm build` — nunca se reconstruye solo, así que hay que correrlo antes de instalar el cron y de nuevo después de cada cambio de código. `pnpm tick` (que corre el código fuente directo con `tsx`, sin compilar) queda para desarrollo local y dry runs. Ver [`docs/superpowers/specs/2026-07-28-build-step-design.md`](superpowers/specs/2026-07-28-build-step-design.md) para el rationale completo.

En cada tick:

1. Escanea specs asignados vía PR + label (`ronin:runner-<id>`, ver §1) → mergea el spec, crea el issue, dispara una sesión `claude -p` en un worktree nuevo para plan + primera slice.
2. Escanea issues abiertos `in-progress` → decide la próxima acción según el estado real del PR/CI/reviews (implementar siguiente slice, resolver comentarios de Copilot, registrar las slices que un humano mergeó).
3. Cada acción es una invocación de Claude no interactiva, aislada en su propio worktree, que termina al completar la unidad de trabajo — así nunca se acumula contexto entre tareas.
4. Manejo de cuota: si `claude` sale por rate-limit/cuota, no se reintenta de inmediato — backoff (usar el reset time del error si viene, si no, reintentar más tarde). *(Pendiente: hoy un fallo así solo se ve reflejado como excepción no manejada → bloqueo del issue; falta backoff específico para el caso de cuota, ver "Pendiente" más abajo.)*
5. Bloqueo real (spec ambiguo, e2e fallando tras N intentos, conflicto que requiere juicio humano) → notificación por email, el loop deja ese issue en paz hasta recibir input humano.

**Un tick a la vez por host**: como un tick puede tardar (una invocación de `claude -p` puede llegar a `AGENT_TASK_TIMEOUT_MINUTES`), el wrapper que genera `setup-cron.sh` usa `flock` para que un disparo (cron o webhook) mientras el anterior sigue corriendo no arranque en paralelo: deja una marca `.tick.pending` y el tick en curso, al terminar, corre otro, así un evento que llega a mitad de un tick no espera al próximo cron — evita que dos ticks concurrentes en el mismo host pisen `.ronin-state.json` a la vez. Esto es independiente del claim entre runners distintos (§9), que protege contra *otro host*, no contra el mismo proceso solapado consigo mismo.

Concurrencia entre issues: un spec/issue a la vez por tick (dentro del mismo tick, secuencial; entre hosts, ver §9). *Dentro* de un mismo issue, el default es secuencial (una slice a la vez, se espera a que mergee para arrancar la siguiente); con el label `ronin:stack-prs` (§2.1) pueden estar en vuelo varias slices/PRs a la vez, cada una apilada sobre la anterior, sin esperar a que una mergee para arrancar la siguiente. Ver [`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`](superpowers/specs/2026-07-28-stacked-prs-design.md) para el rationale completo. Specs independientes sí pueden correr en paralelo en worktrees separados.

Convención de branches: `ronin/<issue>/<slice-slug>` — así el supervisor encuentra el PR de la slice en curso de un issue por prefijo de branch, sin mantener un mapeo aparte.

**Setup**: `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) instala el cron; `pnpm cron:remove` lo saca. El script resuelve el `PATH` real de una shell de login (cron no fuentea `.bashrc`/`.profile`, así que `node`/`pnpm` instalados vía nvm u otro manager no estarían en el `PATH` mínimo de cron) y lo hornea en un wrapper generado (`scripts/run-tick.sh`, no versionado — específico de cada máquina).

**Logs**: `logs/tick-YYYY-MM-DD.log`, un archivo por día — la "rotación" es simplemente escribir a un path nuevo cuando cambia la fecha, sin `logrotate` ni dependencias externas. El wrapper poda archivos más viejos que el retention configurado en cada corrida. Cada línea lleva timestamp ISO (`src/logger.ts`, usado en vez de `console.log` suelto) — incluye el output completo de cada invocación de `claude -p` (antes se descartaba entero; era la única pieza de "qué hizo el agente" que no quedaba en ningún lado, ni en logs ni en GitHub).

### 3.1 Implementación (`src/`)

Scaffold en TypeScript (`pnpm tick` corre un tick y termina — pensado para invocarse en loop desde tmux, no como proceso long-running):

- `config.ts` — env vars, labels, límites de reintento
- `github.ts` — wrappers sobre `gh` CLI (execFile con argv array, nunca shell string) para issues/PRs/labels/merge/body/contador de intentos. El gate de approval está *en código*, no solo documentado: `mergePullRequest` (que solo usa el PR de exploración) lanza si `reviewDecision !== 'APPROVED'`
- `checklist.ts` — parsea y edita el checklist de slices del body del issue (índice de próxima slice, marcar merged, registrar PR); es la fuente de verdad para "qué slice sigue", no un contador aparte
- `spec-content.ts` — lee el contenido de un spec ya mergeado vía `git show origin/main:<path>` (nunca toca el working directory del checkout principal, así que no importa qué branch tenga el humano checked-out ahí)
- `notifier.ts` — prototipo del notificador (nodemailer + Gmail SMTP)
- `logger.ts` — formato `[ISO_TIMESTAMP] LEVEL mensaje`, usado en vez de `console.log` suelto (ver `logs/tick-YYYY-MM-DD.log`, §3)
- `worktree.ts` — crea/reutiliza un git worktree desechable por branch de tarea
- `claude-runner.ts` — invoca `claude -p` con `--permission-mode bypassPermissions`, reenviando el PAT de la cuenta `ronin` como `GH_TOKEN` al proceso hijo (así los `gh` que el propio Claude headless corra también quedan a nombre de esa cuenta)
- `agent-task.ts` — arma el prompt (en inglés, ver §8) según el tipo de tarea (plan / implement-slice / fix-review / fix-e2e / fix-bug) y orquesta worktree + invocación; salvo en `plan`, recuerda al agente dejar constancia de aprendizajes no-obvios en `docs/agent-notes/` del repo destino — ver [`docs/superpowers/specs/2026-08-18-agent-notes-design.md`](superpowers/specs/2026-08-18-agent-notes-design.md)
- `claim.ts` — lock por label (`ronin:runner-<runner-id>`) + cache local (`.ronin-state.json`) para que dos supervisores no procesen el mismo issue — ver §9
- `tick.ts` — el loop de decisión: descubre specs asignados, y por cada issue `in-progress` decide la próxima acción leyendo el checklist y el contador de intentos por PR contra los límites de `docs/BLOCKING.md`

### 4. Testing y review externo

- El agente corre Playwright (`apps/webapp/e2e/`) antes de abrir el PR — si la slice toca comportamiento de usuario, agrega o actualiza un spec y lo corre hasta que pase, en vez de dejárselo a CI.
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

La única contención real es que **cada tarea corre en su propio git worktree desechable** (`src/worktree.ts`), nunca en el checkout principal de `PRODUCT_REPO_PATH` — así un comando destructivo lanzado por error solo puede arruinar ese worktree, que se puede recrear desde cero. Esto es una mitigación, no una garantía: un comando que apunte fuera del worktree (paths absolutos, `cd`, etc.) no está bloqueado por nada. Reconsiderar si en algún momento el blast radius observado no compensa la autonomía ganada.

Segunda limitación encontrada en el primer dry run: el prompt de una tarea puntual no acota lo que el agente puede decidir hacer con `gh`/`git` más allá de esa tarea — si lee contexto que contiene instrucciones para *otras* situaciones (ej. el propio template del issue), puede actuar sobre ellas aunque no vengan de su prompt. Mitigado parcialmente pasando solo la información mínima necesaria en cada prompt (ver §9.1) en vez de decirle al agente que lea documentos completos con instrucciones para roles que no son el suyo.

### 7.2 Usuario mencionable

A diferencia de un GitHub App (cuyo bot user no siempre es confiablemente @mencionable/notificable), `ronin` es una cuenta real — la misma que abre los PRs es la que se @menciona para pedirle una review puntual (ver la [wiki → Comandos](https://github.com/Oskr814/ronin/wiki/Comandos)). No hace falta ninguna cuenta ni setup adicional para esto.

### 9. Concurrencia entre múltiples supervisores

Implementado en `src/claim.ts`, siguiendo el mismo patrón de "GitHub como estado" que el resto del sistema — sin base de datos ni lock service aparte, y sin jitter ni timestamps: un label de claim por runner más un cache local que evita repreguntarle a GitHub por algo que este runner ya sabe que es suyo.

Misma identidad que la asignación de specs (§1): `RUNNER_ID` (el usuario de GitHub, ej. `oskr814`, requerido — no hay default de hostname porque no significaría nada para un humano poniendo la label a mano) y el mismo label `ronin:runner-<runner-id>`, reutilizado como lock automático sobre issues además de como asignación manual sobre specs. La diferencia es quién lo escribe: en un spec PR lo pone un humano a mano; en un issue de tracking lo pone el propio `claim.ts` al procesar.

- **Estado local** (`.ronin-state.json`, gitignored, no compartido entre runners): cache de qué issues ya reclamó este runner. Si un issue ya está ahí, ni siquiera se consulta GitHub — se procesa directo. Es solo una optimización, no la fuente de verdad: si el archivo se pierde o es la primera corrida, se re-deriva todo desde las labels reales.
- Cuando el estado local no tiene el issue: si ya hay un `ronin:runner-*` de *otro* runner, se salta. Si no hay ninguno, agrega el propio y **relee** las labels — dos runners pueden pasar el chequeo y agregar su label en el mismo instante (`--add-label` no es compare-and-swap), así que el desempate es determinista: gana el `runner-id` alfabéticamente menor, sin esperar nada. El que pierde saca su propia label.
- El **descubrimiento de un spec asignado también reclama de inmediato** (`discoverAssignedSpecs` marca el spec PR `in-progress` apenas lo detecta, antes de mergearlo) — así nunca hay una ventana donde algo exista y esté sin dueño.
- El lock sobre un issue se **libera solo cuando deja de estar `in-progress`** (pasa a `blocked` o `done`) — mientras siga en curso, el mismo runner lo retiene sin volver a pelear por él en cada tick.

**El gap de descubrimiento duplicado que documentábamos acá (dos máquinas creando dos issues para el mismo spec) queda resuelto por el cambio de §1**: como la asignación de qué runner procesa un spec la hace un humano poniendo una sola label en un solo PR, no hay dos runners compitiendo por "descubrir" lo mismo — solo uno tiene la label. Lo que sigue siendo un problema de **proceso humano, no de concurrencia**: si alguien pone la misma label en dos PRs que describen el mismo trabajo, eso lo procesan igual como dos specs distintos — no hay nada en el código que detecte esa duplicación de contenido.

### 11. Exploración: ronin usa la app y propone mejoras

Hasta acá ronin solo reacciona: implementa lo que se le asigna y revisa lo que se le pide. Esta sección le agrega la parte que hace un dev senior o un QA por iniciativa propia: **usar la app, encontrar dónde duele y proponer cómo mejorarlo**, con evidencia y el antes/después. El humano sigue decidiendo qué se hace, igual que en el resto del sistema.

#### 11.1 Principios

- **Autodescubrimiento anclado en tareas.** No hay un archivo de objetivos: definir el objetivo suele traer la solución adentro, y entonces no queda nada por descubrir. Una propuesta tiene que nacer de **fricción observada mientras se completaba una tarea real en la app** (crear un borrador, confirmar, surtir…), no de una opinión estética.
- **La evidencia sale de usar la app, no de leer el código.** El código y el historial de git sirven para decidir *dónde* mirar (dónde se concentran los fixes, qué cambió hace poco), pero no alcanzan para justificar una propuesta. En la exploración que llevó a este diseño, un análisis estático ("estas pantallas no tienen clases responsive") concluyó que el flujo de pedidos no funcionaba en mobile, y era falso.
- **Acotado por corrida.** La app crece; ronin nunca la prueba entera. Cada corrida explora como máximo N funciones, y la rotación (§11.4) cubre el resto con el tiempo.
- **Lo que ya se decidió no vuelve.** Cada rechazo, con su motivo, queda en la memoria (§11.6) y se tiene en cuenta en las corridas siguientes.

#### 11.2 Correr la app (`app:up`)

Requisito para todo lo demás. Un manifiesto por repo (en `repos.json` o en `ronin.app.json` del repo del producto) dice cómo levantar la app en un worktree aislado:

- archivo(s) de compose y override generado por ronin para no chocar con el stack de desarrollo de un humano (puertos y `container_name` fijos — p. ej. `web` / `postgres-ecommerce` / 5000 / 5434 en shoppingcart, mismo problema que ya resuelve `DB_PORT` en bmedical)
- paso de seed (en shoppingcart los seeds de `Dumps/postgres/` se montan pero no corren solos)
- URL base y healthcheck
- credenciales de prueba por rol — siempre de seed, nunca reales
- viewports: desktop y mobile

Siempre contra datos de seed, nunca contra producción. El seed tiene que incluir casos de volumen realista (un pedido de 3 líneas no muestra los problemas de uno de 80). La baja reusa `removeDockerStack` de `worktree.ts`. Si `app:up` falla, la corrida lo reporta como primer hallazgo en vez de bloquearse.

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
| datos-hostiles | vacíos, límites, textos largos, caracteres raros, negativos |
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
   - **rechazar**: estado `rechazado` + motivo, y el motivo a `knowledge.md`;
   - **editar**: nuevo título o propuesta; si la imagen del después está mal, el worker levanta la app, rehace la captura con un cambio borrador y la reemplaza en la ficha;
   - **crear un issue** aparte a partir del comentario;
   - **responder** una pregunta.

   Un comentario general del PR que menciona a ronin también se aplica: puede cubrir varias fichas a la vez ("los de mobile se resuelven con F-0003"), que se rechazan o corrigen como arriba, y dejar en `knowledge.md` lo que las exploraciones siguientes no deben volver a proponer. Se procesa antes del merge, así que no se abren issues de fichas que ese comentario descartó.
4. Approve + merge (mismo gate que el resto): al ver el PR aprobado, ronin marca como `aprobado` **las fichas que siguen en pie**, les crea su issue, commitea ambos al PR y recién entonces lo mergea (si sigue aprobado), así la base queda con el estado y el número de issue de cada ficha. La corrida siguiente abre el PR nuevo. Asignar ese issue a ronin lo mete en el flujo de `fix-issue` o de spec de siempre.
5. Excepción: un bug de la app de gravedad `bug` abre su issue en el momento, sin esperar la revisión; igual queda registrado en su ficha. Los problemas del **entorno de desarrollo** (seed, stubs), que el evaluador marca con `entorno`, se registran y se revisan pero nunca abren issue antes de la revisión.

#### 11.8 Programación nocturna

Sin cron aparte: el tick evalúa `es de noche (ventana configurable, p. ej. 01:00–06:00) && la corrida de hoy no está hecha → explorar`. "Hecha" se infiere del repo (existe `runs/<fecha>.md` en la rama del PR de exploración), en línea con "GitHub como máquina de estados": si un corte de cuota interrumpe la corrida, el tick siguiente la retoma.

- **Lo urgente primero**: un issue asignado o una mención que llega de noche se procesa antes; la exploración es la prioridad más baja y es interrumpible entre funciones.
- **Presupuesto por noche, no "usar todo"**: la noche aprovecha la ventana de 5 h de Claude que nadie usa, pero el límite **semanal** es compartido con el trabajo de día. Tope de tiempo y modelo de los workers configurables (como `EXTERNAL_REVIEW_WORKER_MODEL`).
- **Prompt injection desde la app**: el contenido de páginas y datos se trata como dato, con los mismos marcadores `<<<…>>>` que los comentarios.

#### 11.9 Preguntas por Remote Control

Cuando cualquier tarea termina en `RONIN_STATUS: needs-info`, además de dejar las preguntas en el issue, el supervisor puede abrir una sesión `claude --bg --remote-control <nombre>` con el contexto (issue, lo investigado, las preguntas) cuyo único trabajo es entrevistar al humano y escribir `## Respuestas` en el issue. El link (`https://claude.ai/code/session_…`) se lee de `claude logs <id>` y se publica en el issue + email. Al terminar, o tras un timeout (p. ej. 24 h), `claude stop` + `claude rm`; el tick siguiente ve las respuestas y retoma con un worker nuevo.

- Es una sesión **aparte**, no el worker esperando: un worker bloqueado retendría el `flock` del tick, el worktree y el stack de docker.
- Modo `plan`/solo lectura; lo único que hace es comentar en ese issue. Las respuestas siempre quedan en el issue, porque la sesión se borra.
- Debe correr desde un directorio con trust ya dado: sin TTY, `remote-control` no puede preguntarlo y falla con `Workspace not trusted` (los worktrees nuevos no lo tienen).
- **Solo sirve a la cuenta de claude.ai del runner** (Remote Control no se comparte entre cuentas), así que responder por comentario en el issue sigue siendo el canal para el resto del equipo.
- Sin verificar: si `claude rm` también archiva la sesión en claude.ai/code.

#### 11.10 Etapas

0. ~~Spike: Artifacts desde headless, captura del link de Remote Control, quién puede abrir cada cosa~~ — hecho 2026-10-11 (resultados en §11.5 y §11.9)
1. `app:up` para el backoffice de shoppingcart: manifiesto, override de compose, seed, login por rol, desktop + mobile
2. `/explore` a pedido (por mención): inventario, charters, hallazgos e ideas, antes/después en `ronin/evidence`, memoria en `docs/exploration/` — iterar la calidad a mano antes de programarlo
3. Programación nocturna + PR de exploración
4. Preguntas por Remote Control para `needs-info`
5. `/spec`: de un pedido en bruto (o una propuesta aprobada) a un PR draft de spec

Piloto: el backoffice de shoppingcart (herramienta interna, se levanta entero con stubs de Odoo/GCP, usuarios con el mismo rol `Sales` pero dos usos distintos — vendedores en desktop y bodega en el teléfono). El mecanismo se evalúa por la calidad de lo que encuentra: ¿detecta lo que el equipo ya sabía?, ¿encuentra algo nuevo?, ¿cuántas propuestas se descartan?

### 12. Previews por PR en la tailnet (`/preview`)

Para probar un PR sin entrar al server, armar el worktree y levantar la app a mano. `@ronin-agent /preview [app]` en un PR (no fork) hace eso mismo con el `ronin.app.json` del head del PR (§11.2) y responde con una URL de la tailnet y los usuarios de seed. La app es opcional cuando el manifiesto define una sola.

- **Dónde corre.** Un worker aparte (`preview-worker.ts`), como el de exploración: levantar la app tarda minutos y no puede retener el tick. El comando se intercepta en `findUnprocessedMentions`, así que nunca llega a la review ni a fix-comments. El 👀 se pone al lanzar el worker, y el worker contesta en el mismo lugar del comentario. Hay un lock por PR, así que dos `/preview` seguidos no se pisan.
- **Aislamiento.** Worktree `preview-pr-<n>` detached en el SHA del head (vía `refs/pull/<n>/head`) y proyecto compose `ronin-app-<repo>-<app>-pr-<n>`, que corre al lado del de exploración y del de otros PRs. Los puertos siguen en `127.0.0.1`.
- **Publicación.** `tailscale serve --https=<puerto público>` → `http://127.0.0.1:<puerto local>`, solo en la tailnet, nunca `funnel`. Se publica el puerto del `baseUrl` más los que la página usa (ver abajo). Los puertos públicos salen de un rango fijo, `PREVIEW_PORT_RANGE` (por defecto 20000-20999), que es lo único que una política de Tailscale le abre a alguien de afuera:

  ```json
  { "src": ["persona@gmail.com"], "dst": ["tag:media"], "ip": ["tcp:20000-20999"] }
  ```

  El rango queda fuera del rango efímero del kernel (32768-60999), porque ahí caen los puertos aleatorios de Docker. Por ejemplo, los Postgres de las slices se publican en `0.0.0.0:<efímero>`. Si un rango abierto a externos se solapara con el efímero, cualquiera de esos podría quedar adentro. Cada puerto se reserva con un archivo exclusivo en `.preview-reservations/ports/` (`O_EXCL`, compartido por todos los repos y workers), así que dos previews nunca toman el mismo. Un puerto en el que ya escucha otro proceso se saltea. Una reserva cuyo worktree ya no existe se reclama.
- **Límite.** Hay como máximo `PREVIEW_MAX_PER_REPO` previews activas por repo (por defecto 2), sin importar la app: en un repo con varias apps, contar por app confundiría. Los cupos son archivos exclusivos en `.preview-reservations/slots/`. Un `/preview` nuevo en el mismo PR conserva su cupo. Cuando no queda cupo, ronin responde nombrando los PRs que los tienen y borra el worktree que acababa de crear. El cupo se libera con `/preview stop`, al mergear o cerrar el PR, o si la preview falla al levantar.
- **Lo que llama el navegador.** Un frontend que le pega a `http://127.0.0.1:<api>` no funciona desde otra máquina. Lo resuelve el boot, sin tocar el manifiesto: toda URL `http://127.0.0.1:{{…}}` o `http://localhost:{{…}}` en el `env` de un paso `start` se rinde como la URL pública de ese puerto (`https://<host>.ts.net:<puerto>`), y el puerto se publica (`publicizeTemplate`). Los pasos `run`/`wait` quedan en loopback, porque hablan con la app desde el host y corren antes de que haya nada publicado. Fuera de una preview, la URL pública es la misma de loopback, así que la exploración no cambia. Para lo que esa regla no cubre, el manifiesto puede usar `{{public.ports.<servicio>.<puerto>}}` o `{{public.port.<nombre>}}` explícitos, y `{{publicHost}}` para un dev server que valida el header `Host` (Vite ≥5.4.12: `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS`).
- **Vida útil = la del PR.** `sweepPreviews` corre en cada tick: si hay worktrees de preview cuyo PR ya no está abierto, despublica los puertos, baja la app y borra el worktree. El webhook despierta un tick con `pull_request.closed`, así que esto pasa apenas se mergea o se cierra el PR. Lo mismo vale para el worktree de la slice mergeada (`sweepOrphanedWorktrees`) y para el retarget del stack. `/preview stop` la baja antes.
- **Datos para probar el PR.** Los seeds base casi nunca alcanzan para lo que cambia un PR (el #818 necesitaba un cliente con más de 12 catálogos, algunos vencidos). Con la app arriba y publicada, una tarea de agente (`prepare-preview-data`, sonnet por defecto) corre en el worktree de la preview. Lee el título y la descripción del PR (los pasos de "¿Cómo probar?"), su diff contra la base y lo que se haya escrito después del comando (`/preview un cliente con 40 catálogos`), y deja esos datos. Prefiere la API de la app (logueándose con un usuario de seed) y cae a SQL por el stack de compose para lo que la API no permite, como fechas vencidas. Después verifica leyendo de vuelta. La respuesta con la URL lista lo que quedó listo y dónde encontrarlo, y lo que no pudo preparar. Si falla, la preview se entrega igual, con un aviso. No toca código: al terminar, ronin devuelve el checkout al SHA del PR. Se apaga con `PREVIEW_PREPARE_DATA=false`.
- **Commits nuevos.** La preview no se actualiza sola, porque reinstalar en cada push sería caro. Un nuevo `/preview` la mueve al head actual y reusa los `node_modules` del worktree. Cuando el PR recibe commits después de la preview (ronin aplicando un pedido, o el push de quien sea), `sweepPreviews` lo nota en el próximo tick y comenta en el PR que la preview quedó en el commit anterior y que `/preview` la actualiza. El aviso sale una vez por preview (`staleNotified` en `preview.json`) y vuelve a estar disponible con el siguiente `/preview`.

## Estado actual

- [x] Definir el esqueleto del supervisor (script + estructura de tick) — ver §3.1 y `src/`
- [x] Definir el template del issue de tracking (checklist de slices) — ver [`templates/tracking-issue.md`](../templates/tracking-issue.md) y §2.1
- [x] Definir el criterio exacto de "bloqueo" que dispara notificación — ver [`docs/BLOCKING.md`](BLOCKING.md)
- [x] Prototipo de la app de notificación por email — ver `src/notifier.ts`
- [x] `agent-task.ts`: invocación de `claude -p` en un worktree aislado (ciclo de vida básico, prompts por tipo de tarea, en inglés — ver §8) — ver `src/worktree.ts`, `src/claude-runner.ts`, `src/agent-task.ts` y §7.1
- [x] Estado persistente entre ticks: índice de slice actual (`src/checklist.ts`, parseado del propio checklist del issue) y contador de reintentos por PR (`ronin:attempts-N`, labels en `src/github.ts`) — ver §3.1
- [x] Claim entre múltiples supervisores concurrentes — ver `src/claim.ts` y §9
- [x] Descubrimiento por asignación manual vía PR (reemplaza el escaneo de frontmatter local) — ver §1, resuelve de paso el gap de descubrimiento duplicado que tenía la versión anterior de §9
- [x] Recurrencia vía cron (no tmux) — `scripts/setup-cron.sh`, con `flock` para que un host nunca corra dos ticks solapados
- [x] ~~Evidencia visual de e2e en el PR~~ — eliminado (`src/evidence.ts`); no reemplazaba la supervisión humana y la calidad no era suficiente — ver [issue #4](https://github.com/Oskr814/ronin/issues/4)

**Pendiente, fuera de este scaffold:**

- Nunca se probó en vivo contra un PR real con specs de e2e afectados (el dry run de §10 usó un spec sin ningún componente de UI)
- Exploración y propuestas de mejora (§11): implementadas las etapas 1 a 5 (`app:up` y smoke, memoria, inventario y selección, exploración con navegadores y evaluador, PR de exploración rodante, ventana nocturna, entrevistas por Remote Control y `/spec`). Pendiente: calibrar la calidad de las propuestas con varias corridas a mano antes de activar la exploración nocturna (`explore` en `repos.json`)

- Backoff específico para rate-limit/cuota de `claude`: hoy ese fallo cae en el catch-all de `tick.ts` como cualquier otra excepción → bloqueo + email, en vez de reintentarse solo más tarde sin marcar el issue como bloqueado
- Cuándo limpiar un worktree (`removeWorktree` existe pero no está conectado a nada todavía — ¿al mergear? ¿al llegar a `blocked`?)
- Slugs de slice legibles: hoy el branch de `implement-slice` usa el índice crudo (`slice-1`, `slice-2`); una vez que se valore la legibilidad de branches/PRs, debería derivar el slug del título real de la slice
- Decidir si Copilot review se activa (`REQUEST_COPILOT_REVIEW`) y cómo se resuelven sus comentarios automáticamente

### 10. Primer dry run (2026-07-28)

Corrida real de punta a punta contra `Bmedical/bmedical` (spec desechable, tarea trivial: agregar un comentario a `README.md` y abrir PR draft). Resultado: el pipeline funcionó — issue creado, plan generado, slice implementada, PR draft abierto, todo autorado como `ValerIA[bot]`/`app/valeria-agent`, checklist reconciliado correctamente. Se limpiaron todos los artefactos (issue, PR, branches, worktrees) después de verificar.

Encontrado y arreglado a partir de esta corrida:

- Los labels no existían en el repo destino y GitHub no los crea al aplicarlos (`--add-label` falla en seco) — `github.ts` ahora los crea con `--force` antes de usarlos (idempotente).
- `discoverNewSpecs` nunca transicionaba el issue de `valeria:ready` a `valeria:in-progress` — el issue hubiera quedado invisible para el supervisor en todo tick posterior.
- **Hallazgo de contención real**: durante `implement-slice`, el prompt le decía al agente "leé el checklist del issue completo" — eso lo exponía a las instrucciones para *otras* tareas embebidas en `templates/tracking-issue.md` (la sección de Bloqueo), y el agente se auto-aplicó la label `valeria:blocked` por su cuenta, sin que se lo pidiéramos y sin llenar la sección que la propia plantilla exige. Arreglado pasando el título de la slice directo en el prompt en vez de decirle que lea el issue entero, y agregando una instrucción explícita en los cuatro prompts de que la issue/labels son responsabilidad exclusiva del supervisor. Esto no es una garantía — con `bypassPermissions` el agente puede en principio ejecutar cualquier `gh`/`git` que decida — pero reduce la superficie de lo que razonablemente terminaría leyendo y actuando por su cuenta.
- Un PR draft tenía `checksPassing: false` sin que fuera una falla real — la lógica ahora trata `isDraft` como estado de espera normal, no como algo a arreglar.
- Efecto colateral no relacionado con el código: `bmedical` tiene integración con Linear, así que cada issue de tracking real va a generar un ticket enlazado automáticamente — no es un bug, pero vale saberlo.

### 8. Idioma

Todo lo que el agente headless lee o produce como instrucción — los prompts en `agent-task.ts`, el texto y comentarios de `templates/tracking-issue.md` — está en inglés, independientemente del idioma de esta documentación. Lo que es comunicación humana (esta doc, `docs/BLOCKING.md`, el cuerpo de los emails de `src/notifier.ts`, los motivos de bloqueo en `tick.ts`) se mantiene en español.
