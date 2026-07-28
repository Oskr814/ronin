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

Los specs viven en el repo del producto (ej. `docs/superpowers/` en bmedical) con frontmatter:

```yaml
---
status: draft | ready | in-progress | blocked | done
issue: null            # lo rellena el agente al descubrir el spec
---
```

- `draft` / `ready` los controla el humano (marca `ready` cuando terminó de depurar el spec).
- `in-progress` / `blocked` / `done` los controla el agente.
- Una vez que `issue` está seteado, el frontmatter es un espejo — la fuente de verdad es el issue de GitHub, para evitar drift entre dos lugares de estado.

### 2. Mapeo a GitHub

- 1 spec → 1 issue de tracking, con checklist de slices (generado por el paso de planning).
- 1 slice → 1 PR apilado sobre el anterior.
- Estado inferido de GitHub, no de memoria del agente:
  - branch existe → spec empezado
  - PR abierto → slice en curso
  - comentarios sin resolver → ciclo de fix
  - PR **approved** → candidato a merge automático
  - PR merged → siguiente slice

### 2.1 Template del issue de tracking

El body lo genera el agente a partir de [`templates/tracking-issue.md`](../templates/tracking-issue.md): un link al spec, un checklist de slices (una línea por slice, con el PR asociado apenas se abre), y una sección de bloqueo que solo se llena cuando aplica.

El estado en sí **no se infiere parseando el body** — vive en labels, que son consultables directamente vía `gh issue list --label`:

- `valeria` — marca el issue como gestionado por el agente (para poder filtrar sin ambigüedad entre issues del repo).
- `valeria:ready | valeria:in-progress | valeria:blocked | valeria:done` — estado actual, mutuamente excluyente, la swap-ea el agente. Espejo 1:1 del `status` del frontmatter del spec.

El body queda como contexto legible para el humano (qué slice va, qué PR corresponde, por qué está bloqueado); las labels son lo que el supervisor realmente lee para decidir la próxima acción.

### 3. Supervisor (honelab, tmux)

Un proceso supervisor corre en una sesión tmux persistente y en cada tick:

1. Escanea specs con `status: ready` sin `issue` vinculado → crea el issue, dispara una sesión `claude -p` en un worktree nuevo para plan + primera slice.
2. Escanea issues abiertos `in-progress` → decide la próxima acción según el estado real del PR/CI/reviews (implementar siguiente slice, resolver comentarios de Copilot, mergear si está aprobado).
3. Cada acción es una invocación de Claude no interactiva, aislada en su propio worktree, que termina al completar la unidad de trabajo — así nunca se acumula contexto entre tareas.
4. Manejo de cuota: si `claude` sale por rate-limit/cuota, no se reintenta de inmediato — backoff (usar el reset time del error si viene, si no, reintentar más tarde).
5. Bloqueo real (spec ambiguo, e2e fallando tras N intentos, conflicto que requiere juicio humano) → notificación por email, el loop deja ese issue en paz hasta recibir input humano.

Concurrencia: un spec/slice a la vez por seguridad de worktree; specs independientes sí pueden correr en paralelo en worktrees separados.

Convención de branches: `valeria/<issue>/<slice-slug>` — así el supervisor encuentra el PR de la slice en curso de un issue por prefijo de branch, sin mantener un mapeo aparte.

### 3.1 Implementación (`src/`)

Scaffold en TypeScript (`pnpm tick` corre un tick y termina — pensado para invocarse en loop desde tmux, no como proceso long-running):

- `config.ts` — env vars, labels, límites de reintento
- `github.ts` — wrappers sobre `gh` CLI (execFile con argv array, nunca shell string) para issues/PRs/labels/merge. El gate de approval está *en código*, no solo documentado: `mergePullRequest` lanza si `reviewDecision !== 'APPROVED'`
- `specs.ts` — escanea frontmatter de specs, filtra `status: ready` sin `issue`, escribe de vuelta el link una vez creado el issue
- `notifier.ts` — prototipo del notificador (nodemailer + Gmail SMTP)
- `agent-task.ts` — **sin implementar a propósito**: es la interfaz hacia "correr `claude -p` en un worktree aislado". Necesita su propio diseño (ciclo de vida del worktree, forma del prompt, timeout/retry) antes de poder implementarse
- `tick.ts` — el loop de decisión, con dos TODOs explícitos pendientes de estado persistente entre ticks: índice de slice actual y contador de reintentos (ver `docs/BLOCKING.md`)

### 4. Testing y review externo

- E2E: el agente levanta la app y corre flujos con Playwright antes de abrir el PR.
- Pipelines: el agente monitorea CI y solo considera un PR "mergeable" cuando CI está verde **y** el PR tiene approval humano explícito.
- Review de GitHub Copilot: **fuera del loop core por ahora**, parametrizable vía `REQUEST_COPILOT_REVIEW` (default `false`). Si se activa, el agente solicita el review y monitorea/resuelve sus comentarios igual que los de un humano — pero no es una dependencia asumida del flujo.

### 5. Parte visual

Para flujos complejos, el spec incluye un link a un proyecto de Claude Design. El agente lo sincroniza vía MCP (`DesignSync` / skill `/design-sync`) para obtener la propuesta de componentes, en vez de improvisar el diseño visual.

