# Review de ValerIA vía @mención Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a human write `@valeria-agent <ask>` in a comment (general or inline) on a PR ValerIA opened, and have the supervisor post a formal, comment-only GitHub review addressing it on its next tick.

**Architecture:** `tick.ts`'s existing per-issue poll gets one more step: after the existing `isDraft` early-return, it asks a new `mentions.ts` module for any comment mentioning the configured handle that the App hasn't reacted to yet. If there are any, it runs a new `review-request` `AgentTask` (same worktree + headless `claude -p` pipeline as `fix-review`/`fix-e2e`) that reads the diff and posts the review itself via `gh`. Only on success does the supervisor mark those comments with an `eyes` reaction — a failure is logged and silently retried next tick.

**Tech Stack:** TypeScript (Node ESM, `NodeNext`), `gh api` via `execFile`, Vitest for unit tests.

Full design background: `docs/superpowers/specs/2026-07-28-mention-review-design.md`.

## Global Constraints

- Alcance: solo PRs que ValerIA abrió (los que `tick.ts` ya trackea vía `getOpenPrForIssue`) — nunca cualquier PR del repo.
- PRs en draft se ignoran por completo — el chequeo de menciones va después del `if (pr.isDraft) return` existente.
- Cubre ambos tipos de comentario: generales (issue comments) e inline (review comments).
- Comentarios que pertenecen a una review todavía en estado `PENDING` (borrador, no enviada) se excluyen — no son un pedido real todavía.
- La review que postea el agente es **siempre** evento `COMMENT` — nunca `APPROVE` ni `REQUEST_CHANGES`.
- Dedup vía reacción `eyes`, agregada por el App **solo después** de que la review se posteó con éxito. Una falla no marca nada — el próximo tick reintenta, sin límite de intentos (trade-off aceptado, documentado en la spec).
- Una falla en el flujo de mención es local: se loguea y no bloquea el issue ni el resto de `processIssue` — no usa el `try` grande de `tick()`.
- **Prerequisito de infraestructura de test**: este plan asume que `docs/superpowers/plans/2026-07-28-stacked-prs.md` Task 1 (agrega Vitest: `pnpm add -D vitest`, `vitest.config.ts`, script `pnpm test`) ya se aplicó a este checkout. Si `pnpm test` no existe todavía como script en `package.json`, ejecutar esa Task 1 primero — no se duplica acá.
- Convención de imports: ESM con extensión `.js` en cada import relativo (`moduleResolution: NodeNext`).
- Nunca importar `config.js` (ni nada que lo importe transitivamente) desde un módulo que se quiera testeable sin mockear — `config.ts` llama `requireEnv` a nivel de módulo y explota sin las env vars reales. `mentions.ts` sí importa `config.js` y `github.js`, así que su test mockea ambos módulos enteros con `vi.mock(...)` antes del import real (mismo patrón que `checklist.test.ts` en el plan de stacked-prs).
- Sin test dedicado para cambios de pura orquestación de I/O real (`github.ts`, `agent-task.ts`, `tick.ts`) — se verifican con `pnpm typecheck` + la suite completa + un dry run manual, mismo criterio que ya usa el resto del proyecto (ver Task 10 de `stacked-prs.md`).

---

### Task 1: Config nueva (`mentionHandle`, `githubAppSlug`)

**Files:**
- Modify: `src/config.ts:41-44` (justo después de `githubAppInstallationId`)
- Modify: `.env.example:9` (justo después de `VALERIA_GITHUB_APP_INSTALLATION_ID`)

**Interfaces:**
- Produces: `config.mentionHandle: string` (default `'valeria-agent'`), `config.githubAppSlug: string` (requerido, sin default) — usados por `src/mentions.ts` (Task 3).

- [ ] **Step 1: Agregar las dos variables a `src/config.ts`**

En el objeto `config`, inmediatamente después de la línea `githubAppInstallationId: requireEnv('VALERIA_GITHUB_APP_INSTALLATION_ID'),`:

```ts
  // Usuario dedicado (no el bot user del App) creado solo para que
  // @mencionarlo dispare notificación real — mismo approach que usa la
  // integración de Claude Code. Colaborador solo-lectura de PRODUCT_REPO;
  // quien realmente postea reacciones/reviews sigue siendo el App vía
  // installation token. Ver docs/superpowers/specs/2026-07-28-mention-review-design.md.
  mentionHandle: process.env.VALERIA_MENTION_HANDLE ?? 'valeria-agent',
  // Slug del GitHub App (no el usuario valeria-agent) — su bot user en la
  // API es "${slug}[bot]". Necesario para distinguir "el App ya reaccionó a
  // este comentario" de una reacción de cualquier otra persona. Se ve en la
  // URL de configuración del App (Settings → Developer settings → GitHub Apps).
  githubAppSlug: requireEnv('VALERIA_GITHUB_APP_SLUG'),
```

