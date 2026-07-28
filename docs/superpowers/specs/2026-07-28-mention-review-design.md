# Review de ValerIA vía @mención en PRs propios

## Contexto

ValerIA abre PRs en `PRODUCT_REPO` bajo la identidad del GitHub App
(`ValerIA[bot]`, ver `docs/DESIGN.md` §7). Hoy no hay forma de pedirle
feedback puntual sobre uno de esos PRs, al estilo "@copilot revisá esto" —
solo el loop automático de `tick.ts` (checks, review humano, merge).

Como GitHub no expone a apps de terceros el mismo mecanismo nativo que usa
Copilot (aparecer en el selector de "Reviewers"), y como el bot user de un
App no siempre es mencionable/notificable de forma confiable, se creó un
usuario dedicado, `valeria-agent` (misma técnica que usa la integración de
Claude Code), agregado como colaborador **solo-lectura** de `PRODUCT_REPO`
puramente para que `@valeria-agent` en un comentario dispare una
notificación real. Ese usuario no tiene ni necesita permisos de escritura:
quien postea reacciones y reviews sigue siendo el App, vía su installation
token, igual que hoy.

El supervisor (`tick.ts`) es 100% polling — no hay servidor ni webhook
expuesto (§9, §3 del diseño). Este cambio se mantiene consistente con eso:
detecta menciones leyendo comentarios en el próximo tick (hasta 5 min de
latencia), sin infraestructura nueva.

## Objetivo

Que un humano pueda escribir `@valeria-agent <pedido>` en un comentario
general o inline de un PR abierto por ValerIA, y que en el próximo tick el
supervisor postee una review formal (comentarios inline + resumen general)
respondiendo a ese pedido, sin nunca aprobar ni bloquear el PR por su
cuenta — el approval-gate humano (ver "Principios de diseño") sigue siendo
la única vía para habilitar el merge.

## Decisiones

- **Alcance**: solo PRs que ValerIA abrió (los que `tick.ts` ya trackea vía
  `getOpenPrForIssue`), no cualquier PR del repo — reusa el descubrimiento
  existente, sin escanear el repo entero.
- **PRs en draft se ignoran**: mismo criterio que ya aplica el resto de
  `processIssue` (checks/review no corren en draft) — una mención en un PR
  todavía en draft queda sin procesar hasta que salga de ese estado.
- **Ambos tipos de comentario**: generales (issue comments) e inline (review
  comments) — un pedido tipo "@valeria-agent fijate esta línea" es un caso de
  uso natural y no tiene sentido cubrir solo uno de los dos.
- **Comentarios de una review en `PENDING` (borrador, no enviada) se
  ignoran**: no son un pedido real hasta que su autor la publica — actuar
  sobre ellos sería reaccionar a algo que todavía puede cambiar o nunca
  enviarse.
- **Review siempre en estado `COMMENT`**: nunca `APPROVE` ni
  `REQUEST_CHANGES`, sin importar lo que encuentre — un bot no debe tener
  poder de gate sobre el merge, coherente con el principio de que
  autor y aprobador nunca pueden ser la misma identidad.
- **Dedup por reacción 👀**: al procesar con éxito una mención se le agrega
  la reacción `eyes` vía la API — señal visible para humanos de "visto", sin
  necesitar estado local nuevo (`claim.ts` ya usa labels/estado local para
  otras cosas; esto no lo reutiliza porque la granularidad es por-comentario,
  no por-issue).
- **Reintento sin límite**: si la generación de la review falla (excepción,
  timeout de `claude -p`), no se agrega la reacción y el próximo tick la
  vuelve a levantar como no procesada. Sin límite de intentos — a diferencia
  de `valeria:attempts-N` (que sí tiene límite y escala a un humano), acá se
  decidió explícitamente no bloquear nada más del flujo del issue por un
  review-request que no prospera. **Trade-off aceptado**: un mismatch
  persistente (ej. el diff crece demasiado para el contexto del modelo)
  reintenta indefinidamente sin nunca notificar a nadie — reconsiderar si en
  la práctica esto genera ruido o costo de tokens no controlado.
- **Falla local, no bloquea el issue**: un error en `review-request` se
  loguea y se ignora a nivel de ese PR — no dispara `notifyBlocker` ni pone
  el issue en `blocked`, porque es un flujo secundario (feedback puntual),
  no el loop principal de slices.

## Diseño

### 1. `src/config.ts`

Nueva variable:

```ts
// Usuario dedicado (no el bot user del App) creado solo para que @mencionarlo
// dispare notificación real — mismo approach que usa la integración de
// Claude Code. Colaborador solo-lectura de PRODUCT_REPO; quien realmente
// postea reacciones/reviews sigue siendo el App vía installation token.
mentionHandle: process.env.VALERIA_MENTION_HANDLE ?? 'valeria-agent',
// Slug del GitHub App (no el usuario valeria-agent) — su bot user en la API
// es "${slug}[bot]". Necesario para distinguir "el App ya reaccionó a este
// comentario" de una reacción de cualquier otra persona. Se ve en la URL de
// configuración del App (Settings → Developer settings → GitHub Apps).
githubAppSlug: requireEnv('VALERIA_GITHUB_APP_SLUG'),
```

Detección por regex case-insensitive sobre el body del comentario:
`new RegExp(`\\B@${config.mentionHandle}\\b`, 'i')`.

### 2. `src/github.ts`