### 6. Notificaciones

Solo se notifica por email en bloqueos reales, no en progreso rutinario (para evitar fatiga de alertas). Requiere una app pequeña con credenciales de Gmail vía variables de entorno, corriendo junto al supervisor.

### 7. Identidad del agente en GitHub

Los issues/PRs los abre un **GitHub App dedicado a ValerIA** (aparece como `ValerIA[bot]`), no la cuenta personal de quien corre el supervisor — así el historial de autoría es honesto sobre qué hizo un humano y qué hizo el agente, y el approval-gate del merge (§ Principios de diseño) tiene sentido: el aprobador y el autor nunca pueden ser la misma persona por accidente.

Se eligió App sobre usuario/máquina + PAT por dos razones: permisos más finos (Contents/Issues/Pull requests por repo, sin ocupar un seat de la org) y revocación simple (desinstalar el App, sin rotar tokens a mano). El costo es que el App no usa un token estático — se autentica con una private key que firma un JWT, canjeado por un installation token de corta duración (~1h) vía la API de GitHub (`src/github-app-auth.ts`, con `@octokit/auth-app`). El supervisor nunca usa la sesión ambiente de `gh auth login` del host: cada llamada a `gh` fija `GH_TOKEN` con ese installation token (`src/github.ts`).

**Setup manual (no automatizable, pasos para el dueño de la org):**

1. Registrar el GitHub App en `Bmedical` (Settings de la org → Developer settings → GitHub Apps → New GitHub App). Permisos: Contents, Issues, Pull requests en read/write.
2. Generar y descargar la private key (`.pem`) al registrar el App — guardarla fuera del repo, nunca commitearla.
3. Instalar el App en el repo `bmedical` (y en `ValerIA` si en algún momento gestiona issues propios) — esto da el installation ID.
4. Setear `VALERIA_GITHUB_APP_ID`, `VALERIA_GITHUB_APP_PRIVATE_KEY_PATH`, `VALERIA_GITHUB_APP_INSTALLATION_ID` en el `.env` del supervisor — nunca commitear el `.env` (ya está en `.gitignore`).

`VALERIA_GITHUB_APP_INSTALLATION_ID` es **puramente numérico** (ej. `149492854`) — no confundir con ningún client secret u otro string alfanumérico de la pantalla de configuración del App. Si no es obvio cuál es, `pnpm find-installation-id` lo resuelve solo a partir del App ID + la private key (no necesita el installation ID de entrada).

**Verificación:** `pnpm smoke-test` pide un installation token real y confirma lectura de `PRODUCT_REPO` — correrlo después de cualquier cambio de credenciales antes de asumir que quedaron bien.

### 7.1 Permisos de las invocaciones headless

`claude -p` corre sin nadie mirando, así que el modo de permisos por defecto (confirmar cada tool call) se cuelga. Se decidió explícitamente `--permission-mode bypassPermissions` — sin ningún gate — en vez de una allowlist curada, priorizando autonomía sobre contención granular.

La única contención real es que **cada tarea corre en su propio git worktree desechable** (`src/worktree.ts`), nunca en el checkout principal de `PRODUCT_REPO_PATH` — así un comando destructivo lanzado por error solo puede arruinar ese worktree, que se puede recrear desde cero. Esto es una mitigación, no una garantía: un comando que apunte fuera del worktree (paths absolutos, `cd`, etc.) no está bloqueado por nada. Reconsiderar si en algún momento el blast radius observado no compensa la autonomía ganada.

## Estado actual

- [x] Definir el esqueleto del supervisor (script + estructura de tick) — ver §3.1 y `src/`
- [x] Definir el template del issue de tracking (checklist de slices) — ver [`templates/tracking-issue.md`](../templates/tracking-issue.md) y §2.1
- [x] Definir el criterio exacto de "bloqueo" que dispara notificación — ver [`docs/BLOCKING.md`](BLOCKING.md)
- [x] Prototipo de la app de notificación por email — ver `src/notifier.ts`
- [x] `agent-task.ts`: invocación de `claude -p` en un worktree aislado (ciclo de vida básico, prompts por tipo de tarea) — ver `src/worktree.ts`, `src/claude-runner.ts`, `src/agent-task.ts` y §7.1

**Pendiente, fuera de este scaffold:**

- Estado persistente entre ticks para índice de slice actual y contadores de reintento (hoy son TODOs en `tick.ts`) — sin esto, `agent-task.ts` no sabe distinguir un primer intento de un reintento tras bloqueo
- Cuándo limpiar un worktree (`removeWorktree` existe pero no está conectado a nada todavía — ¿al mergear? ¿al llegar a `blocked`?)
- Slugs de slice legibles: hoy el branch de `implement-slice` usa el índice crudo (`slice-1`, `slice-2`); una vez que el checklist real se parsea desde el issue, debería derivar el slug del título
- Decidir si Copilot review se activa (`REQUEST_COPILOT_REVIEW`) y cómo se resuelven sus comentarios automáticamente
- Verificación end-to-end contra un spec real — no se corrió todavía (ver PR de esta pieza)
