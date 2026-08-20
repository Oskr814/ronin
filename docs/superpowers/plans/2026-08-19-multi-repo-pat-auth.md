# Multi-repo + PAT auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one `ronin` instance supervise several product repos from a single cron/process, authenticating as the dedicated `ronin` GitHub account (a PAT) instead of a GitHub App.

**Architecture:** A new mutable "active repo" singleton (`repo-context.ts`) replaces the per-repo fields that today live on the global `config` object; `tick.ts`'s loop iterates a validated `repos.json` list, activating one repo at a time (sequential across repos, `TICK_CONCURRENCY` unchanged within each). `github-app-auth.ts`'s JWT/installation-token machinery is deleted outright in favor of a static PAT read straight from `config`.

**Tech Stack:** TypeScript (Node, ESM, `.js` import specifiers), Vitest, `gh` CLI shelled out via `execFile`.

**Spec:** `docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md`

## Global Constraints

- Repos in `repos.json` are processed strictly in sequence; only the existing per-issue concurrency (`config.tickConcurrency`) runs concurrently, and only within one active repo at a time.
- `RUNNER_ID`, `SPEC_DIR`, `VALERIA_REPO`, and every retry/timeout limit stay global (`.env`), never overridable per repo entry.
- `repos.json` is gitignored; `RONIN_GITHUB_TOKEN` and `RONIN_GITHUB_LOGIN` are required env vars with no default (fail fast at startup, same as every other `requireEnv` field in `config.ts`).
- Every module that needs the active repo's `productRepo`/`productRepoPath`/`worktreeBasePath`/`claudeConfigDir` reads it from `activeRepo()` (`src/repo-context.ts`), never from `config`.
- No test file exists today for `github.ts` or `spec-content.ts` (both are pure `gh`/`git` glue, validated by a manual dry run per repo convention) — this plan doesn't add new ones for the mechanical renames in those files, consistent with the rest of the codebase.

---

### Task 1: `config.ts` gains PAT/repos-config fields, drops GitHub App fields

**Files:**
- Modify: `src/config.ts` (full rewrite of the `config` object)
- Modify: `.env.example`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `config.githubToken: string`, `config.githubLogin: string`, `config.reposConfigPath: string` — consumed by Tasks 3, 5, 7, 9, 10, 11. `config.claudeConfigDir: string` (global fallback, unchanged name) — consumed by Task 7 alongside `activeRepo().claudeConfigDir`.
- Removes: `config.productRepo`, `config.productRepoPath`, `config.worktreeBasePath`, `config.githubAppId`, `config.githubAppPrivateKeyPath`, `config.githubAppInstallationId`, `config.githubAppSlug`, `config.mentionHandle` — no task after this one may reference these.

No test file exists for `config.ts` today (confirmed via `ls src/*.test.ts`) — this task is verified by `pnpm typecheck` after every later task that consumes the new fields, not by a dedicated unit test.

- [ ] **Step 1: Rewrite `src/config.ts`**

```ts
import { join } from 'node:path';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  // Fine-grained PAT de la cuenta de GitHub dedicada `ronin`, invitada como
  // colaboradora en cada repo de repos.json — reemplaza al GitHub App (ver
  // docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md). Token
  // estático: a diferencia del installation token que reemplaza, no hay
  // nada que refrescar ni cachear.
  githubToken: requireEnv('RONIN_GITHUB_TOKEN'),
  // Username real de esa cuenta (sin sufijo "[bot]", no es un App). Usado
  // tanto para detectar @menciones dirigidas al agente (mentions.ts) como
  // para la identidad de los commits de evidencia (evidence.ts).
  githubLogin: requireEnv('RONIN_GITHUB_LOGIN'),
  // Dónde vive la lista de repos a supervisar — ver repos.ts.
  reposConfigPath: process.env.REPOS_CONFIG_PATH ?? join(process.cwd(), 'repos.json'),
  // Ref every new task branch is created from. Defaults to the
  // remote-tracking origin/main (kept fresh by a `git fetch` before each
  // new worktree branch — see worktree.ts) rather than the local `main`
  // branch, since nothing here ever checks out or updates local main
  // directly. Overridable (e.g. a dry run against a throwaway base ref)
  // without needing a code change every time.
  worktreeBaseRef: process.env.WORKTREE_BASE_REF ?? 'origin/main',
  // claude -p runs unattended (nobody to answer permission prompts), and
  // bypassPermissions was chosen deliberately over a curated allowlist —
  // see docs/DESIGN.md §7.1. Containment relies on every task running
  // inside its own disposable git worktree, never the main checkout.
  agentTaskTimeoutMs: Number(process.env.AGENT_TASK_TIMEOUT_MINUTES ?? 30) * 60_000,
  // Binario invocado para las corridas headless. Defaults to plain `claude`;
  // only change this if a genuinely different binary/wrapper script is used.
  claudeCommand: process.env.CLAUDE_COMMAND ?? 'claude',
  // Default global de CLAUDE_CONFIG_DIR — una entrada de repos.json puede
  // pisarlo por repo con su propio claudeConfigDir (ver repo-context.ts);
  // esto es lo que se usa cuando esa entrada no trae el suyo. Empty means
  // "use whatever's ambient".
  claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? '',
  specDir: process.env.SPEC_DIR ?? 'docs/superpowers',
  // Required, not optional: per docs/BLOCKING.md, every blocker always
  // includes an email — a missing value here used to fail lazily, mid
  // incident, inside notifier.ts's transport()/notifyBlocker instead of at
  // startup where a human would actually notice it.
  gmailUser: requireEnv('GMAIL_USER'),
  gmailAppPassword: requireEnv('GMAIL_APP_PASSWORD'),
  notifyTo: requireEnv('NOTIFY_TO'),
  e2eRetryLimit: Number(process.env.E2E_RETRY_LIMIT ?? 2),
  checksPendingRetryLimit: Number(process.env.CHECKS_PENDING_RETRY_LIMIT ?? 60),
  sliceAttemptLimit: Number(process.env.SLICE_ATTEMPT_LIMIT ?? 3),
  rebaseRetryLimit: Number(process.env.REBASE_RETRY_LIMIT ?? 3),
  issueErrorRetryLimit: Number(process.env.ISSUE_ERROR_RETRY_LIMIT ?? 3),
  // How many issues' pipelines (fixes + a possible new-slice start) tick()
  // runs at once *within one active repo* — see repo-context.ts and
  // tick.ts's outer loop for why this stays per-repo, not global-across-repos.
  tickConcurrency: Number(process.env.TICK_CONCURRENCY ?? 2),
  requestCopilotReview: process.env.REQUEST_COPILOT_REVIEW === 'true',
  // A person's GitHub username, e.g. "oskr814" — not a machine hostname.
  // Same RUNNER_ID across every repo in repos.json (confirmed requirement:
  // one operator, not one runner per repo) — see docs/DESIGN.md §1 and §9.
  runnerId: requireEnv('RUNNER_ID'),
  // Base path for the per-machine claim/checks-pending cache — namespaced
  // per active repo by local-state.ts, never read directly as a file path
  // here anymore.
  localStatePath: process.env.LOCAL_STATE_PATH ?? '.valeria-state.json',
  // ValerIA's own repo — e2e screenshot evidence is committed here (main),
  // shared across every repo.json entry, not split per product repo. See
  // docs/DESIGN.md §4.
  valeriaRepo: process.env.VALERIA_REPO ?? 'Bmedical/ValerIA',
  // Playwright's screenshot output dir, relative to each active repo's root.
  playwrightTestResultsDir: process.env.PLAYWRIGHT_TEST_RESULTS_DIR ?? 'apps/webapp/test-results',
} as const;

export const LABEL_MANAGED = 'valeria';
export const LABEL_STATES = {
  ready: 'valeria:ready',
  'in-progress': 'valeria:in-progress',
  blocked: 'valeria:blocked',
  done: 'valeria:done',
} as const;

// bmedical's own pre-existing label ("Something isn't working") — reused as
// the bug-intake trigger instead of a new valeria:-prefixed label, see
// docs/superpowers/specs/2026-07-28-bug-issue-intake-design.md.
export const LABEL_BUG = 'bugfix';

export type SpecStatus = keyof typeof LABEL_STATES;
```

- [ ] **Step 2: Rewrite `.env.example`**

