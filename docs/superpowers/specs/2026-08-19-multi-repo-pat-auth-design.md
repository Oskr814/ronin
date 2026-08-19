# Soporte multi-repo + reemplazo del GitHub App por un PAT de cuenta dedicada

## Motivación

Hoy `ronin` (ex-ValerIA) es un deployment por repo: cada repo de producto necesita su
propio clon, `.env`, cron y credenciales de GitHub App, aunque todos corran bajo el
mismo operador (`RUNNER_ID`). El objetivo es que **una sola instancia** —un cron, un
proceso, una credencial— pueda supervisar varios repos, cada uno opcionalmente con su
propia cuenta de Claude (`CLAUDE_CONFIG_DIR`).

En paralelo, se decidió reemplazar la identidad del agente en GitHub: en vez de un
GitHub App dedicado (§7 de `docs/DESIGN.md`, pensado para el setup de una sola org),
usar el token de una cuenta de GitHub dedicada (`ronin`) ya creada, invitada como
colaboradora en cada repo. Motivación: setup mucho más simple (sin registrar App, sin
private key, sin installation ID), y unifica en una sola identidad lo que hoy son dos
(el App que abre PRs + el usuario `valeria-agent` separado que existe solo para ser
mencionable). El costo aceptado: el token es estático (mitigado con expiración +
rotación manual) y, si algún repo futuro viviera en una org con billing por seat,
la cuenta colaboradora consumiría uno — no aplica a los repos actuales, todos
personales o públicos.

## Alcance

Dentro:
- Reemplazar `github-app-auth.ts` y las 4 env vars `VALERIA_GITHUB_APP_*` por un PAT
  único + el username de la cuenta `ronin`.
- Un archivo `repos.json` (gitignored) que lista los repos a supervisar, cada uno con
  su path local y, opcionalmente, su propio `claudeConfigDir`.
- Namespacing del estado local (`local-state.ts`) por repo, para que un mismo número
  de issue en dos repos distintos no colisione.
- El loop de `tick()` iterando la lista de repos en secuencia (decisión explícita:
  no paralelizar entre repos, solo dentro de cada uno vía `TICK_CONCURRENCY` como hoy).
- Ajuste de `smoke-test.ts` e `init-labels.ts` para operar sobre todos los repos de
  `repos.json`. Eliminación de `find-installation-id.ts` (ya no aplica sin App).

Fuera de alcance (confirmado explícitamente, no YAGNI implícito):
- `RUNNER_ID` sigue siendo global — no hay runner distinto por repo.
- `SPEC_DIR`, el repo de evidencia (`VALERIA_REPO`) y el resto de los límites/timeouts
  siguen siendo configuración global de `.env`, no overrideables por entrada de
  `repos.json`.
- Paralelizar el procesamiento entre repos (solo dentro de cada repo, como hoy).

## Diseño

### 1. Auth: PAT de la cuenta `ronin` en vez de GitHub App

Nuevas env vars requeridas en `.env`, reemplazando `VALERIA_GITHUB_APP_ID`,
`VALERIA_GITHUB_APP_PRIVATE_KEY_PATH`, `VALERIA_GITHUB_APP_INSTALLATION_ID` y
`VALERIA_GITHUB_APP_SLUG`:

- `RONIN_GITHUB_TOKEN` — fine-grained personal access token de la cuenta `ronin`,
  scopeado a Contents/Issues/Pull requests (read-write) sobre los repos listados en
  `repos.json`, con expiración (recomendado: el máximo que permita el uso, a rotar
  manualmente antes de vencer — no hay renovación automática, es un token estático).
- `RONIN_GITHUB_LOGIN` — username de la cuenta (ej. `ronin`), sin sufijo `[bot]` (es
  un usuario real, no un App). Reemplaza a `githubAppSlug` en todo lugar donde hoy se
  arma `${slug}[bot]`.

`src/github-app-auth.ts` se elimina por completo (JWT, cache de installation token de
~1h, todo ese ciclo de vida deja de existir: el PAT es estático, no hay nada que
refrescar).

`src/github.ts`'s `gh()`/`ghApi()` pasan de `const token = await getInstallationToken()`
a leer `config.githubToken` (el PAT) directo — sin `await`, sin cache.

`src/mentions.ts`: `const botLogin = `${config.githubAppSlug}[bot]`` pasa a
`const botLogin = config.githubLogin` (comparación directa contra el login real de la
cuenta, sin el sufijo `[bot]`).

`src/config.ts`: `mentionHandle` (hoy default `'valeria-agent'`, usuario separado) se
elimina como concepto independiente — mencionar al agente es directamente
`@${config.githubLogin}` (`ronin`). Se borra `VALERIA_MENTION_HANDLE` del `.env` y su
sección del README ("Paso manual de setup... crear el usuario `valeria-agent`").

