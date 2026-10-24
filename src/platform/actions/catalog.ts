import { z } from 'zod';
import type { CommentKind } from '../github/github.js';
import { closingRefs } from '../github/pr-body.js';

// The actions an agent can ask the supervisor for (#257): everything that
// changes something outside the agent's own checkout goes through one of
// these. Each is validated here, against its input schema and against the
// run's scope, before anything happens — the rules the prompts used to ask
// the model to follow ("amend, never a new commit", "never write @handle",
// "only the threads listed") are checked in code instead. What an action
// does is executors.ts's business.

// A thread the run attends: the id of its first comment, which is what the
// agent sees and names, and the GraphQL id resolving it needs.
export interface ScopeThread {
  commentId: number;
  threadId: string;
}

// What one run may do, set by the supervisor when it starts the run — never
// by the model.
export interface RunScope {
  // The PR the run works on; none yet for one that opens it (pr.create).
  prNumber?: number;
  // The branch a push goes to; without it there is no git.push.
  headRef?: string;
  // The commit the run started from.
  startSha?: string;
  // What a push may be (default 'amend'):
  //   amend         one commit that replaces the one it started from
  //   branch        the run's own branch: whatever it built on baseSha,
  //                 leased on what the branch had on origin when it started
  //                 (remoteSha; null: it didn't exist)
  //   fast-forward  new commits on top of the one it started from, never
  //                 rewriting what people already review
  push?: { mode: 'amend' } | { mode: 'branch'; baseSha: string; remoteSha: string | null } | { mode: 'fast-forward' };
  // The PR a run may open (pr.create), with what ronin decides about it:
  // its base, whether it's a draft, who it's assigned to, and the issue its
  // body has to close.
  pr?: { base: string; draft: boolean; assignee?: string; closes?: number };
  // The issue a run may comment on or edit (issue.comment,
  // issue.update-body): its whole body, or only what it adds at the end.
  issue?: { number: number; body?: 'replace' | 'append' };
  threads: ScopeThread[];
  // The comments that asked for the run: a review comment is answered in
  // its thread (pr.reply), a general one or a review's own text with
  // pr.comment.
  triggers: Array<{ id: number; kind: CommentKind }>;
  allowed: ActionName[];
}

export class ActionRefused extends Error {}

const prNumberOf = (scope: RunScope): number => {
  if (scope.prNumber === undefined) throw new ActionRefused('esta corrida no tiene un PR');
  return scope.prNumber;
};
export { prNumberOf };