```
# Lista de repos a supervisar — ver repos.json.example y
# docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md.
# repos.json real va gitignored, nunca se commitea. Default: ./repos.json.
REPOS_CONFIG_PATH=

# Fine-grained PAT de la cuenta de GitHub dedicada `ronin` (no un usuario/PAT
# personal), scopeado a Contents/Issues/Pull requests read-write sobre los
# repos de repos.json, con expiración. Setup manual, ver README.md.
RONIN_GITHUB_TOKEN=

# Username real de esa cuenta (sin sufijo [bot], no es un GitHub App) — su
# @mención es la señal para pedirle una review puntual (ver README.md), y es
# la identidad usada para los commits de evidencia (evidence.ts).
RONIN_GITHUB_LOGIN=

SPEC_DIR=docs/superpowers

# Dónde vive cada worktree desechable por tarea (ver docs/DESIGN.md §7.1).
# Default: sibling del productRepoPath de cada entrada de repos.json.
WORKTREE_BASE_PATH=

# Timeout de una invocación headless de `claude -p` antes de considerarla colgada
AGENT_TASK_TIMEOUT_MINUTES=30

# Binario a invocar para las corridas headless. Casi nunca hace falta cambiar esto —
# ver CLAUDE_CONFIG_DIR abajo para el caso de múltiples cuentas.
CLAUDE_COMMAND=claude

# Default global de CLAUDE_CONFIG_DIR — una entrada de repos.json puede
# pisarlo por repo con su propio claudeConfigDir (ver README.md y
# repos.json.example).
CLAUDE_CONFIG_DIR=

# Notificador de bloqueos (Gmail SMTP con app password, no la password de la cuenta)
GMAIL_USER=
GMAIL_APP_PASSWORD=
NOTIFY_TO=

# Reintentos antes de marcar bloqueo (ver docs/BLOCKING.md)
E2E_RETRY_LIMIT=2
SLICE_ATTEMPT_LIMIT=3
ISSUE_ERROR_RETRY_LIMIT=3
# Ticks (≈ minutos, con el cron de a 1/min) que se tolera un CI sin reportar
# nada todavía antes de bloquear — separado de E2E_RETRY_LIMIT porque "CI
# corriendo" nunca debería bloquear por sí solo (ver docs/BLOCKING.md); esto
# es solo la red de seguridad contra un workflow que nunca dispara.
CHECKS_PENDING_RETRY_LIMIT=60

# Opt-in: fuera del loop core por defecto (ver docs/DESIGN.md §3)
REQUEST_COPILOT_REVIEW=false

# Tu usuario de GitHub (ej. oskr814), NO un hostname. Mismo valor para todos
# los repos de repos.json. Usado tanto para que te asignen specs (label
# valeria:runner-<esto> en el PR del spec) como para el claim de issues entre
# supervisores concurrentes (ver docs/DESIGN.md §1 y §9). Requerido, sin default.
RUNNER_ID=

# Cache local de issues ya reclamados por esta máquina, namespaced por repo
# (ver local-state.ts) — nunca commitear (ya está en .gitignore)
LOCAL_STATE_PATH=.valeria-state.json

# Repo de ValerIA — la evidencia de e2e (screenshots) se commitea acá (main),
# compartido entre todos los repos de repos.json (ver docs/DESIGN.md §4)
VALERIA_REPO=Bmedical/ValerIA

# Carpeta de screenshots de Playwright, relativa a la raíz de cada repo activo
# (ver apps/webapp/playwright.config.ts en bmedical)
PLAYWRIGHT_TEST_RESULTS_DIR=apps/webapp/test-results
```

- [ ] **Step 3: Add `repos.json` to `.gitignore`**

Append `repos.json` to `.gitignore` (keep every existing line as-is):

```
node_modules/
dist/
.env
.valeria-state.json
.tick.lock
logs/
# generated by scripts/setup-cron.sh, bakes in a machine-specific PATH
scripts/run-tick.sh
.worktrees/
repos.json
```

- [ ] **Step 4: Typecheck (expected to fail — other files still reference removed config fields)**

Run: `pnpm typecheck`
Expected: FAIL, listing every file that still reads `config.productRepo` / `config.productRepoPath` / `config.worktreeBasePath` / `config.githubApp*` / `config.mentionHandle`. This is the punch list for Tasks 5–10 below — no fix here yet.

- [ ] **Step 5: Commit**

```bash
git add src/config.ts .env.example .gitignore
git commit -m "config: replace GitHub App fields with ronin PAT + repos.json path"
```

---

### Task 2: `repo-context.ts` — active-repo singleton

**Files:**
- Create: `src/repo-context.ts`
- Test: `src/repo-context.test.ts`

**Interfaces:**
- Produces: `interface RepoEntry { productRepo: string; productRepoPath: string; claudeConfigDir?: string }`, `function activeRepo(): RepoEntry & { worktreeBasePath: string }`, `function withActiveRepo<T>(entry: RepoEntry, fn: () => Promise<T>): Promise<T>` — consumed by every task from here on.

- [ ] **Step 1: Write the failing tests**

```ts
// src/repo-context.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { activeRepo, withActiveRepo } from './repo-context.js';

afterEach(() => {
  delete process.env.WORKTREE_BASE_PATH;
});

describe('activeRepo', () => {
  it('throws when called outside withActiveRepo', () => {
    expect(() => activeRepo()).toThrow('activeRepo() called outside withActiveRepo()');
  });
});

describe('withActiveRepo', () => {
  it('makes the entry readable via activeRepo() while fn runs', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => {
      expect(activeRepo().productRepo).toBe('a/b');
      expect(activeRepo().productRepoPath).toBe('/tmp/a');
    });
  });

  it('derives worktreeBasePath as a sibling of productRepoPath by default', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a/checkout' }, async () => {
      expect(activeRepo().worktreeBasePath).toBe('/tmp/a/valeria-worktrees');
    });
  });

  it('honors WORKTREE_BASE_PATH as an override', async () => {
    process.env.WORKTREE_BASE_PATH = '/tmp/custom-worktrees';
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a/checkout' }, async () => {
      expect(activeRepo().worktreeBasePath).toBe('/tmp/custom-worktrees');
    });
  });

  it('carries claudeConfigDir through when the entry has one', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a', claudeConfigDir: '/home/x/.claude-a' }, async () => {
      expect(activeRepo().claudeConfigDir).toBe('/home/x/.claude-a');
    });
  });

  it('resets to null after fn resolves, even when fn throws', async () => {
    await expect(
      withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(() => activeRepo()).toThrow();
  });

  it("returns fn's resolved value", async () => {
    const result = await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => 42);
    expect(result).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/repo-context.test.ts`
Expected: FAIL with "Cannot find module './repo-context.js'"

- [ ] **Step 3: Write `src/repo-context.ts`**

```ts
import { join } from 'node:path';

export interface RepoEntry {
  productRepo: string;
  productRepoPath: string;
  claudeConfigDir?: string;
}

interface ActiveRepo extends RepoEntry {
  worktreeBasePath: string;
}

// Mutable on purpose, not AsyncLocalStorage: repos are processed strictly
// in sequence (tick.ts's outer loop), and the only concurrency that ever
// runs is *within* one active repo (config.tickConcurrency issues at once) —
// see docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md §3.
// A single module-level slot is safe under that constraint and much
// simpler than threading a repo parameter through every function.
let current: ActiveRepo | null = null;

// Null outside an active withActiveRepo call is intentional: anything that
// tries to read repo state outside the loop should crash loudly instead of
// silently reusing a previous repo's context.
export function activeRepo(): ActiveRepo {
  if (!current) throw new Error('activeRepo() called outside withActiveRepo()');
  return current;
}

export async function withActiveRepo<T>(entry: RepoEntry, fn: () => Promise<T>): Promise<T> {
  current = {
    ...entry,
    // Sibling directory to the product repo checkout, not inside it —
    // worktrees come and go per task and should never be mistaken for the
    // main checkout. Same convention config.ts used to derive this
    // globally; WORKTREE_BASE_PATH stays a valid override for every repo.
    worktreeBasePath: process.env.WORKTREE_BASE_PATH ?? join(entry.productRepoPath, '..', 'valeria-worktrees'),
  };
  try {
    return await fn();
  } finally {
    current = null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/repo-context.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/repo-context.ts src/repo-context.test.ts
git commit -m "feat: add active-repo singleton for multi-repo tick loop"
```

---

