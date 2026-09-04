# /fix-comments en PRs externos de colaboradores confiables

> **Corrección post-implementación (2026-08-22):** este documento describe
> la señal de confianza original, `author_association`. Se descubrió en vivo
> (PR #599) que es inutilizable con el PAT fine-grained de ronin: ese token
> no tiene visibilidad de membresía de organización, así que GitHub reporta
> `CONTRIBUTOR` para un miembro/owner real en vez de `MEMBER`/`OWNER`,
> rechazando comandos legítimos. La implementación real usa en su lugar
> `GET /repos/{owner}/{repo}/collaborators/{login}/permission`
> (`admin`/`maintain`/`write`), que lee el ACL real del repo y no depende de
> esa visibilidad. `Comment.authorAssociation` no existe — el campo real es
> `Comment.authorLogin`. El resto de este documento queda como registro del
> diseño original; donde mencione `author_association`/`authorAssociation`,
> léase como la verificación de permiso descrita arriba.
>
> **Segunda corrección (2026-08-22):** `openThreads` para
> `fix-comments-external` no usa `listExternalOpenReviewThreads` (hilos que
> el bot no abrió) como dice el resto de este documento — usa
> `listAllOpenReviewThreads`, sin filtrar por autor. Motivo: en el caso
> real (PR #599) los únicos hilos abiertos eran hallazgos del propio
> `ronin-agent` de una pasada previa de `external-review`, y el humano que
> dispara `/fix-comments` en este camino confiable quiere que también se
> corrijan esos, no solo los de Copilot o de otro humano. Esto es
> exclusivo de `fix-comments-external`; el `/fix-comments` interno (PRs
> propios de ronin) sigue excluyendo sus propios hilos, sin cambios.
>
> **Tercera corrección (2026-09-02):** se eliminó por completo el chequeo de
> `collaborators/{login}/permission` descrito en la primera corrección de
> arriba. Ese endpoint requiere el permiso `Administration` del PAT
> fine-grained, que en un repo de organización necesita aprobación de un
> admin de la org y no está disponible de forma confiable — en vivo, causaba
> que `findPrsNeedingReview` descartara el PR entero cada tick
> (`external-review.ts`, catch por PR). Dado el tamaño del equipo (pocas
> personas, casi todas con `write`), `findTrustedFixCommentsCommand` ahora
> confía en cualquier autor con login real que comente `/fix-comments` en un
> PR no-fork — sin llamar a la API de permisos en absoluto. El único gate que
> queda es `!pr.isCrossRepository` (un PR de un fork nunca entra a este
> camino, sin importar quién comente).
>
> **Cuarta corrección (2026-09-02):** el worktree de `fix-comments-external`
> ya no se crea con `ensureWorktree` (checkout normal por nombre de rama).
> Reproducido en vivo en PR #336 (rama `feat/prescription-frequency-input`):
> esa rama es la del propio humano que dispara `/fix-comments`, y suele estar
> checked out al mismo tiempo en el checkout principal — git rechaza
> `worktree add <dir> <branch>` cuando la rama ya está en uso en otro
> working tree, así que esto fallaba en cada tick mientras la persona
> siguiera trabajando ahí. `ensureTrustedFixWorktree` (`worktree.ts`) resuelve
> esto igual que `ensureExternalReviewWorktree` para forks: checkout
> `--detach` en `origin/<branch>`, que nunca reclama la rama en exclusiva.
> Como consecuencia, el prompt de este task ya no le dice al agente que haga
> un `git push --force-with-lease` implícito a la rama actual — al estar en
> detached HEAD sin upstream, necesita el refspec explícito
> (`git push --force-with-lease origin HEAD:<branch>`).

## Contexto

`/fix-comments` hoy solo existe en `processSlicePr` (`tick.ts`), el pipeline
de PRs que **ronin abrió** desde una tracking issue. Cuando alguien deja
`@ronin-agent /fix-comments` en un PR que ronin no abrió, ese comentario cae
en `findUnprocessedMentions` dentro de `findPrsNeedingReview`
(`external-review.ts`) — que no distingue el comando de una mención
genérica — y termina disparando el task `external-review`
(`docs/superpowers/specs/2026-08-20-external-pr-review-design.md`), que es
**deliberadamente de solo lectura**: corre en un worktree por SHA sin
`.claude/` ni `CLAUDE.md` (`agent-task.ts`, comentario en `runAgentTask`) y su
prompt nunca instruye a hacer commit ni push, porque ese pipeline existe para
revisar código de origen no confiable (forks, contribuidores externos).

Caso real: PR #599 en `redmotos/shoppingcart`, abierto por un colaborador del
equipo (no un fork), recibió `/fix-comments` y el bot solo repitió los
hallazgos en un comentario — nunca los aplicó, porque el flujo que sí aplica
cambios (`fix-comments` en `agent-task.ts:174`) nunca corrió para ese PR.

Este feature agrega un tercer camino, intermedio entre "PR propio de ronin"
y "PR externo no confiable": un PR que no es de ronin pero tampoco es de un
fork, cuando el comando `/fix-comments` lo deja alguien con permiso de
escritura real en el repo (`author_association` `OWNER`/`MEMBER`/
`COLLABORATOR`), entra a un pipeline con permiso de aplicar y publicar
cambios — sin heredar el aislamiento estricto de `external-review`, porque
ese aislamiento existe para código no confiable y este código no lo es.

## Objetivo

Que un colaborador con permiso de escritura pueda dejar `/fix-comments` en
cualquier PR del repo (propio o de otro colaborador, mientras no sea de un
fork) y obtenga el mismo comportamiento que ya existe para los PRs de ronin:
el bot revisa los hilos de comentarios abiertos que no abrió él mismo, aplica
lo que sea concreto y accionable, hace un solo commit+push, y responde
hilo por hilo y al comando disparador — sin abrir una vía nueva para que
código de un fork no confiable obtenga permiso de escritura.

## Decisiones

- **Alcance: solo PRs del propio repo, nunca forks.** `isCrossRepository`
  (ya disponible en `gh pr list --json`) es la señal — un PR de fork nunca
  entra a este camino sin importar quién comenta, porque el *código* sigue
  siendo de origen externo aunque el *comando* venga de alguien confiable.
- **Verificación explícita de autor del comando**: a diferencia del resto
  del pipeline (que confía en que solo gente con acceso al repo puede
  comentar, sin chequeo en código), este camino sí valida en código que
  quien dejó el `/fix-comments` tiene `author_association` en
  `OWNER`/`MEMBER`/`COLLABORATOR` — defensa en profundidad específica para
  la única vía nueva que le da permiso de escritura a código que ronin no
  escribió.
- **Task dedicado (`fix-comments-external`), no reutilizar `fix-comments`
  interno ni ramificar `external-review`**: el prompt de `fix-comments`
  está redactado en términos de "tracking issue" / "slice" / "supervisor",
  que no aplican a un PR sin issue asociada — forzar esos condicionales lo
  vuelve confuso. Ramificar `external-review` para que a veces escriba
  código mezclaría, en una sola función, el camino más sensible en
  seguridad del sistema (código no confiable, aislado) con uno nuevo que
  necesita permiso de escritura — más superficie para que un descuido
  futuro relaje el aislamiento por defecto.
- **Checkout normal, sin aislamiento de `external-review`**: este camino usa
  `ensureWorktree(pr.headRefName)` igual que `fix-comments`/`review-request`
  — sin el `rm .claude/CLAUDE.md` ni el checkout por SHA de
  `ensureExternalReviewWorktree`, porque ese aislamiento es específico para
  código no confiable.
- **Mismas reglas de aplicación que `fix-comments` interno**: aplicar solo
  lo concreto y accionable, dejar sin tocar lo ambiguo o de diseño, un solo
  `git commit --amend` + `push --force-with-lease` al final, responder cada
  hilo, resolver solo los hilos donde se aplicó un cambio, responder al
  comando disparador con un resumen. Igual prohibición de `gh pr review`,
  de tocar labels/issue, y de mencionar `@handles` de terceros.
- **Sin revalidación en caliente**: si la elegibilidad cambia entre la
  detección y la corrida (el autor pierde permiso, el PR se vuelve fork por
  algún motivo), no hay chequeo adicional a mitad de corrida — mismo nivel
  de staleness que el resto del pipeline ya tolera (`review-request`,
  `fix-comments` interno).
- **Falla local, no bloquea el tick**: mismo patrón que el resto —
  try/catch propio, log-only, sin reacción al comentario si falla (el
  próximo tick reintenta).

## Diseño

### 1. `src/github.ts`

- `Comment` gana un campo:

  ```ts
  export interface Comment {
    id: number;
    kind: 'issue' | 'review';
    body: string;
    reactionsEyes: number;
    authorAssociation: string; // valor crudo de GitHub: OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, etc.
  }
  ```

  `RawApiComment` gana `author_association: string`, y `listIssueComments`/
  `listReviewComments` lo mapean sin transformar — ya viene en la respuesta
  REST de GitHub, no hace falta una llamada nueva.

- `ExternalPr` gana `isCrossRepository: boolean`, y `listAllOpenExternalPrs`
  lo pide en el `--json` (`number,isDraft,headRefName,headRefOid,author,
  isCrossRepository`) y lo pasa sin filtrar — el filtrado de fork ocurre en
  `external-review.ts`, no acá (mismo criterio que el resto del archivo:
  esta capa expone datos, no decide elegibilidad).

### 2. `src/mentions.ts`

Nueva función:

```ts
const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export async function findTrustedFixCommentsCommand(prNumber: number): Promise<Comment[]>
```

Mismo fetch que `findUnprocessedMentions` (issue comments + review comments,
ya sin reacción del bot), filtrado a `c.kind === 'issue' &&
isFixCommentsCommand(c.body) && TRUSTED_ASSOCIATIONS.has(c.authorAssociation)`
— mismo criterio que `processSlicePr` ya aplica hoy (`tick.ts:307`): el
comando solo se reconoce como comentario general, nunca como comentario
inline de review. Los comentarios `/fix-comments`
de alguien fuera de ese set quedan sin marcar (ninguna reacción) y por lo
tanto invisibles para ambos caminos — ni disparan este flujo nuevo ni caen
como mención genérica a `external-review`, así que no hay side effect
observable de un comando no confiable.

### 3. `src/external-review.ts`

`findPrsNeedingReview` separa candidatos en dos listas en vez de una:

```ts
export interface TrustedFixCandidate {
  prNumber: number;
  headRefName: string;
  trigger: Comment[];
  openThreads: ReviewThread[];
}

export async function findPrsNeedingReview(): Promise<{
  reviewCandidates: ReviewCandidate[];
  trustedFixCandidates: TrustedFixCandidate[];
}>
```

Por cada PR de `listAllOpenExternalPrs()`: si `!pr.isCrossRepository`, se
consulta `findTrustedFixCommentsCommand(pr.number)` además del chequeo de
SHA/mención existente. Si hay comando confiable pendiente, el PR va a
`trustedFixCandidates` (con `openThreads` vía `listExternalOpenReviewThreads`,
que ya filtra a "no abiertos por el bot" — exactamente el mismo criterio que
usa `fix-comments` interno) — y **no** entra también a `reviewCandidates`
para este tick, evitando doble procesamiento. Un PR de fork nunca llama a
`findTrustedFixCommentsCommand` — la señal `isCrossRepository` corta antes.

### 4. `src/agent-task.ts`

Nueva variante:

```ts
| { type: 'fix-comments-external'; prNumber: number; headRefName: string; trigger: Comment[]; openThreads: ReviewThread[] }
```

Prompt: copia adaptada del de `fix-comments` (mismo `triggerList`/`threadList`
con el mismo fencing de texto no confiable, mismas reglas de qué aplicar y
qué dejar para un humano, mismo commit único + push, mismas respuestas por
hilo y al comando final), reemplazando el encuadre inicial:

> "You are ronin. A human left the following /fix-comments command on PR
> #{prNumber}, which was opened directly by a human collaborator with write
> access to this repo — not by you, and not tied to any tracking issue."

y quitando toda mención de "tracking issue" / "supervisor owns the issue" —
no aplica acá.

`runAgentTask`: para `fix-comments-external`, `branch = task.headRefName` y
`worktreeDir = await ensureWorktree(branch)` — mismo camino que
`fix-comments`/`review-request`, **no** pasa por la rama `if (task.type ===
'external-review')` que hace `ensureExternalReviewWorktree` ni el `rm`.

### 5. `src/tick.ts`

`runExternalReviews()` desestructura las dos listas de `findPrsNeedingReview`
y las procesa por separado, cada una con su propio `runWithConcurrency`:

```ts
export async function processTrustedFixCandidate(candidate: TrustedFixCandidate): Promise<void> {
  try {
    await runAgentTask({
      type: 'fix-comments-external',
      prNumber: candidate.prNumber,
      headRefName: candidate.headRefName,
      trigger: candidate.trigger,
      openThreads: candidate.openThreads,
    });
    for (const m of candidate.trigger) await addReaction(m.id, m.kind, 'eyes');
  } catch (error) {
    log.error(`fix-comments-external failed for PR #${candidate.prNumber}`, error);
    // Sin reacción → el próximo tick reintenta el mismo comentario.
  }
}
```

Try/catch local por candidato, mismo patrón que
`processExternalReviewCandidate` — una falla acá no debe poner ningún issue
en `blocked` ni abortar el resto del tick.

## Testing

- `github.ts`: `Comment` incluye `authorAssociation` en los mappers de
  `listIssueComments`/`listReviewComments`; `listAllOpenExternalPrs` incluye
  `isCrossRepository` sin filtrarlo.
- `mentions.ts`: `findTrustedFixCommentsCommand` — acepta
  OWNER/MEMBER/COLLABORATOR, rechaza CONTRIBUTOR/NONE/FIRST_TIME_CONTRIBUTOR,
  ignora comentarios que no matchean `/fix-comments`, respeta la misma regla
  de "ya reaccionado" que `findUnprocessedMentions`.
- `external-review.ts`: `findPrsNeedingReview` — un PR de fork con comando
  confiable nunca aparece en `trustedFixCandidates` (solo, si acaso, en
  `reviewCandidates` como mención genérica); un PR no-fork con comando
  confiable aparece en `trustedFixCandidates` y no también en
  `reviewCandidates`; un PR no-fork con comando de alguien no confiable no
  aparece en ninguna de las dos por ese comando (puede seguir apareciendo en
  `reviewCandidates` si además tiene una mención genérica separada).
- `agent-task.ts`: el prompt de `fix-comments-external` no contiene
  "tracking issue"; `runAgentTask` con este tipo llama a `ensureWorktree`
  (no `ensureExternalReviewWorktree`) y no borra `.claude`/`CLAUDE.md`.
- `tick.ts`: `processTrustedFixCandidate` — reacciona solo tras éxito, no
  propaga excepción hacia el catch de `tick()`, mismo estilo que el test
  existente de `processExternalReviewCandidate`.
- Sin e2e — no hay UI involucrada.

## Fuera de alcance

- Extender `review-request` (mención genérica, sin `/fix-comments`) a PRs
  externos confiables — este spec cubre únicamente el comando explícito;
  una mención simple en un PR externo sigue yendo por `external-review`
  de solo lectura, sin excepción.
- Revocar en caliente la elegibilidad si cambia a mitad de corrida — mismo
  trade-off de staleness ya aceptado en el resto del pipeline.
- Configuración de qué `author_association` cuentan como confiables — el
  set `OWNER`/`MEMBER`/`COLLABORATOR` es fijo en código, no una env var.