// "@persona" pings that person on GitHub; an e-mail address ("x@y.z"), an
// npm scope ("@scope/pkg") and anything inside backticks don't. Same rule
// every prompt repeats, enforced.
const MENTION_RE = /(^|[^\w.+-])@[A-Za-z0-9][A-Za-z0-9-]{0,38}(?![A-Za-z0-9/-])/;
const CODE_RE = /```[\s\S]*?```|`[^`\n]*`/g;

export function hasMention(text: string): boolean {
  return MENTION_RE.test(text.replace(CODE_RE, ''));
}

const body = z
  .string()
  .trim()
  .min(1)
  .max(4_000)
  .refine((s) => !hasMention(s), { message: 'no se puede escribir @ seguido de un nombre: menciona a la persona por su rol' });

const commentId = z.number().int().positive();

export const ACTIONS = {
  'pr.reply': {
    summary: 'Responde dentro del hilo de review de un comentario listado.',
    input: z.object({ commentId: commentId.describe('El id del comentario al que respondes'), body: body.describe('La respuesta, en Markdown') }),
  },
  'pr.comment': {
    summary: 'Deja un comentario general en el PR.',
    input: z.object({ body: body.describe('El comentario, en Markdown') }),
  },
  'pr.resolve-thread': {
    summary: 'Resuelve el hilo de un comentario listado. Solo si cambiaste código por ese hilo.',
    input: z.object({ commentId: commentId.describe('El id del primer comentario del hilo') }),
  },
  'pr.update-body': {
    summary: 'Reemplaza la descripción del PR. Tiene que conservar igual la primera línea "Closes #N" y todo desde la línea "<!-- ronin:help -->".',
    input: z.object({ body: z.string().trim().min(1).max(60_000).refine((s) => !hasMention(s), { message: 'no se puede escribir @ seguido de un nombre: menciona a la persona por su rol' }).describe('La descripción completa, en Markdown') }),
  },
  'pr.create': {
    summary: 'Abre el PR de la rama que subiste con git.push. La base, si es borrador y a quién se asigna los decide ronin.',
    input: z.object({
      title: z.string().trim().min(1).max(256).refine((s) => !hasMention(s), { message: 'no se puede escribir @ seguido de un nombre' }).describe('El título del PR'),
      body: z.string().trim().min(1).max(60_000).refine((s) => !hasMention(s), { message: 'no se puede escribir @ seguido de un nombre: menciona a la persona por su rol' }).describe('La descripción, en Markdown'),
    }),
  },
  'issue.comment': {
    summary: 'Comenta en el issue de esta corrida.',
    input: z.object({ body: body.describe('El comentario, en Markdown') }),
  },
  'issue.update-body': {
    summary: 'Cambia la descripción del issue de esta corrida: la reemplaza entera o le agrega texto al final, según lo que la corrida permita.',
    input: z.object({ body: z.string().trim().min(1).max(60_000).refine((s) => !hasMention(s), { message: 'no se puede escribir @ seguido de un nombre: menciona a la persona por su rol' }).describe('La descripción entera, o lo que se agrega al final') }),
  },
  'git.push': {
    summary: 'Sube el checkout a la rama de la corrida, sin cambios sin commitear. Según la corrida: un amend del commit con el que empezaste, tu propia rama sobre su base, o commits nuevos encima del que empezaste.',
    input: z.object({}),
  },
  'services.up': {
    summary: 'Levanta servicios del compose del repo (el de la rama base) para tus tests, como una base de datos: devuelve en qué puerto de localhost quedó cada puerto de cada servicio. Siguen arriba hasta que termina la corrida.',
    input: z.object({ services: z.array(z.string().min(1)).min(1).describe('Los nombres de los servicios, como en el compose') }),
  },
  'services.run': {
    summary: 'Corre un comando dentro de un servicio del compose del repo (el de la rama base), con tu checkout montado donde el compose monta el repo: para tests que necesitan las herramientas de ese contenedor. Devuelve el código de salida y el final de la salida. Corta a los 9 minutos.',
    input: z.object({
      service: z.string().min(1).describe('El servicio, como en el compose'),
      command: z.string().min(1).max(4_000).describe('El comando, para sh -c'),
    }),
  },
  'app.exec': {
    summary: 'Corre un comando en un servicio del stack de la app que ronin levantó para esta corrida, como psql en su base de datos: en el contenedor que ya corre, o con oneOff en uno nuevo del servicio (compose run --rm), para tests que necesitan sus herramientas. Devuelve el código de salida y el final de la salida. Corta a los 9 minutos.',
    input: z.object({
      service: z.string().min(1).describe('El servicio, como en el compose de la app'),
      command: z.string().min(1).max(4_000).describe('El comando, para sh -c'),
      oneOff: z.boolean().default(false).describe('En un contenedor nuevo del servicio en vez del que corre'),
    }),
  },
  'result.report': {
    summary: 'Reporta el resultado de la corrida. Es lo último que haces.',
    input: z.object({
      threads: z
        .array(z.object({
          commentId,
          changed: z.boolean().describe('Si cambiaste código por este hilo'),
          reply: z.string().trim().min(1).max(4_000).describe('Lo que respondiste en el hilo'),
        }))
        .default([])
        .describe('Uno por hilo listado, si la corrida atiende hilos'),
      summary: z.string().trim().min(1).max(2_000).describe('Una o dos líneas, en español'),
      status: z.enum(['done', 'needs-info']).optional().describe('Si la corrida lo pide: done si terminaste, needs-info si te detuviste a preguntar'),
    }),
  },
} as const;

export type ActionName = keyof typeof ACTIONS;
export type ActionInput<A extends ActionName> = z.infer<(typeof ACTIONS)[A]['input']>;

export function isActionName(name: string): name is ActionName {
  return Object.hasOwn(ACTIONS, name);
}

// The schema in JSON Schema, for the CLI's listing and its --help.
export function describeActions(scope: RunScope): Array<{ name: ActionName; summary: string; inputSchema: unknown }> {
  return scope.allowed.map((name) => ({ name, summary: ACTIONS[name].summary, inputSchema: z.toJSONSchema(ACTIONS[name].input) }));
}

// What git says about the run's checkout, for git.push's rule.
export interface CheckoutState {
  head: string;
  parentOfHead: string | null;
  parentOfStart: string | null;
  dirty: boolean;
  // Whether HEAD has, in its history, the base its branch was built on
  // (push mode 'branch') and the commit the run started from.
  onBase: boolean;
  onStart: boolean;
}

export type ValidAction = { [A in ActionName]: { name: A; input: ActionInput<A> } }[ActionName];

// Throws ActionRefused with the reason the agent gets back. Pure but for
// `checkout`, which only git.push needs.
export async function validateAction(
  scope: RunScope,
  name: string,
  raw: unknown,
  checkout?: () => Promise<CheckoutState>,
): Promise<ValidAction> {
  if (!isActionName(name)) throw new ActionRefused(`no existe la acción "${name}"`);
  if (!scope.allowed.includes(name)) throw new ActionRefused(`esta corrida no puede usar "${name}"`);
  const parsed = ACTIONS[name].input.safeParse(raw ?? {});
  if (!parsed.success) throw new ActionRefused(parsed.error.issues.map((i) => `${i.path.join('.') || 'entrada'}: ${i.message}`).join('; '));
  const action = { name, input: parsed.data } as ValidAction;

  const isThread = (id: number) => scope.threads.some((t) => t.commentId === id);
  if (action.name === 'pr.reply') {
    const id = action.input.commentId;
    if (!isThread(id) && !scope.triggers.some((t) => t.id === id && (t.kind === 'review' || t.kind === 'command'))) {
      throw new ActionRefused(`el comentario ${id} no es de los que esta corrida atiende`);
    }
  }
  if (action.name === 'pr.resolve-thread' && !isThread(action.input.commentId)) {
    throw new ActionRefused(`el comentario ${action.input.commentId} no abre ninguno de los hilos que esta corrida atiende`);
  }
  if (action.name === 'git.push') {
    if (!scope.headRef || !scope.startSha || !checkout) throw new ActionRefused('esta corrida no tiene rama a la que subir');
    const state = await checkout();
    const mode = scope.push?.mode ?? 'amend';
    if (state.dirty) throw new ActionRefused(mode === 'amend' ? 'hay cambios sin commitear: haz el amend primero' : 'hay cambios sin commitear: haz el commit primero');
    if (state.head === scope.startSha) throw new ActionRefused('no hay nada que subir: el commit es el mismo con el que empezaste');
    if (mode === 'amend' && state.parentOfHead !== state.parentOfStart) throw new ActionRefused('el commit tiene que ser un amend del commit con el que empezaste (git commit --amend), no uno nuevo');
    if (mode === 'branch' && !state.onBase) throw new ActionRefused('la rama tiene que salir de su base: no la rebases sobre otra cosa');
    if (mode === 'fast-forward' && !state.onStart) throw new ActionRefused('solo commits nuevos encima del que empezaste: nunca amend, rebase ni force-push');
  }
  if (action.name === 'pr.create') {
    if (!scope.pr || !scope.headRef) throw new ActionRefused('esta corrida no abre un PR');
    const closes = scope.pr.closes;
    if (closes !== undefined && !new RegExp(`^Closes #${closes}\\b`, 'i').test(action.input.body.trimStart())) {
      throw new ActionRefused(`la descripción tiene que empezar con "Closes #${closes}"`);
    }
    // Only the issue the run closes: a slice PR closes none, ronin closes its
    // issue once the last slice merges.
    const other = closingRefs(action.input.body).filter((ref) => ref !== `#${closes}`);
    if (other.length > 0) {
      throw new ActionRefused(closes === undefined
        ? `este PR no cierra ningún issue: saca "${other.join('", "')}" (para enlazarlo, "Parte de #N")`
        : `este PR solo cierra #${closes}: saca "${other.join('", "')}"`);
    }
  }
  if ((action.name === 'issue.comment' || action.name === 'issue.update-body') && !scope.issue) throw new ActionRefused('esta corrida no tiene un issue');
  if (action.name === 'issue.update-body' && !scope.issue?.body) throw new ActionRefused('esta corrida no puede cambiar la descripción del issue');
  return action;
}