### Task 3: `repos.ts` — load and validate `repos.json`

**Files:**
- Create: `src/repos.ts`
- Test: `src/repos.test.ts`
- Create: `repos.json.example` (checked in, since the real `repos.json` is gitignored)

**Interfaces:**
- Consumes: `RepoEntry` (Task 2, `./repo-context.js`), `config.reposConfigPath` (Task 1, `./config.js`)
- Produces: `function loadRepos(): Promise<RepoEntry[]>` — consumed by Task 10 (`tick.ts`) and Task 11 (`scripts/smoke-test.ts`, `scripts/init-labels.sh` reads the raw JSON directly via `jq`, not this function, since it's a bash script).

- [ ] **Step 1: Write the failing tests**

```ts
// src/repos.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let reposConfigPath = '';
vi.mock('./config.js', () => ({
  config: new Proxy({}, { get: (_t, prop) => (prop === 'reposConfigPath' ? reposConfigPath : undefined) }),
}));

const { loadRepos } = await import('./repos.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valeria-repos-test-'));
  reposConfigPath = join(dir, 'repos.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadRepos', () => {
  it('loads and validates a well-formed repos.json', async () => {
    await writeFile(
      reposConfigPath,
      JSON.stringify([
        { productRepo: 'a/b', productRepoPath: '/tmp/a' },
        { productRepo: 'c/d', productRepoPath: '/tmp/c', claudeConfigDir: '/home/x/.claude-c' },
      ]),
    );

    const repos = await loadRepos();
    expect(repos).toEqual([
      { productRepo: 'a/b', productRepoPath: '/tmp/a', claudeConfigDir: undefined },
      { productRepo: 'c/d', productRepoPath: '/tmp/c', claudeConfigDir: '/home/x/.claude-c' },
    ]);
  });

  it('throws when the file does not exist', async () => {
    await expect(loadRepos()).rejects.toThrow(`No se pudo leer ${reposConfigPath}`);
  });

  it('throws when the file is not valid JSON', async () => {
    await writeFile(reposConfigPath, '{not json');
    await expect(loadRepos()).rejects.toThrow('no es JSON válido');
  });

  it('throws when the file is an empty array', async () => {
    await writeFile(reposConfigPath, '[]');
    await expect(loadRepos()).rejects.toThrow('al menos un repo');
  });

  it('throws when an entry is missing productRepo', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepoPath: '/tmp/a' }]));
    await expect(loadRepos()).rejects.toThrow('productRepo');
  });

  it('throws when an entry is missing productRepoPath', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b' }]));
    await expect(loadRepos()).rejects.toThrow('productRepoPath');
  });

  it('throws when claudeConfigDir is present but not a string', async () => {
    await writeFile(reposConfigPath, JSON.stringify([{ productRepo: 'a/b', productRepoPath: '/tmp/a', claudeConfigDir: 42 }]));
    await expect(loadRepos()).rejects.toThrow('claudeConfigDir');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/repos.test.ts`
Expected: FAIL with "Cannot find module './repos.js'"

- [ ] **Step 3: Write `src/repos.ts`**

```ts
import { readFile } from 'node:fs/promises';
import { config } from './config.js';
import type { RepoEntry } from './repo-context.js';

export async function loadRepos(): Promise<RepoEntry[]> {
  let raw: string;
  try {
    raw = await readFile(config.reposConfigPath, 'utf8');
  } catch {
    throw new Error(`No se pudo leer ${config.reposConfigPath} — ver REPOS_CONFIG_PATH en .env.example y repos.json.example`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${config.reposConfigPath} no es JSON válido: ${(error as Error).message}`);
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${config.reposConfigPath} debe ser un array con al menos un repo`);
  }

  return parsed.map((entry, i) => validateEntry(entry, i));
}

function validateEntry(entry: unknown, index: number): RepoEntry {
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`${config.reposConfigPath}[${index}] no es un objeto`);
  }
  const { productRepo, productRepoPath, claudeConfigDir } = entry as Record<string, unknown>;
  if (typeof productRepo !== 'string' || productRepo.length === 0) {
    throw new Error(`${config.reposConfigPath}[${index}].productRepo falta o no es un string`);
  }
  if (typeof productRepoPath !== 'string' || productRepoPath.length === 0) {
    throw new Error(`${config.reposConfigPath}[${index}].productRepoPath falta o no es un string`);
  }
  if (claudeConfigDir !== undefined && typeof claudeConfigDir !== 'string') {
    throw new Error(`${config.reposConfigPath}[${index}].claudeConfigDir debe ser un string si está presente`);
  }
  return { productRepo, productRepoPath, claudeConfigDir };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/repos.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Write `repos.json.example`**

```json
[
  {
    "productRepo": "Oskr814/repo-a",
    "productRepoPath": "/home/link/RM/repo-a",
    "claudeConfigDir": "/home/link/.claude-repo-a"
  },
  {
    "productRepo": "Oskr814/repo-b",
    "productRepoPath": "/home/link/RM/repo-b"
  }
]
```

- [ ] **Step 6: Commit**

```bash
git add src/repos.ts src/repos.test.ts repos.json.example
git commit -m "feat: load and validate repos.json"
```

---

### Task 4: `local-state.ts` — namespace state by active repo

**Files:**
- Modify: `src/local-state.ts`
- Modify: `src/local-state.test.ts`

**Interfaces:**
- Consumes: `activeRepo()` (Task 2, `./repo-context.js`)
- No exported signatures change (`readLocalState`, `writeLocalState`, `incrementChecksPendingCount`, `resetChecksPendingCount`, `withLocalStateLock` keep the same names/types) — callers in `claim.ts` and `tick.ts` need no changes for this task.

- [ ] **Step 1: Update `src/local-state.ts`**

Add the import and a `statePath()` helper, and switch both file-touching functions to use it:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { config } from './config.js';
import { activeRepo } from './repo-context.js';

// ... (LocalState interface, withLocalStateLock, queue — unchanged) ...

// Namespaced per active repo so an issue #12 in one repo.json entry never
// shares claimedIssues/checksPendingCounts with a #12 in another — see
// docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md §4.
function statePath(): string {
  const slug = activeRepo().productRepo.replaceAll('/', '-');
  return `${config.localStatePath}.${slug}.json`;
}

export async function readLocalState(): Promise<LocalState> {
  try {
    const raw = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<LocalState>;
    return { claimedIssues: raw.claimedIssues ?? [], checksPendingCounts: raw.checksPendingCounts ?? {} };
  } catch {
    return { claimedIssues: [], checksPendingCounts: {} };
  }
}

export async function writeLocalState(state: LocalState): Promise<void> {
  await writeFile(statePath(), JSON.stringify(state, null, 2));
}
```

(`incrementChecksPendingCount`, `resetChecksPendingCount`, `withLocalStateLock` stay byte-for-byte identical — they already only call `readLocalState`/`writeLocalState`, never touch a path directly.)

- [ ] **Step 2: Update `src/local-state.test.ts`**

Replace the whole file:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let localStatePath = '';
vi.mock('./config.js', () => ({
  config: new Proxy({}, { get: (_t, prop) => (prop === 'localStatePath' ? localStatePath : undefined) }),
}));

const { incrementChecksPendingCount, resetChecksPendingCount, withLocalStateLock, readLocalState } = await import('./local-state.js');
const { withActiveRepo } = await import('./repo-context.js');

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'valeria-local-state-test-'));
  localStatePath = join(dir, 'state.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function withRepo<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  return withActiveRepo({ productRepo: repo, productRepoPath: '/tmp/unused' }, fn);
}

