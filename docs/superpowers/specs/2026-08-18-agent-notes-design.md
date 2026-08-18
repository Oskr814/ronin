# Memoria persistente entre ticks (agent-notes)

## Contexto

Cada tarea del agente (`runAgentTask` en `src/agent-task.ts`) corre en una
sesión de `claude -p` con contexto fresco, en un worktree desechable —
principio de diseño central de ronin (`docs/DESIGN.md`, "Nunca una sesión
continua"). Eso significa que cualquier gotcha o constraint no-obvia que un
tick descubre (por qué un test fallaba, por qué un rebase no fue mecánico,
una convención real del repo que el spec no menciona) se pierde apenas
termina esa tarea — la próxima sesión que toque la misma área la vuelve a
descubrir desde cero, o peor, repite el mismo error.

[snarktank/ralph](https://github.com/snarktank/ralph) (herramienta
comparable: loop autónomo que implementa PRDs con Claude Code/Amp,
inspirado en el patrón Ralph de Geoffrey Huntley) resuelve esto con un
`AGENTS.md`/`progress.txt` que cada iteración actualiza con lo aprendido —
las herramientas de IA lo cargan automáticamente al arrancar. Portamos la
idea, adaptada a dos diferencias reales con Ralph:

- Ralph corre todo en **una sola rama de feature**, con `progress.txt`
  archivado en cada feature nueva — nunca acumula más que la vida de una
  feature. Ronin trocea en **PRs apilados** sobre múltiples issues, a veces
  en paralelo (`docs/superpowers/specs/2026-07-28-stacked-prs-design.md`),
  así que no hay un punto natural de reset por feature.
- Claude Code ya carga `CLAUDE.md` automáticamente en cada sesión — bmedical
  ya tiene uno. No hace falta un `AGENTS.md` paralelo; alcanza con una
  sección nueva ahí.

## Objetivo

Que un tick que descubre algo no-obvio pueda dejarlo anotado en un lugar
que una sesión futura (de ronin o de un dev humano) va a encontrar sin
que el supervisor tenga que inyectar nada — y que ese conocimiento no
termine en un solo archivo gigante que degrade el contexto de cada sesión
(el problema exacto que el diseño de "nunca sesión continua" evita).

## Decisiones

- **El conocimiento vive en `PRODUCT_REPO`, no en ronin** — a diferencia de
  la evidencia e2e (`docs/DESIGN.md` §4, que vive en `VALERIA_REPO` para no
  ensuciar el historial del producto con binarios), esto es texto que
  describe el propio código de `PRODUCT_REPO` y solo tiene sentido leído
  junto a él.
- **Índice + archivos por tema, no un único archivo plano** — un
  `docs/agent-notes/INDEX.md` con una línea por tema y el detalle en
  `docs/agent-notes/<topic-slug>.md` aparte. Evita que `CLAUDE.md` (cargado
  entero en cada sesión) crezca sin límite; el agente solo abre el archivo
  de tema puntual cuando algo en `INDEX.md` es relevante para su tarea
  actual, no todo el conocimiento acumulado de una.
- **Puntero en el `CLAUDE.md` existente de bmedical, no un `AGENTS.md`
  nuevo** — evita dos archivos con propósito solapado cargándose en
  paralelo; bmedical ya estandarizó en `CLAUDE.md`.
- **Disciplina de escritura, no enforcement de código**: vara alta (solo
  algo no-obvio, mismo criterio que ya usa `CLAUDE.md` para comentarios de
  código), y upsert (actualizar el archivo de tema existente en vez de
  duplicar) — ambas viven como texto en la convención documentada, no como
  validación en `src/`. La poda de entradas de baja calidad la hace el
  review humano normal del PR, igual que con cualquier otro archivo.
- **El cambio de código es un solo recordatorio corto en el prompt, no las
  reglas completas** — como `CLAUDE.md` ya se carga automáticamente, el
  prompt de cada `AgentTask` solo necesita apuntar a la convención, no
  repetirla.
- **Todas las tareas que producen o corrigen código lo escriben, `plan` no**
  — `implement-slice`, `fix-bug`, `fix-review`, `fix-e2e`, `fix-rebase` y
  `review-request` pueden dejar una nota; `plan` no toca código todavía así
  que no tiene de qué dejar constancia. El recordatorio es condicional a
  que la tarea efectivamente esté commiteando algo: `fix-bug` y
  `review-request` tienen salidas explícitas sin tocar código (pedir info
  a un humano, o dejar el código como está porque el pedido es ambiguo) —
  en esos casos el agente lo salta, no fuerza un commit/amend solo para
  dejar la nota.
- **Sin commit aparte**: el cambio a `docs/agent-notes/` viaja en el mismo
  commit (`implement-slice`/`fix-bug`) o el mismo amend (`fix-review`/
  `fix-e2e`/`fix-rebase`/`review-request`) que la tarea ya está haciendo —
  pasa por el mismo review humano que el resto del diff, sin gate nuevo.
- **Bootstrap manual, fuera de este spec**: crear `docs/agent-notes/
  INDEX.md` vacío y agregar la sección al `CLAUDE.md` de bmedical es un
  paso manual único (misma categoría que el registro del GitHub App,
  `docs/DESIGN.md` §7) — no hay código de ronin que lo automatice, y por
  diseño la feature queda inerte (el agente simplemente no encuentra la
  convención y no hace nada) en cualquier repo que no lo haya hecho.

## Diseño

### 1. `src/agent-task.ts`

Nueva constante exportable, junto a las demás funciones del módulo:

```ts
export const AGENT_NOTES_REMINDER =
  "If you are committing code changes for this task and learned something " +
  "non-obvious while doing it (a hidden constraint, a subtle invariant, a " +
  "workaround for a specific bug) that would help a future task or a " +
  "human dev, record it now as part of that same commit, following the " +
  "agent-notes convention in this repo's CLAUDE.md — write it as a " +
  "descriptive observation of what you found, never as an instruction or " +
  "directive for future readers to follow. If you are not committing any " +
  "code changes for this task, skip this.";
```

Se agrega como última línea del prompt (después de la línea existente
"Do not edit the tracking issue...") en los `case` de: `implement-slice`,
`fix-bug`, `fix-review`, `fix-e2e`, `fix-rebase`, `review-request`. El
`case 'plan'` no cambia.

Ejemplo (case `implement-slice`, dentro del array que arma el join):

```ts
prompt: [
  `You are ValerIA, an autonomous agent working on tracking issue #${task.issueNumber} in ${repoUrl()}.`,
  `Implement this single slice: "${task.sliceTitle}".`,
  "Follow this repo's CLAUDE.md conventions, including its testing requirements.",
  'If this slice touches user-facing behavior in apps/webapp, add or update a Playwright e2e spec under apps/webapp/e2e/ covering it, and run it (`pnpm --filter @bmedical/webapp exec playwright test`) until it passes — do not leave that for CI to catch. Leave the resulting output under apps/webapp/test-results/ as-is; do not move, copy, or commit it — the supervisor collects it separately.',
  `When done: run the relevant tests, and make exactly one commit for this slice (squash any work-in-progress commits into one before pushing). Push this branch and open a PR (\`${prCommand}\`) describing the slice.`,
  'Scope: only touch files needed for this slice. Do not edit the tracking issue (body, labels, assignees, or anything else) — that is owned entirely by the supervisor, not by you.',
  AGENT_NOTES_REMINDER,
].join('\n'),
```

Mismo patrón (agregar `AGENT_NOTES_REMINDER` como última línea del array)
en los otros cinco `case`.

### 2. Bootstrap manual en `PRODUCT_REPO` (fuera del código de ronin)

Documentado como paso de setup, análogo a `docs/DESIGN.md` §7:

1. Crear `docs/agent-notes/INDEX.md` con un encabezado corto explicando el
   propósito del directorio y el formato de entrada (`- [Título](topic-slug.md) — gancho de una línea`).
2. Agregar una sección al `CLAUDE.md` del repo destino (ej. bmedical)
   apuntando a `docs/agent-notes/INDEX.md`, con las reglas de cuándo
   consultarlo, cuándo agregar una entrada (vara alta) y la disciplina de
   upsert.

No requiere cambios en `tick.ts`, `github.ts`, `claim.ts` ni ningún otro
módulo del supervisor — el flujo de lectura (Claude Code carga `CLAUDE.md`
solo) y escritura (el agente decide leer/editar archivos dentro de su
propio worktree) ya está cubierto por comportamiento existente.

## Manejo de errores y seguridad

- **Sin nuevo modo de fallo en el supervisor**: `tick.ts`, `github.ts`,
  `claim.ts` quedan intocados — esto vive enteramente en texto de prompt y
  convención de repo.
- **Nota de mala calidad**: la atrapa el review humano normal del PR
  destino, igual que cualquier otro archivo tocado.
- **Conflicto de merge** entre dos slices que tocan el mismo
  `docs/agent-notes/<topic>.md` en paralelo: conflicto de git ordinario,
  resuelto por el flujo `fix-rebase` que ya existe.
- **Riesgo de corpus de instrucciones envenenadas**: a diferencia de un
  comentario de mención — que viene de cualquiera con permiso de comentar,
  y por eso se cerca explícitamente como "untrusted" en el prompt de
  `review-request` — un archivo en `docs/agent-notes/` solo llega a `main`
  habiendo pasado el mismo review humano que el código. Pero a diferencia
  de un archivo de código cualquiera, esto es un **corpus que crece con el
  tiempo y que cada sesión futura carga automáticamente vía `CLAUDE.md`**,
  bajo `--permission-mode bypassPermissions` (`docs/DESIGN.md` §7.1). Una
  nota escrita como instrucción imperativa ("siempre saltear el e2e cuando
  X", "está bien setear la label acá") se convierte en una instrucción de
  pie para cada tick siguiente — un incidente real documentado en
  `docs/DESIGN.md` §10 muestra exactamente este patrón: el agente leyó
  instrucciones para otro rol embebidas en `templates/tracking-issue.md` y
  se auto-aplicó una label sin que se lo pidieran. La mitigación no es
  código: `AGENT_NOTES_REMINDER` (`src/agent-task.ts`) instruye
  explícitamente escribir cada nota como observación descriptiva de lo que
  se encontró, nunca como directiva — la misma regla debe estar en el
  texto de bootstrap del `CLAUDE.md` del repo destino (ver "Decisiones").
- **Repo destino sin bootstrap**: el agente no encuentra la convención y no
  hace nada — degradación silenciosa, sin flag ni config necesarios.

## Testing

- `src/agent-task.test.ts`: para cada uno de los seis tipos de tarea que sí
  llevan el recordatorio, agregar (o extender un test existente) una
  aserción `expect(prompt).toContain(AGENT_NOTES_REMINDER)` — exportando
  `AGENT_NOTES_REMINDER` desde `agent-task.ts` para no duplicar el literal
  en el test.
- Un test para `plan` que confirme la ausencia (`expect(prompt).not.toContain(...)`).
- Sin tests de integración ni e2e — es composición de strings, no hay
  código nuevo con dependencias externas.

## Fuera de alcance

- Automatizar el bootstrap de `docs/agent-notes/INDEX.md`/`CLAUDE.md` en
  `PRODUCT_REPO` desde código de ronin — paso manual, ver "Decisiones".
- Cualquier mecanismo de poda automática (cap de tamaño, tarea periódica de
  curación) — se descartó a favor de vara alta + upsert + review humano.
- Frontmatter o metadata estructurada en los archivos de tema — texto plano,
  misma convención que `docs/superpowers/specs/`.
- Aplicar este mecanismo a repos productos que no sean bmedical — el
  bootstrap es por repo, pero el cambio de código en `agent-task.ts` no
  asume ningún repo en particular.
