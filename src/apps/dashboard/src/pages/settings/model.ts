// Ajustes' words, and the shapes of what /api/settings answers (its
// services say `unknown`, so the page says what it reads). The JSON keys
// are the server's, in Spanish.

export type Value = string | number | boolean;

export interface Setting {
  key: string;
  env: string;
  type: 'int' | 'bool' | 'enum' | 'text';
  value: Value;
  source: 'tablero' | 'env' | 'defecto';
  base: Value;
  baseSource: 'env' | 'defecto';
  min?: number;
  max?: number;
  options?: string[];
}

export interface Task {
  task: string;
  model: string;
  effort: string;
  envModel: string | null;
  envEffort: string | null;
  defaultModel: string | null;
  defaultEffort: string | null;
}

export interface Notifications { repo: string; events: string[]; chosen: boolean }

export interface Page {
  me: { login: string; admin: boolean };
  perfil: { name?: string; email?: string; linear?: Record<string, { id: string; name?: string }> };
  notificaciones: Notifications[];
  notifyTo?: string;
  linear: Array<{ repo: string; team: string; workspace?: string | null; people: Array<{ id: string; name: string }> }>;
  valores: Setting[];
  tareas: Task[];
  fixed: { previewPortRange: string; runnerId: string; githubLogin: string };
  portal: { url: string };
  dashboard: { url: string };
}

export interface LogEntry { at: string; login: string; what: string; from: string; to: string }

export interface Connections {
  github: { ok: boolean; login?: string; expires?: string; error?: string };
  oauth: boolean;
  webhookSecret: boolean;
  gmail: { user: string; password: boolean };
  sessions: { dashboard: boolean; portal: boolean };
}

export interface Plan { id: string; name: string; priceUsd: number | null }
export interface UsageWindow { utilization: number; resetsAt: string }
export interface Account {
  account: string;
  claudeConfigDir: string;
  repos: string[];
  plan: { plan: string; name: string; priceUsd: number | null; source: string };
  usage: { measuredAt: string; fiveHour?: UsageWindow; sevenDay?: UsageWindow } | null;
}
export interface Accounts { plans: Plan[]; cuentas: Account[] }

export interface Person {
  login: string;
  name?: string;
  email?: string;
  role: 'admin' | 'member';
  envAdmin: boolean;
  lastSeenAt?: string;
  addedBy?: string;
}
export interface Team {
  entrada: 'github' | 'lista';
  entradaSet: boolean;
  porDefecto: SetName;
  envAllowed: string[];
  people: Array<Person & { repos: Array<{ repo: string; github: string | null; set: string | null; hidden: boolean; desplegar: boolean }> }>;
}
export type Perms = Record<'notas' | 'aprobar' | 'acciones' | 'desplegar', boolean>;
export interface User extends Person {
  porDefecto: SetName;
  entrada: 'github' | 'lista';
  notificaciones: Notifications[];
  repos: Array<{ repo: string; github: string | null; githubLets: boolean | null; set: string | null; hidden: boolean; perms: Perms }>;
}

export interface RepoApp { id: string; inManifest: boolean; portal: boolean; name?: string; description?: string; explore: boolean; project?: string }
export interface Repo {
  repo: string;
  productRepoPath: string;
  claudeConfigDir?: string;
  baseRef?: string;
  changelogRepo?: string;
  portal: { name: string; notifyTo: string[] } | null;
  apps: RepoApp[];
  linear: { apiKeyEnv: string; connected: boolean; projects: string[] } | null;
  deploy: { prerelease: boolean; selective: boolean } | null;
  agent: { model: string; effort: string };
  autoMerge: boolean;
  concurrency: number | null;
}
export interface Repos {
  path: string;
  linearKeys: string[];
  models: string[];
  efforts: string[];
  defaults: { baseRef: string; model: string; effort: string; concurrency: number };
  maxConcurrency: number;
  repos: Repo[];
}

