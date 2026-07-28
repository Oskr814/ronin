# Explicit Build Step for the Supervisor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the cron-run supervisor execute a compiled `dist/` build instead of interpreting `src/` live via `tsx`, so a code change (including a merge to `main`) only takes effect once someone explicitly runs `pnpm build`.

**Architecture:** `pnpm build` (`tsc`, already configured with `outDir: dist`) compiles `src/` to `dist/`. `pnpm start` (`node dist/index.js`) runs the compiled output. Only the cron wrapper (`scripts/setup-cron.sh`'s generated `scripts/run-tick.sh`) switches to `pnpm start`; local dev (`pnpm tick`, `tsx`) is untouched.

**Tech Stack:** TypeScript (`tsc`), bash (cron wrapper).

Full design background: `docs/superpowers/specs/2026-07-28-build-step-design.md`.

## Global Constraints

- `pnpm tick` (dev, `tsx`) does not change — the build gate applies only to the cron/production path.
- Build fails loudly on type errors (`noEmitOnError: true`) — never emit a partially-broken `dist/` that looks successful.
- Missing `dist/index.js` blocks the tick (hard fail, clear message); a `dist/` merely older than `src/` only logs a `WARN` and still runs — no automated test, this is a config/shell change verified manually (per spec's Testing section).
- Re-running `scripts/setup-cron.sh` (`pnpm cron:setup`) mutates the real, live crontab on this host — confirm with the human partner before running it for real (Task 4), it is not something to run silently as part of a task's own verification.

---

### Task 1: `package.json` + `tsconfig.json` — build/start scripts, fail-loud on type errors

**Files:**
- Modify: `package.json` (scripts block)
- Modify: `tsconfig.json` (compilerOptions)

**Interfaces:**
- Produces: `pnpm build` (emits `dist/` from `src/`, fails on type errors), `pnpm start` (runs `dist/index.js`) — consumed by the cron wrapper in Task 2.

- [ ] **Step 1: Add `build` and `start` scripts to `package.json`**

In `package.json`, in `"scripts"`, add (after `"typecheck"`):

```json
"build": "tsc",
"start": "node dist/index.js"
```

- [ ] **Step 2: Add `noEmitOnError` to `tsconfig.json`**

In `tsconfig.json`, add to `compilerOptions` (order doesn't matter, e.g. after `"rootDir"`):

```json
"noEmitOnError": true
```

- [ ] **Step 3: Verify a clean build works**

Run: `pnpm build`
Expected: exits 0, no output (tsc is silent on success). Then `ls dist/index.js` — file exists.

- [ ] **Step 4: Verify `noEmitOnError` actually blocks a broken build**

Temporarily introduce a type error to confirm the gate works — do NOT commit this:

```bash
echo "const _bad: number = 'not a number';" >> src/index.ts
pnpm build; echo "exit code: $?"
```

Expected: non-zero exit code, `tsc` reports the type error, and — check `dist/index.ts.js`-equivalent output for `index.ts` is NOT updated (compare `dist/index.js`'s mtime/content to before this step; with `noEmitOnError`, tsc does not rewrite it).

Then revert the temporary line:

```bash
git checkout -- src/index.ts
```

- [ ] **Step 5: Re-run the clean build and typecheck to confirm nothing is left broken**

Run: `pnpm build && pnpm typecheck`
Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json
git commit -m "feat: add pnpm build/start scripts, fail loud on type errors"
```

---

### Task 2: Cron wrapper requires a built `dist/`, warns on staleness

**Files:**
- Modify: `scripts/setup-cron.sh` (the heredoc that generates `scripts/run-tick.sh`)

**Interfaces:**
- Consumes: `pnpm start` (Task 1).
- Produces: the wrapper template that Task 4 deploys for real via `pnpm cron:setup`.

- [ ] **Step 1: Replace the wrapper heredoc's final section**

In `scripts/setup-cron.sh`, inside the `cat > "$WRAPPER" <<EOF ... EOF` block, replace the last two lines:

```bash
set -a
source "$REPO_DIR/.env"
set +a
pnpm tick
EOF
```

with:

```bash
set -a
source "$REPO_DIR/.env"
set +a

if [ ! -f dist/index.js ]; then
  echo "\$(date -Is) [cron] dist/index.js no existe — correr pnpm build" >&2
  exit 1
fi
if [ -n "\$(find src -newer dist/index.js)" ]; then
  echo "\$(date -Is) [cron] WARN: src/ tiene cambios más nuevos que dist/ — considerar pnpm build"
fi
pnpm start
EOF
```

(Note the `\$` escaping — this is inside the existing heredoc, which already escapes `$LOG_DIR`/`$REPO_DIR`-style variables the same way so they end up literal in the generated `scripts/run-tick.sh` rather than expanded when `setup-cron.sh` itself runs. Match that existing style exactly — check the surrounding lines in the file for the pattern before editing.)

- [ ] **Step 2: Verify the shell logic in isolation (without touching the real crontab)**

`scripts/setup-cron.sh` mutates the live crontab when run for real (Task 4 does that deliberately, with confirmation). To verify just the new snippet's logic first, reproduce it standalone:

```bash
mkdir -p /tmp/valeria-wrapper-check/src /tmp/valeria-wrapper-check/dist
cd /tmp/valeria-wrapper-check

# Case 1: dist/index.js missing
rm -f dist/index.js
if [ ! -f dist/index.js ]; then echo "MISSING: blocked as expected"; else echo "FAIL: did not block"; fi

# Case 2: dist/index.js present and current — no warning expected
touch dist/index.js
sleep 1
touch src/some-file.ts
touch dist/index.js  # dist newer than src again
if [ -n "$(find src -newer dist/index.js)" ]; then echo "FAIL: warned when it should not have"; else echo "OK: no warning, dist is current"; fi

# Case 3: src/ newer than dist/index.js — warning expected
sleep 1
touch src/some-file.ts
if [ -n "$(find src -newer dist/index.js)" ]; then echo "OK: warned as expected"; else echo "FAIL: did not warn"; fi

cd -
rm -rf /tmp/valeria-wrapper-check
```

Expected output: `MISSING: blocked as expected`, `OK: no warning, dist is current`, `OK: warned as expected`.

- [ ] **Step 3: Commit**

```bash
git add scripts/setup-cron.sh
git commit -m "feat: cron wrapper requires a built dist/, warns when stale"
```

---

### Task 3: `README.md` note

**Files:**
- Modify: `README.md` (setup steps, near the `pnpm cron:setup` line)

- [ ] **Step 1: Add the note**

In `README.md`, right after the line documenting `pnpm cron:setup`/`pnpm cron:remove`, add:

```markdown
7. Después de cualquier cambio de código, correr `pnpm build` — el cron corre el `dist/` compilado, nunca reconstruye solo. Sin un build nuevo, sigue corriendo la versión vieja (o corta si `dist/` nunca se generó).
```

(Ajustar el número de paso si no es exactamente el 7 — seguir la numeración real del archivo en ese punto.)

- [ ] **Step 2: Verify**

Run: `grep -n "pnpm build" README.md`
Expected: shows the new line.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: note pnpm build as a required step before cron picks up changes"
```

---

### Task 4: Deploy on this host

**Files:** none (commands only — this is the real, live deploy, not a test)

- [ ] **Step 1: Build for real**

Run: `pnpm build && pnpm typecheck`
Expected: both exit 0; `ls dist/index.js` shows the file.

- [ ] **Step 2: Confirm with the human partner before touching the live crontab**

`scripts/setup-cron.sh` (via `pnpm cron:setup`) replaces this repo's crontab entry — it's idempotent and designed to be safe to re-run (same marker-based replace it already does today), but it IS a real mutation of shared host state. Ask explicitly: "¿Confirmás que corra `pnpm cron:setup 5 14` para regenerar `scripts/run-tick.sh` con el wrapper nuevo? Mantiene el mismo intervalo (5 min) y retención (14 días) que ya está instalado hoy." Do not proceed to Step 3 without an explicit yes.

- [ ] **Step 3: Regenerate the live wrapper**

Run: `pnpm cron:setup 5 14`
Expected: prints `Cron instalado: cada 5 min -> .../scripts/run-tick.sh`. Then `cat scripts/run-tick.sh` — confirm it ends with the `dist/index.js` check + `pnpm start`, not `pnpm tick`.

- [ ] **Step 4: Verify the live wrapper runs clean once**

Run: `./scripts/run-tick.sh` (manually, once, outside of cron)
Then: `tail -20 logs/tick-$(date +%F).log`
Expected: a normal `tick complete` line (or normal tick activity) — same shape as existing log entries, no `dist/index.js no existe` error.

No commit in this task — it's a live deploy action, not a code change.
