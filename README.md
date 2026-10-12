# ronin

> *Del japonés 浪人 (rōnin): samurai sin señor, que actúa por su propio juicio.*

Orquestación de agentes autónomos (Claude Code) para desarrollo dirigido por specs. Le asignás un spec o un issue en GitHub y ronin lo trocea en PRs chicos y apilados, corre los tests, pide review, responde a los comentarios y escala a un humano solo cuando se bloquea de verdad.

📖 **Documentación completa en la [wiki](https://github.com/Oskr814/ronin/wiki).**

## Comandos

Todo se pide desde GitHub, mencionando a [`@ronin-agent`](https://github.com/ronin-agent) en un comentario. Cuando ronin ya procesó un comentario, le deja una reacción 👀.

| Dónde | Comando | Qué hace |
|---|---|---|
| PR de ronin | `@ronin-agent <pedido>` | Si el pedido es concreto, lo aplica (amend + force-push). Si no, responde por qué. |
| PR de un humano | `@ronin-agent <pedido>` | Corre una review de solo lectura, enfocada en tu pedido. |
| Cualquier PR (no fork) | `@ronin-agent /fix-comments` | Aplica en un solo pase los hilos de review abiertos, responde en cada uno y resuelve los que cambió. Para excluir un hilo, resolvelo antes. |
| Issue sin asignar | `@ronin-agent /spike <app> [instrucción]` | Investiga en solo lectura y agrega una sección `## Contexto adicional (spike)` al issue. |
| Issue sin asignar | `@ronin-agent /spec <app> [instrucción]` | Convierte el pedido en un spec: investiga, pregunta lo que falte y abre un PR draft con el spec. Al marcarlo *ready for review*, lo implementa. |
| Issue sin asignar | `@ronin-agent /explore <app> [funciones]` | Levanta la app, usa algunas de sus funciones como cada rol en desktop y mobile, y deja las propuestas de mejora en el PR de exploración abierto (o abre uno). |
| PR o issue | `@ronin-agent /help` | Responde con los comandos que se pueden usar ahí. Si escribís mal un comando, te sugiere el correcto. |

**Asignarle trabajo:**
- **Spec:** PR draft con el `.md` en `docs/superpowers/specs/`, asignado a `ronin-agent`. Cuando lo marcás *ready for review*, arranca.
- **Issue:** asignáselo con el picker de Assignees.

Detalle de cada comando: [wiki → Comandos](https://github.com/Oskr814/ronin/wiki/Comandos).

**Exploración y propuestas de mejora** ([`docs/DESIGN.md` §11](docs/DESIGN.md)): con un `ronin.app.json` en el repo del producto, ronin levanta la app, la usa como cada rol y propone mejoras con capturas del antes y del después (en la rama huérfana `ronin/evidence` del repo del producto). Las propuestas van a un PR de exploración (`ronin/exploration/<fecha>`), listo para revisar apenas termina cada corrida; mientras siga abierto, las corridas siguientes se suman a él. Comentando en una ficha podés rechazarla, pedir que la corrija (incluso rehacer la captura del después) o pedir un issue aparte; al aprobar y mergear, abre un issue por cada propuesta que quedó en pie y la próxima corrida abre un PR nuevo. Las apps listadas en `explore` de `repos.json` se exploran solas de noche (`EXPLORE_NIGHT_WINDOW`).

## Operar un runner

- [Setup](https://github.com/Oskr814/ronin/wiki/Setup): instalación, cuenta de GitHub, cron
- [Webhooks](https://github.com/Oskr814/ronin/wiki/Webhooks): reaccionar al instante en vez de esperar al próximo tick
- [Changelog](https://github.com/Oskr814/ronin/wiki/Changelog): publicación automática de releases
- [Bloqueos](https://github.com/Oskr814/ronin/wiki/Bloqueos): cuándo ronin se detiene y avisa por email

## Desarrollo

```bash
pnpm install
pnpm test
pnpm build   # el cron corre dist/, así que hay que reconstruir después de cada cambio
pnpm browsers:install          # una vez por runner: navegadores para la exploración
pnpm app smoke --repo <owner/name> --app <app>   # levanta la app, entra con cada rol y saca capturas
pnpm explore run --repo <owner/name> --app <app> # una corrida de exploración local, sin tocar GitHub
```

La arquitectura y las decisiones de diseño están en [`docs/DESIGN.md`](docs/DESIGN.md), y hay un documento por feature en [`docs/superpowers/specs/`](docs/superpowers/specs/).
