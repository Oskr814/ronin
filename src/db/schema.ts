import type { ColumnType, Generated } from 'kysely';

// The tables, as Kysely sees them (#235, stage 2): one interface per table,
// named as in Postgres. Created by the migrations in ./migrations.

// A jsonb column: read as the value, written as its JSON text (pg would send
// a plain string as text, which isn't valid jsonb).
type Json<T> = ColumnType<T, string, string>;
type Stamp = ColumnType<Date, string | undefined, string>;

// Ajustes (core/settings.ts): a value changed from the dashboard, by its key.
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

// Despliegues (deploy/store.ts): each release ronin published.
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

// Reuniones (meetings/meetings.ts): each meeting, its record as a document.
export interface MeetingsTable {
  number: number;
  repo: string;
  hash: string;
  status: string;
  data: Json<unknown>;
  created_at: ColumnType<Date, string, string>;
  updated_at: Stamp;
}

// The portal's accounts (portal/accounts.ts), each its record as a document.
export interface PortalUsersTable {
  id: string;
  email: string;
  data: Json<unknown>;
  updated_at: Stamp;
}

// The portal's requests (portal/requests.ts), each its record as a document.
export interface PortalRequestsTable {
  number: number;
  user_id: string;
  repo: string;
  status: string;
  data: Json<unknown>;
  created_at: ColumnType<Date, string, string>;
  updated_at: ColumnType<Date, string, string>;
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
}
