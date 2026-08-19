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
- **Autonomía en el descubrimiento, no en el criterio de merge.** El agente decide solo qué spec trabajar y cómo trocearlo, pero **el merge automático de un PR requiere approval explícito** — nunca dispara solo porque el CI está verde. Este gate no es negociable.
- **La revisión humana se mantiene, pero en PRs pequeños.** El review sigue siendo manual (técnica de stacked PRs), la mejora es que cada PR sea revisable en minutos, no horas.

## Arquitectura

### 1. Descubrimiento de specs

El spec se escribe como un **PR draft contra el repo del producto** (ej. `bmedical`), con el archivo `.md` en `docs/superpowers/specs/` — sin frontmatter, un doc markdown normal, igual que los specs ya existentes en el repo.

Flujo:

1. El humano escribe el spec, abre el PR **en draft**, y le pone la label `valeria:runner-<su-usuario-de-github>` (ej. `valeria:runner-oskr814`) — así asigna qué runner lo va a procesar. Mientras está en draft, el agente lo ignora por completo: el humano puede seguir iterando el contenido sin que nada dispare.
2. Cuando el spec está listo, el humano lo marca **ready for review** (sin necesidad de aprobación — undraft es la señal de "andá"). Esta es la única señal que importa; no hace falta más.
3. El runner cuyo label coincide detecta el PR (abierto, no-draft, con su label, sin haber sido ya procesado — ver `listAssignedSpecPrs` en `github.ts`), lo mergea (sin el gate de approval que aplica a PRs de implementación — es documentación, no código de producto, y el humano ya señaló que está listo con la label + el undraft), y a partir de ahí sigue el flujo normal: crear issue de tracking, plan, slicing.

Por qué asignación manual y no descubrimiento automático: dos runners corriendo en paralelo no pueden competir por "quién vio primero" un spec si solo uno de ellos tiene la label puesta — la decisión de quién lo procesa la toma un humano una sola vez, no una carrera entre máquinas. Ver §9 para el gap que esto todavía no resuelve (dos specs *distintos* asignados sin querer al mismo runner no es un problema; el problema real sería un humano poniendo la misma label en dos PRs que describen lo mismo — eso es un problema de proceso humano, no una condición de carrera en el código).

**Variante: issues de bug.** Un issue ya existente en el repo del producto, etiquetado
con la label propia de `bugfix` (ya existente en el repo) y `valeria:runner-<id>`, se
toma con la misma señal de asignación manual que un spec PR, pero sin paso de
draft/ready (un issue de GitHub no tiene estado draft). A diferencia de un spec, no se
crea un issue de tracking espejo — el issue de bug pasa a ser directamente la unidad de
tracking, sembrado con un checklist mecánico de una sola slice para que el resto del
motor (merge gate, ciclos `fix-review`/`fix-e2e`, evidencia) lo trate igual que la
tracking issue de un spec. Ver
[`docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md`](superpowers/specs/2026-07-28-bug-issue-intake-design.md).

### 2. Mapeo a GitHub

- 1 spec → 1 issue de tracking, con checklist de slices (generado por el paso de planning).
- 1 slice → 1 PR apilado sobre el anterior.
- Estado inferido de GitHub, no de memoria del agente:
  - branch existe → spec empezado
  - PR abierto → slice en curso (pueden ser varios PRs de un mismo issue abiertos a la vez, cada uno una slice apilada sobre la anterior — ver [`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`](superpowers/specs/2026-07-28-stacked-prs-design.md) para el rationale completo)
  - comentarios sin resolver → ciclo de fix
  - PR **approved** → candidato a merge automático
  - PR abierto (aunque no esté mergeado) → arranca la siguiente slice apilada encima, sin esperar; solo el PR de menor índice del stack es candidato a merge

### 2.1 Template del issue de tracking

El body lo genera el agente a partir de [`templates/tracking-issue.md`](../templates/tracking-issue.md): un link al spec, un checklist de slices (una línea por slice, con el PR asociado apenas se abre), y una sección de bloqueo que solo se llena cuando aplica.

El estado en sí **no se infiere parseando el body** — vive en labels, que son consultables directamente vía `gh issue list --label`:

- `valeria` — marca el issue como gestionado por el agente (para poder filtrar sin ambigüedad entre issues del repo).
- `valeria:ready | valeria:in-progress | valeria:blocked | valeria:done` — estado actual, mutuamente excluyente, la swap-ea el agente. Espejo 1:1 del `status` del frontmatter del spec.

El body queda como contexto legible para el humano (qué slice va, qué PR corresponde, por qué está bloqueado); las labels son lo que el supervisor realmente lee para decidir la próxima acción.

### 3. Supervisor (honelab, cron)