describe('withLocalStateLock', () => {
  it('serializes overlapping critical sections instead of interleaving them', async () => {
    const order: string[] = [];
    const a = withLocalStateLock(async () => {
      order.push('a-start');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a-end');
    });
    const b = withLocalStateLock(async () => {
      order.push('b-start');
      await new Promise((r) => setTimeout(r, 0));
      order.push('b-end');
    });
    await Promise.all([a, b]);
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  it('does not stay locked forever after a critical section throws', async () => {
    await expect(withLocalStateLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');

    await expect(withLocalStateLock(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('incrementChecksPendingCount — concurrent calls', () => {
  it('never loses an update under concurrent increments', async () => {
    await withRepo('owner/repo-a', async () => {
      await Promise.all(Array.from({ length: 20 }, () => incrementChecksPendingCount(229)));
      const state = await readLocalState();
      expect(state.checksPendingCounts['229']).toBe(20);
    });
  });

  it('a concurrent reset does not clobber an in-flight increment', async () => {
    await withRepo('owner/repo-a', async () => {
      await Promise.all([
        incrementChecksPendingCount(229),
        incrementChecksPendingCount(229),
        resetChecksPendingCount(229),
        incrementChecksPendingCount(229),
      ]);

      const raw = await readFile(join(dir, 'state.json.owner-repo-a.json'), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });
  });
});

describe('per-repo namespacing', () => {
  it('keeps checksPendingCounts separate between two repos', async () => {
    await withRepo('owner/repo-a', () => incrementChecksPendingCount(229));

    const stateA = await withRepo('owner/repo-a', readLocalState);
    const stateB = await withRepo('owner/repo-b', readLocalState);

    expect(stateA.checksPendingCounts['229']).toBe(1);
    expect(stateB.checksPendingCounts['229']).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/local-state.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/local-state.ts src/local-state.test.ts
git commit -m "feat: namespace local claim state per active repo"
```

---

### Task 5: Delete GitHub App auth, switch `github.ts` to the PAT + `activeRepo()`

**Files:**
- Delete: `src/github-app-auth.ts`
- Modify: `src/github.ts`

**Interfaces:**
- Consumes: `config.githubToken` (Task 1), `activeRepo()` (Task 2)
- No exported function signatures in `github.ts` change — every caller (`tick.ts`, `claim.ts`, `mentions.ts`, `agent-task.ts`, scripts) keeps working unmodified by this task alone.

No test file exists for `github.ts` (confirmed) — verified by `pnpm typecheck` plus a manual dry run per the codebase's existing convention for `gh`-calling glue.

- [ ] **Step 1: Delete `src/github-app-auth.ts`**

```bash
rm src/github-app-auth.ts
```

- [ ] **Step 2: Update `src/github.ts`'s imports and the two `gh`/`ghApi` helpers**

Replace:

```ts
import { config, LABEL_MANAGED, LABEL_STATES, LABEL_BUG, type SpecStatus } from './config.js';
import { getInstallationToken } from './github-app-auth.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

// All gh invocations use execFile with an argv array (never a shell string) so
// issue/PR titles and bodies coming from spec content can't be interpreted as
// shell syntax. GH_TOKEN is set explicitly per-call from the GitHub App
// installation token rather than relying on `gh auth login` state on the
// host, so every issue/PR is authored by "ValerIA[bot]" regardless of who
// else is logged into `gh` there.
async function gh(args: string[]): Promise<string> {
  const token = await getInstallationToken();
  const { stdout } = await execFileAsync('gh', [...args, '--repo', config.productRepo], {
    env: { ...process.env, GH_TOKEN: token },
  });
  return stdout;
}
```

with:

```ts
import { config, LABEL_MANAGED, LABEL_STATES, LABEL_BUG, type SpecStatus } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

// All gh invocations use execFile with an argv array (never a shell string) so
// issue/PR titles and bodies coming from spec content can't be interpreted as
// shell syntax. GH_TOKEN is set explicitly per-call from the dedicated
// `ronin` account's PAT rather than relying on `gh auth login` state on the
// host, so every issue/PR is authored by that account regardless of who
// else is logged into `gh` there.
async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', [...args, '--repo', activeRepo().productRepo], {
    env: { ...process.env, GH_TOKEN: config.githubToken },
  });
  return stdout;
}
```

And `ghApi`:

```ts
async function ghApi(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    env: { ...process.env, GH_TOKEN: config.githubToken },
  });
  return stdout;
}
```

- [ ] **Step 3: Replace every remaining `config.productRepo` with `activeRepo().productRepo`**

Six occurrences, all inside template literals passed to `ghApi`:

- `` `repos/${config.productRepo}/pulls/${dependent}` `` (inside `mergePullRequest`)
- `` `repos/${config.productRepo}/issues/${prNumber}/comments?per_page=100` `` (`listIssueComments`)
- `` `repos/${config.productRepo}/pulls/${prNumber}/comments?per_page=100` `` and `` `repos/${config.productRepo}/pulls/${prNumber}/reviews?per_page=100` `` (`listReviewComments`)
- `` `repos/${config.productRepo}/${reactionsPath(kind)}/${commentId}/reactions?content=eyes&per_page=100` `` (`hasBotReaction`)
- `` `repos/${config.productRepo}/${reactionsPath(kind)}/${commentId}/reactions` `` (`addReaction`)

Change each `config.productRepo` to `activeRepo().productRepo` in place — no other change to these lines.

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: `github.ts` no longer appears in the error list from Task 1 Step 4. `github-app-auth.js` import errors from `claude-runner.ts` and `scripts/smoke-test.ts` still appear — fixed in Tasks 7 and 11.

- [ ] **Step 5: Commit**

```bash
git add src/github.ts
git rm src/github-app-auth.ts
git commit -m "refactor: authenticate gh calls with the ronin PAT, not a GitHub App"
```

---

### Task 6: `worktree.ts` + `spec-content.ts` — read repo paths from `activeRepo()`

**Files:**
- Modify: `src/worktree.ts`
- Modify: `src/spec-content.ts`
- Modify: `src/worktree.test.ts`

**Interfaces:**
- Consumes: `activeRepo()` (Task 2)
- No exported function signatures change.

`spec-content.ts` has no test file (confirmed) — verified by typecheck only.

- [ ] **Step 1: Update `src/worktree.ts`**

Add the import:

```ts
import { config } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
```

Then replace every `config.worktreeBasePath` → `activeRepo().worktreeBasePath` and every `config.productRepoPath` → `activeRepo().productRepoPath`, at these exact spots (`config.worktreeBaseRef` stays untouched — it's still global):

```ts
export function worktreeDirFor(branch: string): string {
  return join(activeRepo().worktreeBasePath, branch.replaceAll('/', '-'));
}

async function branchExists(branch: string): Promise<boolean> {
  return execFileAsync('git', ['rev-parse', '--verify', branch], { cwd: activeRepo().productRepoPath })
    .then(() => true)
    .catch(() => false);
}

export async function remoteBranchExists(branch: string): Promise<boolean> {
  return execFileAsync('git', ['ls-remote', '--exit-code', '--heads', 'origin', branch], { cwd: activeRepo().productRepoPath })
    .then(() => true)
    .catch(() => false);
}

export async function ensureWorktree(branch: string, baseRef = config.worktreeBaseRef): Promise<string> {
  const dir = worktreeDirFor(branch);
  if (existsSync(dir)) return dir;

  await mkdir(activeRepo().worktreeBasePath, { recursive: true });
  const local = await branchExists(branch);
  const remote = local ? false : await remoteBranchExists(branch);
  if (!local) {
    await execFileAsync('git', ['fetch', 'origin'], { cwd: activeRepo().productRepoPath }).catch(() => {});
  }
  const args = local
    ? ['worktree', 'add', dir, branch]
    : remote
      ? ['worktree', 'add', '-b', branch, dir, `origin/${branch}`]
      : ['worktree', 'add', '-b', branch, dir, baseRef];
  await execFileAsync('git', args, { cwd: activeRepo().productRepoPath });

  const port = await getFreePort();
  await writeFile(join(dir, '.env'), `DB_PORT=${port}\n`);

  return dir;
}
```

```ts
export async function removeWorktree(branch: string): Promise<void> {
  const dir = worktreeDirFor(branch);
  await removeDockerStack(dir);
  await execFileAsync('git', ['worktree', 'remove', dir, '--force'], { cwd: activeRepo().productRepoPath })
    .catch((error) => log.error(`removeWorktree: 'git worktree remove' falló para ${dir}`, error));
}
```

```ts
export async function sweepOrphanedWorktrees(allPrs: PullRequestStatus[]): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(activeRepo().worktreeBasePath);
  } catch {
    return;
  }

  for (const branch of branchesToSweep(entries, allPrs)) {
    await removeWorktree(branch);
  }
}
```

(`isBehind` and `attemptRebase` are untouched — they already take `worktreeDir`/branch names as explicit parameters, never read `config`/`activeRepo` directly.)

- [ ] **Step 2: Update `src/spec-content.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { activeRepo } from './repo-context.js';

const execFileAsync = promisify(execFile);

export async function fetchOriginMain(): Promise<void> {
  await execFileAsync('git', ['fetch', 'origin', 'main'], { cwd: activeRepo().productRepoPath });
}

export async function readSpecFile(specPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['show', `origin/main:${specPath}`], { cwd: activeRepo().productRepoPath });
  return stdout;
}

export function extractTitle(content: string, fallback: string): string {
  return content.match(/^#\s+(.+)$/m)?.[1] ?? fallback;
}
```

(Drops the now-unused `config` import entirely.)

- [ ] **Step 3: Update `src/worktree.test.ts`**

Change the top-of-file mock and the `ensureWorktree` describe block. New top:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PullRequestStatus } from './github.js';

// worktreeBaseRef is the only field these tests still read off config —
// productRepoPath/worktreeBasePath now come from activeRepo() (see
// repo-context.ts), set per test via withActiveRepo below.
let mockConfig: Record<string, unknown> = { worktreeBaseRef: 'main' };
vi.mock('./config.js', () => ({ get config() { return mockConfig; } }));

const { isBehind, attemptRebase, branchFromWorktreeDirName, branchesToSweep, ensureWorktree } = await import('./worktree.js');
const { withActiveRepo } = await import('./repo-context.js');
```

`branchFromWorktreeDirName`, `branchesToSweep`, and the `isBehind`/`attemptRebase` real-git describe block stay exactly as they are today (none of them touch `config` or `activeRepo`).

Replace the `ensureWorktree — per-worktree DB_PORT` describe block with:

```ts
describe('ensureWorktree — per-worktree DB_PORT', () => {
  let base: string;
  let productRepoPath: string;
  let worktreeBasePath: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), 'valeria-ensure-worktree-test-'));
    productRepoPath = join(base, 'repo');
    worktreeBasePath = join(base, 'worktrees');
    process.env.WORKTREE_BASE_PATH = worktreeBasePath;

    await mkdir(productRepoPath, { recursive: true });
    await initRepo(productRepoPath);
    await writeFile(join(productRepoPath, 'README.md'), 'seed\n');
    await git(productRepoPath, ['add', '.']);
    await git(productRepoPath, ['commit', '-q', '-m', 'initial']);
    await git(productRepoPath, ['branch', '-M', 'main']);
  });

  afterEach(async () => {
    delete process.env.WORKTREE_BASE_PATH;
    await rm(base, { recursive: true, force: true });
  });

  function withRepo<T>(fn: () => Promise<T>): Promise<T> {
    return withActiveRepo({ productRepo: 'test/repo', productRepoPath }, fn);
  }

  it('writes a repo-root .env with a real, listening-ready DB_PORT for a freshly created worktree', async () => {
    const dir = await withRepo(() => ensureWorktree('valeria/300/slice-1'));

    const envContents = await readFile(join(dir, '.env'), 'utf8');
    const match = envContents.match(/^DB_PORT=(\d+)$/m);
    expect(match).not.toBeNull();
    const port = Number(match![1]);
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThanOrEqual(65535);
  });

  it('gives two different worktrees different ports', async () => {
    const dirA = await withRepo(() => ensureWorktree('valeria/300/slice-1'));
    const dirB = await withRepo(() => ensureWorktree('valeria/300/slice-2'));

    const portA = (await readFile(join(dirA, '.env'), 'utf8')).match(/DB_PORT=(\d+)/)![1];
    const portB = (await readFile(join(dirB, '.env'), 'utf8')).match(/DB_PORT=(\d+)/)![1];
    expect(portA).not.toBe(portB);
  });

  it('does not rewrite .env when reusing an already-existing worktree', async () => {
    const dir = await withRepo(() => ensureWorktree('valeria/300/slice-1'));
    const first = await readFile(join(dir, '.env'), 'utf8');

    const reused = await withRepo(() => ensureWorktree('valeria/300/slice-1'));
    const second = await readFile(join(reused, '.env'), 'utf8');

    expect(reused).toBe(dir);
    expect(second).toBe(first);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/worktree.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: `worktree.ts` and `spec-content.ts` no longer appear in the error list.

- [ ] **Step 6: Commit**

```bash
git add src/worktree.ts src/spec-content.ts src/worktree.test.ts
git commit -m "refactor: worktree.ts and spec-content.ts read repo paths from activeRepo()"
```

---

### Task 7: `claude-runner.ts` — drop the installation-token fetch, use the PAT + per-repo Claude account

**Files:**
- Modify: `src/claude-runner.ts`
- Modify: `src/claude-runner.test.ts`

**Interfaces:**
- Consumes: `config.githubToken`, `config.claudeConfigDir` (Task 1), `activeRepo().claudeConfigDir` (Task 2)
- No exported signature changes (`runClaudeHeadless`, `ClaudeUsageLimitError`).

- [ ] **Step 1: Update `src/claude-runner.ts`**

Replace the imports:

```ts
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
```

(drops `import { getInstallationToken } from './github-app-auth.js';`)

Replace the token/env setup at the top of `runClaudeHeadless`:

```ts
export async function runClaudeHeadless(cwd: string, prompt: string, label: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GH_TOKEN: config.githubToken };
  // A repos.json entry's own claudeConfigDir wins over the global default —
  // lets each repo run under its own Claude account (docs/superpowers/specs/
  // 2026-08-19-multi-repo-pat-auth-design.md §2).
  const claudeConfigDir = activeRepo().claudeConfigDir ?? config.claudeConfigDir;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.claudeCommand,
      ['-p', prompt, '--permission-mode', 'bypassPermissions', '--output-format', 'stream-json', '--verbose'],
```

(Everything else in the file — the rest of the `Promise` executor, streaming, usage-limit detection — is unchanged.)

Update the doc comment just above (currently explains "GH_TOKEN is forwarded... authenticates as ValerIA[bot]"):

```ts
// GH_TOKEN is forwarded into the child process so that when the spawned
// session itself shells out to `gh` (opening its PR, pushing, editing the
// issue), it authenticates as the `ronin` account too — without this, those
// calls fall back to whatever `gh auth` session is ambient on the host,
// silently defeating the bot-identity work in github.ts.
```

- [ ] **Step 2: Update `src/claude-runner.test.ts`**

```ts
import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('./config.js', () => ({
  config: {
    claudeCommand: 'claude',
    claudeConfigDir: '',
    agentTaskTimeoutMs: 30_000,
    githubToken: 'fake-token',
  },
}));

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

let fakeChild: FakeChildProcess;
const spawn = vi.fn(() => fakeChild);
vi.mock('node:child_process', () => ({
  spawn: () => spawn(),
}));

const { runClaudeHeadless, ClaudeUsageLimitError } = await import('./claude-runner.js');
const { withActiveRepo } = await import('./repo-context.js');

function emitStdout(child: FakeChildProcess, text: string): void {
  child.stdout.emit('data', Buffer.from(`${text}\n`));
}

function runInRepo(cwd: string, prompt: string, label: string): Promise<string> {
  return withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, () => runClaudeHeadless(cwd, prompt, label));
}

describe('runClaudeHeadless usage-limit detection', () => {
  it('throws ClaudeUsageLimitError when the notice is a bare non-JSON stdout line', async () => {
    fakeChild = new FakeChildProcess();
    const promise = runInRepo('/tmp/wt', 'prompt', 'label');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    emitStdout(fakeChild, "You've hit your monthly spend limit · raise it at claude.ai/settings/usage");
    fakeChild.emit('close', 1);
    await expect(promise).rejects.toBeInstanceOf(ClaudeUsageLimitError);
  });

  it('throws ClaudeUsageLimitError when the notice is embedded in a JSON stream-json event', async () => {
    fakeChild = new FakeChildProcess();
    const promise = runInRepo('/tmp/wt', 'prompt', 'label');
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const jsonLine = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: "You've hit your monthly spend limit · raise it at claude.ai/settings/usage" }] },
    });
    emitStdout(fakeChild, jsonLine);
    fakeChild.emit('close', 1);
    await expect(promise).rejects.toBeInstanceOf(ClaudeUsageLimitError);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/claude-runner.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/claude-runner.ts src/claude-runner.test.ts
git commit -m "refactor: claude-runner.ts uses the ronin PAT and per-repo claudeConfigDir"
```

---

### Task 8: `agent-task.ts` — read `productRepo` from `activeRepo()`

**Files:**
- Modify: `src/agent-task.ts`
- Modify: `src/agent-task.test.ts`

**Interfaces:**
- Consumes: `activeRepo()` (Task 2)
- No exported signature changes.

- [ ] **Step 1: Update `src/agent-task.ts`**

Add the import and fix `repoUrl`:

```ts
import { config } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
```

```ts
function repoUrl(): string {
  return `https://github.com/${activeRepo().productRepo}`;
}
```

(`config.worktreeBaseRef` and `config.playwrightTestResultsDir` usages elsewhere in the file are unchanged — both stay global.)

- [ ] **Step 2: Update `src/agent-task.test.ts`**

Change the top-of-file mocks (config loses `productRepo`, a new `repo-context.js` mock supplies it):

```ts
vi.mock('./config.js', () => ({
  config: {
    playwrightTestResultsDir: 'apps/webapp/test-results',
    worktreeBaseRef: 'origin/main',
  },
}));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' }),
}));
```

Every `runAgentTask(...)` call site later in the file is unchanged — none of them reference `productRepo` directly, and the stub above makes `activeRepo()` resolve without needing `withActiveRepo`.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/agent-task.test.ts`
Expected: PASS (all existing assertions, none of which check the repo URL string, are unaffected)

- [ ] **Step 4: Commit**

```bash
git add src/agent-task.ts src/agent-task.test.ts
git commit -m "refactor: agent-task.ts reads productRepo from activeRepo()"
```

---

### Task 9: `mentions.ts` + `evidence.ts` — bot identity becomes `config.githubLogin`

**Files:**
- Modify: `src/mentions.ts`
- Modify: `src/mentions.test.ts`
- Modify: `src/evidence.ts`
- Modify: `src/evidence.test.ts`

**Interfaces:**
- Consumes: `config.githubLogin` (Task 1), `activeRepo()` (Task 2)
- No exported signature changes.

- [ ] **Step 1: Update `src/mentions.ts`**

```ts
import { listIssueComments, listReviewComments, hasBotReaction, type Comment } from './github.js';
import { config } from './config.js';

function mentionsHandle(body: string, handle: string): boolean {
  // `handle` is not escaped for regex metacharacters on purpose: it comes from
  // operator-supplied config (RONIN_GITHUB_LOGIN), never from a comment or
  // any other attacker-controlled input, and a GitHub login can only contain
  // alphanumerics and hyphens — none of which are metacharacters.
  return new RegExp(`\\B@${handle}\\b`, 'i').test(body);
}

export async function findUnprocessedMentions(prNumber: number): Promise<Comment[]> {
  const botLogin = config.githubLogin;
  const [issueComments, reviewComments] = await Promise.all([
    listIssueComments(prNumber),
    listReviewComments(prNumber),
  ]);
  const mentioned = [...issueComments, ...reviewComments].filter((c) => mentionsHandle(c.body, botLogin));

  const unprocessed: Comment[] = [];
  for (const comment of mentioned) {
    const alreadyReacted = comment.reactionsEyes > 0 && (await hasBotReaction(comment.id, comment.kind, botLogin));
    if (!alreadyReacted) unprocessed.push(comment);
  }
  return unprocessed;
}
```

(`config.mentionHandle` and `config.githubAppSlug` are both gone — `botLogin` now does double duty as both "who to @mention" and "whose reaction counts as already-processed", since the `ronin` account is the one real identity doing both.)

- [ ] **Step 2: Update `src/mentions.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
  config: { githubLogin: 'ronin' },
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
      { id: 1, kind: 'issue', body: 'hey @ronin can you check this?', reactionsEyes: 0 },
      { id: 2, kind: 'issue', body: 'no mention here', reactionsEyes: 0 },
    ]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 1, kind: 'issue', body: 'hey @ronin can you check this?', reactionsEyes: 0 }]);
  });

  it('matches the handle case-insensitively', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@Ronin please review', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('includes inline review comments that mention the handle', async () => {
    reviewComments.mockResolvedValue([{ id: 5, kind: 'review', body: '@ronin fijate esta línea', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([{ id: 5, kind: 'review', body: '@ronin fijate esta línea', reactionsEyes: 0 }]);
  });

  it('excludes a mention already reacted to by the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(true);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
    expect(botReaction).toHaveBeenCalledWith(1, 'issue', 'ronin');
  });

  it('includes a mention with reactions from other users but not the bot', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 1 }]);
    botReaction.mockResolvedValue(false);

    const result = await findUnprocessedMentions(42);
    expect(result).toHaveLength(1);
  });

  it('does not match a longer handle sharing the same prefix', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: 'cc @roninic-bot', reactionsEyes: 0 }]);

    const result = await findUnprocessedMentions(42);
    expect(result).toEqual([]);
  });

  it('skips the extra reaction lookup when reactionsEyes is 0', async () => {
    issueComments.mockResolvedValue([{ id: 1, kind: 'issue', body: '@ronin revisá esto', reactionsEyes: 0 }]);

    await findUnprocessedMentions(42);
    expect(botReaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Update `src/evidence.ts`**

Add the import and replace the identity/repo lines:

```ts
import { config } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';
```

```ts
export async function publishEvidence(issueNumber: number, prNumber: number, worktreeDir: string): Promise<string[]> {
  const resultsDir = join(worktreeDir, config.playwrightTestResultsDir);
  const screenshots = await findScreenshots(resultsDir);
  if (screenshots.length === 0) return [];

  await ensureEvidenceCheckout();
  const destDir = `evidence/${issueNumber}/${prNumber}/${Date.now()}`;
  await mkdir(join(EVIDENCE_CHECKOUT_DIR, destDir), { recursive: true });

  const committed: string[] = [];
  for (const src of screenshots) {
    const name = relative(resultsDir, src).replaceAll('/', '-');
    const destRelative = `${destDir}/${name}`;
    await copyFile(src, join(EVIDENCE_CHECKOUT_DIR, destRelative));
    committed.push(destRelative);
  }

  await execFileAsync('git', ['add', ...committed], { cwd: EVIDENCE_CHECKOUT_DIR });
  // -c user.name/user.email rather than relying on this checkout (or the
  // host) having git identity configured globally — a fresh clone of
  // EVIDENCE_CHECKOUT_DIR has neither, and `git commit` refuses to guess.
  // Same RONIN_GITHUB_LOGIN identity used for gh calls elsewhere (github.ts).
  await execFileAsync('git', [
    '-c', `user.name=${config.githubLogin}`,
    '-c', `user.email=${config.githubLogin}@users.noreply.github.com`,
    'commit',
    '-m', `evidence: e2e screenshots for ${activeRepo().productRepo} PR #${prNumber}`,
  ], { cwd: EVIDENCE_CHECKOUT_DIR });
  await execFileAsync('git', ['push', 'origin', 'main'], { cwd: EVIDENCE_CHECKOUT_DIR });

  log.info(`published ${committed.length} evidence screenshot(s) for PR #${prNumber} to ${config.valeriaRepo}`);
  return committed;
}
```

- [ ] **Step 4: Update `src/evidence.test.ts`**

Change the config mock and add a `repo-context.js` mock:

```ts
vi.mock('./config.js', () => ({
  config: {
    valeriaRepo: 'Bmedical/ValerIA',
    githubLogin: 'ronin',
    playwrightTestResultsDir: 'apps/webapp/test-results',
  },
}));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' }),
}));
```

(Every other line in the test file — the `node:fs`/`node:fs/promises`/`node:child_process` mocks, both `describe` blocks — is unchanged; none of them assert on the commit identity or message text.)

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/mentions.test.ts src/evidence.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/mentions.ts src/mentions.test.ts src/evidence.ts src/evidence.test.ts
git commit -m "refactor: mentions.ts and evidence.ts use the ronin account as bot identity"
```

