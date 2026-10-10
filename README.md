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
| PR o issue | `@ronin-agent /help` | Responde con los comandos que se pueden usar ahí. Si escribís mal un comando, te sugiere el correcto. |

**Asignarle trabajo:**
- **Spec:** PR draft con el `.md` en `docs/superpowers/specs/`, asignado a `ronin-agent`. Cuando lo marcás *ready for review*, arranca.
- **Issue:** asignáselo con el picker de Assignees.

Detalle de cada comando: [wiki → Comandos](https://github.com/Oskr814/ronin/wiki/Comandos).

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
```

La arquitectura y las decisiones de diseño están en [`docs/DESIGN.md`](docs/DESIGN.md), y hay un documento por feature en [`docs/superpowers/specs/`](docs/superpowers/specs/).
