# Rebrand completo de ValerIA a ronin

## Motivación

El repo se renombró a `ronin` y el PR de multi-repo + PAT (docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md) ya empezó a usar esa identidad para las credenciales (`RONIN_GITHUB_TOKEN`, `RONIN_GITHUB_LOGIN`), pero el resto del código —labels de GitHub, nombres de branch, paths de estado local, el propio texto que el agente recibe como su identidad— sigue hablando de "ValerIA"/"valeria". Esta spec completa esa migración: todo el naming interno pasa a `ronin`, consistente con el nombre del repo y de la cuenta de bot.

No hay ningún deployment en producción hoy (confirmado) — es un rename limpio, sin necesidad de compatibilidad con labels/branches/estado ya existentes.

## Alcance

Dentro:
- Labels de GitHub: `valeria`, `valeria:ready/in-progress/blocked/done`, `valeria:runner-<id>`, `valeria:attempts-N` → prefijo `ronin`.
- Nombres de branch: `valeria/<issue>/slice-N`, `valeria/<issue>/plan` → `ronin/<issue>/...`.
- Nombres de directorio de worktree: `valeria-<issue>-<rest>` → `ronin-<issue>-<rest>`.
- `LOCAL_STATE_PATH` default: `.valeria-state.json` → `.ronin-state.json`.
- `VALERIA_REPO` (env var) y `config.valeriaRepo` → `RONIN_REPO`/`config.roninRepo`, default `Oskr814/ronin` (confirmado — antes apuntaba a `Bmedical/ValerIA`, que no existe para este fork).
- Checkout de evidencia: `valeria-evidence-checkout` → `ronin-evidence-checkout`.
- Marker de comentario de evidencia: `<!-- valeria:e2e-evidence -->` → `<!-- ronin:e2e-evidence -->`.
- `listAllOpenValeriaPrs` → `listAllOpenRoninPrs`.
- Identidad del agente en los prompts de `agent-task.ts` (`"You are ValerIA..."`) → `"You are ronin..."`.
- Asunto del email de bloqueo (`notifier.ts`): `[ValerIA] Bloqueo: ...` → `[ronin] Bloqueo: ...`.
- Prefijos de directorios temporales (`mkdtemp`) en `github.ts`: `valeria-issue-`, `valeria-evidence-comment-`, `valeria-spec-pr-comment-`, `valeria-issue-body-` → `ronin-*`.
- `package.json`'s `"name"` field: `"valeria"` → `"ronin"`.
- `.gitignore`: `.valeria-state.json*` → `.ronin-state.json*`.
- `templates/tracking-issue.md`: referencia al label `valeria:blocked` → `ronin:blocked`.
- `README.md`: título, primera línea (nueva etimología, ver abajo), y cualquier mención de "ValerIA" en el cuerpo.
- `docs/DESIGN.md` y `docs/BLOCKING.md`: documentación viva (no fechada como spec/plan histórico) — se actualiza toda mención de "ValerIA"/"valeria" a "ronin".
- Todos los `*.test.ts` correspondientes a los archivos de arriba (assertions que verifican los strings/regex renombrados).

Fuera de alcance (decisión explícita, no omisión):
- `docs/superpowers/specs/*.md` y `docs/superpowers/plans/*.md` — registro histórico fechado de decisiones ya tomadas. Quedan exactamente como están, incluidas sus menciones a "ValerIA"/"valeria" — no se editan ni se borran. 13 archivos de `src/` los citan por path en comentarios (ej. `// ver docs/superpowers/specs/2026-07-28-stacked-prs-design.md`); esas referencias siguen resolviendo porque los archivos no se tocan.
- Cualquier compatibilidad retroactiva con labels/branches/estado con el naming viejo — no aplica, no hay nada en producción.

## Diseño

### Convención de casing

Todo en minúscula `ronin` — consistente con el username real de la cuenta de GitHub (`RONIN_GITHUB_LOGIN`) y con cómo ya se usa en el código mergeado del PR de multi-repo. Esto incluye el asunto del email (`[ronin]`, no `[Ronin]` ni `[ValerIA]`) y el título del README (`# ronin`, no `# Ronin`).

### Etimología del README

Reemplaza la actual ("Del latín 'valere'...") por:

> *Del japonés 浪人 (rōnin) — samurai sin señor, que actúa por su propio juicio.*

Encaja con el tema del proyecto: un agente autónomo que no necesita que un humano supervise cada paso — como un ronin, opera sin un "señor" pendiente de cada movimiento.

### Mapa completo de símbolos renombrados