---

### Task 10: `tick.ts` — orchestrate the repo loop

**Files:**
- Modify: `src/tick.ts`
- Modify: `src/tick.test.ts`

**Interfaces:**
- Consumes: `loadRepos()` (Task 3), `withActiveRepo`/`activeRepo()` (Task 2)
- Produces: `tick(): Promise<void>` (same name, new behavior — iterates repos); the current per-repo body becomes `tickOneRepo(): Promise<void>` (not exported — internal only, no other module calls it).

- [ ] **Step 1: Update `src/tick.ts`'s imports and the three `config.productRepo` call sites**

Add:

```ts
import { activeRepo, withActiveRepo } from './repo-context.js';
import { loadRepos } from './repos.js';
```

Replace the three remaining `config.productRepo` usages:

```ts
function prUrl(prNumber: number): string {
  return `https://github.com/${activeRepo().productRepo}/pull/${prNumber}`;
}
```

```ts
async function renderTrackingIssueBody(specPaths: string[]): Promise<string> {
  const template = await readFile(join(process.cwd(), 'templates/tracking-issue.md'), 'utf8');
  const repoUrl = `https://github.com/${activeRepo().productRepo}`;
  const specLinks = specPaths.map((p) => `- [${p}](${repoUrl}/blob/main/${p})`).join('\n');
  return template.replaceAll('{{spec_links}}', specLinks);
}
```

```ts
function issueUrl(issueNumber: number): string {
  return `https://github.com/${activeRepo().productRepo}/issues/${issueNumber}`;
}
```

- [ ] **Step 2: Rename `tick` to `tickOneRepo` and add the new `tick` orchestrator**

Replace the existing `export async function tick(): Promise<void> { ... }` (the full body, unchanged inside) with:

```ts
async function tickOneRepo(): Promise<void> {
  const start = Date.now();
  resetTickMetrics();
  log.info(`tick start (commit ${await currentCommit()}, repo ${activeRepo().productRepo})`);
  await discoverAssignedSpecs();
  await discoverAssignedBugs();

  const inProgress = await listTrackingIssues('in-progress');
  log.info(`${inProgress.length} issue(s) en progreso`);

  try {
    let allPrs: PullRequestStatus[];
    try {
      allPrs = await listAllOpenValeriaPrs();
    } catch (error) {
      log.info(`tick: listAllOpenValeriaPrs falló, reintentando en el próximo tick: ${(error as Error).message}`);
      return;
    }

    await sweepOrphanedWorktrees(allPrs);

    await runWithConcurrency(inProgress, config.tickConcurrency, async (issue) => {
      if (!(await tryClaim(issue.number))) return;
      await runIssueStep(issue, async () => {
        const next = await processIssue(issue, allPrs);
        if (!next) return;
        const context = next.stackSize === 0
          ? 'sin PRs abiertos'
          : `stack de ${next.stackSize} PR(s) abierto(s)`;
        log.info(`issue #${next.issue.number}: ${context}, arrancando slice ${next.index + 1} (${next.title})`);
        await runAgentTask(agentTaskFor(next.issue, next.index, next.title));
      });
    });
  } finally {
    const { agentRuns, agentRunsDurationMs } = getTickAgentMetrics();
    log.metric('tick_complete', { durationMs: Date.now() - start, issuesInProgress: inProgress.length, agentRuns, agentRunsDurationMs, repo: activeRepo().productRepo });
  }
}