`src/evidence.ts`: la identidad de commit (`user.name`/`user.email`) que hoy usa
`${config.githubAppSlug}[bot]` pasa a usar `${config.githubLogin}` y su email real de
noreply de GitHub (`<id>+<login>@users.noreply.github.com`, tomado del PAT owner —
igual de válido para el commit, no requiere ninguna llamada extra).

**Setup manual actualizado (reemplaza el §7 de `docs/DESIGN.md`):**
1. Generar un fine-grained PAT desde la cuenta `ronin` (Settings → Developer settings
   → Personal access tokens → Fine-grained tokens), scopeado a los repos de
   `repos.json`, permisos Contents/Issues/Pull requests en read-write, con expiración.
2. Invitar a `ronin` como colaborador en cada repo de `repos.json` (o de la org, si
   aplica) y aceptar la invitación desde esa cuenta.
3. Setear `RONIN_GITHUB_TOKEN` y `RONIN_GITHUB_LOGIN` en `.env`.
4. `pnpm smoke-test` valida el token y el acceso a cada repo listado (ver §6).

### 2. `repos.json`

Archivo nuevo en la raíz del repo `ronin`, gitignored (agregar a `.gitignore`), path
configurable vía `REPOS_CONFIG_PATH` (default `./repos.json`):

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

- `productRepo` (`owner/repo`) y `productRepoPath` (checkout local) son requeridos por
  entrada.
- `claudeConfigDir` es opcional; si falta, esa entrada usa el `CLAUDE_CONFIG_DIR`
  global de `.env` (mismo comportamiento que hoy, sin romper el caso de una sola
  cuenta de Claude para todos los repos).
- `PRODUCT_REPO` y `PRODUCT_REPO_PATH` se eliminan de `.env` — `repos.json` es la única
  fuente de verdad para qué repos supervisar. Un `.env.example` que todavía las tenga
  queda obsoleto y se actualiza.
- Se carga y valida una vez al arrancar (mismo espíritu fail-fast que `requireEnv` en
  `config.ts`): falta el archivo, es un array vacío, o a una entrada le falta
  `productRepo`/`productRepoPath` → excepción antes del primer tick, nunca un fallo
  silencioso a mitad de loop.

### 3. Contexto de repo activo

Los campos hoy en el singleton `config` que son por-repo (`productRepo`,
`productRepoPath`, `worktreeBasePath`, `claudeConfigDir`) se mueven a un nuevo módulo
`src/repo-context.ts`:

```ts
export interface RepoEntry {
  productRepo: string;
  productRepoPath: string;
  claudeConfigDir?: string;
}

interface ActiveRepo extends RepoEntry {
  worktreeBasePath: string;
}

let current: ActiveRepo | null = null;

export function activeRepo(): ActiveRepo {
  if (!current) throw new Error('activeRepo() called outside withActiveRepo()');
  return current;
}

export async function withActiveRepo<T>(entry: RepoEntry, fn: () => Promise<T>): Promise<T> {
  current = {
    ...entry,
    worktreeBasePath: process.env.WORKTREE_BASE_PATH ?? join(entry.productRepoPath, '..', 'valeria-worktrees'),
  };
  try {
    return await fn();
  } finally {
    current = null;
  }
}
```

Como los repos se procesan en secuencia (decisión de diseño, ver "Alcance") y toda la
concurrencia interna (`TICK_CONCURRENCY`) ocurre mientras un único repo está activo, un
singleton mutable simple alcanza — no hace falta `AsyncLocalStorage` ni threadear un
parámetro por cada función. `current = null` fuera de un `withActiveRepo` activo es
intencional: cualquier código que intente leer `activeRepo()` fuera del loop revienta
fuerte en vez de leer basura de una corrida anterior.

Los ~7 archivos que hoy leen `config.productRepo` / `config.productRepoPath` /
`config.worktreeBasePath` / `config.claudeConfigDir` (`agent-task.ts`,
`claude-runner.ts`, `evidence.ts`, `github.ts`, `spec-content.ts`, `tick.ts`,
`worktree.ts`) cambian a `activeRepo().productRepo`, etc. — renombre mecánico, sin
cambios de lógica en ninguno de ellos.

`src/config.ts` pierde esos 4 campos y su `requireEnv('PRODUCT_REPO_PATH')` de tope de
archivo; conserva todo lo demás (`githubToken`, `githubLogin`, límites, `RUNNER_ID`,
etc.) tal cual, ya que son genuinamente globales.

### 4. Estado local por repo

`src/local-state.ts` deriva su path de archivo agregando un slug del repo activo:

```ts
function statePathFor(repo: string): string {
  const slug = repo.replaceAll('/', '-');
  return `${config.localStatePath}.${slug}.json`;
}
```

`readLocalState`/`writeLocalState` usan `statePathFor(activeRepo().productRepo)` en vez
del `config.localStatePath` fijo de hoy. Evita que un issue #12 de `repo-a` y un issue
#12 de `repo-b` compartan `claimedIssues`/`checksPendingCounts` — sin pedirte que
configures nada extra por entrada de `repos.json`.

### 5. Loop del supervisor

