# ronin

> *Del japonés 浪人 (rōnin) — samurai sin señor, que actúa por su propio juicio.*

Orquestación de agentes autónomos para desarrollo dirigido por specs. Nace del flujo de trabajo de [bmedical](https://github.com/Bmedical/bmedical), pero es independiente del monorepo para poder versionarse, iterar y compartirse con otros equipos/devs sin acoplarse al ciclo de release del producto.

## Estado

🚧 Supervisor funcional (`pnpm tick`), verificado en un dry run real de punta a punta. Ver [`docs/DESIGN.md`](docs/DESIGN.md) para la arquitectura completa y las decisiones tomadas.

## Objetivo

Reducir el cuello de botella de PRs gigantes (+100 archivos) generados por implementación "one-shot" de specs, dándole al agente autonomía para:

- Trocear el trabajo en slices pequeños y revisables (PRs apilados), una vez que un humano le asigna un spec (PR asignado a la cuenta `ronin` vía el Assignees nativo de GitHub, ver §1 del diseño)
- Correr tests e2e (Playwright) y pedir review externo (GitHub Copilot) por sí mismo
- Reanudar automáticamente tras cortes de cuota, sin sesión continua ni intervención humana
- Escalar bloqueos reales a un humano (notificación por email) en vez de improvisar
- Correr en paralelo entre varios runners sin pisarse (claim por label, ver §9 del diseño)

## Setup

1. Clonar y `pnpm install`.
2. Copiar `.env.example` a `.env` y completar `RUNNER_ID` (tu usuario de GitHub, no un hostname).
3. Copiar `repos.json.example` a `repos.json` y completar cada repo a supervisar (`productRepo`, `productRepoPath`, y opcionalmente `claudeConfigDir` si ese repo debe correr bajo una cuenta de Claude distinta a la global). Si el branch default/activo de ese repo no se llama `main` (ej. `odoo-main`), completar también `worktreeBaseRef` (ej. `"origin/odoo-main"`) — sin esto, ronin asume `origin/main` para ese repo y todo lo que dependa de la rama base (specs, rebases, merges de stack) falla silenciosamente contra el branch equivocado. Opcionalmente, `changelogRepo`/`changelogRepoPath` habilita la publicación automática de releases al changelog (ver §Publicar releases al changelog). `repos.json` va gitignored — nunca se commitea.
4. Crear una cuenta de GitHub dedicada (ej. `ronin`) e invitarla como colaboradora en cada repo de `repos.json`. Generar un fine-grained PAT desde esa cuenta (Settings → Developer settings → Personal access tokens → Fine-grained tokens), scopeado a esos repos, con permisos Contents/Issues/Pull requests en read-write (y, opcional, `Commit statuses` en read-write — habilita el check `ronin/review` que aparece en la caja de checks del PR mientras ronin corre una review; sin ese permiso todo lo demás funciona igual) y una expiración — es un token estático, sin renovación automática, hay que rotarlo a mano antes de que venza. Completar `RONIN_GITHUB_TOKEN` (el token) y `RONIN_GITHUB_LOGIN` (el username de esa cuenta) en `.env`.
5. `pnpm smoke-test` — confirma que el token autentica como `RONIN_GITHUB_LOGIN`, que puede leer cada repo de `repos.json`, y (soft, no bloquea) si puede escribir commit statuses, antes de seguir.
6. `pnpm init-labels` — crea en cada repo de `repos.json` los labels `ronin*` que usa el pipeline (incluida `ronin:runner-<RUNNER_ID>`, que sigue existiendo solo para el claim interno de concurrencia entre runners — la asignación de specs/bugs ya no usa labels, ver más abajo). Requiere `jq` instalado en el host (el script itera `repos.json` con él).
7. Correr `pnpm build` (antes de instalar el cron por primera vez, y después de cualquier cambio de código posterior) — el cron corre el `dist/` compilado, nunca reconstruye solo. Sin un build nuevo, sigue corriendo la versión vieja (o corta si `dist/` nunca se generó).
8. `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) — instala el supervisor como cron job. `pnpm cron:remove` para sacarlo. Logs en `logs/tick-YYYY-MM-DD.log` (`tail -f logs/tick-$(date +%F).log` para seguir el de hoy).
9. (Opcional, recomendado) Bootstrapear la convención de memoria persistente entre ticks en el repo del producto: crear `docs/agent-notes/INDEX.md` vacío y agregar una sección al `CLAUDE.md` del repo apuntando a él — ver [`docs/superpowers/specs/2026-08-18-agent-notes-design.md`](docs/superpowers/specs/2026-08-18-agent-notes-design.md). Sin este paso la convención queda inerte: el agente no encuentra dónde dejar constancia de lo que aprende y simplemente no hace nada, sin error ni flag.

### Asignarte un spec

1. Escribí el spec como `.md` en `docs/superpowers/specs/` del repo del producto, en un PR **draft**.
2. Asigná ese PR a la cuenta `ronin` (`RONIN_GITHUB_LOGIN`) usando el picker nativo de Assignees de GitHub.
3. Cuando esté listo, marcalo **ready for review** (undraft). Esa es la señal de "andá" — mientras siga en draft, el agente lo ignora por completo y podés seguir iterando.
4. El supervisor lo va a detectar en su próximo tick, mergearlo, y arrancar el plan + slicing automáticamente.

### Pedirle una review por @mención

En cualquier PR que el agente haya abierto (y que no esté en draft) podés escribir `@<RONIN_GITHUB_LOGIN> <pedido>` (ej. `@ronin`) en un comentario general o inline, y en el próximo tick el supervisor postea una review formal — siempre en estado `Commented`, nunca `Approved` ni `Changes requested` — respondiendo a ese pedido. Los comentarios ya atendidos quedan marcados con 👀. Ver [`docs/superpowers/specs/2026-07-28-mention-review-design.md`](docs/superpowers/specs/2026-07-28-mention-review-design.md).

Mientras corre, ronin postea un commit status `ronin/review` (`pending` → `success`/`error`) sobre el head del PR, así que en la caja de checks se ve cuándo está revisando y cómo terminó. El flujo `/fix-comments` usa el mismo mecanismo con el context `ronin/fix-comments`. Es informativo: nunca gatea el merge, y si el PAT no tiene el permiso `Commit statuses` simplemente no aparece el check. Vale para PRs propios y externos.

No hace falta ningún setup manual adicional para esto: la cuenta `ronin` invitada como colaboradora en el §Setup ya es la misma identidad que abre los PRs y la que se @menciona — a diferencia del diseño anterior (GitHub App + un segundo usuario mencionable separado), no hay una segunda cuenta que crear.

### Webhooks (opcional) — reaccionar antes del próximo tick

Por defecto, todo se descubre por polling cada 5 minutos vía el cron del §Setup. Si preferís reaccionar casi al instante a una asignación, un PR externo nuevo/actualizado, o un comentario/comando (`@ronin`, `/fix-comments`), podés levantar `webhook-server.ts`: un proceso separado que escucha webhooks de GitHub para esos tres eventos y dispara un tick anticipado (usando el mismo `flock` sobre `.tick.lock` que el cron, así nunca hay dos ticks corriendo a la vez) en vez de esperar al próximo slot del cron. La lógica de qué hacer sigue siendo exactamente la misma — los webhooks solo adelantan cuándo corre.

Requiere que la máquina donde corre `ronin` sea alcanzable desde GitHub. Si no tiene IP pública, exponé `webhook-server` a través de lo que ya tengas (ej. un contenedor con `cloudflared` + nginx-proxy-manager: agregá un proxy host apuntando a `127.0.0.1:$WEBHOOK_PORT` y dejá que el túnel/certificado lo resuelva) — eso es infraestructura fuera de este repo, `ronin` solo necesita el puerto local.

1. Generar un secreto: `openssl rand -hex 32` → completar `WEBHOOK_SECRET` en `.env` (y opcionalmente `WEBHOOK_PORT`/`WEBHOOK_DEBOUNCE_MS`, ver `.env.example`).
2. `pnpm build` (igual que para el cron, `webhook-server` corre el `dist/` compilado).
3. `pnpm webhook:setup` — instala `webhook-server` como servicio systemd `--user` (`ronin-webhook`), con reinicio automático. `pnpm webhook:remove` para sacarlo. Logs: `journalctl --user -u ronin-webhook -f`.
4. Exponer ese puerto públicamente vía tu reverse proxy/túnel (ver arriba) bajo una URL HTTPS, ej. `https://ronin-webhooks.tudominio.com/webhook`.
5. `pnpm init-webhooks https://ronin-webhooks.tudominio.com/webhook` — registra (o actualiza, es idempotente) el webhook en cada repo de `repos.json`, con los eventos `issues`, `pull_request`, `issue_comment`, `pull_request_review_comment` y `release`.

Los webhooks pueden perderse (downtime del túnel, reinicio de la máquina, etc.), así que esto no reemplaza al cron — es un adelanto, no un sustituto. Con webhooks andando, tiene sentido bajarle la frecuencia al cron de reconciliación en vez de sacarlo: `pnpm cron:setup 30` (cada 30 min).

### Pedirle que investigue un issue crudo antes de asignarlo — `/spike`

Si un issue tiene una descripción corta y todavía no querés asignárselo (asignarlo dispara el pipeline completo — ver §Asignarte un spec), podés dejarle un comentario general `@<RONIN_GITHUB_LOGIN> /spike <app_name> <instrucción opcional>` (ej. `@ronin /spike backoffice revisá el flujo de checkout`). En el próximo tick, el agente investiga en modo solo-lectura la parte del repo correspondiente a `<app_name>` (busca la carpeta/área por su cuenta, no depende de una convención fija) y agrega al body del issue una sección `## Contexto adicional (spike)` con archivos relevantes, una hipótesis de causa raíz o enfoque, y preguntas abiertas — sin borrar la descripción original.

`/spike` nunca escribe código, nunca abre PR, y nunca cambia labels ni assignees — solo enriquece la descripción. Asignarle el issue a `ronin` después sigue siendo un paso manual aparte, exactamente igual que con cualquier otro issue (ver §Setup). Solo aplica a issues que todavía no están gestionados por `ronin` — uno ya asignado o bloqueado sigue el pipeline normal.

### Pedirle que resuelva varios comentarios de review de una — `/fix-comments`

En un comentario general del PR (no inline), `@<RONIN_GITHUB_LOGIN> /fix-comments` le pide al agente que recorra en un solo pase todos los hilos de review todavía abiertos que él mismo no abrió (los de Copilot, un humano, u otro bot) y aplique los cambios que le parezcan concretos y accionables, respondiendo dentro de cada hilo y resolviendo los que efectivamente cambió. Los hilos ya resueltos no se listan: si no querés que toque una observación puntual del review, resolvela vos manualmente antes de pedirle el `/fix-comments` — esa es la forma de excluirla del batch.

### Publicar releases al changelog

Opt-in por repo: si una entrada de `repos.json` trae `changelogRepo` (ej. `"redmotos/changelog"`) y `changelogRepoPath` (un clon local de ese repo, ya cloneado a mano — mismo contrato manual que `productRepoPath`, ronin nunca lo clona solo), cada vez que ese repo publica un release real (no draft, no pre-release) ronin genera automáticamente su entrada en el repo de changelog y la publica.

El agente sigue al pie de la letra las reglas que ya están escritas en el propio repo de changelog (su `AGENTS.md`/`README.md`: formato de frontmatter, tono de copy, cómo traer los datos reales con `gh release view`/`gh pr view`, manejo de imágenes, y que el deploy se dispara con un `git push origin main` directo, sin PR) — este repo no redefine ninguna de esas reglas. Si el repo de changelog cambia su convención, el comportamiento de ronin cambia solo, sin tocar código acá.

Si el agente encuentra una captura de pantalla que podría tener datos reales de cliente (el propio `AGENTS.md` del changelog pide confirmar eso con un humano antes de publicar, y acá no hay nadie para responder), publica igual el resto de la entrada mencionando el cambio, mostrando la imagen omitida y avisa por email (mismo mecanismo de bloqueo que el resto de ronin) para que un humano la revise y la agregue a mano si corresponde.

Se dispara por webhook (evento `release`, acción `released` — la única acción que GitHub manda solo para releases reales, nunca para drafts ni pre-releases) igual que el resto de eventos de §Webhooks, y también se reconcilia en cada tick del cron por si se perdió un webhook. Al activarse por primera vez para un repo no genera entradas retroactivas: marca el release más reciente que ya existe como punto de partida y solo procesa los publicados de ahí en adelante.
