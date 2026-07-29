# Evidencia e2e disparada por @mención en un PR

## Contexto

El flujo automático de evidencia (`docs/DESIGN.md` §4, `src/evidence.ts`)
solo corre una vez por PR: cuando el agente termina de implementar una
slice y abre el PR, el siguiente tick del supervisor busca `.png` en
`test-results/`, los publica en `Bmedical/ValerIA` bajo
`evidence/<issue>/<pr>/` y postea un comentario con los links raw —
gateado por `hasEvidenceComment` para que no se repita en cada tick.

Desde el flujo de `@mención` (`docs/superpowers/specs/2026-07-28-mention-review-design.md`),
un humano puede pedirle a ValerIA en un comentario del PR que corra los
e2e y deje evidencia — por ejemplo, después de un cambio manual o para
verificar algo puntual que no formó parte de la slice original. Hoy el
`review-request` `AgentTask` sí puede correr los tests si el prompt se lo
pide implícitamente ("atendé lo que se pidió"), pero el agente headless no
tiene forma de publicar nada en ValerIA (no tiene ese checkout ni ese
propósito) — solo puede responder el comentario en texto, sin links
verificables ni persistentes. Es el caso reportado en PR #240: el agente
corrió la suite, confirmó "2 passed, 0 failed" en texto, pero no hay
evidencia consultable después del hecho.

## Objetivo

Que un `@mención` que pida explícitamente evidencia e2e ("corré los e2e",
"dejá evidencia", equivalentes) dispare, además de la respuesta en texto
que ya existe, una publicación real de los screenshots resultantes en
ValerIA con un comentario nuevo en el PR linkeándolos — reusando el
pipeline de `evidence.ts` en vez de construir uno paralelo.

## Decisiones

- **El agente headless decide si corre e2e, no el supervisor**: el
  supervisor no interpreta el texto del mention — el prompt de
  `review-request` instruye a Claude a correr Playwright únicamente
  cuando el pedido es explícitamente por evidencia/e2e, igual que ya hace
  distinción entre "cambio concreto y accionable" vs "pregunta/opinión"
  para decidir si toca código.
- **El supervisor siempre intenta publicar después de un `review-request`**:
  no valida el texto del comentario por su cuenta — `publishEvidence` ya
  es barato cuando no hay `.png` nuevos (un `readdir` que vuelve vacío), así
  que evita duplicar la lógica de detección de intención en dos lugares.