- [ ] **Step 2: Documentar las variables en `.env.example`**

Inmediatamente después de la línea `VALERIA_GITHUB_APP_INSTALLATION_ID=`:

```bash

# Slug del App (ver la URL de su página de configuración) — su bot user es
# "<esto>[bot]", usado para saber si el App ya reaccionó a un comentario.
VALERIA_GITHUB_APP_SLUG=

# Usuario dedicado (no el App) que se puede @mencionar en un PR para pedirle
# una review puntual a ValerIA — ver docs/superpowers/specs/2026-07-28-mention-review-design.md.
# Default: valeria-agent.
VALERIA_MENTION_HANDLE=
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 4: Commit**

```bash
git add src/config.ts .env.example
git commit -m "feat: add mentionHandle and githubAppSlug config for PR mention reviews"
```

---

### Task 2: `github.ts` — leer comentarios/reacciones y postear reacción

**Files:**
- Modify: `src/github.ts` (agregar al final del archivo, después de `commentOnSpecPr`)

**Interfaces:**
- Produces:
  - `interface Comment { id: number; kind: 'issue' | 'review'; body: string; reactionsEyes: number }`
  - `listIssueComments(prNumber: number): Promise<Comment[]>`
  - `listReviewComments(prNumber: number): Promise<Comment[]>` (excluye comentarios de reviews `PENDING`)
  - `hasBotReaction(commentId: number, kind: 'issue' | 'review', botLogin: string): Promise<boolean>`
  - `addReaction(commentId: number, kind: 'issue' | 'review', content: 'eyes'): Promise<void>`
- Consumidos por `src/mentions.ts` (Task 3) y `src/tick.ts` (Task 5).
- Sin test dedicado (capa de I/O contra `gh`, mismo criterio que el resto de `github.ts`) — se verifica con `pnpm typecheck`.

- [ ] **Step 1: Agregar el tipo `Comment` y el helper de path por `kind`**

Al final de `src/github.ts`:

```ts
export interface Comment {
  id: number;
  kind: 'issue' | 'review';
  body: string;
  reactionsEyes: number;
}

interface RawApiComment {
  id: number;
  body: string;
  reactions: { eyes: number };
  pull_request_review_id?: number | null;
}

function reactionsPath(kind: 'issue' | 'review'): string {
  return kind === 'issue' ? 'issues/comments' : 'pulls/comments';
}
```

- [ ] **Step 2: Agregar `listIssueComments`**

```ts
export async function listIssueComments(prNumber: number): Promise<Comment[]> {
  const stdout = await gh(['api', `repos/{owner}/{repo}/issues/${prNumber}/comments`]);
  const raw = JSON.parse(stdout) as RawApiComment[];
  return raw.map((c) => ({ id: c.id, kind: 'issue' as const, body: c.body, reactionsEyes: c.reactions.eyes }));
}
```

- [ ] **Step 3: Agregar `listReviewComments`, excluyendo reviews `PENDING`**

```ts
interface RawReview {
  id: number;
  state: string;
}

// Excluye comentarios que pertenecen a una review todavía en borrador
// (PENDING, no enviada) — no son un pedido real hasta que su autor la
// publica. Ver docs/superpowers/specs/2026-07-28-mention-review-design.md.
export async function listReviewComments(prNumber: number): Promise<Comment[]> {
  const [commentsStdout, reviewsStdout] = await Promise.all([
    gh(['api', `repos/{owner}/{repo}/pulls/${prNumber}/comments`]),
    gh(['api', `repos/{owner}/{repo}/pulls/${prNumber}/reviews`]),
  ]);
  const rawComments = JSON.parse(commentsStdout) as RawApiComment[];
  const rawReviews = JSON.parse(reviewsStdout) as RawReview[];
  const pendingReviewIds = new Set(rawReviews.filter((r) => r.state === 'PENDING').map((r) => r.id));

  return rawComments
    .filter((c) => !(c.pull_request_review_id != null && pendingReviewIds.has(c.pull_request_review_id)))
    .map((c) => ({ id: c.id, kind: 'review' as const, body: c.body, reactionsEyes: c.reactions.eyes }));
}
```

- [ ] **Step 4: Agregar `hasBotReaction` y `addReaction`**

```ts
export async function hasBotReaction(commentId: number, kind: 'issue' | 'review', botLogin: string): Promise<boolean> {
  const stdout = await gh(['api', `repos/{owner}/{repo}/${reactionsPath(kind)}/${commentId}/reactions?content=eyes`]);
  const raw = JSON.parse(stdout) as Array<{ user: { login: string } }>;
  return raw.some((r) => r.user.login === botLogin);
}

