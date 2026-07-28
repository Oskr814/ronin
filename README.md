# ValerIA

> *Del latín "valere" — estar sano, ser fuerte.*

Orquestación de agentes autónomos para desarrollo dirigido por specs. Nace del flujo de trabajo de [bmedical](https://github.com/Bmedical/bmedical), pero es independiente del monorepo para poder versionarse, iterar y compartirse con otros equipos/devs sin acoplarse al ciclo de release del producto.

## Estado

🚧 Supervisor funcional (`pnpm tick`), verificado en un dry run real de punta a punta. Ver [`docs/DESIGN.md`](docs/DESIGN.md) para la arquitectura completa y las decisiones tomadas.

## Objetivo

Reducir el cuello de botella de PRs gigantes (+100 archivos) generados por implementación "one-shot" de specs, dándole al agente autonomía para:

- Trocear el trabajo en slices pequeños y revisables (PRs apilados), una vez que un humano le asigna un spec (PR + label `valeria:runner-<usuario>`, ver §1 del diseño)
- Correr tests e2e (Playwright) y pedir review externo (GitHub Copilot) por sí mismo
- Reanudar automáticamente tras cortes de cuota, sin sesión continua ni intervención humana
- Escalar bloqueos reales a un humano (notificación por email) en vez de improvisar
- Correr en paralelo entre varios runners sin pisarse (claim por label, ver §9 del diseño)

## Setup

1. Clonar y `pnpm install`.
2. Copiar `.env.example` a `.env` y completar `PRODUCT_REPO` / `PRODUCT_REPO_PATH` / `RUNNER_ID` (tu usuario de GitHub, no un hostname).
3. Registrar el GitHub App dedicado e instalarlo en el repo del producto — pasos manuales en [`docs/DESIGN.md` §7](docs/DESIGN.md#7-identidad-del-agente-en-github), no automatizables. Completar las variables `VALERIA_GITHUB_APP_*` del `.env`: `VALERIA_GITHUB_APP_ID`, `VALERIA_GITHUB_APP_PRIVATE_KEY_PATH`, `VALERIA_GITHUB_APP_INSTALLATION_ID` y `VALERIA_GITHUB_APP_SLUG` (el slug del App, visible en la URL de su página de configuración: `github.com/settings/apps/<slug>`). **Las cuatro son requeridas** — un deployment ya existente que no tenga `VALERIA_GITHUB_APP_SLUG` en su `.env` corta al arrancar hasta agregarla. Opcional: `VALERIA_MENTION_HANDLE` (default `valeria-agent`), ver "Pedirle una review por @mención" más abajo.
4. `pnpm smoke-test` — confirma que el App autentica, puede leer `PRODUCT_REPO`, y que `VALERIA_GITHUB_APP_SLUG` coincide con el slug real del App, antes de seguir.
5. `pnpm init-labels` — crea en `PRODUCT_REPO` los labels `valeria*` que usa el pipeline, incluida tu label de asignación `valeria:runner-<RUNNER_ID>`. Sin esto no vas a poder seleccionarla desde la UI de GitHub al asignarte un spec.
6. Correr `pnpm build` (antes de instalar el cron por primera vez, y después de cualquier cambio de código posterior) — el cron corre el `dist/` compilado, nunca reconstruye solo. Sin un build nuevo, sigue corriendo la versión vieja (o corta si `dist/` nunca se generó).
7. `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) — instala el supervisor como cron job. `pnpm cron:remove` para sacarlo. Logs en `logs/tick-YYYY-MM-DD.log` (`tail -f logs/tick-$(date +%F).log` para seguir el de hoy).

### Asignarte un spec

1. Escribí el spec como `.md` en `docs/superpowers/specs/` del repo del producto, en un PR **draft**.
2. Poné la label `valeria:runner-<RUNNER_ID>` en ese PR — así lo asignás a tu runner.
3. Cuando esté listo, marcalo **ready for review** (undraft). Esa es la señal de "andá" — mientras siga en draft, el agente lo ignora por completo y podés seguir iterando.
4. El runner asignado lo va a detectar en su próximo tick, mergearlo, y arrancar el plan + slicing automáticamente.

### Pedirle una review por @mención

En cualquier PR que ValerIA haya abierto (y que no esté en draft) podés escribir `@valeria-agent <pedido>` en un comentario general o inline, y en el próximo tick el supervisor postea una review formal — siempre en estado `Commented`, nunca `Approved` ni `Changes requested` — respondiendo a ese pedido. Los comentarios ya atendidos quedan marcados con 👀. Ver [`docs/superpowers/specs/2026-07-28-mention-review-design.md`](docs/superpowers/specs/2026-07-28-mention-review-design.md).

**Paso manual de setup (una vez, por parte del dueño del repo):** crear el usuario de GitHub `valeria-agent` (o el que configures en `VALERIA_MENTION_HANDLE`) y agregarlo como colaborador **solo-lectura** de `PRODUCT_REPO`. Ese usuario existe puramente para que la @mención dispare una notificación real; no necesita ni debe tener permisos de escritura — quien postea reacciones y reviews sigue siendo el GitHub App vía su installation token. Sin este paso la mención no notifica a nadie (la detección por polling igual funciona, pero se pierde la señal para el humano).
