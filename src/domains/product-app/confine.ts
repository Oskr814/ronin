import { renderTemplate, type TemplateContext } from './manifest.js';

// What an app on a checkout of the agent's (#257, AppUpOptions.as) may ask
// of ronin's Docker. Its compose and its steps run as root, and what they
// say can come from the agent — a .env it left in the checkout, a manifest
// it edited — or from a PR's head. So the stack reaches only its checkout,
// and a step that uses it only runs a command in one of its containers.

// What would let a container out of the stack: onto the host's files
// beyond the checkout, its devices, or its namespaces.
const ESCAPES = ['privileged', 'cap_add', 'devices', 'device_cgroup_rules', 'security_opt', 'pid', 'ipc', 'network_mode', 'userns_mode', 'uts', 'cgroup_parent'];

// Of `docker compose config --format json`: every bind mount inside `dir`,
// nothing of ESCAPES. Throws with everything that isn't.
export function confineCompose(resolved: any, dir: string): void {
  const problems: string[] = [];
  const inside = (source: string) => source === dir || source.startsWith(`${dir}/`);
  for (const [name, service] of Object.entries<any>(resolved.services ?? {})) {
    for (const key of ESCAPES) if (service[key] !== undefined && service[key] !== false) problems.push(`${name}: ${key}`);
    for (const volume of Array.isArray(service.volumes) ? service.volumes : []) {
      if (volume?.type === 'bind' && !(typeof volume.source === 'string' && inside(volume.source))) problems.push(`${name}: monta ${volume.source}, fuera del checkout`);
    }
  }
  if (problems.length > 0) throw new Error(`el compose de la app pide más de lo que se le da en un checkout del agente: ${problems.join('; ')}`);
}

const STEP_RE = /^\s*\{\{\s*compose\s*\}\}\s+([\s\S]*)$/;
const SHELL = /[;&|<>()$`\\*?[\]{}~#!\n]/;
// `docker compose exec`'s own options a step may use, and whether each
// takes a value.
const EXEC_OPTIONS: Record<string, boolean> = { '-T': false, '--no-TTY': false, '-e': true, '--env': true, '-u': true, '--user': true, '-w': true, '--workdir': true, '--index': true };

// Words as sh would split them, for a step without anything of sh in it:
// quotes are taken literally, and anything sh would expand or run is
// refused.
function words(text: string): string[] {
  const out: string[] = [];
  let word: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"') {
      const end = text.indexOf(c, i + 1);
      if (end < 0) throw new Error('una comilla sin cerrar');
      const quoted = text.slice(i + 1, end);
      if (c === '"' && /[$`\\]/.test(quoted)) throw new Error('$, ` o \\ entre comillas dobles');
      word = (word ?? '') + quoted;
      i = end;
    } else if (/\s/.test(c)) {
      if (word !== null) out.push(word);
      word = null;
    } else if (SHELL.test(c)) {
      throw new Error(`"${c}", que es de sh`);
    } else {
      word = (word ?? '') + c;
    }
  }
  if (word !== null) out.push(word);
  return out;
}

// A step that uses the stack, as the arguments that follow `docker compose
// -p … -f …`: only `{{compose}} exec [options] <service> <command…>`, with
// nothing for sh. Throws when it is anything else.
export function stackCommand(template: string, ctx: TemplateContext): string[] {
  const match = STEP_RE.exec(template);
  if (!match) throw new Error(`en un checkout del agente, un paso que usa el stack empieza con {{compose}}: "${template}"`);
  let args: string[];
  try {
    args = words(renderTemplate(match[1], ctx));
  } catch (error) {
    throw new Error(`en un checkout del agente, un paso que usa el stack no lleva nada de sh (${(error as Error).message}): "${template}"`);
  }
  if (args[0] !== 'exec') throw new Error(`en un checkout del agente, un paso que usa el stack solo corre \`{{compose}} exec\`: "${template}"`);
  let i = 1;
  while (i < args.length && args[i].startsWith('-')) {
    const [flag] = args[i].split('=');
    if (!(flag in EXEC_OPTIONS)) throw new Error(`\`{{compose}} exec\` no acepta ${flag} en un checkout del agente: "${template}"`);
    i += EXEC_OPTIONS[flag] && !args[i].includes('=') ? 2 : 1;
  }
  if (i >= args.length) throw new Error(`\`{{compose}} exec\` sin servicio: "${template}"`);
  return args;
}