`pnpm tick` corre y termina — no es un proceso long-running. La recurrencia la da **cron** (no un loop en tmux, que era la idea original): `scripts/setup-cron.sh <minutos>` instala una entrada de crontab que invoca el tick cada N minutos.

En producción (y en el cron) lo que se ejecuta es el build compilado en `dist/` vía `pnpm start`, generado por un paso explícito `pnpm build` — nunca se reconstruye solo, así que hay que correrlo antes de instalar el cron y de nuevo después de cada cambio de código. `pnpm tick` (que corre el código fuente directo con `tsx`, sin compilar) queda para desarrollo local y dry runs. Ver [`docs/superpowers/specs/2026-07-28-build-step-design.md`](superpowers/specs/2026-07-28-build-step-design.md) para el rationale completo.

En cada tick:

1. Escanea specs asignados vía PR + label (`valeria:runner-<id>`, ver §1) → mergea el spec, crea el issue, dispara una sesión `claude -p` en un worktree nuevo para plan + primera slice.
2. Escanea issues abiertos `in-progress` → decide la próxima acción según el estado real del PR/CI/reviews (implementar siguiente slice, resolver comentarios de Copilot, mergear si está aprobado).
3. Cada acción es una invocación de Claude no interactiva, aislada en su propio worktree, que termina al completar la unidad de trabajo — así nunca se acumula contexto entre tareas.
4. Manejo de cuota: si `claude` sale por rate-limit/cuota, no se reintenta de inmediato — backoff (usar el reset time del error si viene, si no, reintentar más tarde). *(Pendiente: hoy un fallo así solo se ve reflejado como excepción no manejada → bloqueo del issue; falta backoff específico para el caso de cuota, ver "Pendiente" más abajo.)*
5. Bloqueo real (spec ambiguo, e2e fallando tras N intentos, conflicto que requiere juicio humano) → notificación por email, el loop deja ese issue en paz hasta recibir input humano.

**Un tick a la vez por host**: como un tick puede tardar (una invocación de `claude -p` puede llegar a `AGENT_TASK_TIMEOUT_MINUTES`), el wrapper que genera `setup-cron.sh` usa `flock` para que un disparo de cron mientras el anterior sigue corriendo se salte en vez de arrancar en paralelo — evita que dos ticks concurrentes en el mismo host pisen `.valeria-state.json` a la vez. Esto es independiente del claim entre runners distintos (§9), que protege contra *otro host*, no contra el mismo proceso solapado consigo mismo.

Concurrencia entre issues: un spec/issue a la vez por tick (dentro del mismo tick, secuencial; entre hosts, ver §9), pero *dentro* de un mismo issue pueden estar en vuelo varias slices/PRs a la vez, cada una apilada sobre la anterior — ya no se espera a que una slice mergee para arrancar la siguiente. Ver [`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`](superpowers/specs/2026-07-28-stacked-prs-design.md) para el rationale completo. Specs independientes sí pueden correr en paralelo en worktrees separados.

Convención de branches: `valeria/<issue>/<slice-slug>` — así el supervisor encuentra el PR de la slice en curso de un issue por prefijo de branch, sin mantener un mapeo aparte.