// The portal's accounts (#114): role Usuario in Usuarios.
export interface Grant { repo: string; app: string }
export interface PortalApp extends Grant { org: string; name: string; description?: string }
export interface PortalUser {
  id: string;
  name: string;
  email: string;
  grants: Grant[];
  dailyLimit?: number | null;
  disabled: boolean;
  hasPassword: boolean;
  link?: { expiresAt: string };
  createdBy: string;
  lastLoginAt?: string;
  today?: { used: number; limit: number };
}
export interface Portal { dailyLimit: number; apps: PortalApp[]; users: PortalUser[] }
// What an account's change answers: a link that didn't go out by email, to pass on.
export interface PortalChange { user: PortalUser; sent?: boolean; url?: string }

// What each setting is, in words; the server says its value and where it comes from.
export const SETTINGS: Record<string, [string, string, string]> = {
  'dashboard.sessionDays': ['Duración de la sesión', 'Cuánto dura una sesión del tablero antes de volver a entrar con GitHub. Las que ya están abiertas no cambian.', 'días'],
  'dashboard.githubTtlSeconds': ['Datos de GitHub', 'Cuánto se reusa lo que el tablero leyó de GitHub antes de volver a pedirlo.', 's'],
  'portal.dailyLimit': ['Pedidos por día', 'Los que puede empezar cada persona del portal por día, salvo que su cuenta tenga otro tope.', 'pedidos'],
  'portal.sessionDays': ['Duración de la sesión del portal', 'Las sesiones que ya están abiertas no cambian.', 'días'],
  'agent.model': ['Modelo', 'El de todas las corridas, salvo las que tienen el suyo abajo o en su repo. "(lo que diga Claude)": el de la configuración de la cuenta.', ''],
  'agent.effort': ['Esfuerzo', '', ''],
  'agent.reviewWorkerModel': ['Modelo de los revisores', 'Los agentes que juntan candidatos en la review de PRs externos; el orquestador usa el modelo de arriba.', ''],
  'agent.taskTimeoutMinutes': ['Tope de una corrida', 'Pasado este tiempo, una corrida de claude -p se considera colgada y se corta.', 'min'],
  'agent.handlerTimeoutMinutes': ['Tope de un webhook', 'Todo lo que hace un evento de GitHub: esperar su turno, un lugar y cada agente que lance.', 'min'],
  'tick.intervalMinutes': ['Cada cuánto corre el tick', 'La conciliación de todos los repos, contada desde la hora en punto (30: a las :00 y a las :30). Solo con la base de datos: sin ella, la frecuencia la decide el cron.', 'min'],
  'tick.concurrency': ['Tareas por repo', 'Las que corren juntas en cada repo, de todos los flujos (issues, reviews, /spike, changelog, exploración). Cada repo tiene su propia cola, y puede tener su número en Repos.', 'a la vez'],
  'tick.externalReviewConcurrency': ['De ellas, reviews externas', 'Cada review es un orquestador con sus revisores: tres juntas agotaron el límite de la cuenta.', 'a la vez'],
  'retry.e2e': ['La misma falla de CI', 'Veces que se intenta arreglar una misma falla antes de bloquear.', 'veces'],
  'retry.e2eHard': ['Tope de intentos con CI rojo', 'Aunque cada intento falle distinto.', 'intentos'],
  'retry.checksPending': ['CI sin terminar', 'Ticks que se espera un CI pendiente antes de bloquear (60 ≈ 5 h).', 'ticks'],
  'retry.slice': ['Una slice', '', 'intentos'],
  'retry.retarget': ['Cambiar la base de un PR', '', 'intentos'],
  'retry.issueError': ['Un issue que da error', '', 'intentos'],
  'explore.timezone': ['Zona horaria', 'La ventana nocturna, la fecha de cada corrida y la semana de su PR.', ''],
  'explore.nightWindow': ['Ventana nocturna', 'HH:MM-HH:MM; puede cruzar la medianoche. Pasado el fin no empieza ninguna función nueva.', ''],
  'explore.functionsPerNight': ['Funciones por noche', 'El presupuesto: usa el límite semanal de Claude de la cuenta, el mismo del trabajo de día.', 'funciones'],
  'explore.functionsPerRun': ['Funciones por corrida de /explore', '', 'funciones'],
  'explore.findingsPerRun': ['Hallazgos que se publican', 'Los más graves primero.', 'fichas'],
  'explore.ideasPerRun': ['Ideas que se publican', 'Nunca en el lugar de un hallazgo.', 'fichas'],
  'explore.publishEvidence': ['Subir las capturas', 'A la rama ronin/evidence del repo del producto, para verlas en las fichas y el PR.', ''],
  'preview.prepareData': ['Preparar datos para probar', 'Un agente lee el PR y deja los datos para probarlo, además de los seeds.', ''],
  'preview.ttlMinutes': ['Cuánto vive una preview', 'Desde que se levanta. 0: hasta /preview stop o que se cierre el PR.', 'min'],
  'preview.maxPerRepo': ['Previews a la vez', 'Por repo; la siguiente se rechaza.', 'por repo'],
};
// The emails ronin sends the team (#174, stage 4), each person choosing theirs repo by repo.
export const EVENTS = [
  ['pedido-equipo', 'Pedido para el equipo', 'Un pedido o un error del portal que pasa al equipo, con su issue.'],
  ['pedido-revisar', 'Pedido para revisar', 'El PR que ronin abrió para un pedido espera la aprobación de alguien.'],
  ['reunion', 'Propuestas de una reunión', 'ronin terminó de leer unas notas y hay propuestas para aprobar.'],
  ['bloqueo', 'Bloqueos', 'Un issue o PR de ronin necesita a alguien (docs/BLOCKING.md).'],
] as const;
// Ajustes → Usuarios (#174, stage 2): what each person can do repo by repo,
// never more than GitHub gives.
export const SETS = { todo: ['Todo', 'como hoy'], reuniones: ['Reuniones y pedidos', 'sin tocar código'], lectura: ['Solo lectura', 've el repo, no hace nada'] } as const;
export type SetName = keyof typeof SETS;
export const PERMS = [['notas', 'Subir notas', 'de reuniones'], ['aprobar', 'Aprobar', 'lo que propone una reunión'], ['acciones', 'Acciones', 'asignar a ronin, /spike, /spec, revisar, auto-merge'], ['desplegar', 'Desplegar', 'publicar un release']] as const;

