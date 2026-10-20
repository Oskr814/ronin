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

export interface Database {
  settings: SettingsTable;
  task_settings: TaskSettingsTable;
  claude_account_plans: ClaudeAccountPlansTable;
  settings_log: SettingsLogTable;
}
