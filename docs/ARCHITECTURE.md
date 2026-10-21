# Arquitectura de ronin

Este documento describe la arquitectura hacia la que va ronin y cómo llegar a ella sin cortar el servicio. Es la etapa 0 de [#235](https://github.com/Oskr814/ronin/issues/235). [`DESIGN.md`](DESIGN.md) sigue contando cada feature y por qué está hecho así; este documento cuenta cómo se arma el sistema que los corre.

Cuando una etapa de #235 se mergea, lo que cambió se pasa a `DESIGN.md` y la sección de acá dice que ya está hecho.

## Principios que se mantienen

- **GitHub es la máquina de estados del trabajo.** El progreso de un issue vive en su issue, sus PRs, sus labels y sus checks (DESIGN §1–§3). La base de datos de ronin **no** guarda ese progreso: guarda los datos propios de ronin, que GitHub no tiene (el portal, las reuniones, los ajustes, las corridas, la cuota, la cola y los locks). Si la base se pierde, el trabajo en GitHub se retoma igual.
- **Una sesión de Claude nueva por unidad de trabajo,** en su propio worktree, que termina. Nada cambia en cómo corre un agente.
- **Autonomía en el cómo, no en el merge.** El gate de aprobación sigue en `mergePullRequest`.
- **Cambios chicos.** Cada etapa se mergea en PRs que se revisan en minutos, y cada una deja ronin funcionando.

## Cómo está hoy

**Procesos**, todos en una sola máquina:

| Proceso | Qué hace | Cómo arranca |
|---|---|---|
| Tick | Concilia todos los flujos de todos los repos (DESIGN §3, §14) | cron cada 30 min, con `flock` y la marca `.tick.pending` |
| Servidor | Webhooks, portal y tablero: dos listeners, uno público y uno en la tailnet (§15.2) | unidad de systemd del usuario |
| Handler por evento | Corre los flujos del scope de un webhook (§14) | lo lanza el servidor, un proceso por evento |
| Workers | Previews, prototipos, conflictos, exploración, portal y reuniones | `launchWorker`, procesos sueltos con su pid en un lock |
| Agentes | `claude -p`, uno por tarea | `runAgentTask`, dentro de cualquiera de los anteriores |
| Apps de prueba | Previews, prototipos y reproducciones | `docker compose` contra el Docker del host |

**Datos**, todos en archivos:

| Qué | Dónde | Cómo se coordina |
|---|---|---|
| Cuentas, pedidos y eventos del portal; sus imágenes | `PORTAL_DATA_DIR` (un `request.json` por pedido) | `withJson`: lock de archivo y escritura atómica |
| Reuniones | `MEETINGS_DATA_DIR` | ídem |
| Despliegues | `DEPLOYS_DATA_DIR` | ídem |
| Ajustes | `SETTINGS_DATA_DIR` (Postgres con `DATABASE_URL` desde la etapa 2) | ídem |
| Métricas (caché de GitHub) | `METRICS_DATA_DIR` | ídem |
| Catálogo de seeds | `SEED_CATALOG_DATA_DIR` | ídem |
| Corridas de agentes | `logs/runs/<día>/<corrida>.jsonl` | un archivo por corrida; el tablero los recorre |
| Uso de cada cuenta de Claude | `logs/usage/` | se reescribe en cada corrida, con historial aparte |
| Estado local (claims, comentarios procesados, firmas de fallas, bloqueos…) | `.ronin-state.json` | lock de archivo y escritura atómica |
| Locks de recursos (`issue-N`, `pr-N`…) y de workers | `<worktreeBasePath>/.locks/` | archivo con el pid; se toma si el proceso murió |
| Cupos por repo y por tipo | `.ronin-slots/` | ídem |
| Lo que espera un cupo (la cola del tablero) | `.ronin-slots/waiting/` | una marca por job, con su pid |
| Repos atendidos | `repos.json` | editado a mano o desde Ajustes → Repos |

**Código:** unas 36 mil líneas de TypeScript y JS, con 130 archivos de tests y casi sin dependencias.
- **Servidor:** `node:http`, con las rutas resueltas en cada archivo de `src/server/api/`.
- **Tablero:** un solo `src/apps/dashboard/public/app.js` de unas 6.400 líneas, JS plano sin build, con estado global y HTML armado como texto. El portal (`src/apps/portal/`) sigue el mismo patrón.

**Instalación:** a mano. Node y pnpm, `.env`, `repos.json`, el cron (`scripts/setup-cron.sh`), la unidad de systemd (`pnpm server:setup`), `tailscale serve`, un `claude login` por cuenta y `gh`. Recuperar ronin en otra máquina es repetir todo eso.

**Lo que cuesta hoy:**
- **Coordinar por archivos:** cada store tiene su lock, cada lock su pid, y leer "todos los pedidos" es abrir un archivo por pedido.
- **El tablero es un archivo enorme** sin tipos ni componentes: un cambio en la API no rompe nada hasta que alguien abre la página.
- **Las apps de prueba** corren contra el Docker del host.
- **Instalar o recuperar ronin** lleva muchos pasos.

## Hacia dónde va

```
                 GitHub (webhooks) · portal público · tablero (tailnet)
                                     │
        ┌────────────────────────────▼─────────────────────────────┐
        │                          ronin                           │
        │                                                          │
        │   API (Hono)          Planificador         Cola de       │
        │   tablero · portal ─► (lo que hoy hace ─►  trabajos      │
        │   webhooks            el tick)             (leases)      │
        │                                               │          │
        │   Postgres ◄── repositorios ◄── servicios     │          │
        │   archivos (imágenes, transcripciones)        ▼          │
        │                                         Runner local     │
        │   cuentas de Claude ◄── claude -p ◄──── (Host local:     │
        │                                          git, docker,    │
        │                                          tests, browser) │
        └──────────────────────────────────────────────────────────┘
                   Docker: ronin · Postgres · Tailscale · Docker propio
```

- **Un solo servicio de larga vida.** El planificador corre dentro de ronin, sin cron.
  - Los webhooks y la conciliación periódica crean trabajos.
  - El runner local los toma y los ejecuta en procesos hijos, como hoy.
- **Postgres** para los datos de ronin.
- **Archivos en un volumen** para lo que es binario o muy grande.
- **Toda ejecución sobre el código pasa por `Host`,** y la única implementación por ahora es la local.
- **La API tiene contratos tipados,** y el frontend se construye con Vite.
- **Todo eso se instala con Docker Compose.**

### Estructura del código

`src/` tiene tres capas y las apps, y las dependencias van en una sola dirección: **`apps` → `domains` → `platform`**. Un dominio nunca importa de `apps/`; `platform/` no importa de ningún dominio; las apps web solo usan los *tipos* de las rutas de los dominios.

```
src/
├── apps/              lo que se ejecuta o se sirve; arma, no decide
│   ├── api/           el servidor: main.ts, http/ (listeners, login, estáticos, Hono), routes.ts (monta los dominios), jobs/ (cola), tick/, webhooks/
│   ├── dashboard/     el tablero: public/ (el marco: app.js, app.css, fuentes) y src/pages/<dominio>/ en React
│   └── portal/        el portal de pedidos: src/pages/, src/components/
├── domains/           la lógica de ronin, una carpeta por dominio, con sus rutas (routes.ts), su lógica y su almacenamiento
│                      portal, meetings, deploys, explorations, metrics, settings, items, runs, access,
│                      slices, review, commands, previews, changelog, product-app
├── platform/          lo técnico que usan todos: config/, db/, github/, linear/, git/, claude/, agents/, state/, locks/, workers/, notify/,
│                      http/, store/, fs/, logger, timing, errors.ts
└── ui/                React compartido por el tablero y el portal: components/, api-client.ts, time.ts
```

**Reglas:**
- **Cada cosa en un solo lugar.** Lo que dos dominios necesitan va a `platform/` (si es técnico) o a un dominio propio (si es de ronin: quién ve qué es `domains/access`); lo que dos apps web necesitan, a `ui/`. Nada se copia «como lo hace el otro».
- **Un dominio no sabe de HTTP salvo en su `routes.ts`**, que usa las piezas comunes de `platform/http/middleware.ts` (solo JSON, el cuerpo con su tope y su esquema, solo administradores, el repo del path, los errores) en vez de declararlas. Quién pregunta en el tablero (`Session`, `DashboardEnv`) es de `domains/access/http.ts`.
- **Las pruebas van junto a su archivo** (`x.ts` y `x.test.ts`); las que cruzan capas o dominios (el HTTP del tablero a través de la app entera, Postgres con otro dominio, los recorridos con Playwright), en `test/`, con la misma estructura que `src/` (`test/domains/meetings/routes.test.ts`).
- **La dirección se prueba:** `test/structure.test.ts` falla si `platform/` importa de un dominio o de una app, si un dominio importa de una app, si `ui/` importa algo del servidor, o si una app web importa del servidor algo más que tipos.
- **Una carpeta que crece se parte en subcarpetas**, no en archivos más largos.

**Lo repetido y su pieza común** (relevado el 2026-10-21):

| Hoy, repetido | Pieza común |
|---|---|
| El almacén con dos backends (Postgres o archivos) escrito por cada módulo — reuniones, pedidos, cuentas, ajustes, despliegues —, con locks de números mágicos | `platform/store/`: `documentStore` (reuniones y pedidos: el documento numerado), `onStore` (Postgres o archivos, medido), `requireDb` y `STORE_LOCKS` (cada lock de Postgres con su nombre). **Hecho.** Cuentas, Ajustes y despliegues guardan cada uno una forma distinta (una lista, tres tablas, filas por repo y tag): usan `onStore` y su lock, sin una abstracción para un solo usuario. |
| Escribir JSON con tmp + rename y el lock de archivo, en `domains/portal/json-store.ts` y copias | `platform/fs/atomic-json.ts`: `readJson`, `withJson`, `writeJson` y `writeFileAtomic`, que reemplaza las cuatro copias (corridas de exploración, catálogo de seeds, uso de Claude, estado local). **Hecho.** |
| En cada `routes.ts`: solo JSON (415), solo administradores, `z.record(...)`, el tope del cuerpo, `owner/name`, «no lo ves: 404» | `platform/http/middleware.ts`: `onlyJson`, `jsonBody`, `body`, `anyObject`, `adminsOnly`, `repoParam`, `onError`. **Hecho.** El permiso (403) ya era uno solo, `refusal` en `domains/access/visible.ts`; cada «no existe: 404» se queda en su ruta, con el mensaje de su dominio. Los dominios ya no importan nada de `apps/`. |
| ~15 clases de error de dominio con su status, y la lista de cada `onError` | `platform/errors.ts`: `DomainError(message, { status, details })`; cada clase de un dominio la extiende y `onError` ya no lleva lista. **Hecho.** |
| `pidAlive` (6 copias), lanzar un worker y relanzar los que murieron, el arranque de cada worker | `platform/workers/`: `pidAlive`, `runWorker` y `withProductRepo`, `trackedWorker`, `worktreeLock`. **Hecho.** |
| Llamadas a la API de GitHub con sus headers y errores, en 5 archivos; `owner/name` partido a mano | `platform/github/rest.ts`: `githubFetch` (headers, timeout, medida) y `parseRepo()`. **Hecho.** Qué significa cada respuesta (un 401, un 404) sigue siendo de quien llama. |
| El cliente de la API, las fechas y los chips de estado en el tablero y el portal | `ui/api-client.ts` (`ApiError`, `jsonFetch`, `ok`), `ui/time.ts` y `ui/components/Chip.tsx`. **Hecho.** Las palabras de cada estado de un pedido no se repiten: el portal le habla a la persona («Espera tu respuesta») y el tablero al equipo («Espera a la persona»); el tipo lo dan las rutas. |

**Cómo se llega**, en PRs que solo mueven o solo unifican, nunca las dos cosas:
1. `apps/`: el servidor, la cola, el tick y las dos apps web. **Hecho.**
2. `domains/`: lo que estaba en `server/api/` y en las carpetas de dominio, con `access` como dominio propio. **Hecho.**
3. `platform/`: lo que estaba en `core/` y `db/`, por tema (`config/`, `github/`, `agents/`, `state/`…). **Hecho.** `platform/` ya no importa de ningún dominio: la marca del pie de ayuda de los PRs pasó a `platform/github/pr-body.ts` y el registro de bloqueos, que escribe el notificador, a `platform/notify/block-log.ts`.
4. Una pieza común por PR, de la tabla de arriba, reemplazando todas sus copias.

### Datos: Postgres

**Qué va a la base:**

| Hoy | En la base |
|---|---|
| Ajustes | `settings` (clave, valor, quién y cuándo), `task_settings` |
| Repos atendidos (`repos.json`) | `repos` (y sus bloques `portal`, `deploy`, `agent`) |
| Despliegues | `deploys`, `deploy_picks` |
| Reuniones | `meetings`, `meeting_items` (las notas originales, como archivo) |
| Portal | `portal_users`, `portal_links`, `requests`, `request_messages`, `request_events`; las imágenes, como archivo |
| Uso de las cuentas de Claude | `claude_accounts`, `usage_measurements` |
| Corridas | `runs`: el resumen, con repo, tipo, issue, PR, pedido, cuenta, modelo, tokens, costo, duración y resultado; la transcripción completa sigue como archivo |
| Estado local | `repo_state`: una fila por entrada (claims, comentarios procesados, firmas de fallas, bloqueos…), no un JSON |
| Locks, cupos, cola, workers | `jobs`, `resource_locks`, `slots` (ver la sección «Cola de trabajos») |

**Qué queda como archivo,** en el volumen `ronin-files`:
- las imágenes del portal;
- las transcripciones de corridas;
- las notas de reuniones;
- los diffs de prototipos;
- las capturas y evidencias antes de publicarse.

La base guarda la ruta y los metadatos.

**Qué no va:** nada que GitHub ya tenga. Los labels, el checklist de slices, los intentos y el claim siguen en GitHub. Los caches de GitHub (métricas) pueden ir a la base como caché, nunca como fuente de verdad.

**Cómo se accede:**
- **Kysely** sobre `pg`: consultas tipadas sin un ORM que esconda lo que hace.
- **Migraciones versionadas** en `src/platform/db/migrations/`, que corren al arrancar.
- **Un repositorio por módulo** (`domains/portal/store.ts`, `domains/deploys/store.ts`…) con la misma interfaz que hoy exponen los módulos. Los servicios no cambian de forma.

**Hecho:** la base (`src/platform/db/`: Kysely, migraciones en `src/platform/db/migrations/` que el servidor corre al arrancar, `compose.postgres.yml`, `compose.test.yml` y un Postgres en el CI) y los módulos **Ajustes** (`platform/config/settings-store.ts`) **Despliegues** (`domains/deploys/store.ts`) **Portal** (`domains/portal/accounts.ts`, `domains/portal/requests.ts`: `portal_users` y `portal_requests`, con cada pedido como un documento en vez de `request_messages` y `request_events`) y **Reuniones** (`domains/meetings/meetings.ts`; cada una como un documento `jsonb`, en vez de `meeting_items`, porque se lee y se escribe entera). El **estado local**, el **índice de corridas** y la **cuota** pasan a la etapa 3: los tres viven dentro del tick y de los agentes (locks durante llamadas a GitHub, escrituras síncronas), y la cola rediseña justo los claims, los locks y el registro de trabajos. Mientras dura la etapa, `DATABASE_URL` la activa y sin ella todo sigue en archivos: cada módulo se despliega primero y se pasa después con su `pnpm db:import-<módulo>`. `config.ts` lee Ajustes con `await` al cargar, así que cada proceso abre su pool (chico, que no impide que el proceso termine).

**Migración, un módulo por vez:**
1. Se crea la tabla.
2. Un script importa los archivos.
3. El repositorio pasa a leer y escribir la base.
4. Los archivos viejos quedan un tiempo como respaldo.

**Tests:**
- Los de repositorios corren contra un Postgres real: un servicio en el CI y, en local, `docker compose -f compose.test.yml`.
- Los de servicios siguen con dobles en memoria.

### Cola de trabajos y planificador

**Un trabajo** (`jobs`) es una unidad que hoy corre el tick, un handler o un worker:

| Campo | Qué guarda |
|---|---|
| tipo | el tipo de trabajo |
| repo | el repo al que pertenece |
| recursos | los que toma (`issue-N`, `pr-N`, `changelog`…) |
| tipo de cupo | el cupo por tipo que ocupa (`all`, `external-review`…) |
| estado | `queued`, `running`, `done` o `failed` |
| lease | quién lo tiene y hasta cuándo |
| intentos | cuántas veces se intentó |
| cuándo | cuándo se creó y cuándo se ejecuta (para lo diferido) |

- **El planificador crea trabajos.**
  - Los webhooks, con el mismo `scopeForEvent` de hoy.
  - La conciliación periódica: lo que hoy hace el tick, a la misma frecuencia, configurable en Ajustes.
  - Las acciones del tablero y del portal.
  - Un trabajo idéntico a uno en cola no se duplica.
- **Tomar un trabajo** es una transacción con `FOR UPDATE SKIP LOCKED` sobre el próximo trabajo cuyos recursos estén libres y cuyo cupo (por repo y por tipo) tenga lugar. Así se reemplazan `withSlots`, `withResourceLock` y los archivos de `.locks/` y `.ronin-slots/`.
- **Lease y heartbeat.** Quien ejecuta renueva el lease cada 30 s. Si el proceso muere, el lease vence y el trabajo vuelve a la cola. No hace falta mirar pids, y funciona igual cuando el ejecutor está en otra máquina.
- **Reintentos:** con un tope y espera creciente. El límite de uso de Claude no es un fallo: el trabajo vuelve a la cola para cuando la cuota se reinicie, como hoy hace el tick.
- **El runner local** es un loop dentro de ronin: toma trabajos hasta llenar sus turnos y corre cada uno en un proceso hijo, como hoy `launchWorker`, para que un trabajo que se cuelga no frene al resto.
- **El tablero** lee la cola, los turnos y lo que corre de la base, en una consulta.

Lo que **desaparece**:
- el cron, `flock` y `.tick.pending`;
- los handlers por evento como proceso propio;
- los locks con pid.

**Por pasos,** cada uno desplegable:

| Paso | Qué | Reemplaza |
|---|---|---|
| 3.1 | Tabla `jobs`, el planificador y el runner local en el servidor: el tick y los handlers son trabajos, con lease renovado por su propio proceso | el cron, `flock`, `.tick.pending`, lanzar handlers directo |
| 3.2 | Locks de recursos y cupos en la base, con lease | `.locks/` y `.ronin-slots/` con pid |
| 3.3 | Estado local en tablas (claims, comentarios procesados, firmas de fallas, bloqueos…) | `.ronin-state.*.json` |
| 3.4 | Índice de corridas | recorrer `logs/runs/` |
| 3.5 | Cuota de las cuentas de Claude | `logs/usage/` |

**Hecho (3.1):** `apps/api/jobs/store.ts`, `apps/api/jobs/runner.ts`, `apps/api/jobs/scheduler.ts`, `apps/api/jobs/child.ts` (DESIGN §14). Por ahora sin reintentos: un trabajo cuyo lease vence queda `lost` y el próximo tick concilia, como antes.

**Hecho (3.2):** `platform/locks/locks-db.ts`: tablas `locks` y `lock_waits`. `locks.ts` conserva su interfaz (`withResourceLock`, `pinResources`, `withSlots`) y elige la base o los archivos según `DATABASE_URL`. Los locks de los workers (preview, portal, reuniones) y el del estado local siguen en archivos: son de esta máquina y el paso 3.3 rediseña el segundo.

**Hecho (3.3):** `platform/state/local-state-db.ts`: tabla `repo_state`, una fila por entrada (repo, tipo, clave y su valor), en vez de una tabla por cosa: son diez listas chicas que se leen juntas y ninguna se consulta por sus columnas. `local-state.ts` conserva su interfaz y una escritura toca solo las entradas que cambiaron. Su lock pasa a la tabla `locks` (uno por repo, con lease) y no a una transacción, porque abarca llamadas a GitHub (el claim de un issue).

**Hecho (3.4):** `platform/agents/runs-store.ts`: tabla `runs`, una fila por corrida que `RunRecord` escribe al empezar y al terminar; la transcripción sigue en su archivo. `listRuns` lee la base y solo abre el archivo de una corrida en curso (sus pasos, y si su proceso sigue vivo; el de otra máquina no se puede saber y cuenta como en curso). Si el archivo dice que terminó y la base no (la base no respondía), la pone al día. Las filas no se podan con los archivos (14 días): la vista de suscripción, que mira 63 días, ve la historia completa.

**Hecho (3.5):** el uso de las cuentas de Claude (`platform/claude/claude-usage.ts`): tablas `claude_usage` (la última medición de cada cuenta, como documento) y `claude_usage_history` (todas). Las escribe el proceso de la corrida que recibe el `rate_limit_event`, sin hacerla esperar ni fallar. El límite alcanzado se marca en una sola sentencia sobre la última medición. Con esto la etapa 3 queda completa.

El claim entre supervisores por label (DESIGN §9) deja de hacer falta con un solo nodo central que reparte el trabajo. Se mantiene mientras haya instalaciones viejas y después se simplifica.

### `Host`: dónde se ejecuta

**Una interfaz para todo lo que hoy se hace directo en la máquina:**
- **git:** clonar, fetch, crear y borrar worktrees, commit y push, incluida la rama de evidencias;
- **ejecutar un comando** en un directorio, con su salida y un tope de tiempo;
- **archivos:** leer, escribir, copiar las capturas de una corrida;
- **`docker compose`** de las apps de prueba;
- **el MCP del navegador** y el `claude -p` de una tarea: su directorio de trabajo y las herramientas que recibe.

La única implementación es `LocalHost`. El código de dominio no vuelve a llamar a `execFile` ni a `fs` sobre el código del producto: lo hace a través de `Host`. Es lo que permite, más adelante, ejecutar en otra máquina (ver «Proyección») sin tocar los flujos.

**Hecho (4, comandos y procesos):** `platform/host/host.ts`, con `host()` y su única implementación, `localHost`:
- `exec` y `execBuffer`: un comando hasta el final (git, `docker compose`, `tailscale serve`);
- `runLogged` y `startLogged`: los pasos de una app de prueba, con su salida al log, y los dev servers en su grupo de procesos, que `stopGroup` detiene;
- `alive`, `freePort` y `browserMcp`: el MCP de Playwright que recibe `claude -p`.

Los ~70 `execFile` de los dominios y de `platform/git` pasan por ahí. No pasan por `Host` los procesos propios de ronin, que corren siempre en el central: `claude -p`, sus workers y `gh`. `test/structure.test.ts` falla si otro archivo importa `node:child_process`.

**Hecho (4, archivos):** `host().fs`, con lo que los dominios usan de `node:fs/promises` (`readFile`, `writeFile`, `appendFile`, `mkdir`, `rm`, `readdir`), más `exists` y `mkdtemp`; no tiene llamadas síncronas. Pasa por ahí todo lo que está en el checkout del producto o bajo el `worktreeBasePath` del repo activo: crear y barrer worktrees, el `.env` de cada uno, el manifiesto de la app y el estado de una app de prueba, la memoria de exploración y sus fichas, las previews, y lo que una tarea le prepara al agente o le deja escrito (el `mcp.json`, el archivo de agentes de la review, el resultado, las capturas). Son unas 160 llamadas: explorations 50, previews 25, commands 19, product-app 16, `platform/git` 15, portal 13, meetings 8, slices 6, review 4, `platform/agents` 4, deploys 2, items 1.

Siguen en `node:fs` los datos de ronin, que viven en el central: `config.*.dataDir` (portal, reuniones, catálogos de seeds), los logs y los registros de corridas, los ajustes, `.ronin-state.json`, las reservas de puertos de las previews, los criterios de review del propio repo de ronin y la salida de prueba (`dryRun`) de la review. Cuando un archivo cruza, se lee del host y se escribe en el central: las capturas que el portal guarda en el pedido.

Quedan fuera, a propósito:
- el Playwright que corre dentro del proceso de ronin (el login de los usuarios, las capturas de humo, `renderHtmlToPng`): escribe con su propio `fs`, y moverlo es mover el navegador al host;
- los candados en archivo bajo el `worktreeBasePath` (`.locks/`, `worktree-lock.ts`): coordinan a ronin, no son código del producto;
- las capturas de un pedido del portal, que `publishEvidence` le pasa a git en el host y el prompt del portal le pasa al agente: están en los datos del central. Con un solo nodo es la misma máquina; un runner remoto necesita copiarlas antes.

### API

- **Hono** como router, con `@hono/zod-validator` para validar cada entrada.
- **Capas:** rutas → servicios (los módulos de dominio actuales: `portal/`, `deploy/`, `meetings/`…) → repositorios. Una ruta no lee archivos ni la base: llama a un servicio.
- **Errores comunes:** un error de dominio (por ejemplo, `RequestError`) es un 400 con su mensaje. Lo demás es un 500 con un id que también queda en el log.
- **Contratos:** los tipos de cada endpoint se exportan desde el servidor y el frontend los importa (el cliente de Hono, o tipos compartidos). Un cambio en la API rompe el build del frontend, no la página.
- **No cambia:** los dos listeners (público y tailnet), la autenticación del tablero con GitHub, la sesión del portal, las cabeceras de seguridad y `X-Portal-Version`.
- **Migración:** por grupo de rutas (portal, pedidos, despliegues, métricas, ajustes, ítems). Hono se monta en el servidor actual, y las rutas viejas siguen respondiendo hasta que cada grupo pasa.
- **Carpetas por dominio:** las rutas de un dominio viven con él, junto a su servicio y su repositorio: `domains/portal/routes.ts`, `domains/deploys/routes.ts`… Lo que comparten todas (el cuerpo JSON con su tope, la validación con zod, los errores) está en `platform/http/middleware.ts`, y `apps/api/routes.ts` monta cada dominio.

**Hecho (6, portal):** la API del portal (`/api/portal/*`) en Hono: `domains/portal/routes.ts` y `domains/portal/routes-requests.ts`, montadas por `apps/api/http/portal.ts` con `@hono/node-server` sin tocar los `Request`/`Response` globales. Respondía y sigue respondiendo lo mismo: las pruebas HTTP de antes pasan sin cambios. `PortalApi` es el tipo que va a usar el cliente de la etapa 7.

**Hecho (6, tablero: el portal):** el tablero pasa a Hono de a un grupo. `apps/api/routes.ts` monta los que ya pasaron y `handleDashboard` le entrega sus paths, con la sesión y el acceso que ya revisó `tailnet.ts` en `c.env`. Lo responde `answer()` (`apps/api/http/hono.ts`), que escribe con `writeHead` y `end` como el resto del tablero. Primer grupo: el portal visto desde el tablero, `/api/requests/*` y `/api/portal-admin/*`, en `domains/portal/routes-dashboard.ts`. Lo que ve cada sesión sale de `domains/access/visible.ts`. Segundo grupo: las reuniones (`/api/meetings/*`, `domains/meetings/routes.ts`); el permiso de cada cambio (`refusal`) también sale de `access/visible.ts`. Tercero: los despliegues (`/api/deploys/*`, `domains/deploys/routes.ts`); un error de dominio puede sumar datos a su respuesta (`details`: el plan nuevo de un release). Cuarto: las métricas (`/api/metrics/*`, `domains/metrics/routes.ts`), con la consulta validada con zod. Quinto: las exploraciones (`/api/explorations/*`, `domains/explorations/routes.ts`). Sexto: Ajustes (`/api/settings/*`, `domains/settings/routes.ts`), cada sección con su permiso. Séptimo: las corridas y sus capturas (`/api/runs/*`, `/api/evidence/*`, `domains/runs/routes.ts`); la transcripción en vivo es un `streamSSE` de Hono, y `answer()` escribe una respuesta `text/event-stream` a medida que llega y la corta cuando la persona se va. Octavo y último: el snapshot, Hoy y los ítems (`/api/snapshot`, `/api/today`, `/api/items/*`, `/api/repos/*/issues`), en `domains/items/routes.ts`. Lo que leen pasa a `domains/items/service.ts` y recibe el acceso de la sesión como argumento, en vez del `AsyncLocalStorage` de antes. Con esto **todo el tablero responde desde Hono**: `apps/api/http/dashboard.ts` solo le entrega cada pedido a `apps/api/routes.ts`. Los servicios de cada grupo viven hoy con sus rutas, en `domains/<dominio>/`. `DashboardApi` es el tipo para el cliente del tablero en la etapa 7.

### Frontend

- **Vite, TypeScript y React,** con TanStack Query para la caché y el polling, que el tablero y el portal usan en todos lados.
- **Primero el portal,** que es chico y aislado: sirve de piloto del build, del despliegue y de los tests de componentes.
- **Después el tablero, página por página:** cada página nueva en React se monta dentro del marco que dibuja `app.js`, hasta que `app.js` queda vacío.
- **Las carpetas de cada app web** (`src/apps/portal/`, `src/apps/dashboard/`): `src/pages/` (una página por archivo, o una carpeta cuando tiene varios: `pages/deploys/`), `src/components/` (lo que usan varias páginas), `src/lib/` (lo que no dibuja: textos, fechas, imágenes) y, en la raíz de `src/`, la entrada, el cliente de la API y lo que la app comparte (`main.tsx`, `api.ts`).
- **El build sale en `dist/public/dashboard` y `dist/public/portal`,** servido por ronin como hoy, con nombres versionados por hash.

**Hecho (7, portal):** la página del portal en React (`src/apps/portal/src/`), con Vite y TanStack Query, sobre el cliente `hc<PortalApi>`: los tipos de cada respuesta salen de las rutas, y `pnpm typecheck` revisa también la página. Se ve y se comporta igual que la de antes: las 16 pantallas (escritorio y teléfono) dieron idénticas píxel a píxel con los mismos datos, y un recorrido de 40 pasos (entrar, pedir, responder, la entrevista, el resumen, el prototipo, cancelar, el historial, el tema, salir) dejó lo mismo en las dos. El CSS, `theme.js` y el ícono quedan en `public/`, tal cual. Pruebas de componentes con jsdom y Testing Library.

**Hecho (7, tablero: Despliegues):** el tablero pasa a React por páginas. `src/apps/dashboard/` se arma con Vite en un solo `dist/public/dashboard/pages.js`, que `index.html` carga antes que `app.js`; `app.js` sigue dibujando el marco (la barra lateral, la barra de estado, las rutas) y monta cada página ya pasada donde va (`showPage`, `window.roninPages.mount`), con lo que la página le pide al marco (`Host`: el aviso, abrir un pedido, volver a entrar, el color del repo, lo que la barra lateral muestra de ella). `setCenter` la desmonta cuando el centro muestra otra cosa. Cada página lee la API con `hc<DashboardApi>` y TanStack Query, y se refresca sola. Primera: Despliegues, con su diálogo; se vio igual píxel a píxel que la de antes en escritorio y teléfono, y el mismo recorrido (el plan mientras se escribe el tag, el conflicto, las notas, publicar) mandó el mismo cuerpo. Siguen las demás páginas, de la más aislada a la ficha de un ítem.

**Hecho (7, tablero: Métricas):** las dos pestañas, Trabajo y Suscripción, son las páginas `metrics` y `subscription` (`pages/metrics/`); `app.js` solo decide cuál montar según la dirección (`/metricas`, `/metricas/suscripcion`). Lo que la página le pide al marco va por `Host`: abrir un ítem, abrir Ajustes, cambiar de pestaña, los repos y el nombre de cada tipo de tarea. El filtro, el orden y la fila abierta se guardan mientras la persona está en otra página, como antes en `S.mt`. Comparada con la de antes con los mismos datos inventados (calculados por `domains/metrics`) y el reloj fijo, en escritorio y en el teléfono: idénticas, salvo el suavizado de algunos bordes (8/255 como mucho).

### Docker

**Una sola imagen,** `ronin`, con:
- Node;
- el CLI de Claude;
- git y `gh`;
- los navegadores de Playwright;
- el cliente de Docker y el plugin de compose.

El compose de una instalación:

| Servicio | Qué es |
|---|---|
| `ronin` | La app: API, planificador y runner local |
| `postgres` | La base, con su volumen |
| `tailscale` | Publica el tablero en la tailnet (sidecar, con su estado en un volumen) |
| `docker` | Un Docker propio (Docker-in-Docker) donde corren las previews, los prototipos y las reproducciones. ronin le habla por TCP con TLS; el socket del host no se monta |

**Volúmenes:**

| Volumen | Qué guarda |
|---|---|
| `ronin-files` | archivos |
| `ronin-repos` | clones y worktrees |
| `ronin-claude` | una carpeta por cuenta de Claude |
| `postgres-data` | la base |
| `tailscale-state` | el estado de Tailscale |
| `docker-data` | imágenes y volúmenes del Docker propio |

**Los worktrees** viven en `ronin-repos`, montado también en el servicio `docker` en la misma ruta. Los bind mounts de un `docker compose` lanzado desde ronin apuntan a la misma ruta dentro del Docker propio.

**El portal público** sigue detrás del proxy que ya existe; el compose solo publica el puerto del listener público.

**`ronin init`** es un asistente de una vez:
1. arma el `.env` (secretos generados, la URL del portal, la cuenta de GitHub de ronin);
2. crea el primer admin;
3. registra los repos;
4. pide un `claude login` por cuenta dentro del volumen.

**Instalar** es clonar, `ronin init` y `docker compose up -d`.

**Respaldos:**
- **Postgres:** un `pg_dump` diario desde el propio compose.
- **El volumen `ronin-files`:** una instantánea con restic.
- **Destino:** el que diga el `.env` (S3 compatible o SFTP).
- **Retención:** 7 diarios y 4 semanales.
- `ronin-repos` y `docker-data` no se respaldan: se reconstruyen solos.

**Recuperar en otra máquina:**
1. clonar;
2. `ronin restore <respaldo>`: trae la base y los archivos;
3. `docker compose up -d`;
4. un `claude login` por cuenta.

Los trabajos que estaban corriendo vuelven a la cola cuando vencen sus leases. La guía queda en el sitio de documentación y se prueba una vez por etapa.

**Hecho (5):** la imagen (`Dockerfile`), el compose (`compose.yml`), `ronin init` y los respaldos. La guía, en el sitio: [Instalar con Docker](https://oskr814.github.io/ronin/operar/docker/) y [Respaldar y recuperar](https://oskr814.github.io/ronin/operar/respaldos/).
- **La imagen** se construye en tres pasos (el build con pnpm, las dependencias de producción, la final) y corre `node dist/apps/api/main.js` detrás de `docker/entrypoint.sh`, que configura git y `gh` con el token de ronin, clona los repos de `repos.json` que falten y publica el tablero. Trae Node 24 y pnpm, git, `gh`, Claude Code, el cliente de Docker con compose y buildx, el CLI de Tailscale (sin el daemon) y el Chromium de Playwright. Corre como root, con `IS_SANDBOX=1` para que Claude Code acepte `bypassPermissions`: el contenedor es el sandbox.
- **La red:** `ronin` y `docker` usan la red del servicio `tailscale` (`network_mode: service:tailscale`). Para los tres, `127.0.0.1` es el mismo: el tablero sigue escuchando solo ahí; los puertos que publica el Docker propio para una preview (siempre en `127.0.0.1`, `domains/product-app/runtime.ts`) los alcanzan ronin, el navegador de los agentes y Tailscale; y `tailscale serve`, por el socket del sidecar en un volumen compartido, publica el tablero y las previews como antes. Así el código de las previews no cambia. Tailscale corre en modo userspace: sin `/dev/net/tun` ni `NET_ADMIN`.
- **El Docker propio** es `docker:dind` con TLS: ronin le habla en `tcp://localhost:2376` con los certificados de cliente que el servicio genera al arrancar, en un volumen de solo lectura para ronin. `ronin-repos` se monta en `/repos` en los dos, y cada repo se clona en `/repos/<owner>/<nombre>/repo`, con sus worktrees al lado: dos repos nunca comparten la carpeta de worktrees.
- **Volúmenes:** los de la tabla de arriba, más `tailscale-socket` (el socket del sidecar, compartido con ronin) y los certificados del Docker propio. Las rutas de datos las fija `compose.yml` en `/data` (el volumen `ronin-files`) y pisan las del `.env`.
- **`ronin init`** (`src/apps/cli/init.ts`, con su parte pura en `env-file.ts`) arma el `.env` a partir de `.env.example` y del `.env` que haya, pide lo que falta, genera los secretos, suma los repos a `repos.json` (en el volumen de datos) y migra la base. El primer administrador va en `DASHBOARD_ADMINS`. `scripts/init.sh` lo corre en el servicio `init` del compose (perfil `tools`), que monta el checkout en `/install`. `repos.json` sigue siendo un archivo; pasarlo a la base queda para después.
- **Respaldos:** `scripts/backup.sh` deja `<destino>/<día>/` con el `pg_dump` (formato custom), un `tar` del volumen de datos, el `.env` y un manifiesto, y aplica la retención (7 diarios y 4 semanales). `scripts/restore.sh` los trae de vuelta. **Sin restic por ahora:** un `tar` y un `pg_dump` se restauran con lo que trae cualquier máquina con Docker, sin otra herramienta ni credenciales de un destino remoto. Copiar los respaldos fuera de la máquina, y programarlos con el cron del host, queda a cargo de quien opera; restic con un destino del `.env` es el paso siguiente si hace falta.

**Lo que falta de la etapa 5:**
- **Mover la instalación actual a compose.** Lo hace una persona, en una ventana anunciada, con los pasos de [Pasar una instalación a mano a Docker](https://oskr814.github.io/ronin/operar/docker/#pasar-una-instalación-a-mano-a-docker): preparar el `.env` (más `TS_AUTHKEY` y `TS_HOSTNAME`); cambiar la URL del tablero y el callback de la OAuth App al nodo nuevo; aplicarle al tag del nodo la política de `PREVIEW_PORT_RANGE`; esperar la cola quieta y bajar las previews; frenar el servicio de systemd; armar un respaldo con el formato de `backup.sh` (el `pg_dump` del Postgres de `compose.postgres.yml` y las carpetas de datos, con las rutas de `repos.json` pasadas a `/repos/…` y `/claude/…`); restaurarlo; `docker compose up -d`; y un `claude login` por cuenta. Volver atrás es `docker compose down` y `pnpm server:setup`.
- **Probarlo en real:** la imagen se construye y el compose valida, pero todavía nadie lo levantó con una tailnet, una preview y un agente de verdad.
- **Un despliegue corta lo que corre.** Con systemd, `KillMode=process` dejaba terminar a los handlers y sus agentes; recrear el contenedor los corta, y sus trabajos quedan `lost` hasta el tick siguiente.
- **Las herramientas de los productos:** los agentes corren las pruebas de cada repo dentro del contenedor `ronin`, que trae Node y pnpm. Un producto que necesite otra cosa en la máquina (otro lenguaje, un binario) no la tiene.
- **El destino remoto de los respaldos** y su programación desde el propio compose, en vez del cron del host.

### Rendimiento

> **Hecho** (etapa 1): ver [`DESIGN.md` §21](DESIGN.md#21-tiempos-235-etapa-1).

Antes de optimizar nada, se mide (etapa 1):
- **Cada request** de la API del tablero y del portal: cabecera `Server-Timing` (lectura de datos, GitHub, armado) y una línea de log para los que pasan de 500 ms.
- **Cada paso del tick:** su duración en el log, junto al `tick_complete` que ya existe.

Con esa línea base, cada etapa dice si mejoró o empeoró. Candidatos que ya se ven en el código, para confirmar con la medición:
- **Pedidos del portal:** se leen abriendo un archivo por pedido en cada consulta del tablero y del portal.
- **El resumen del tablero:** recorre los directorios de corridas.
- **El portal:** consulta cada 2 s mientras ronin trabaja.

La base de datos resuelve los dos primeros.

## Decisiones

| Tema | Decisión | Por qué |
|---|---|---|
| Base | Postgres | Varias conexiones y procesos escribiendo, colas con `SKIP LOCKED`, respaldos estándar. Abre la puerta a un nodo central con runners. |
| Acceso a datos | Kysely sobre `pg`, migraciones versionadas | Consultas tipadas y visibles; sin ORM. |
| Cola | Tablas propias (`jobs`, `resource_locks`, `slots`) con `FOR UPDATE SKIP LOCKED` | Necesita recursos exclusivos por issue o PR y cupos por repo y por tipo, que una librería como pg-boss no modela; y el tablero la tiene que leer tal cual. |
| Router | Hono, con zod | Liviano, sobre Request/Response estándar, rutas tipadas y un cliente con los mismos tipos para el frontend (`hc<typeof app>`), sin generar código. Se evaluó NestJS, que el equipo conoce: da estructura (módulos, guards, pipes) pero suma mucha dependencia y ceremonia para unas 40 rutas, pide decoradores y es incómodo con el ESM de ronin, y su contrato con el frontend pasa por OpenAPI y un generador. Lo que se toma de su enfoque: middlewares para sesión, validación, errores y tiempos, y servicios separados de las rutas. |
| Frontend | Vite, TypeScript, React, TanStack Query | El equipo ya usa React en los productos; el polling y la caché son el patrón dominante. |
| Contenedores | Una imagen, Compose, Docker-in-Docker para las apps de prueba | Instalar y recuperar con pocos pasos; aislar las apps de prueba del host. |
| Respaldos | `pg_dump` diario y un `tar` del volumen de archivos, a una carpeta del `.env`; 7 diarios y 4 semanales. restic más adelante, si hace falta un destino remoto | Lo único que no se reconstruye solo es la base y los archivos. Un `tar` se restaura en cualquier máquina con Docker, sin otra herramienta. |

## Proyección: runners y ejecución distribuida

Fuera de #235, que deja todo preparado:

- **ronin es el nodo central** y el único con Claude: las cuentas y la suscripción viven solo ahí.
- **ronin también es un runner, el local.** Una instalación de una sola máquina sigue funcionando sola.
- **Runners en otras máquinas suman capacidad** o le sacan carga al central.
  - Se conectan por SSH, de preferencia Tailscale SSH con ACLs por tag.
  - No guardan estado ni tienen credenciales de Claude.
  - Son la misma imagen con el rol `runner`: sshd y `ronin-runner`.
- **Cómo usa un runner el agente:**
  - `claude -p` corre en el central, con las herramientas propias de Claude Code apagadas.
  - Recibe un servidor MCP del runner por stdio sobre SSH (`ssh runner ronin-runner tools --workspace …`), con leer, editar, buscar y ejecutar en el worktree del runner.
  - El MCP del navegador va por el mismo camino.
- **El trabajo sin agente** (worktrees, previews, tests, evidencias) es un `SshHost` que implementa la misma interfaz `Host`.
- **Cada trabajo sabe en qué host corre sin que nadie lo cambie a mitad de camino:**
  - un worker recibe su runner al arrancar, en el entorno, y `host()` lo resuelve una vez para todo el proceso;
  - el servidor y el tick, que atienden varias cosas a la vez, lo fijan por llamada con un `AsyncLocalStorage`, como `activeRepo()` con el repo;
  - por eso `host()` es una función y no hay un `setHost` global, que haría que dos peticiones se pisaran.
- **El planificador reparte** según capacidades (repos, Docker, navegadores), turnos y carga.
- **El runner local tiene una preferencia configurable:** usarlo como a cualquiera, solo si los demás están ocupados, o nunca.
- **Antes de construirlo, un spike:**
  - comparar con `fix-replay` la calidad, el tiempo y el costo de las herramientas MCP contra las propias de Claude Code;
  - resolver cómo recibe el agente el `CLAUDE.md` del repo cuando el worktree es remoto.

**Lo que #235 respeta para no cerrarle la puerta:**
- nada del dominio supone que el código, los procesos o los archivos están en la misma máquina: todo pasa por `Host`;
- los trabajos son leases que cualquier ejecutor puede tomar y devolver;
- el runner local es un runner más del registro, no un caso especial.

## Etapas

Las de [#235](https://github.com/Oskr814/ronin/issues/235). Cada una deja ronin funcionando:

| # | Etapa | Depende de |
|---|---|---|
| 0 | Este documento | — |
| 1 | Medir | — |
| 2 | Postgres y repositorios, un módulo por vez | — |
| 3 | Cola de trabajos, planificador y runner local | 2 |
| 4 | `Host` con `LocalHost` | — (puede ir en paralelo con 2 y 3) |
| 5 | Docker, `ronin init`, respaldos y recuperación | 3 y 4 |
| 6 | API con contratos (Hono) | 2 |
| 7 | Frontend (Vite, React): portal y después el tablero | 6 |

**Mientras dura la migración:** ronin sigue corriendo en la máquina de siempre con su despliegue actual (`pnpm build` y reinicio). Recién en la etapa 5 pasa a Compose, con una ventana corta y anunciada: la imagen, el compose y los respaldos ya están; falta el paso de la instalación (ver «Docker»).

## Riesgos

- **Una migración de datos a medias.** Cada módulo se importa con un script idempotente, se compara contra los archivos y los archivos se conservan hasta la etapa siguiente.
- **El planificador dentro del servidor:** un fallo en un flujo no puede tirar la API. Los trabajos corren en procesos hijos y el planificador captura y anota sus errores, como hoy el tick.
- **Docker-in-Docker:** cuesta algo de rendimiento y disco. Si una app de prueba no anda adentro, la alternativa es Sysbox, o el socket del host como excepción documentada.
- **Credenciales de Claude en un volumen:** el volumen `ronin-claude` es tan sensible como el `.env`. Ni se respalda en claro ni se comparte entre instalaciones: cada una hace su `claude login`.
