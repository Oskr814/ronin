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
- **Tablero:** un solo `src/web/app.js` de unas 6.400 líneas, JS plano sin build, con estado global y HTML armado como texto. El portal (`src/portal-web/`) sigue el mismo patrón.

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
| Estado local | `processed_comments`, `failure_signatures`, `checks_pending`, `reviewed_shas`, `blocks`… (una tabla por cosa, no un JSON) |
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
- **Migraciones versionadas** en `src/db/migrations/`, que corren al arrancar.
- **Un repositorio por módulo** (`portal/store.ts`, `deploy/store.ts`…) con la misma interfaz que hoy exponen los módulos. Los servicios no cambian de forma.

**Hecho:** la base (`src/db/`: Kysely, migraciones en `src/db/migrations/` que el servidor corre al arrancar, `compose.postgres.yml`, `compose.test.yml` y un Postgres en el CI) y los módulos **Ajustes** (`core/settings-store.ts`) **Despliegues** (`deploy/store.ts`) **Portal** (`portal/accounts.ts`, `portal/requests.ts`: `portal_users` y `portal_requests`, con cada pedido como un documento en vez de `request_messages` y `request_events`) y **Reuniones** (`meetings/meetings.ts`; cada una como un documento `jsonb`, en vez de `meeting_items`, porque se lee y se escribe entera). Mientras dura la etapa, `DATABASE_URL` la activa y sin ella todo sigue en archivos: cada módulo se despliega primero y se pasa después con su `pnpm db:import-<módulo>`. `config.ts` lee Ajustes con `await` al cargar, así que cada proceso abre su pool (chico, que no impide que el proceso termine).

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

El claim entre supervisores por label (DESIGN §9) deja de hacer falta con un solo nodo central que reparte el trabajo. Se mantiene mientras haya instalaciones viejas y después se simplifica.

### `Host`: dónde se ejecuta

**Una interfaz para todo lo que hoy se hace directo en la máquina:**
- **git:** clonar, fetch, crear y borrar worktrees, commit y push, incluida la rama de evidencias;
- **ejecutar un comando** en un directorio, con su salida y un tope de tiempo;
- **archivos:** leer, escribir, copiar las capturas de una corrida;
- **`docker compose`** de las apps de prueba;
- **el MCP del navegador** y el `claude -p` de una tarea: su directorio de trabajo y las herramientas que recibe.

La única implementación es `LocalHost`. El código de dominio no vuelve a llamar a `execFile` ni a `fs` sobre el código del producto: lo hace a través de `Host`. Es lo que permite, más adelante, ejecutar en otra máquina (ver «Proyección») sin tocar los flujos.

### API

- **Hono** como router, con `@hono/zod-validator` para validar cada entrada.
- **Capas:** rutas → servicios (los módulos de dominio actuales: `portal/`, `deploy/`, `meetings/`…) → repositorios. Una ruta no lee archivos ni la base: llama a un servicio.
- **Errores comunes:** un error de dominio (por ejemplo, `RequestError`) es un 400 con su mensaje. Lo demás es un 500 con un id que también queda en el log.
- **Contratos:** los tipos de cada endpoint se exportan desde el servidor y el frontend los importa (el cliente de Hono, o tipos compartidos). Un cambio en la API rompe el build del frontend, no la página.
- **No cambia:** los dos listeners (público y tailnet), la autenticación del tablero con GitHub, la sesión del portal, las cabeceras de seguridad y `X-Portal-Version`.
- **Migración:** por grupo de rutas (portal, pedidos, despliegues, métricas, ajustes, ítems). Hono se monta en el servidor actual, y las rutas viejas siguen respondiendo hasta que cada grupo pasa.

### Frontend

- **Vite, TypeScript y React,** con TanStack Query para la caché y el polling, que el tablero y el portal usan en todos lados.
- **Primero el portal,** que es chico y aislado: sirve de piloto del build, del despliegue y de los tests de componentes.
- **Después el tablero, sección por sección:** cada sección nueva se monta como una isla de React dentro de la página actual, hasta que `app.js` queda vacío.
- **El build sale en `dist/web` y `dist/portal-web`,** servido por ronin como hoy, con nombres versionados por hash.

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
| Respaldos | `pg_dump` diario y restic del volumen de archivos, a un destino del `.env`; 7 diarios y 4 semanales | Lo único que no se reconstruye solo es la base y los archivos. |

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

**Mientras dura la migración:** ronin sigue corriendo en la máquina de siempre con su despliegue actual (`pnpm build` y reinicio). Recién en la etapa 5 pasa a Compose, con una ventana corta y anunciada.

## Riesgos

- **Una migración de datos a medias.** Cada módulo se importa con un script idempotente, se compara contra los archivos y los archivos se conservan hasta la etapa siguiente.
- **El planificador dentro del servidor:** un fallo en un flujo no puede tirar la API. Los trabajos corren en procesos hijos y el planificador captura y anota sus errores, como hoy el tick.
- **Docker-in-Docker:** cuesta algo de rendimiento y disco. Si una app de prueba no anda adentro, la alternativa es Sysbox, o el socket del host como excepción documentada.
- **Credenciales de Claude en un volumen:** el volumen `ronin-claude` es tan sensible como el `.env`. Ni se respalda en claro ni se comparte entre instalaciones: cada una hace su `claude login`.