**Setup**: `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) instala el cron; `pnpm cron:remove` lo saca. El script resuelve el `PATH` real de una shell de login (cron no fuentea `.bashrc`/`.profile`, así que `node`/`pnpm` instalados vía nvm u otro manager no estarían en el `PATH` mínimo de cron) y lo hornea en un wrapper generado (`scripts/run-tick.sh`, no versionado — específico de cada máquina).

**Logs**: `logs/tick-YYYY-MM-DD.log`, un archivo por día — la "rotación" es simplemente escribir a un path nuevo cuando cambia la fecha, sin `logrotate` ni dependencias externas. El wrapper poda archivos más viejos que el retention configurado en cada corrida. Cada línea lleva timestamp ISO (`src/logger.ts`, usado en vez de `console.log` suelto) — incluye el output completo de cada invocación de `claude -p` (antes se descartaba entero; era la única pieza de "qué hizo el agente" que no quedaba en ningún lado, ni en logs ni en GitHub).

### 3.1 Implementación (`src/`)

Scaffold en TypeScript (`pnpm tick` corre un tick y termina — pensado para invocarse en loop desde tmux, no como proceso long-running):

- `config.ts` — env vars, labels, límites de reintento
- `github.ts` — wrappers sobre `gh` CLI (execFile con argv array, nunca shell string) para issues/PRs/labels/merge/body/contador de intentos. El gate de approval está *en código*, no solo documentado: `mergePullRequest` lanza si `reviewDecision !== 'APPROVED'`
- `checklist.ts` — parsea y edita el checklist de slices del body del issue (índice de próxima slice, marcar merged, registrar PR); es la fuente de verdad para "qué slice sigue", no un contador aparte
- `spec-content.ts` — lee el contenido de un spec ya mergeado vía `git show origin/main:<path>` (nunca toca el working directory del checkout principal, así que no importa qué branch tenga el humano checked-out ahí)
- `notifier.ts` — prototipo del notificador (nodemailer + Gmail SMTP)
- `logger.ts` — formato `[ISO_TIMESTAMP] LEVEL mensaje`, usado en vez de `console.log` suelto (ver `logs/tick-YYYY-MM-DD.log`, §3)
- `worktree.ts` — crea/reutiliza un git worktree desechable por branch de tarea
- `evidence.ts` — publica screenshots de Playwright en `VALERIA_REPO` (no en `PRODUCT_REPO`) y arma sus URLs raw — ver §4
- `claude-runner.ts` — invoca `claude -p` con `--permission-mode bypassPermissions`, reenviando el installation token del App como `GH_TOKEN` al proceso hijo (así los `gh` que el propio Claude headless corra también quedan a nombre de `ValerIA[bot]`)
- `agent-task.ts` — arma el prompt (en inglés, ver §8) según el tipo de tarea (plan / implement-slice / fix-review / fix-e2e / fix-bug) y orquesta worktree + invocación; salvo en `plan`, recuerda al agente dejar constancia de aprendizajes no-obvios en `docs/agent-notes/` del repo destino — ver [`docs/superpowers/specs/2026-08-18-agent-notes-design.md`](superpowers/specs/2026-08-18-agent-notes-design.md)
- `claim.ts` — lock por label (`valeria:runner-<runner-id>`) + cache local (`.valeria-state.json`) para que dos supervisores no procesen el mismo issue — ver §9
- `tick.ts` — el loop de decisión: descubre specs asignados, y por cada issue `in-progress` decide la próxima acción leyendo el checklist, la evidencia e2e, y el contador de intentos por PR contra los límites de `docs/BLOCKING.md`

### 4. Testing, evidencia e2e, y review externo

- El agente corre Playwright (`apps/webapp/e2e/`) antes de abrir el PR — si la slice toca comportamiento de usuario, agrega o actualiza un spec y lo corre hasta que pase, en vez de dejárselo a CI.
- Pipelines: el agente monitorea CI y solo considera un PR "mergeable" cuando CI está verde **y** el PR tiene approval humano explícito.

**Evidencia visual**: `apps/webapp/playwright.config.ts` en bmedical tiene `screenshot: 'on'`, así que cada corrida deja capturas en `test-results/` — gitignoreado ahí a propósito, nunca llegan al historial de bmedical. En vez de eso:

1. El agente solo corre los tests; no toca `test-results/` para nada más.
2. El supervisor (`src/evidence.ts`) lee esas capturas directo del worktree en disco, las copia a un checkout dedicado de **ValerIA** (`VALERIA_REPO`, siempre en `main`, nunca el checkout que un humano pueda tener en otra branch) bajo `evidence/<issue>/<pr>/<timestamp>/` — la subcarpeta por timestamp evita que dos publicaciones para el mismo PR se pisen —, commitea y pushea.
3. Postea un comentario en el PR de bmedical (`postEvidenceComment` — no edita, evita la complejidad de resolver el id REST de un comentario desde el `--json` de `gh`) con un link a cada imagen (`github.com/<VALERIA_REPO>/blob/main/...`, la vista blob normal de GitHub, no `raw.githubusercontent.com` — ese dominio no comparte la sesión del browser con github.com y no puede autenticar contra un repo privado).

Hay dos formas de disparar una publicación: la automática, justo después de que se abre el PR de una slice (en el tick siguiente a que se detecta el PR) — esta sigue siendo una sola vez por PR, gateada por el marcador del comentario de evidencia (`hasEvidenceComment`); y una nueva, disparada cuando un humano menciona al bot pidiendo evidencia e2e — esta postea un comentario nuevo cada vez que encuentra screenshots nuevos, sin ese gate. Ver `docs/superpowers/specs/2026-07-29-mention-e2e-evidence-design.md` para el diseño completo.

Por qué en ValerIA y no en bmedical: el historial del producto no debería acumular binarios de cada PR. El costo es un checkout extra (`valeria-evidence-checkout/`, sibling del repo) que el supervisor mantiene sincronizado a `main` en cada publicación — y como `main` de ValerIA también tiene código revisado del propio supervisor, esto mezcla commits automáticos de datos con historial de código (decisión consciente, más simple que una branch separada, pero vale reconsiderar si el volumen crece mucho).

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

A diferencia de un GitHub App (cuyo bot user no siempre es confiablemente @mencionable/notificable), `ronin` es una cuenta real — la misma que abre los PRs es la que se @menciona para pedirle una review puntual (ver README.md, "Pedirle una review por @mención"). No hace falta ninguna cuenta ni setup adicional para esto.

### 9. Concurrencia entre múltiples supervisores

Implementado en `src/claim.ts`, siguiendo el mismo patrón de "GitHub como estado" que el resto del sistema — sin base de datos ni lock service aparte, y sin jitter ni timestamps: un label de claim por runner más un cache local que evita repreguntarle a GitHub por algo que este runner ya sabe que es suyo.

Misma identidad que la asignación de specs (§1): `RUNNER_ID` (el usuario de GitHub, ej. `oskr814`, requerido — no hay default de hostname porque no significaría nada para un humano poniendo la label a mano) y el mismo label `valeria:runner-<runner-id>`, reutilizado como lock automático sobre issues además de como asignación manual sobre specs. La diferencia es quién lo escribe: en un spec PR lo pone un humano a mano; en un issue de tracking lo pone el propio `claim.ts` al procesar.

- **Estado local** (`.valeria-state.json`, gitignored, no compartido entre runners): cache de qué issues ya reclamó este runner. Si un issue ya está ahí, ni siquiera se consulta GitHub — se procesa directo. Es solo una optimización, no la fuente de verdad: si el archivo se pierde o es la primera corrida, se re-deriva todo desde las labels reales.
- Cuando el estado local no tiene el issue: si ya hay un `valeria:runner-*` de *otro* runner, se salta. Si no hay ninguno, agrega el propio y **relee** las labels — dos runners pueden pasar el chequeo y agregar su label en el mismo instante (`--add-label` no es compare-and-swap), así que el desempate es determinista: gana el `runner-id` alfabéticamente menor, sin esperar nada. El que pierde saca su propia label.
- El **descubrimiento de un spec asignado también reclama de inmediato** (`discoverAssignedSpecs` marca el spec PR `in-progress` apenas lo detecta, antes de mergearlo) — así nunca hay una ventana donde algo exista y esté sin dueño.
- El lock sobre un issue se **libera solo cuando deja de estar `in-progress`** (pasa a `blocked` o `done`) — mientras siga en curso, el mismo runner lo retiene sin volver a pelear por él en cada tick.

**El gap de descubrimiento duplicado que documentábamos acá (dos máquinas creando dos issues para el mismo spec) queda resuelto por el cambio de §1**: como la asignación de qué runner procesa un spec la hace un humano poniendo una sola label en un solo PR, no hay dos runners compitiendo por "descubrir" lo mismo — solo uno tiene la label. Lo que sigue siendo un problema de **proceso humano, no de concurrencia**: si alguien pone la misma label en dos PRs que describen el mismo trabajo, eso lo procesan igual como dos specs distintos — no hay nada en el código que detecte esa duplicación de contenido.

## Estado actual

- [x] Definir el esqueleto del supervisor (script + estructura de tick) — ver §3.1 y `src/`
- [x] Definir el template del issue de tracking (checklist de slices) — ver [`templates/tracking-issue.md`](../templates/tracking-issue.md) y §2.1
- [x] Definir el criterio exacto de "bloqueo" que dispara notificación — ver [`docs/BLOCKING.md`](BLOCKING.md)
- [x] Prototipo de la app de notificación por email — ver `src/notifier.ts`
- [x] `agent-task.ts`: invocación de `claude -p` en un worktree aislado (ciclo de vida básico, prompts por tipo de tarea, en inglés — ver §8) — ver `src/worktree.ts`, `src/claude-runner.ts`, `src/agent-task.ts` y §7.1
- [x] Estado persistente entre ticks: índice de slice actual (`src/checklist.ts`, parseado del propio checklist del issue) y contador de reintentos por PR (`valeria:attempts-N`, labels en `src/github.ts`) — ver §3.1
- [x] Claim entre múltiples supervisores concurrentes — ver `src/claim.ts` y §9
- [x] Descubrimiento por asignación manual vía PR (reemplaza el escaneo de frontmatter local) — ver §1, resuelve de paso el gap de descubrimiento duplicado que tenía la versión anterior de §9
- [x] Recurrencia vía cron (no tmux) — `scripts/setup-cron.sh`, con `flock` para que un host nunca corra dos ticks solapados
- [x] Evidencia visual de e2e en el PR — `src/evidence.ts` publica screenshots a `VALERIA_REPO` y las embebe en un comentario vía URL raw, ver §4

**Pendiente, fuera de este scaffold:**

- Nunca se probó en vivo contra un PR real con specs de e2e afectados (el dry run de §10 usó un spec sin ningún componente de UI)

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