export async function addReaction(commentId: number, kind: 'issue' | 'review', content: 'eyes'): Promise<void> {
  await gh(['api', `repos/{owner}/{repo}/${reactionsPath(kind)}/${commentId}/reactions`, '-f', `content=${content}`]);
}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/github.ts
git commit -m "feat: read PR comments/reactions and post reactions for mention detection"
```

---

### Task 3: `src/mentions.ts` — detectar menciones no procesadas

**Files:**
- Create: `src/mentions.ts`
- Create: `src/mentions.test.ts`

**Interfaces:**
- Consumes: `listIssueComments`, `listReviewComments`, `hasBotReaction`, `type Comment` de `./github.js` (Task 2); `config.mentionHandle`, `config.githubAppSlug` de `./config.js` (Task 1).
- Produces: `findUnprocessedMentions(prNumber: number): Promise<Comment[]>` — usado por `src/tick.ts` (Task 5).

- [ ] **Step 1: Escribir el test file completo (fallará: `mentions.ts` no existe)**

`src/mentions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { mentionHandle: 'valeria-agent', githubAppSlug: 'valeria' },
}));

const issueComments = vi.fn();
const reviewComments = vi.fn();
const botReaction = vi.fn();

vi.mock('./github.js', () => ({
  listIssueComments: (...args: unknown[]) => issueComments(...args),
  listReviewComments: (...args: unknown[]) => reviewComments(...args),
  hasBotReaction: (...args: unknown[]) => botReaction(...args),
}));

import { findUnprocessedMentions } from './mentions.js';

beforeEach(() => {
  issueComments.mockReset().mockResolvedValue([]);
  reviewComments.mockReset().mockResolvedValue([]);
  botReaction.mockReset().mockResolvedValue(false);
});

