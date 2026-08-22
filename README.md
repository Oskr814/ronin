# ronin

> *Del japonés 浪人 (rōnin) — samurai sin señor, que actúa por su propio juicio.*

Orquestación de agentes autónomos para desarrollo dirigido por specs. Nace del flujo de trabajo de [bmedical](https://github.com/Bmedical/bmedical), pero es independiente del monorepo para poder versionarse, iterar y compartirse con otros equipos/devs sin acoplarse al ciclo de release del producto.

## Estado

🚧 Supervisor funcional (`pnpm tick`), verificado en un dry run real de punta a punta. Ver [`docs/DESIGN.md`](docs/DESIGN.md) para la arquitectura completa y las decisiones tomadas.

## Objetivo

Reducir el cuello de botella de PRs gigantes (+100 archivos) generados por implementación "one-shot" de specs, dándole al agente autonomía para:

- Trocear el trabajo en slices pequeños y revisables (PRs apilados), una vez que un humano le asigna un spec (PR + label `ronin:runner-<usuario>`, ver §1 del diseño)
- Correr tests e2e (Playwright) y pedir review externo (GitHub Copilot) por sí mismo
- Reanudar automáticamente tras cortes de cuota, sin sesión continua ni intervención humana
- Escalar bloqueos reales a un humano (notificación por email) en vez de improvisar
- Correr en paralelo entre varios runners sin pisarse (claim por label, ver §9 del diseño)

## Setup

1. Clonar y `pnpm install`.
2. Copiar `.env.example` a `.env` y completar `RUNNER_ID` (tu usuario de GitHub, no un hostname).
3. Copiar `repos.json.example` a `repos.json` y completar cada repo a supervisar (`productRepo`, `productRepoPath`, y opcionalmente `claudeConfigDir` si ese repo debe correr bajo una cuenta de Claude distinta a la global). Si el branch default/activo de ese repo no se llama `main` (ej. `odoo-main`), completar también `worktreeBaseRef` (ej. `"origin/odoo-main"`) — sin esto, ronin asume `origin/main` para ese repo y todo lo que dependa de la rama base (specs, rebases, merges de stack) falla silenciosamente contra el branch equivocado. `repos.json` va gitignored — nunca se commitea.
4. Crear una cuenta de GitHub dedicada (ej. `ronin`) e invitarla como colaboradora en cada repo de `repos.json`. Generar un fine-grained PAT desde esa cuenta (Settings → Developer settings → Personal access tokens → Fine-grained tokens), scopeado a esos repos, con permisos Contents/Issues/Pull requests en read-write y una expiración — es un token estático, sin renovación automática, hay que rotarlo a mano antes de que venza. Completar `RONIN_GITHUB_TOKEN` (el token) y `RONIN_GITHUB_LOGIN` (el username de esa cuenta) en `.env`.
5. `pnpm smoke-test` — confirma que el token autentica como `RONIN_GITHUB_LOGIN` y que puede leer cada repo de `repos.json`, antes de seguir.
6. `pnpm init-labels` — crea en cada repo de `repos.json` los labels `ronin*` que usa el pipeline, incluida tu label de asignación `ronin:runner-<RUNNER_ID>`. Sin esto no vas a poder seleccionarla desde la UI de GitHub al asignarte un spec. Requiere `jq` instalado en el host (el script itera `repos.json` con él).
7. Correr `pnpm build` (antes de instalar el cron por primera vez, y después de cualquier cambio de código posterior) — el cron corre el `dist/` compilado, nunca reconstruye solo. Sin un build nuevo, sigue corriendo la versión vieja (o corta si `dist/` nunca se generó).
8. `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) — instala el supervisor como cron job. `pnpm cron:remove` para sacarlo. Logs en `logs/tick-YYYY-MM-DD.log` (`tail -f logs/tick-$(date +%F).log` para seguir el de hoy).
9. (Opcional, recomendado) Bootstrapear la convención de memoria persistente entre ticks en el repo del producto: crear `docs/agent-notes/INDEX.md` vacío y agregar una sección al `CLAUDE.md` del repo apuntando a él — ver [`docs/superpowers/specs/2026-08-18-agent-notes-design.md`](docs/superpowers/specs/2026-08-18-agent-notes-design.md). Sin este paso la convención queda inerte: el agente no encuentra dónde dejar constancia de lo que aprende y simplemente no hace nada, sin error ni flag.

### Asignarte un spec

1. Escribí el spec como `.md` en `docs/superpowers/specs/` del repo del producto, en un PR **draft**.
2. Poné la label `ronin:runner-<RUNNER_ID>` en ese PR — así lo asignás a tu runner.
3. Cuando esté listo, marcalo **ready for review** (undraft). Esa es la señal de "andá" — mientras siga en draft, el agente lo ignora por completo y podés seguir iterando.
4. El runner asignado lo va a detectar en su próximo tick, mergearlo, y arrancar el plan + slicing automáticamente.

### Pedirle una review por @mención

En cualquier PR que el agente haya abierto (y que no esté en draft) podés escribir `@<RONIN_GITHUB_LOGIN> <pedido>` (ej. `@ronin`) en un comentario general o inline, y en el próximo tick el supervisor postea una review formal — siempre en estado `Commented`, nunca `Approved` ni `Changes requested` — respondiendo a ese pedido. Los comentarios ya atendidos quedan marcados con 👀. Ver [`docs/superpowers/specs/2026-07-28-mention-review-design.md`](docs/superpowers/specs/2026-07-28-mention-review-design.md).

No hace falta ningún setup manual adicional para esto: la cuenta `ronin` invitada como colaboradora en el §Setup ya es la misma identidad que abre los PRs y la que se @menciona — a diferencia del diseño anterior (GitHub App + un segundo usuario mencionable separado), no hay una segunda cuenta que crear.
