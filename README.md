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
| Cualquier PR (no fork) | `@ronin-agent /preview [app] [qué datos querés]` | Levanta la app con el código del PR, su base y sus seeds; prepara los datos que piden los pasos de prueba del PR (más lo que agregues después del comando), y responde con una URL de la tailnet y los usuarios de prueba. Se baja sola a la hora (`PREVIEW_TTL_MINUTES`) o al mergear o cerrar el PR; `/preview stop` la baja antes. Ver [`docs/DESIGN.md` §12](docs/DESIGN.md). |
| Cualquier PR | `@ronin-agent /auto-merge [off]` | Le pone el label `ronin:auto-merge` (también se puede poner a mano) y mergea el PR apenas esté aprobado y con los checks en verde, como el auto-merge de GitHub. `/auto-merge off` o sacar el label lo cancela. Se desactiva solo si hay conflictos o el merge falla. Ver [`docs/DESIGN.md` §13](docs/DESIGN.md). |
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

**Exploración y propuestas de mejora** ([`docs/DESIGN.md` §11](docs/DESIGN.md)): con un `ronin.app.json` en el repo del producto, ronin levanta la app, la usa como cada rol y propone mejoras con capturas del antes y del después (en la rama huérfana `ronin/evidence` del repo del producto). Las propuestas van a un PR de exploración (`ronin/exploration/<fecha>`), listo para revisar apenas termina cada corrida; mientras siga abierto, las corridas siguientes se suman a él. Comentando en una ficha podés rechazarla, pedir que la corrija (incluso rehacer la captura del después, que reemplaza a la anterior) o pedir un issue aparte. Dentro de un hilo, ronin solo atiende las respuestas que lo mencionan (`@ronin-agent`), y siempre lee lo que ya se habló sobre esa ficha; al aprobar y mergear, abre un issue por cada propuesta que quedó en pie y la próxima corrida abre un PR nuevo. Las apps listadas en `explore` de `repos.json` se exploran solas de noche (`EXPLORE_NIGHT_WINDOW`).

**Tablero** ([`docs/DESIGN.md` §15](docs/DESIGN.md)): una página que se ve solo por la tailnet y pide entrar con GitHub. Muestra:
- la ficha de cada issue o PR: su descripción, sus comentarios y lo que hicieron los agentes;
- qué agentes están corriendo, con su transcript en vivo;
- qué issues esperan a alguien y por qué;
- cómo va cada stack de slices, con sus checks;
- las previews arriba;
- el uso de cada cuenta de Claude;
- en *Hoy*, las corridas de las últimas 12 horas y los totales del día.

Desde la ficha se le pide a ronin lo mismo que comentando en GitHub: resolver conflictos, levantar o bajar la preview, el auto-merge, o responder y destrabar un issue. ronin deja en el issue o PR un comentario con quién lo pidió.

## Operar un runner

- [Setup](https://github.com/Oskr814/ronin/wiki/Setup): instalación, cuenta de GitHub, cron
- [Webhooks](https://github.com/Oskr814/ronin/wiki/Webhooks): el servidor de ronin (`pnpm server:setup`), para reaccionar al instante en vez de esperar al próximo tick
- [Tablero](https://github.com/Oskr814/ronin/wiki/Tablero): activarlo y entrar desde la tailnet
- [Changelog](https://github.com/Oskr814/ronin/wiki/Changelog): publicación automática de releases
- [Bloqueos](https://github.com/Oskr814/ronin/wiki/Bloqueos): cuándo ronin se detiene y avisa por email

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