describe('findUnprocessedMentions', () => {
  it('returns an issue comment that mentions the handle and has no reactions yet', async () => {
    issueComments.mockResolvedValue([
      { id: 1, kind: 'issue', body: 'hey @valeria-agent can you check this?', reactionsEyes: 0 },
      { id: 2, kind: 'issue', body: 'no mention here', reactionsEyes: 0 },
    ]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: 'hey @valeria-agent can you check this?', reactionsEyes: 0 }]);
  });

  it('matches the handle case-insensitively', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@Valeria-Agent please review', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('includes inline review comments that mention the handle', async () => {
    reviewComments.mockResolvedValue([{ id: 5, kind: 'review', body: '@valeria-agent fijate esta línea', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 5, kind: 'review', body: '@valeria-agent fijate esta línea', reactionsEyes: 0 }]);
  });

  it('excludes a mention already reacted to by the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(true);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
    expect(botReaction).toHaveBeenCalledWith(1, 'issue', 'valeria[bot]');
  });

  it('includes a mention with reactions from other users but not the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(false);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('does not match a longer handle sharing the same prefix', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: 'cc @valeria-agentic-bot', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
  });

  it('skips the extra reaction lookup when reactionsEyes is 0', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@valeria-agent revisá esto', reactionsEyes: 0 }]);

    await findUnprocessedMentions(42);
    expect(botReaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test y confirmar que falla**

Run: `pnpm test mentions.test.ts`
Expected: FAIL — `Cannot find module './mentions.js'` (o equivalente).

- [ ] **Step 3: Implementar `src/mentions.ts`**

```ts
import { listIssueComments, listReviewComments, hasBotReaction, type Comment } from './github.js';
import { config } from './config.js';

function mentionsHandle(body: string, handle: string): boolean {
  return new RegExp(`\\B@${handle}\\b`, 'i').test(body);
}

export async function findUnprocessedMentions(prNumber: number): Promise<Comment[]> {
  const botLogin = `${config.githubAppSlug}[bot]`;
  const [issueComments, reviewComments] = await Promise.all([
    listIssueComments(prNumber),
    listReviewComments(prNumber),
  ]);
  const mentioned = [...issueComments, ...reviewComments].filter((c) => mentionsHandle(c.body, config.mentionHandle));

  const unprocessed: Comment[] = [];
  for (const comment of mentioned) {
    const alreadyReacted = comment.reactionsEyes > 0 && (await hasBotReaction(comment.id, comment.kind, botLogin));
    if (!alreadyReacted) unprocessed.push(comment);
  }
  return unprocessed;
}
```

- [ ] **Step 4: Correr el test y confirmar que todos pasan**

Run: `pnpm test mentions.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add src/mentions.ts src/mentions.test.ts
git commit -m "feat: detect unprocessed @mentions on a PR's comments"
```

---

### Task 4: `agent-task.ts` — tarea `review-request`

**Files:**
- Modify: `src/agent-task.ts:1-11` (imports y union type)
- Modify: `src/agent-task.ts:32-85` (`buildTask`)

**Interfaces:**
- Consumes: `type Comment` de `./github.js` (Task 2).
- Produces: nueva variante de `AgentTask`: `{ type: 'review-request'; issueNumber: number; prNumber: number; mentions: Comment[] }` — usada por `src/tick.ts` (Task 5) vía `runAgentTask`.
- Sin test dedicado (mismo criterio que las demás variantes de `buildTask`, ninguna tiene test hoy — dependen de `getPullRequestStatus`, I/O real). Se verifica con `pnpm typecheck`.

- [ ] **Step 1: Importar `Comment` y agregar la variante al union type**

En `src/agent-task.ts`, cambiar:

```ts
import { getPullRequestStatus } from './github.js';
```

por:

```ts
import { getPullRequestStatus, type Comment } from './github.js';
```

Y en el tipo `AgentTask`, agregar una línea al final de la unión:

```ts
export type AgentTask =
  | { type: 'plan'; issueNumber: number; specPaths: string[] }
  | { type: 'implement-slice'; issueNumber: number; sliceIndex: number; sliceTitle: string }
  | { type: 'fix-review'; issueNumber: number; prNumber: number }
  | { type: 'fix-e2e'; issueNumber: number; prNumber: number }
  | { type: 'review-request'; issueNumber: number; prNumber: number; mentions: Comment[] };
```

- [ ] **Step 2: Agregar el case `'review-request'` en `buildTask`**

Dentro del `switch (task.type)`, después del case `'fix-e2e'` (antes de la llave de cierre del `switch`):

```ts
    case 'review-request': {
      const pr = await getPullRequestStatus(task.prNumber);
      const mentionList = task.mentions
        .map((m) => `- ${m.kind === 'review' ? 'Inline comment' : 'Comment'} (id ${m.id}): "${m.body}"`)
        .join('\n');
      return {
        branch: pr.headRefName,
        prompt: [
          `You are ValerIA. A human left the following comment(s) on PR #${task.prNumber} (tracking issue #${task.issueNumber}), mentioning you and asking for a review:`,
          mentionList,
          `Read the current diff ("gh pr diff ${task.prNumber}") and address what was asked.`,
          `Post inline comments on specific lines via "gh api repos/{owner}/{repo}/pulls/${task.prNumber}/reviews" and a general summary via "gh pr review ${task.prNumber} --comment --body <text>".`,
          'The review event must always be COMMENT — never APPROVE or REQUEST_CHANGES, regardless of what you find. Merge approval is reserved for a human, not for you.',
          'Do not edit the tracking issue or change any labels, on either the issue or this PR — that is owned entirely by the supervisor, not by you.',
        ].join('\n'),
      };
    }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores — confirma que el `switch` sigue siendo exhaustivo y que `task.mentions` tipa correctamente.

- [ ] **Step 4: Commit**

```bash
git add src/agent-task.ts
git commit -m "feat: add review-request agent task for @mention-triggered PR reviews"
```

---

### Task 5: `tick.ts` — enganchar la detección de menciones

**Files:**
- Modify: `src/tick.ts:1-27` (imports)
- Modify: `src/tick.ts:114-186` (`processIssue`)

**Interfaces:**
- Consumes: `findUnprocessedMentions` de `./mentions.js` (Task 3); `addReaction` de `./github.js` (Task 2); `log` de `./logger.js`.
- Sin test dedicado — orquestación de I/O real (`gh`, `git`, `claude -p`), mismo criterio que el resto de `processIssue`. Se verifica con `pnpm typecheck` + la suite completa + un dry run manual (Task 6).

- [ ] **Step 1: Agregar los imports nuevos**

En el bloque de imports de `src/tick.ts`, agregar:

