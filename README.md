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
3. Registrar el GitHub App dedicado e instalarlo en el repo del producto — pasos manuales en [`docs/DESIGN.md` §7](docs/DESIGN.md#7-identidad-del-agente-en-github), no automatizables. Completar las tres variables `VALERIA_GITHUB_APP_*` del `.env`.
4. `pnpm smoke-test` — confirma que el App autentica y puede leer `PRODUCT_REPO` antes de seguir.
5. `pnpm init-labels` — crea en `PRODUCT_REPO` los labels `valeria*` que usa el pipeline, incluida tu label de asignación `valeria:runner-<RUNNER_ID>`. Sin esto no vas a poder seleccionarla desde la UI de GitHub al asignarte un spec.
6. `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) — instala el supervisor como cron job. `pnpm cron:remove` para sacarlo. Logs en `logs/tick-YYYY-MM-DD.log` (`tail -f logs/tick-$(date +%F).log` para seguir el de hoy).
7. Después de cualquier cambio de código, correr `pnpm build` — el cron corre el `dist/` compilado, nunca reconstruye solo. Sin un build nuevo, sigue corriendo la versión vieja (o corta si `dist/` nunca se generó).

### Asignarte un spec

1. Escribí el spec como `.md` en `docs/superpowers/specs/` del repo del producto, en un PR **draft**.
2. Poné la label `valeria:runner-<RUNNER_ID>` en ese PR — así lo asignás a tu runner.
3. Cuando esté listo, marcalo **ready for review** (undraft). Esa es la señal de "andá" — mientras siga en draft, el agente lo ignora por completo y podés seguir iterando.
4. El runner asignado lo va a detectar en su próximo tick, mergearlo, y arrancar el plan + slicing automáticamente.