// Entry point invoked once per cron run (see index.ts). Repos run strictly
// in sequence — see docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md
// §3/§5 for why a mutable activeRepo() singleton is safe under that
// constraint. A repo whose tick throws is logged and skipped for this run;
// it never stops the rest of repos.json from ticking.
export async function tick(): Promise<void> {
  const repos = await loadRepos();
  for (const repo of repos) {
    try {
      await withActiveRepo(repo, tickOneRepo);
    } catch (error) {
      log.error(`tick: ${repo.productRepo} falló, sigue con el resto: ${(error as Error).message}`);
    }
  }
}
```

- [ ] **Step 3: Update `src/tick.test.ts`'s mocks**

Remove `productRepo: 'bmedical/bmedical'` from the `./config.js` mock (keep every other field: `e2eRetryLimit`, `checksPendingRetryLimit`, `sliceAttemptLimit`, `rebaseRetryLimit`, `worktreeBaseRef`, `LABEL_BUG`, `LABEL_MANAGED`) and add a `./repo-context.js` mock next to it:

```ts
vi.mock('./config.js', () => ({
  config: {
    e2eRetryLimit: 2,
    checksPendingRetryLimit: 60,
    sliceAttemptLimit: 3,
    rebaseRetryLimit: 3,
    worktreeBaseRef: 'origin/main',
  },
  LABEL_BUG: 'bugfix',
  LABEL_MANAGED: 'valeria',
}));

