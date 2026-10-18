import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../core/config.js';
import { log } from '../../core/logger.js';
import type { RepoEntry } from '../../core/repo-context.js';
import { validateRepos } from '../../core/repos.js';
import { linearKey, teamPlanning } from '../../core/linear-api.js';
import { withJson } from '../../portal/json-store.js';
import { AjustesError, record } from './ajustes.js';
import { repoApps } from './dashboard-new-issue.js';

// Ajustes → Repos (#174, stage 5), admins only:
//   GET  /api/ajustes/repos                  each repo of repos.json, with what can be changed from here
//   POST /api/ajustes/repos/<owner>/<repo>   one change: { baseRef } | { portalName } | { app: { id, portal?, name?, description?, explore?, project? } }
//                                            | { linear } | { deploy: { on?, prerelease?, selective? } } | { agent: { model?, effort? } } | { notifyTo }
//
// repos.json stays where every repo lives: what changes here is written
// there, checked with the same rules that read it (validateRepos) and with
// a copy of the previous one kept in <SETTINGS_DATA_DIR>/repos-json/. Adding
// or removing a repo, its checkout, its Claude account and its changelog
// (a path on the server) are still done in the file.

const BACKUPS_KEPT = 30;
const MODELS = ['opus', 'sonnet', 'haiku'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const LINEAR_TTL_MS = 10 * 60_000;

type Raw = Record<string, unknown> & { productRepo: string };

// The env vars that hold a Linear key, by name only: the key never leaves .env.
const linearKeyNames = () => Object.keys(process.env).filter((name) => /^LINEAR_API_KEY_[A-Z0-9_]+$/.test(name) && process.env[name]).sort();

const projectsCache = new Map<string, { at: number; names: string[] }>();
async function linearProjects(entry: RepoEntry, now = Date.now()): Promise<string[]> {
  const key = linearKey(entry);
  if (!key) return [];
  const cached = projectsCache.get(entry.productRepo);
  if (cached && now - cached.at < LINEAR_TTL_MS) return cached.names;
  const names = await teamPlanning(entry, key).then((p) => (p?.projects ?? []).map((x) => x.name), (error) => {
    log.error(`repos: no se pudieron leer los proyectos de Linear de ${entry.productRepo}`, error);
    return cached?.names ?? [];
  });
  projectsCache.set(entry.productRepo, { at: now, names });
  return names;
}

export async function reposView(entries: RepoEntry[]): Promise<unknown> {
  return {
    path: config.reposConfigPath,
    linearKeys: linearKeyNames(),
    models: MODELS,
    efforts: EFFORTS,
    defaults: { baseRef: config.worktreeBaseRef, model: config.agentModel, effort: config.agentEffort },
    repos: await Promise.all(entries.map(async (entry) => {
      const manifest = await repoApps(entry);
      const ids = [...new Set([...manifest, ...Object.keys(entry.portal?.apps ?? {}), ...(entry.explore ?? [])])];
      return {
        repo: entry.productRepo,
        productRepoPath: entry.productRepoPath,
        ...(entry.claudeConfigDir ? { claudeConfigDir: entry.claudeConfigDir } : {}),
        ...(entry.worktreeBaseRef ? { baseRef: entry.worktreeBaseRef } : {}),
        ...(entry.changelogRepo ? { changelogRepo: entry.changelogRepo } : {}),
        portal: entry.portal ? { name: entry.portal.name, notifyTo: entry.portal.notifyTo ?? [] } : null,
        apps: ids.map((id) => ({
          id,
          inManifest: manifest.includes(id),
          portal: Boolean(entry.portal?.apps[id]),
          ...(entry.portal?.apps[id] ? { name: entry.portal.apps[id].name, ...(entry.portal.apps[id].description ? { description: entry.portal.apps[id].description } : {}) } : {}),
          explore: (entry.explore ?? []).includes(id),
          ...(entry.linear?.explorationProject?.[id] ? { project: entry.linear.explorationProject[id] } : {}),
        })),
        linear: entry.linear ? { apiKeyEnv: entry.linear.apiKeyEnv, connected: Boolean(linearKey(entry)), projects: await linearProjects(entry) } : null,
        deploy: entry.deploy ? { prerelease: entry.deploy.prerelease === true, selective: entry.deploy.selective === true } : null,
        agent: { model: entry.agent?.model ?? '', effort: entry.agent?.effort ?? '' },
      };
    })),
  };
}

// The previous repos.json, before it's written: the last few are kept.
async function backup(): Promise<void> {
  const dir = join(config.settings.dataDir, 'repos-json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await copyFile(config.reposConfigPath, join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
  const old = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort().slice(0, -BACKUPS_KEPT);
  for (const file of old) await rm(join(dir, file), { force: true });
}

const str = (value: unknown) => (typeof value === 'string' ? value.trim() : undefined);
const yesNo = (value: unknown) => (value ? 'sí' : 'no');

// Applies one change to the repo's raw entry, as it is in the file (so what
// the page doesn't touch stays as it was), and says what changed.
function apply(raw: Raw, body: Record<string, unknown>, manifest: string[]): Array<{ what: string; from: string; to: string }> {
  const changes: Array<{ what: string; from: string; to: string }> = [];
  const portal = raw.portal as { name: string; apps: Record<string, { name: string; description?: string }>; notifyTo?: string[] } | undefined;

  if (body.baseRef !== undefined) {
    const ref = body.baseRef === null ? '' : str(body.baseRef);
    if (ref === undefined || (ref && !/^[\w./-]+$/.test(ref))) throw new AjustesError('La rama base no es válida (p. ej. origin/main).');
    const before = (raw.worktreeBaseRef as string | undefined) ?? '';
    if (ref) raw.worktreeBaseRef = ref;
    else delete raw.worktreeBaseRef;
    if (before !== ref) changes.push({ what: 'rama base', from: before || `la de .env (${config.worktreeBaseRef})`, to: ref || `la de .env (${config.worktreeBaseRef})` });
  }

  if (body.portalName !== undefined) {
    const name = str(body.portalName);
    if (!portal) throw new AjustesError('Este repo no está en el portal: hace falta al menos una app en el portal.');
    if (!name) throw new AjustesError('El nombre en el portal no puede quedar vacío.');
    if (portal.name !== name) changes.push({ what: 'nombre en el portal', from: portal.name, to: name });
    portal.name = name;
  }

  if (body.app !== undefined) {
    const app = (body.app ?? {}) as Record<string, unknown>;
    const id = str(app.id);
    if (!id) throw new AjustesError('Falta la app.');
    const known = manifest.includes(id) || Boolean(portal?.apps[id]) || ((raw.explore as string[] | undefined) ?? []).includes(id);
    if (!known) throw new AjustesError(`${id} no está en el ronin.app.json del repo.`);
    if (app.portal !== undefined) {
      const on = app.portal === true;
      const was = Boolean(portal?.apps[id]);
      if (on && !was) {
        if (!manifest.includes(id)) throw new AjustesError(`${id} ya no está en el ronin.app.json del repo: no se puede agregar al portal.`);
        if (!portal) raw.portal = { name: raw.productRepo.split('/')[1], apps: { [id]: { name: id } } };
        else portal.apps[id] = { name: id };
      } else if (!on && was) {
        if (Object.keys(portal!.apps).length === 1) throw new AjustesError('Es la única app del portal en este repo: el portal necesita al menos una.');
        delete portal!.apps[id];
      }
      if (on !== was) changes.push({ what: `${id} · en el portal`, from: yesNo(was), to: yesNo(on) });
    }
    const portalApp = (raw.portal as typeof portal)?.apps[id];
    for (const field of ['name', 'description'] as const) {
      if (app[field] === undefined) continue;
      if (!portalApp) throw new AjustesError(`${id} no está en el portal.`);
      const value = str(app[field]) ?? '';
      if (field === 'name' && !value) throw new AjustesError('El nombre de la app en el portal no puede quedar vacío.');
      const before = portalApp[field] ?? '';
      if (value) portalApp[field] = value;
      else delete portalApp[field];
      if (before !== value) changes.push({ what: `${id} · ${field === 'name' ? 'nombre en el portal' : 'descripción'}`, from: before || '—', to: value || '—' });
    }
    if (app.explore !== undefined) {
      const list = ((raw.explore as string[] | undefined) ?? []).filter((a) => a !== id);
      const was = ((raw.explore as string[] | undefined) ?? []).includes(id);
      if (app.explore === true) list.push(id);
      if (list.length) raw.explore = list;
      else delete raw.explore;
      if (was !== (app.explore === true)) changes.push({ what: `${id} · exploración nocturna`, from: yesNo(was), to: yesNo(app.explore) });
    }
    if (app.project !== undefined) {
      const linear = raw.linear as { apiKeyEnv: string; explorationProject?: Record<string, string> } | undefined;
      if (!linear) throw new AjustesError('Este repo no tiene Linear.');
      const project = app.project === null ? '' : str(app.project) ?? '';
      const before = linear.explorationProject?.[id] ?? '';
      const map = { ...(linear.explorationProject ?? {}) };
      if (project) map[id] = project;
      else delete map[id];
      if (Object.keys(map).length) linear.explorationProject = map;
      else delete linear.explorationProject;
      if (before !== project) changes.push({ what: `${id} · proyecto de Linear`, from: before || 'ninguno', to: project || 'ninguno' });
    }
  }

  if (body.linear !== undefined) {
    const name = body.linear === null ? '' : str(body.linear) ?? '';
    if (name && !linearKeyNames().includes(name)) throw new AjustesError(`${name} no está en .env.`);
    const linear = raw.linear as { apiKeyEnv: string } | undefined;
    const before = linear?.apiKeyEnv ?? '';
    if (!name) delete raw.linear;
    else if (linear) linear.apiKeyEnv = name;
    else raw.linear = { apiKeyEnv: name };
    if (before !== name) changes.push({ what: 'Linear', from: before || 'sin Linear', to: name || 'sin Linear' });
  }

  if (body.deploy !== undefined) {
    const d = (body.deploy ?? {}) as Record<string, unknown>;
    for (const k of ['on', 'prerelease', 'selective']) if (d[k] !== undefined && typeof d[k] !== 'boolean') throw new AjustesError('Despliegues: cada opción es sí o no.');
    const before = raw.deploy as { prerelease?: boolean; selective?: boolean } | undefined;
    if (d.on === false) delete raw.deploy;
    else {
      if (d.on !== true && !before) throw new AjustesError('Este repo no se despliega desde ronin: primero hay que prenderlo.');
      const next: { prerelease?: boolean; selective?: boolean } = { ...(before ?? {}) };
      for (const k of ['prerelease', 'selective'] as const) {
        if (d[k] === true) next[k] = true;
        else if (d[k] === false) delete next[k];
      }
      raw.deploy = next;
    }
    const label = (x: { prerelease?: boolean; selective?: boolean } | undefined) => (x ? ['sí', x.prerelease ? 'pre-release' : '', x.selective ? 'PRs elegidos' : ''].filter(Boolean).join(', ') : 'no');
    if (label(before) !== label(raw.deploy as typeof before)) changes.push({ what: 'despliegues', from: label(before), to: label(raw.deploy as typeof before) });
  }

  if (body.agent !== undefined) {
    const a = (body.agent ?? {}) as Record<string, unknown>;
    const agent = { ...((raw.agent as Record<string, unknown> | undefined) ?? {}) };
    for (const [field, allowed] of [['model', MODELS], ['effort', EFFORTS]] as const) {
      if (a[field] === undefined) continue;
      const value = a[field] === null ? '' : str(a[field]) ?? '';
      if (value && !allowed.includes(value)) throw new AjustesError(`${field === 'model' ? 'Ese modelo' : 'Ese esfuerzo'} no existe.`);
      const before = (agent[field] as string | undefined) ?? '';
      if (value) agent[field] = value;
      else delete agent[field];
      if (before !== value) changes.push({ what: field === 'model' ? 'modelo de los agentes' : 'esfuerzo de los agentes', from: before || 'el general', to: value || 'el general' });
    }
    if (Object.keys(agent).length) raw.agent = agent;
    else delete raw.agent;
  }

  if (body.notifyTo !== undefined) {
    if (!portal) throw new AjustesError('Este repo no está en el portal.');
    if (!Array.isArray(body.notifyTo) || body.notifyTo.some((a) => typeof a !== 'string')) throw new AjustesError('notifyTo es una lista de correos.');
    const keep = (body.notifyTo as string[]).map((a) => a.trim()).filter(Boolean);
    // Only taking addresses off: who gets what is chosen in Notificaciones now.
    if (keep.some((a) => !(portal.notifyTo ?? []).includes(a))) throw new AjustesError('Desde aquí solo se quitan correos de portal.notifyTo; cada persona elige los suyos en Notificaciones.');
    const before = portal.notifyTo ?? [];
    if (keep.length) portal.notifyTo = keep;
    else delete portal.notifyTo;
    if (before.length !== keep.length) changes.push({ what: 'portal.notifyTo', from: before.join(', ') || '—', to: keep.join(', ') || '—' });
  }
  return changes;
}

export async function editRepo(admin: string, repo: string, body: Record<string, unknown>, entries: RepoEntry[]): Promise<unknown> {
  const entry = entries.find((e) => e.productRepo === repo);
  if (!entry) throw new AjustesError('Ese repo no está en repos.json.', 404);
  const manifest = await repoApps(entry);
  const changes = await withJson<Raw[], Array<{ what: string; from: string; to: string }>>(config.reposConfigPath, () => { throw new AjustesError(`No existe ${config.reposConfigPath}.`, 500); }, async (list) => {
    const raw = list.find((e) => e.productRepo === repo);
    if (!raw) throw new AjustesError('Ese repo no está en repos.json.', 404);
    const found = apply(raw, body, manifest);
    if (!found.length) return found;
    try {
      validateRepos(list);
    } catch (error) {
      throw new AjustesError(`No se guardó: repos.json quedaría mal. ${(error as Error).message}`);
    }
    await backup();
    return found;
  });
  for (const change of changes) await record({ login: admin, what: `Repos · ${repo} · ${change.what}`, from: change.from, to: change.to });
  if (changes.length) log.info(`repos: ${admin} cambió ${repo} en repos.json: ${changes.map((c) => c.what).join(', ')}`);
  return { changed: changes.length };
}