export const word = (value: Value | null | undefined) => (value === true ? 'sí' : value === false ? 'no' : value === '' ? '(lo que diga Claude)' : String(value));
export const repoShort = (repo: string) => repo.split('/')[1] ?? repo;
export const setName = (set: string | null, def?: SetName) => (set === 'custom' ? 'Personalizado' : set ? SETS[set as SetName][0] : SETS[def ?? 'todo'][0]);
// "General · portal.dailyLimit" reads as the setting's name.
export const what = (w: string) => w.replace(/^(\S+) · ([\w.]+)$/, (m, sec: string, key: string) => (SETTINGS[key] ? `${sec} · ${SETTINGS[key][0]}` : m));
export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });

export const appKey = (a: Grant) => `${a.repo}:${a.app}`;
export const appLabel = (apps: PortalApp[] | undefined, grant: Grant) => {
  const app = apps?.find((a) => appKey(a) === appKey(grant));
  return app ? `${app.org} · ${app.name}` : `${grant.repo} · ${grant.app} (ya no está en el portal)`;
};
export function portalStatus(u: PortalUser): [string, string] {
  if (u.disabled) return ['idle', 'desactivada'];
  if (!u.hasPassword) return u.link && Date.parse(u.link.expiresAt) > Date.now() ? ['warn', 'invitada'] : ['crit', 'invitación vencida'];
  return ['ok', 'activa'];
}
