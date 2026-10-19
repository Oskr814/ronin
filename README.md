# ronin

> *Del japonés 浪人 (rōnin): samurai sin señor, que actúa por su propio juicio.*

Orquestación de agentes autónomos (Claude Code) para desarrollo dirigido por specs. Le asignás un spec o un issue en GitHub y ronin lo trocea en PRs chicos y apilados, corre los tests, pide review, responde a los comentarios y escala a un humano solo cuando se bloquea de verdad.

📖 **Documentación completa en la [wiki](https://github.com/Oskr814/ronin/wiki).**

## Comandos

Todo se pide desde GitHub, mencionando a [`@ronin-agent`](https://github.com/ronin-agent) en un comentario. Apenas recibe un comentario que lo menciona, le pone 👀.

| Dónde | Comando | Qué hace |
|---|---|---|
| PR de ronin | `@ronin-agent <pedido>` | Si el pedido es concreto, lo aplica (amend + force-push). Si no, responde por qué. |
| Hilo de review de un PR de un humano (no fork) | `@ronin-agent <pedido>` en cualquier comentario del hilo | Lee el hilo completo y el código al que apunta. Si el pedido es concreto lo aplica (amend + force-push); si es una pregunta, la responde. Contesta en el mismo hilo y no lo resuelve. |
| PR de un humano (comentario general, o fork) | `@ronin-agent <pedido>` | Corre una review de solo lectura, enfocada en tu pedido. |
| Cualquier PR (no fork) | `@ronin-agent /preview [app] [qué datos querés]` | Levanta la app con el código del PR, su base y sus seeds; prepara los datos que piden los pasos de prueba del PR (más lo que agregues después del comando), y responde con una URL de la tailnet y los usuarios de prueba. Con cada commit nuevo del PR se actualiza sola, en el lugar cuando el `ronin.app.json` declara `rerunOn`. Se baja sola a la hora (`PREVIEW_TTL_MINUTES`) o al mergear o cerrar el PR; `/preview stop` la baja antes. Ver [`docs/DESIGN.md` §12](docs/DESIGN.md). |
| Cualquier PR | `@ronin-agent /auto-merge [off]` | Le pone el label `ronin:auto-merge` (también se puede poner a mano) y mergea el PR apenas esté aprobado y con los checks en verde, como el auto-merge de GitHub. `/auto-merge off` o sacar el label lo cancela. Se desactiva solo si hay conflictos o el merge falla. Los PRs de slice que abre ronin ya salen con el label (se apaga por repo con `"autoMerge": false` en `repos.json`, o desde *Ajustes → Repos*). Ver [`docs/DESIGN.md` §13](docs/DESIGN.md). |
| Cualquier PR (no fork) | `@ronin-agent /resolve-conflicts` | Trae la base al PR con un merge, como "Update branch" de GitHub: no reescribe la historia ni hace force-push. Resuelve los conflictos manteniendo lo que cambian los dos lados, corre las verificaciones del repo, sube el merge y cuenta cómo quedó cada archivo. Si un conflicto necesita una decisión del equipo, o alguien subió commits mientras tanto, no sube nada y lo explica. |
| Cualquier PR (no fork) | `@ronin-agent /fix-comments` | Aplica en un solo pase los hilos de review abiertos, responde en cada uno y resuelve los que cambió. Para excluir un hilo, resolvelo antes. |
| Issue sin asignar | `@ronin-agent <pedido>` | Hace lo que pide el comentario, sin abrir un PR: si cambia el alcance, lo reescribe en una sección `## Alcance` (la descripción original queda) y anota el cambio en `## Cambios de alcance`; si pide investigar algo, agrega el contexto; si pide un prototipo, lo hace como `/prototype`; si es una pregunta, la responde. |
| Issue sin asignar | `@ronin-agent /prototype <app> [instrucción]` | Levanta la app, aplica un cambio borrador con lo que pide el issue y deja en el issue las capturas del antes y el después, con el diff. No abre rama ni PR. Ver [`docs/DESIGN.md` §11.11](docs/DESIGN.md). |
| Issue sin asignar | `@ronin-agent /spike <app> [instrucción]` | Investiga en solo lectura y agrega una sección `## Contexto adicional (spike)` al issue. |
| Issue sin asignar | `@ronin-agent /spec <app> [instrucción]` | Convierte el pedido en un spec: investiga, pregunta lo que falte y abre un PR draft con el spec. Al marcarlo *ready for review*, lo implementa. |
| Issue sin asignar | `@ronin-agent /explore <app> [funciones]` | Levanta la app, usa algunas de sus funciones como cada rol en desktop y mobile, y deja las propuestas de mejora en el PR de exploración abierto (o abre uno). |
| PR o issue | `@ronin-agent /help` | Responde con los comandos que se pueden usar ahí. Si escribís mal un comando, te sugiere el correcto. |

**Asignarle trabajo:**
- **Spec:** PR draft con el `.md` en `docs/superpowers/specs/`, asignado a `ronin-agent`. Cuando lo marcás *ready for review*, arranca.
- **Issue:** asignáselo con el picker de Assignees.

Detalle de cada comando: [wiki → Comandos](https://github.com/Oskr814/ronin/wiki/Comandos).

**Exploración y propuestas de mejora** ([`docs/DESIGN.md` §11](docs/DESIGN.md)): con un `ronin.app.json` en el repo del producto, ronin levanta la app, la usa como cada rol y propone mejoras con capturas del antes y del después (en la rama huérfana `ronin/evidence` del repo del producto). Las propuestas van a un PR de exploración (`ronin/exploration/<fecha>`), listo para revisar apenas termina cada corrida; mientras siga abierto, las corridas siguientes se suman a él. Comentando en una ficha (en GitHub, o desde la pestaña *Fichas* del tablero) podés rechazarla, pedir que la corrija (incluso rehacer la captura del después, que reemplaza a la anterior) o pedir un issue aparte. Dentro de un hilo, ronin solo atiende las respuestas que lo mencionan (`@ronin-agent`), y siempre lee lo que ya se habló sobre esa ficha; al aprobar y mergear, abre un issue por cada propuesta que quedó en pie y la próxima corrida abre un PR nuevo. Las apps listadas en `explore` de `repos.json` se exploran solas de noche (`EXPLORE_NIGHT_WINDOW`), o cuando lo pidas con *Explorar ahora* desde su página del tablero.

**Tablero** ([`docs/DESIGN.md` §15](docs/DESIGN.md)): una página que se ve solo por la tailnet y pide entrar con GitHub. Muestra:
- la ficha de cada issue o PR: su descripción, sus comentarios y lo que hicieron los agentes;
- en un PR, sus archivos para revisarlo como en "Files changed": comentarios por línea, sugerencias, "Visto" y la revisión con Comentar, Aprobar o Pedir cambios (la revisión pendiente es la de GitHub);
- en un PR de ronin, su descripción por secciones (qué se pidió, qué cambió, cómo se verificó, sus decisiones propias y lo que dejó fuera) y, en el encabezado, las tres decisiones: *Aprobar y mergear*, *Pedir un ajuste* (con los comentarios de línea, si hay) o *Cerrar*, con los atajos `A`, `P` y `X`; `?` muestra todos los atajos del teclado;
- en *Exploraciones*, cada app que ronin explora: las fichas de su PR para revisarlas (el antes y el después lado a lado, la propuesta y su hilo, para rechazar, pedir cambios o aprobar), sus corridas con el transcript de cada agente, su inventario con lo que ya se exploró, y *Explorar ahora* para lanzar una corrida sin esperar a la noche (por defecto, cuenta como la de esa noche);
- qué agentes están corriendo, con su transcript en vivo;
- los issues de ronin y los que trabajó hace poco, cada uno con sus PRs; buscando, cualquier issue abierto (por título, número, `RED-n` o número de PR), y *Abrir #N* para lo que no está en la lista;
- en *Pedidos del portal*, los pendientes primero (los cerrados, en *Cerrados* o *Todos*) y la ficha de cada pedido, con su issue y su PR en la pestaña *Issue y PR*;
- qué issues esperan a alguien y por qué;
- cómo va cada stack de slices, con sus checks;
- las previews arriba;
- el uso de cada cuenta de Claude;
- en *Hoy*: los totales del día con su semana, lo que necesita tu atención (bloqueados, PRs que esperan review, exploración, previews) y las corridas de las últimas 12 horas;
- en *Despliegues*, para administradores y para quien tenga permiso de desplegar ese repo: lo mergeado sin desplegar de cada repo y sus últimos releases con su workflow. *Nuevo despliegue* publica un release de GitHub con el tag que escribas, con todo o solo con los PRs que elijas (ronin prueba antes que se apliquen limpio), y el workflow del repo hace el resto;
- con una API key de Linear en el repo, el proyecto y el ciclo de cada issue, un filtro por ciclo o proyecto, y en *Hoy* el ciclo actual con su avance. Con la key, el tick además toma primero los issues del ciclo.

Desde la ficha se le pide a ronin lo mismo que comentando en GitHub: resolver conflictos, levantar o bajar la preview, el auto-merge, o responder y destrabar un issue. Al aprobar cualquier PR desde la revisión, otra casilla, marcada por defecto, le activa el auto-merge (`/auto-merge`). El botón **+** de cada repo crea un issue nuevo y, si querés, se lo asigna a ronin o le pide un `/spike` o un `/spec`; con Linear, también elegís su proyecto y su ciclo. El login pide el permiso `repo` de GitHub, y lo que se pide desde el tablero queda comentado a tu nombre, como si lo escribieras en GitHub. Los administradores ven todos los repos; cualquier otra persona ve los repos en los que puede gestionar issues (triage o más) en GitHub, consultado con su propia sesión.

**Ajustes** ([`docs/DESIGN.md` §19](docs/DESIGN.md)): el engranaje del tablero. Cada persona pone su nombre, su correo y quién es en Linear, y elige qué correos de ronin le llegan de cada repo. Los administradores manejan ahí a los usuarios (el equipo, con su rol y lo que puede hacer en cada repo, y las cuentas del portal), los repos (lo que se escribe en `repos.json`) y lo que antes solo se cambiaba en `.env` (agentes, exploración, previews), sin reiniciar; cada cambio queda en un registro. Los secretos, rutas y puertos se siguen cambiando en `.env`, y `DASHBOARD_ADMINS` queda como administradores de respaldo.

**Reuniones** ([`docs/DESIGN.md` §17](docs/DESIGN.md)): en el tablero se suben las notas de una reunión (PDF, Word, texto o pegadas) y ronin propone el trabajo que sale de ellas.
- **ronin las lee** contra los issues abiertos, los proyectos y ciclos de Linear, lo que propusieron otras reuniones y el código. Propone proyectos nuevos de Linear con sus issues, issues y comentarios en issues que ya existen. Cada propuesta cita las líneas de las notas que la justifican, y lo que descarta lleva su motivo.
- **Nada se crea hasta que alguien lo apruebe** en la ficha de la reunión, donde puede marcar, desmarcar y editar cada propuesta. Los issues y los comentarios se crean en GitHub a nombre de quien aprueba, y los proyectos en Linear con la key del repo.
- **Correo:** el equipo del repo recibe uno cuando hay algo que revisar. Las notas quedan en el runner, nunca en GitHub.

**Portal de pedidos** ([`docs/DESIGN.md` §16](docs/DESIGN.md)): en `https://ronin-agent.redmotoshn.com`, la gente que usa las aplicaciones pide ajustes chicos sin cuenta de GitHub. Entra con email y contraseña, elige la aplicación (las que le habilitaron) y le cuenta a ronin qué necesita, con texto y capturas.
- **ronin lee el pedido y revisa el código.** Puede hacer una pregunta, responder (cuando no hay nada que cambiar) o decidir si es un ajuste chico, un error o algo para el equipo.
- **Ajuste chico:** le muestra un prototipo con el antes y el después, armado sobre la app levantada, y la persona lo aprueba, pide un ajuste (hasta 3 prototipos) o dice que no le sirve.
- **Aprobado:** ronin abre un issue asignado a sí mismo, hace el cambio en un PR con `ronin:auto-merge` y avisa al equipo. El PR se mergea cuando un dev lo aprueba y CI pasa, y la persona recibe "Listo, sale en la próxima actualización". Cuando el release que lo lleva termina de desplegarse, recibe "Ya está en la aplicación".
- **Un error:** ronin lo reproduce en una copia de la app, con un test que falla por ese error. Si el arreglo es pequeño y el test pasa a verde, lo corrige él en un PR como uno aprobado, sin que la persona apruebe nada. Si no, o si no lo pudo reproducir, va al equipo con lo que encontró.
- **Grande, o "no me sirve":** va al equipo en un issue con label `ronin:portal`, y la persona recibe un correo cuando se cierra.
- **Cuentas:** las crean los administradores del tablero, en la página *Portal de pedidos*, con las aplicaciones de cada persona. Las aplicaciones salen del bloque `portal` de cada repo en `repos.json`.
- **Correos:** salen de la cuenta de `GMAIL_USER`.

## Operar un runner

- [Setup](https://github.com/Oskr814/ronin/wiki/Setup): instalación, cuenta de GitHub, cron
- [Webhooks](https://github.com/Oskr814/ronin/wiki/Webhooks): el servidor de ronin (`pnpm server:setup`), para reaccionar al instante en vez de esperar al próximo tick
- [Tablero](https://github.com/Oskr814/ronin/wiki/Tablero): activarlo y entrar desde la tailnet
- [Changelog](https://github.com/Oskr814/ronin/wiki/Changelog): publicación automática de releases
- [Bloqueos](https://github.com/Oskr814/ronin/wiki/Bloqueos): cuándo ronin se detiene y avisa por email
- Portal de pedidos: `PORTAL_URL` y `PORTAL_SESSION_SECRET` en `.env`, y el bloque `portal` en `repos.json` ([`docs/DESIGN.md` §16.9](docs/DESIGN.md))
- Despliegues: el bloque `deploy` en `repos.json`, `DEPLOYS_DATA_DIR` en `.env` (respaldarlo) y el evento `workflow_run` en los webhooks (`scripts/init-webhooks.sh`) ([`docs/DESIGN.md` §18.8](docs/DESIGN.md))
- Ajustes: nada que configurar; `SETTINGS_DATA_DIR` (por defecto `settings-data/`) guarda lo que se cambia en el tablero, el equipo y el registro: respaldarlo ([`docs/DESIGN.md` §19.10](docs/DESIGN.md))
- Reuniones: `MEETINGS_DATA_DIR` en `.env` (respaldarlo), y la key de Linear del repo para los proyectos ([`docs/DESIGN.md` §17.7](docs/DESIGN.md))

## Desarrollo

```bash
pnpm install
pnpm test
pnpm build   # el cron corre dist/, así que hay que reconstruir después de cada cambio
pnpm server  # el servidor de ronin sin compilar: webhooks y, con su .env, el tablero
pnpm browsers:install          # una vez por runner: navegadores para la exploración
pnpm app smoke --repo <owner/name> --app <app>   # levanta la app, entra con cada rol y saca capturas
pnpm explore run --repo <owner/name> --app <app> # una corrida de exploración local, sin tocar GitHub
```

La arquitectura y las decisiones de diseño están en [`docs/DESIGN.md`](docs/DESIGN.md), y el criterio de bloqueo en [`docs/BLOCKING.md`](docs/BLOCKING.md). Los features más viejos tienen además su documento de diseño en [`docs/superpowers/specs/`](docs/superpowers/specs/); los nuevos se documentan directo en `DESIGN.md`.