vi.mock('./repo-context.js', () => ({
  activeRepo: () => ({ productRepo: 'bmedical/bmedical', productRepoPath: '/tmp/repo', worktreeBasePath: '/tmp/worktrees' }),
}));
```

(`tick()`/`tickOneRepo()` themselves are not imported or tested anywhere in this file today — confirmed via `grep -n "from './tick.js'" src/tick.test.ts`, which only pulls in `processSlicePr`, `agentTaskFor`, `discoverAssignedBugs`. No other line in this file needs to change.)

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/tick.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS with zero errors — this closes out the punch list from Task 1 Step 4.

- [ ] **Step 6: Commit**

```bash
git add src/tick.ts src/tick.test.ts
git commit -m "feat: tick() iterates repos.json sequentially via withActiveRepo"
```

---

### Task 11: Scripts — drop `find-installation-id`, rewrite `smoke-test`, loop `init-labels` over repos.json

**Files:**
- Delete: `scripts/find-installation-id.ts`
- Modify: `scripts/smoke-test.ts`
- Modify: `scripts/init-labels.sh`
- Modify: `package.json`

- [ ] **Step 1: Delete the installation-id script**

```bash
rm scripts/find-installation-id.ts
```

- [ ] **Step 2: Remove its `package.json` entry**

Delete this line from `"scripts"`:

```json
"find-installation-id": "tsx scripts/find-installation-id.ts",
```

- [ ] **Step 3: Rewrite `scripts/smoke-test.ts`**

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../src/config.js';
import { loadRepos } from '../src/repos.js';
import { withActiveRepo } from '../src/repo-context.js';
import { listTrackingIssues } from '../src/github.js';

const execFileAsync = promisify(execFile);

async function main() {
  console.log('1. Verificando que RONIN_GITHUB_TOKEN autentica como RONIN_GITHUB_LOGIN...');
  const { stdout: userStdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login'], {
    env: { ...process.env, GH_TOKEN: config.githubToken },
  });
  const login = userStdout.trim();
  if (login !== config.githubLogin) {
    throw new Error(
      `El token autentica como "${login}", pero RONIN_GITHUB_LOGIN="${config.githubLogin}". ` +
        'Con este valor mal seteado, la detección de @menciones nunca matchea al bot — corregilo en el .env antes de seguir.',
    );
  }
  console.log(`   OK — autentica como "${login}"`);

  console.log('2. Cargando repos.json...');
  const repos = await loadRepos();
  console.log(`   OK — ${repos.length} repo(s) configurados`);

  for (const repo of repos) {
    await withActiveRepo(repo, async () => {
      console.log(`3. Verificando lectura de ${repo.productRepo}...`);
      const { stdout } = await execFileAsync('gh', ['repo', 'view', repo.productRepo, '--json', 'name,visibility'], {
        env: { ...process.env, GH_TOKEN: config.githubToken },
      });
      console.log(`   OK — ${stdout.trim()}`);

      const ready = await listTrackingIssues('ready');
      console.log(`   OK — ${ready.length} issue(s) valeria:ready encontrados en ${repo.productRepo}`);
    });
  }

  console.log('\nSmoke test completo: el PAT autentica y tiene acceso de lectura a todos los repos de repos.json.');
}

main().catch((error) => {
  console.error('Smoke test falló:', error);
  process.exitCode = 1;
});
```

- [ ] **Step 4: Update `scripts/init-labels.sh`**

```bash
#!/usr/bin/env bash
# One-time setup step (idempotent, safe to re-run): creates every valeria:*
# label used by the pipeline in every repo listed in repos.json, including
# this runner's own assignment label (valeria:runner-<RUNNER_ID>). Run
# manually, using your own `gh auth` session — this is a human setup step,
# not something the supervisor does on its own. Without this, a fresh
# RUNNER_ID has no label to pick from the GitHub UI when you go to assign
# yourself a spec PR.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
set -a
source "$REPO_DIR/.env"
set +a

: "${RUNNER_ID:?RUNNER_ID no está seteado en .env}"
REPOS_CONFIG_PATH="${REPOS_CONFIG_PATH:-$REPO_DIR/repos.json}"

if [[ ! -f "$REPOS_CONFIG_PATH" ]]; then
  echo "No se encontró $REPOS_CONFIG_PATH — ver repos.json.example" >&2
  exit 1
fi

LABELS=(
  "valeria|Gestionado por el supervisor ValerIA"
  "valeria:ready|Spec listo para que un runner lo tome"
  "valeria:in-progress|En curso"
  "valeria:blocked|Esperando una decisión humana"
  "valeria:done|Completado"
  "valeria:runner-$RUNNER_ID|Asignado a este runner (ver docs/DESIGN.md §1 y §9)"
)

for repo in $(jq -r '.[].productRepo' "$REPOS_CONFIG_PATH"); do
  echo "Creando labels en $repo..."
  for entry in "${LABELS[@]}"; do
    name="${entry%%|*}"
    desc="${entry#*|}"
    gh label create "$name" --repo "$repo" --force --color ededed --description "$desc"
    echo "  ✓ $name"
  done
done
```

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (scripts are covered by the same `tsc --noEmit` config — confirm by checking `tsconfig.json`'s `include`; if scripts aren't included, run `npx tsc --noEmit scripts/smoke-test.ts` directly instead)

