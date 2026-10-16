import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// config.ts throws on load when a required env var is missing. Importing a
// feature through its barrel (src/<feature>/index.ts) loads every module of
// that feature, so a test can end up loading config.ts even when the module
// under test never reads it. Placeholder values, only where a test hasn't set
// its own.
for (const name of ['RONIN_GITHUB_TOKEN', 'RONIN_GITHUB_LOGIN', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'NOTIFY_TO', 'RUNNER_ID']) {
  process.env[name] ??= `test-${name.toLowerCase()}`;
}

// Never the runner's own files: the checkout tests run in may be the live
// runner, and a test using the real local state or locks with config's
// defaults wrote into its .ronin-state (2026-10-16). Always overridden, even
// when the shell running the tests has the runner's .env loaded.
const scratch = mkdtempSync(join(tmpdir(), 'ronin-test-'));
process.env.LOCAL_STATE_PATH = join(scratch, '.ronin-state.json');
process.env.WORKTREE_BASE_PATH = join(scratch, 'worktrees');
process.env.RONIN_LOGS_DIR = join(scratch, 'logs');