- **`test-results/` se limpia antes de cada `review-request`**: sin esto,
  cualquier mención no relacionada con evidencia (ej. "renombrá esta
  variable") encontraría screenshots viejos de una corrida anterior y el
  supervisor publicaría evidencia falsa/stale. Solo se limpia para este
  tipo de tarea — `implement-slice` ya arranca en un worktree nuevo y
  `fix-review`/`fix-e2e` quedan fuera de este cambio.
- **Subcarpeta por corrida (`evidence/<issue>/<pr>/<timestamp>/`)**: evita
  que una segunda corrida del mismo spec pise los archivos de la primera
  (o, peor, no tenga nada que comitear si el contenido es idéntico byte a
  byte). Cada publicación queda en su propia carpeta, trazable a un
  momento concreto.
- **Comentario nuevo por cada publicación con evidencia fresca**: no se
  reusa el gate de "una sola vez por PR" (`hasEvidenceComment`) para este
  camino — ese gate sigue existiendo tal cual para el publish automático
  inicial de slice, que sí debe ser único. El publish disparado por mention
  es un evento puntual y cada uno postea su propio comentario, dejando
  historial navegable de qué se pidió y cuándo.
- **Sin límite de reintentos ni bloqueo de issue**: mismo criterio que el
  resto del flujo de mentions — una falla acá (push a ValerIA falla, `gh`
  falla) se loguea y no propaga a `blocked`; sin reacción 👀 si
  `runAgentTask` falla, el mention se reprocesa el próximo tick.

## Diseño

### 1. `src/agent-task.ts` — prompt de `review-request`

Agregar una instrucción explícita al prompt existente (después de la
línea que dice "If the request is concrete and actionable..."):

```
'If (and only if) the request explicitly asks you to run the e2e suite or
leave e2e evidence, run it now (`pnpm --filter @bmedical/webapp exec
playwright test`) and report pass/fail in your reply — do not move, copy,
commit, or delete anything under apps/webapp/test-results/, the supervisor
collects it separately right after this task finishes. For any other kind
of request, do not run the e2e suite.'
```

Antes de invocar `runClaudeHeadless` — pero **solo cuando el `AgentTask`
sea `review-request`** — vaciar `apps/webapp/test-results/` en el worktree
(`rm -rf`, mismo helper que `evidence.ts` ya usa para localizar el dir vía
`config.playwrightTestResultsDir`). Así, cualquier `.png` que exista al
terminar la tarea es garantía de esta corrida puntual, nunca de una
anterior.

### 2. `src/evidence.ts`

`publishEvidence` cambia el destino de:

```ts
const destDir = `evidence/${issueNumber}/${prNumber}`;
```

a:

```ts
const destDir = `evidence/${issueNumber}/${prNumber}/${Date.now()}`;
```

Sin otro cambio de comportamiento — sigue siendo no-op (`return []`) si no
encuentra `.png`, y el resto de la función (clone/reset del checkout,
commit, push) es igual. El publish automático de slice (`processSlicePr`)
no necesita ningún cambio: sigue llamando a esta misma función, ahora cada
corrida cae en su propia subcarpeta con timestamp en vez de una carpeta
plana — irrelevante para ese caso porque ahí solo se llama una vez
(gateado por `hasEvidenceComment`).

### 3. `src/tick.ts`

Dentro del bloque de mentions en `processSlicePr` (línea ~287-299),
después de la línea que ya llama a `runAgentTask({ type: 'review-request', ... })`
y antes de agregar las reacciones 👀:

```ts
await runAgentTask({ type: 'review-request', issueNumber: issue.number, prNumber: pr.number, mentions });

const evidencePaths = await publishEvidence(issue.number, pr.number, worktreeDirFor(pr.headRefName));
if (evidencePaths.length > 0) {
  await postEvidenceComment(pr.number, evidencePaths.map(rawEvidenceUrl));
}

for (const m of mentions) await addReaction(m.id, m.kind, 'eyes');
```

Sigue dentro del mismo `try` local que ya existe para el bloque de
mentions — una falla en `publishEvidence`/`postEvidenceComment` acá se
loguea y no bloquea el issue, mismo criterio que una falla del
`review-request` en sí.

No hace falta tocar el bloque separado de `processSlicePr` que ya llama a
`publishEvidence` gateado por `hasEvidenceComment` (línea ~270) — ese sigue
intacto, es un camino distinto (publish automático inicial de slice, antes
de siquiera llegar al chequeo de mentions).

## Testing

- `agent-task.ts`: test de que el prompt de `review-request` incluye la
  instrucción condicional de e2e, y de que se limpia `test-results/` antes
  de invocar `runClaudeHeadless` solo para este tipo de tarea (mock de
  `rm`/`existsSync`).
- `evidence.ts`: test de que `publishEvidence` escribe bajo una subcarpeta
  nueva por invocación (dos llamadas seguidas con el mismo `resultsDir`
  producen `destDir` distintos).
- `tick.ts`: extender el test existente del branch de mentions — con
  `publishEvidence` mockeado devolviendo paths no vacíos, confirmar que se
  llama `postEvidenceComment`; con `[]`, confirmar que no se llama. Ambos
  casos deben seguir agregando la reacción 👀 tras el `runAgentTask`
  exitoso.
- Sin e2e nuevo — no hay UI involucrada, es lógica de supervisor.

## Fuera de alcance

- Limpiar `test-results/` antes de `fix-review`/`fix-e2e` — quedan con su
  comportamiento actual, este cambio es específico de `review-request`.
- Responder el evidence comment *dentro* del hilo del mention original en
  vez de como comentario nuevo — decisión explícita, ver sección
  "Decisiones".
- Cualquier cambio al gate `hasEvidenceComment` del publish automático de
  slice (`processSlicePr` línea ~270) — sigue siendo "una vez por PR" tal
  cual hoy.