| Archivo | Símbolo/constante | Antes | Después |
|---|---|---|---|
| `src/config.ts` | `LABEL_MANAGED` | `'valeria'` | `'ronin'` |
| `src/config.ts` | `LABEL_STATES` (valores) | `valeria:ready` etc. | `ronin:ready` etc. |
| `src/config.ts` | `localStatePath` default | `.valeria-state.json` | `.ronin-state.json` |
| `src/config.ts` | `valeriaRepo` → `roninRepo` | env `VALERIA_REPO`, default `Bmedical/ValerIA` | env `RONIN_REPO`, default `Oskr814/ronin` |
| `src/claim.ts` | `RUNNER_PREFIX` | `'valeria:runner-'` | `'ronin:runner-'` |
| `src/stack.ts` | `sliceBranch`/`planBranch` | `valeria/<issue>/...` | `ronin/<issue>/...` |
| `src/stack.ts` | `SLICE_BRANCH_RE` | `/^valeria\/\d+\/slice-(\d+)$/` | `/^ronin\/\d+\/slice-(\d+)$/` |
| `src/stack.ts` | `prsForIssue` prefix | `` `valeria/${issueNumber}/` `` | `` `ronin/${issueNumber}/` `` |
| `src/worktree.ts` | `WORKTREE_DIR_RE` | `/^valeria-(\d+)-(.+)$/` | `/^ronin-(\d+)-(.+)$/` |
| `src/worktree.ts` | `branchFromWorktreeDirName` | reconstruye `valeria/...` | reconstruye `ronin/...` |
| `src/evidence.ts` | `EVIDENCE_CHECKOUT_DIR` | `valeria-evidence-checkout` | `ronin-evidence-checkout` |
| `src/evidence.ts` | usa `config.valeriaRepo` | — | usa `config.roninRepo` |
| `src/notifier.ts` | asunto del email | `[ValerIA] Bloqueo: ...` | `[ronin] Bloqueo: ...` |
| `src/github.ts` | `mkdtemp` prefixes (4 lugares) | `valeria-issue-`, `valeria-issue-body-`, `valeria-evidence-comment-`, `valeria-spec-pr-comment-` | `ronin-*` |
| `src/github.ts` | `ATTEMPT_LABEL_RE` | `/^valeria:attempts-(\d+)$/` | `/^ronin:attempts-(\d+)$/` |
| `src/github.ts` | `EVIDENCE_COMMENT_MARKER` | `<!-- valeria:e2e-evidence -->` | `<!-- ronin:e2e-evidence -->` |
| `src/github.ts` | `listAllOpenValeriaPrs` | función + filtro `startsWith('valeria/')` | `listAllOpenRoninPrs` + `startsWith('ronin/')` |
| `src/tick.ts` | import/uso de `listAllOpenValeriaPrs` | — | `listAllOpenRoninPrs` |
| `src/agent-task.ts` | identidad en 7 prompts | `"You are ValerIA..."` | `"You are ronin..."` |
| `package.json` | `name` | `"valeria"` | `"ronin"` |
| `.gitignore` | patrón de estado local | `.valeria-state.json*` | `.ronin-state.json*` |
| `templates/tracking-issue.md` | referencia a label | `valeria:blocked` | `ronin:blocked` |

Todos los comentarios que mencionan "ValerIA"/"valeria" en estos mismos archivos (no en specs/plans históricos) se actualizan a "ronin" como parte del mismo cambio — son parte del mismo string/símbolo que se está renombrando, no un texto aparte.

### Por qué un rename mecánico simple alcanza

No hace falta ninguna capa de compatibilidad (labels viejas + nuevas coexistiendo, migración de branches, etc.) porque no hay nada corriendo en producción todavía — confirmado explícitamente. El cambio es sustituir cada símbolo/string listado arriba por su equivalente `ronin`, sin lógica nueva.

### Testing

Cada archivo de test correspondiente (`*.test.ts`) se actualiza para que sus fixtures/assertions usen el naming nuevo — mismo patrón que ya usaron los tests durante el trabajo de multi-repo+PAT (buscar y reemplazar los literales `valeria`/`ValerIA` por `ronin` donde el test verifica el símbolo renombrado). No se agregan tests nuevos: el comportamiento no cambia, solo los strings/regex que lo implementan.

Verificación final: `pnpm test` (debe seguir en 100%), `pnpm typecheck`, `pnpm build`, y un grep de cierre:

```
grep -rin "valeria" src/ scripts/ templates/ package.json .gitignore README.md docs/DESIGN.md docs/BLOCKING.md
```

Debe devolver cero resultados (fuera de `docs/superpowers/specs/` y `docs/superpowers/plans/`, que están fuera de alcance por diseño).

## Archivos afectados

- `src/config.ts`, `src/claim.ts`, `src/stack.ts`, `src/worktree.ts`, `src/evidence.ts`, `src/notifier.ts`, `src/github.ts`, `src/tick.ts`, `src/agent-task.ts` — símbolos y strings renombrados según la tabla de arriba.
- `src/stack.test.ts`, `src/worktree.test.ts`, `src/evidence.test.ts`, `src/notifier.test.ts`, `src/tick.test.ts`, `src/agent-task.test.ts`, `src/repos.test.ts`, `src/repo-context.test.ts`, `src/local-state.test.ts` — fixtures/assertions actualizados. (`config.ts` y `claim.ts` no tienen test file propio hoy — confirmado, no hay que crear uno.)
- `package.json`, `.gitignore`, `templates/tracking-issue.md`.
- `README.md`, `docs/DESIGN.md`, `docs/BLOCKING.md`.

## Fuera de alcance (explícito)

- `docs/superpowers/specs/*.md`, `docs/superpowers/plans/*.md` — no se tocan, quedan como registro histórico.
- Compatibilidad retroactiva con naming viejo — no aplica, no hay producción.
