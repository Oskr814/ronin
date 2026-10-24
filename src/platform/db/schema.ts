import type { ColumnType, Generated } from 'kysely';

// The tables, as Kysely sees them (#235, stage 2): one interface per table,
// named as in Postgres. Created by the migrations in ./migrations.

// A jsonb column: read as the value, written as its JSON text (pg would send
// a plain string as text, which isn't valid jsonb).
type Json<T> = ColumnType<T, string, string>;
type Stamp = ColumnType<Date, string | undefined, string>;

// Ajustes (platform/config/settings.ts): a value changed from the dashboard, by its key.
export interface SettingsTable {
  key: string;
  value: Json<unknown>;
  updated_by: string;
  updated_at: Stamp;
}

// A task type's own model or effort (Ajustes → Agentes).
export interface TaskSettingsTable {
  task_type: string;
  model: string | null;
  effort: string | null;
  updated_by: string;
  updated_at: Stamp;
}

// The plan each Claude account pays (Ajustes → Cuentas de Claude, claude-plans.ts).
export interface ClaudeAccountPlansTable {
  account: string;
  choice: Json<unknown>;
  updated_by: string;
  updated_at: Stamp;
}

// Every change made in Ajustes, never rewritten (Ajustes → Registro).
export interface SettingsLogTable {
  id: Generated<string>;
  at: ColumnType<Date, string, never>;
  login: string;
  what: string;
  from_value: string;
  to_value: string;
}

// Despliegues (domains/deploys/store.ts): each release ronin published.
export interface DeploysTable {
  repo: string;
  tag: string;
  prerelease: boolean;
  mode: string;
  base: string | null;
  sha: string;
  url: string;
  changes: Json<unknown>;
  pedidos: number[];
  by: string;
  at: ColumnType<Date, string, string>;
  state: string;
  runs: ColumnType<unknown | null, string | null, string | null>;
  ended_at: ColumnType<Date | null, string | null, string | null>;
  release_error: string | null;
}

// Reuniones (domains/meetings/meetings.ts): each meeting, its record as a document.
export interface MeetingsTable {
  number: number;
  repo: string;
  hash: string;
  status: string;
  data: Json<unknown>;
  created_at: ColumnType<Date, string, string>;
  updated_at: Stamp;
}

// The portal's accounts (domains/portal/accounts.ts), each its record as a document.
export interface PortalUsersTable {
  id: string;
  email: string;
  data: Json<unknown>;
  updated_at: Stamp;
}

// The portal's requests (domains/portal/requests.ts), each its record as a document.
export interface PortalRequestsTable {
  number: number;
  user_id: string;
  repo: string;
  status: string;
  data: Json<unknown>;
  created_at: ColumnType<Date, string, string>;
  updated_at: ColumnType<Date, string, string>;
}

// The job queue (apps/api/jobs/store.ts).
type MaybeStamp = ColumnType<Date | null, string | null | undefined, string | null>;
export interface JobsTable {
  id: Generated<string>;
  kind: string;
  repo: string | null;
  payload: ColumnType<unknown, string | undefined, string>;
  dedupe_key: string | null;
  status: string;
  created_at: ColumnType<Date, string | undefined, never>;
  run_after: ColumnType<Date, string | undefined, string>;
  started_at: MaybeStamp;
  finished_at: MaybeStamp;
  lease_until: MaybeStamp;
  runner: string | null;
  pid: number | null;
  error: string | null;
}

// The locks on issues and PRs and the agent slots (platform/locks/locks-db.ts).
export interface LocksTable {
  scope: string;
  name: string;
  holder: string;
  host: string;
  pid: number;
  acquired_at: ColumnType<Date, string | undefined, string>;
  lease_until: ColumnType<Date, string, string>;
}

// What's waiting for a slot (platform/locks/locks-db.ts), for the dashboard's queue.
export interface LockWaitsTable {
  id: Generated<string>;
  holder: string;
  kind: string;
  label: string;
  repo: string | null;
  since: ColumnType<Date, string, string>;
  lease_until: ColumnType<Date, string, string>;
}

// The local state of each repo (platform/state/local-state.ts), an entry per row.
export interface RepoStateTable {
  repo: string;
  kind: string;
  key: string;
  value: Json<unknown>;
  updated_at: Stamp;
}

// The index of the agents' runs (platform/agents/runs-store.ts); each transcript stays a file.
type MaybeNum = number | null;
export interface RunsTable {
  run_id: string;
  day: string;
  repo: string;
  task_type: string;
  label: string;
  issue_number: MaybeNum;
  pr_number: MaybeNum;
  portal_request: MaybeNum;
  meeting: MaybeNum;
  slice_index: MaybeNum;
  slice_title: string | null;
  grp: string | null;
  model: string | null;
  effort: string | null;
  account: string;
  worktree: string;
  host: string | null;
  pid: MaybeNum;
  started_at: ColumnType<Date, string, string>;
  ended_at: ColumnType<Date | null, string | null, string | null>;
  duration_ms: MaybeNum;
  outcome: string | null;
  cost_usd: MaybeNum;
  billing: ColumnType<string | null, string | null | undefined, string | null>;
  error: string | null;
  steps: ColumnType<number, number | undefined, number>;
  last_step: string | null;
  updated_at: Stamp;
}

// What each repo spent on its API fallback since it was last reset (#421).
export interface ApiBudgetsTable {
  repo: string;
  spent_usd: ColumnType<number, number | undefined, number>;
  reset_at: MaybeStamp;
  reset_by: string | null;
  updated_at: Stamp;
}

// Each Claude account's last usage measurement (platform/claude/claude-usage.ts)…
export interface ClaudeUsageTable {
  account: string;
  data: Json<unknown>;
  updated_at: Stamp;
}

// …and every one before.
export interface ClaudeUsageHistoryTable {
  id: Generated<string>;
  account: string;
  at: ColumnType<Date, string, string>;
  data: Json<unknown>;
}

// What was asked of ronin from the tablero (domains/commands/store.ts, #446).
export interface CommandsTable {
  id: Generated<string>;
  repo: string;
  number: number;
  kind: string;
  args: ColumnType<unknown, string | undefined, string>;
  requested_by: string;
  dedupe_key: string | null;
  status: string;
  messages: ColumnType<unknown, string | undefined, string>;
  run_id: string | null;
  error: string | null;
  created_at: ColumnType<Date, string | undefined, never>;
  started_at: MaybeStamp;
  finished_at: MaybeStamp;
}

export interface Database {
  settings: SettingsTable;
  task_settings: TaskSettingsTable;
  claude_account_plans: ClaudeAccountPlansTable;
  settings_log: SettingsLogTable;
  deploys: DeploysTable;
  meetings: MeetingsTable;
  portal_users: PortalUsersTable;
  portal_requests: PortalRequestsTable;
  jobs: JobsTable;
  locks: LocksTable;
  lock_waits: LockWaitsTable;
  repo_state: RepoStateTable;
  runs: RunsTable;
  claude_usage: ClaudeUsageTable;
  claude_usage_history: ClaudeUsageHistoryTable;
  api_budgets: ApiBudgetsTable;
  commands: CommandsTable;
}