`src/tick.ts` gana una función orquestadora que reemplaza el `tick()` actual como
entry point (el `tick()` de hoy pasa a `tickOneRepo()`, sin cambios internos más allá
del rename de `config.productRepo` → `activeRepo().productRepo`):

```ts
export async function tick(): Promise<void> {
  const repos = await loadRepos(); // src/repos.ts, lee y valida repos.json
  for (const repo of repos) {
    try {
      await withActiveRepo(repo, tickOneRepo);
    } catch (error) {
      // Un repo roto no debe cortar a los demás — mismo principio de
      // aislamiento que ya aplica por-issue dentro de tickOneRepo.
      log.error(`tick: ${repo.productRepo} falló, sigue con el resto: ${(error as Error).message}`);
    }
  }
}
```

Secuencial entre repos, concurrente por issues dentro de cada uno (sin cambios ahí).

### 6. Scripts

- `scripts/find-installation-id.ts` se elimina (dependía enteramente del GitHub App).
- `scripts/smoke-test.ts` se reescribe: valida que `RONIN_GITHUB_TOKEN` autentica como
  `RONIN_GITHUB_LOGIN` (`gh api user` con ese token) y, por cada entrada de
  `repos.json`, que puede leer el repo (`gh api repos/<productRepo>` con ese token) —
  reemplaza la validación de installation token + slug de hoy.
- `scripts/init-labels.sh` (o su equivalente) pasa a loopear sobre `repos.json` en vez
  de un solo repo, creando el mismo set de labels `valeria*` en cada uno.

### Testing

- `repo-context.ts`: test unitario de `withActiveRepo` (setea, corre, resetea incluso
  si `fn` tira; `activeRepo()` fuera de un `withActiveRepo` tira).
- Nuevo `src/repos.ts` (carga/valida `repos.json`): test de los casos de error (archivo
  ausente, array vacío, entrada incompleta) y del default de `claudeConfigDir`.
- `local-state.test.ts`: se actualiza para cubrir el namespacing por repo (dos
  `withActiveRepo` con repos distintos no comparten `claimedIssues`).
- Tests existentes que hoy mockean `config.productRepo`/`productRepoPath` (`worktree.test.ts`,
  `evidence.test.ts`, `claude-runner.test.ts`, etc.) se actualizan para envolver sus
  casos en `withActiveRepo` en vez de setear esos campos en `config` directamente.
- `github.ts` sigue sin tests unitarios directos de las funciones que invocan `gh` real
  (consistente con el resto del repo hoy) — se valida con un dry run puntual contra un
  repo de prueba antes de mergear, mismo patrón que ya usa `ronin`.

## Archivos afectados

- `src/config.ts` — pierde `productRepo`, `productRepoPath`, `worktreeBasePath`,
  `claudeConfigDir`, `githubApp*`, `mentionHandle`; gana `githubToken`, `githubLogin`.
- `src/github-app-auth.ts` — eliminado.
- `src/repo-context.ts` — nuevo (`activeRepo`, `withActiveRepo`).
- `src/repos.ts` — nuevo (carga/valida `repos.json`).
- `src/local-state.ts` — namespacing de path por repo activo.
- `src/tick.ts` — nuevo `tick()` orquestador que itera repos; el `tick()` actual pasa a
  `tickOneRepo()`.
- `src/agent-task.ts`, `src/claude-runner.ts`, `src/evidence.ts`, `src/github.ts`,
  `src/spec-content.ts`, `src/worktree.ts`, `src/mentions.ts` — rename mecánico de
  `config.xxx` a `activeRepo().xxx` donde aplica; `mentions.ts`/`evidence.ts` además
  cambian su lógica de identidad de bot (`githubAppSlug` + `[bot]` → `githubLogin`).
- `scripts/smoke-test.ts` — reescrito para PAT + loop de repos.
- `scripts/init-labels.sh` — loop de repos.
- `scripts/find-installation-id.ts` — eliminado.
- `.env.example` — se quitan `PRODUCT_REPO`, `PRODUCT_REPO_PATH`,
  `VALERIA_GITHUB_APP_*`, `VALERIA_MENTION_HANDLE`; se agregan `RONIN_GITHUB_TOKEN`,
  `RONIN_GITHUB_LOGIN`, `REPOS_CONFIG_PATH` (opcional).
- `.gitignore` — se agrega `repos.json`.
- `README.md`, `docs/DESIGN.md` §7/§7.2 — se reescriben para reflejar el setup con PAT
  + `repos.json` en vez de GitHub App + usuario mencionable separado.
- Todos los `*.test.ts` correspondientes a los archivos de arriba.

## Fuera de alcance (posible spec futura)

- Overrides por repo de `SPEC_DIR`, el repo de evidencia, o límites/timeouts —
  confirmado que no hace falta hoy; se agregaría a `RepoEntry` si surge la necesidad.
- Paralelizar el procesamiento entre repos (hoy secuencial por decisión explícita).
- `RUNNER_ID` por repo (hoy global, un solo operador).