```ts
import { findUnprocessedMentions } from './mentions.js';
```

Y agregar `addReaction` a la lista ya importada de `./github.js`:

```ts
import {
  createTrackingIssue,
  listTrackingIssues,
  listAssignedSpecPrs,
  setPrState,
  getSpecPathsFromPr,
  mergeSpecPr,
  commentOnSpecPr,
  getOpenPrForIssue,
  mergePullRequest,
  setIssueState,
  incrementAttemptCount,
  hasEvidenceComment,
  postEvidenceComment,
  addReaction,
  type TrackingIssue,
  type PullRequestStatus,
} from './github.js';
```

Y agregar el import del logger:

```ts
import { log } from './logger.js';
```

- [ ] **Step 2: Agregar el chequeo de menciones en `processIssue`, después del `isDraft` return**

En `src/tick.ts`, dentro de `processIssue`, el bloque:

```ts
  if (pr.isDraft) {
    // A draft PR has no checks/review yet by design — that's not a failure
    // state. Left alone until it's marked ready for review (out of scope
    // for this scaffold: nothing currently marks a draft ready).
    return;
  }
```

pasa a:

```ts
  if (pr.isDraft) {
    // A draft PR has no checks/review yet by design — that's not a failure
    // state. Left alone until it's marked ready for review (out of scope
    // for this scaffold: nothing currently marks a draft ready). A mention
    // left here is ignored too, until the PR leaves draft — see
    // docs/superpowers/specs/2026-07-28-mention-review-design.md.
    return;
  }

  const mentions = await findUnprocessedMentions(pr.number);
  if (mentions.length > 0) {
    try {
      await runAgentTask({ type: 'review-request', issueNumber: issue.number, prNumber: pr.number, mentions });
      for (const m of mentions) await addReaction(m.id, m.kind, 'eyes');
    } catch (error) {
      // Local failure, not the issue-wide catch in tick(): a review-request
      // that doesn't land shouldn't block the slice loop. No reaction was
      // added, so the next tick picks these same comments up again.
      log.error(`review-request failed for PR #${pr.number}`, error);
    }
  }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 4: Correr la suite completa**

Run: `pnpm test`
Expected: PASS — mismos tests de `mentions.test.ts` (Task 3), nada roto.

- [ ] **Step 5: Commit**

```bash
git add src/tick.ts
git commit -m "feat: trigger a review-request when a tracked PR gets an unprocessed @mention"
```

---

### Task 6: Verificación final

**Files:** ninguno (solo comandos y un dry run manual)

- [ ] **Step 1: Typecheck completo**

Run: `pnpm typecheck`
Expected: sin errores.

- [ ] **Step 2: Suite completa**

Run: `pnpm test`
Expected: PASS — los 7 tests de `mentions.test.ts` (y cualquier otro test ya existente en el checkout).

- [ ] **Step 3: Setear las env vars nuevas**

En el `.env` real (no en `.env.example`), completar:
- `VALERIA_GITHUB_APP_SLUG` con el slug del App ya registrado (visible en la URL de su página de configuración, `github.com/settings/apps/<slug>`).
- `VALERIA_MENTION_HANDLE` (opcional, default `valeria-agent`) solo si el usuario mencionable tiene otro nombre.

- [ ] **Step 4: Dry run manual contra un PR real (fuera del alcance de test automatizado)**

1. Con un PR real abierto por ValerIA en `PRODUCT_REPO` (no draft), dejar un comentario general: `@valeria-agent ¿podés revisar el manejo de errores de esta función?`.
2. Dejar además un comentario inline sobre una línea puntual del diff, mencionando también al handle.
3. Correr `pnpm tick` (o esperar al próximo ciclo de cron) y seguir el log (`tail -f logs/tick-$(date +%F).log`).
4. Confirmar en GitHub: el PR tiene una review nueva en estado `Commented` (nunca `Approved`/`Changes requested`), con un comentario inline sobre la línea señalada y un resumen general.
5. Confirmar que ambos comentarios originales (general e inline) tienen la reacción 👀 del App.
6. Dejar un tercer comentario, esta vez como parte de una review en borrador sin enviar (`Start a review`, sin hacer submit) mencionando al handle — confirmar que el próximo tick lo ignora (no aparece review nueva, no se agrega reacción) mientras siga sin enviarse.
7. Correr `pnpm tick` una segunda vez sin agregar comentarios nuevos — confirmar que no se dispara una segunda review-request (los comentarios ya reaccionados no vuelven a aparecer en `findUnprocessedMentions`).