Funciones nuevas (mismo patrón de `gh(...)` con `GH_TOKEN` del installation
token, ver línea 17):

- `listIssueComments(prNumber): Promise<Comment[]>` — `gh api
  repos/{owner}/{repo}/issues/{pr}/comments`, incluye `reactions` en la
  respuesta para poder filtrar sin una segunda llamada.
- `listReviewComments(prNumber): Promise<Comment[]>` — mismo patrón contra
  `.../pulls/{pr}/comments` (los inline), **excluyendo los que pertenecen a
  una review en estado `PENDING`** (borrador, no enviada — GitHub la incluye
  en la respuesta cuando el que llama a la API tiene visibilidad de esa
  review en curso). Requiere cruzar con `GET .../pulls/{pr}/reviews` para
  saber qué `pull_request_review_id` están en `PENDING` y descartar esos
  comentarios antes de devolver la lista: un comentario que su autor todavía
  no publicó no es un pedido real todavía.
- `addReaction(commentId: number, kind: 'issue' | 'review', content:
  'eyes'): Promise<void>` — `POST .../issues/comments/{id}/reactions` o
  `.../pulls/comments/{id}/reactions` según `kind`.

No hace falta una función de posteo de review acá: quien publica la review
formal (comentarios inline + resumen) es el propio `claude -p` corriendo
dentro de su worktree, vía `gh` directo — igual que ya hace `fix-review`
para pushear commits, ver sección 4. El supervisor solo lee comentarios y
marca reacciones.

`Comment` es `{ id: number; kind: 'issue' | 'review'; body: string;
reactions: string[] }`.

### 3. `src/mentions.ts` (nuevo módulo)

```ts
export async function findUnprocessedMentions(prNumber: number): Promise<Comment[]>
```

Combina `listIssueComments` + `listReviewComments`, filtra primero por el
regex de mención. El listado base de comentarios solo trae un conteo
agregado de reacciones (`reactions.eyes: number`), no quién reaccionó — así
que, únicamente para los comentarios que matchean el regex y tienen
`reactions.eyes > 0`, hace una segunda llamada (`GET .../reactions?content=eyes`)
y descarta el comentario si algún `user.login` de esa lista es el bot user
del App (`${config.githubAppSlug}[bot]`). Evita la llamada extra para el
caso común (comentario nuevo, sin ninguna reacción todavía).

Un módulo separado en vez de agregarlo a `tick.ts` — que ya orquesta bastante
— o a `github.ts` — que es la capa de bajo nivel contra `gh`, no lógica de
negocio.

### 4. `src/agent-task.ts`

Nuevo variante de `AgentTask`:

```ts
| { type: 'review-request'; issueNumber: number; prNumber: number; mentions: Comment[] }
```

Prompt (mismo estilo que `fix-review`): lista los textos de las menciones
como contexto, indica leer el diff (`gh pr diff <n>`), postear comentarios
inline vía `gh api .../pulls/{n}/reviews` (`event: COMMENT`) para lo
puntual y un resumen vía `gh pr review <n> --comment` para lo general.
Explícito: **nunca usar `APPROVE` ni `REQUEST_CHANGES`** bajo ninguna
circunstancia. No tocar labels ni el body del issue.

Corre en el worktree del branch del PR (`ensureWorktree(pr.headRefName)`,
igual que `fix-review`) — necesita el código real para dar una review con
contexto, no solo el diff en texto plano.

### 5. `src/tick.ts`

Dentro de `processIssue`, agregado **después** del `if (pr.isDraft) return`
— un PR en draft se ignora por completo, igual que ya ignora checks/review
en ese estado; una mención ahí queda simplemente sin procesar hasta que el
PR salga de draft (no se marca con 👀, así que el primer tick post-draft la
levanta normalmente):

```ts
if (pr.isDraft) return; // ya existente

const mentions = await findUnprocessedMentions(pr.number);
if (mentions.length > 0) {
  try {
    await runAgentTask({ type: 'review-request', issueNumber: issue.number, prNumber: pr.number, mentions });
    for (const m of mentions) await addReaction(m.id, m.kind, 'eyes');
  } catch (error) {
    log.error(`review-request failed for PR #${pr.number}`, error);
    // Sin reacción → el próximo tick los vuelve a levantar como no procesados.
  }
}
```

Try/catch local, separado del `try` grande de `tick()` que rodea
`processIssue` — una falla acá no debe poner el issue en `blocked`.

## Testing

- `findUnprocessedMentions`: unit tests con fixtures de respuesta de `gh
  api` — cubrir match de mención en ambos tipos de comentario, case
  insensitivity, y exclusión de comentarios ya reaccionados.
- `processIssue`: test del branch nuevo con `runAgentTask`/`addReaction`
  mockeados — confirmar que reacciona solo tras éxito, y que una excepción
  no propaga hacia el catch de `tick()` (el issue no debe terminar en
  `blocked` por esto).
- Sin e2e — no hay UI involucrada.

## Fuera de alcance

- Límite de reintentos / escalamiento a humano si una mención nunca se
  puede procesar (trade-off documentado arriba, no resuelto en esta spec).
- Dar a `valeria-agent` cualquier permiso más allá de solo-lectura, o
  explorar el flujo nativo de "Request review" de GitHub — el usuario
  existe puramente para que el @mention notifique.
- Menciones en PRs que ValerIA no abrió.