- [ ] **Step 6: Commit**

```bash
git add scripts/smoke-test.ts scripts/init-labels.sh package.json
git rm scripts/find-installation-id.ts
git commit -m "chore: rewrite smoke-test and init-labels for the PAT + repos.json"
```

---

### Task 12: Docs — README.md and docs/DESIGN.md

**Files:**
- Modify: `README.md`
- Modify: `docs/DESIGN.md`

- [ ] **Step 1: Rewrite `README.md`'s `## Setup` section**

Replace steps 2–3 (today: copy `.env.example`, then the GitHub App registration paragraph) with:

```markdown
2. Copiar `.env.example` a `.env` y completar `RUNNER_ID` (tu usuario de GitHub, no un hostname).
3. Copiar `repos.json.example` a `repos.json` y completar cada repo a supervisar (`productRepo`, `productRepoPath`, y opcionalmente `claudeConfigDir` si ese repo debe correr bajo una cuenta de Claude distinta a la global). `repos.json` va gitignored — nunca se commitea.
4. Crear una cuenta de GitHub dedicada (ej. `ronin`) e invitarla como colaboradora en cada repo de `repos.json`. Generar un fine-grained PAT desde esa cuenta (Settings → Developer settings → Personal access tokens → Fine-grained tokens), scopeado a esos repos, con permisos Contents/Issues/Pull requests en read-write y una expiración — es un token estático, sin renovación automática, hay que rotarlo a mano antes de que venza. Completar `RONIN_GITHUB_TOKEN` (el token) y `RONIN_GITHUB_LOGIN` (el username de esa cuenta) en `.env`.
5. `pnpm smoke-test` — confirma que el token autentica como `RONIN_GITHUB_LOGIN` y que puede leer cada repo de `repos.json`, antes de seguir.
6. `pnpm init-labels` — crea en cada repo de `repos.json` los labels `valeria*` que usa el pipeline, incluida tu label de asignación `valeria:runner-<RUNNER_ID>`. Sin esto no vas a poder seleccionarla desde la UI de GitHub al asignarte un spec.
7. Correr `pnpm build` (antes de instalar el cron por primera vez, y después de cualquier cambio de código posterior) — el cron corre el `dist/` compilado, nunca reconstruye solo. Sin un build nuevo, sigue corriendo la versión vieja (o corta si `dist/` nunca se generó).
8. `pnpm cron:setup [minutos] [días_retención]` (default 5 min / 14 días) — instala el supervisor como cron job. `pnpm cron:remove` para sacarlo. Logs en `logs/tick-YYYY-MM-DD.log` (`tail -f logs/tick-$(date +%F).log` para seguir el de hoy).
```

Renumber the remaining "(Opcional, recomendado)" agent-notes step to 9.

- [ ] **Step 2: Update the "Pedirle una review por @mención" section**

Replace the current text (which references `@valeria-agent` and the separate mentionable-user setup step) with:

```markdown
### Pedirle una review por @mención

En cualquier PR que el agente haya abierto (y que no esté en draft) podés escribir `@<RONIN_GITHUB_LOGIN> <pedido>` (ej. `@ronin`) en un comentario general o inline, y en el próximo tick el supervisor postea una review formal — siempre en estado `Commented`, nunca `Approved` ni `Changes requested` — respondiendo a ese pedido. Los comentarios ya atendidos quedan marcados con 👀. Ver [`docs/superpowers/specs/2026-07-28-mention-review-design.md`](docs/superpowers/specs/2026-07-28-mention-review-design.md).

No hace falta ningún setup manual adicional para esto: la cuenta `ronin` invitada como colaboradora en el §Setup ya es la misma identidad que abre los PRs y la que se @menciona — a diferencia del diseño anterior (GitHub App + usuario `valeria-agent` separado), no hay una segunda cuenta que crear.
```

- [ ] **Step 3: Rewrite `docs/DESIGN.md` §7**

Replace the whole "### 7. Identidad del agente en GitHub" section (through the end of the current §7.2) with:

```markdown
### 7. Identidad del agente en GitHub

Los issues/PRs los abre la cuenta de GitHub dedicada `ronin` (no la cuenta personal de quien corre el supervisor) — así el historial de autoría es honesto sobre qué hizo un humano y qué hizo el agente, y el approval-gate del merge (§ Principios de diseño) tiene sentido: el aprobador y el autor nunca pueden ser la misma persona por accidente.

Se eligió un token de cuenta dedicada (fine-grained PAT) sobre un GitHub App — ver docs/superpowers/specs/2026-08-19-multi-repo-pat-auth-design.md para el detalle completo de la decisión — por simplicidad de setup: sin registrar un App, sin private key, sin installation ID, y sin necesitar una segunda cuenta separada solo para ser mencionable (a diferencia del diseño original de este documento). El costo aceptado: el token es estático (sin JWT ni refresh automático — se rota a mano antes de que expire), y si algún repo futuro viviera en una org con billing por seat, la cuenta colaboradora consumiría uno.

**Setup manual (no automatizable, pasos para el dueño de cada repo):**

1. Crear la cuenta de GitHub dedicada `ronin` (o el nombre que prefieras) e invitarla como colaboradora en cada repo de `repos.json`.
2. Generar un fine-grained PAT desde esa cuenta (Settings → Developer settings → Personal access tokens → Fine-grained tokens), scopeado a esos repos, permisos Contents/Issues/Pull requests en read-write, con expiración.
3. Setear `RONIN_GITHUB_TOKEN` (el token) y `RONIN_GITHUB_LOGIN` (el username de la cuenta) en el `.env` del supervisor — nunca commitear el `.env` (ya está en `.gitignore`).

**Verificación:** `pnpm smoke-test` confirma que el token autentica como `RONIN_GITHUB_LOGIN` y que puede leer cada repo de `repos.json` — correrlo después de cualquier cambio de credenciales antes de asumir que quedaron bien.

### 7.2 Usuario mencionable

A diferencia de un GitHub App (cuyo bot user no siempre es confiablemente @mencionable/notificable), `ronin` es una cuenta real — la misma que abre los PRs es la que se @menciona para pedirle una review puntual (ver README.md, "Pedirle una review por @mención"). No hace falta ninguna cuenta ni setup adicional para esto.
```

(§7.1 "Permisos de las invocaciones headless" is untouched — it's about `bypassPermissions` and worktree containment, unrelated to auth identity.)

- [ ] **Step 4: Commit**

```bash
git add README.md docs/DESIGN.md
git commit -m "docs: update setup instructions for the ronin PAT and repos.json"
```

---

### Task 13: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS, zero failures

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS, zero errors

- [ ] **Step 3: Build**

Run: `pnpm build`
Expected: PASS, `dist/` regenerated with no errors

- [ ] **Step 4: Confirm no leftover references to the removed GitHub App concepts**

Run: `grep -rn "githubApp\|VALERIA_GITHUB_APP\|getInstallationToken\|mentionHandle\|VALERIA_MENTION_HANDLE\|find-installation-id" src/ scripts/ .env.example README.md docs/DESIGN.md`
Expected: no output (the only remaining mentions of these strings, if any, should be historical — e.g. inside other spec files under `docs/superpowers/specs/` that describe past designs and shouldn't be rewritten)

- [ ] **Step 5: Confirm no leftover reads of the removed per-repo config fields**

Run: `grep -rn "config\.productRepo\b\|config\.productRepoPath\b\|config\.worktreeBasePath\b" src/ scripts/`
Expected: no output
