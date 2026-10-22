import { z } from 'zod';

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
  prNumber: number;
  // The branch a push goes to; without it there is no git.push.
  headRef?: string;
  // The commit the run started from: a push must be an amend of it.
  startSha?: string;
  threads: ScopeThread[];
  // The comments that asked for the run: a review comment is answered in
  // its thread (pr.reply), a general one with pr.comment.
  triggers: Array<{ id: number; kind: 'issue' | 'review' }>;
  allowed: ActionName[];
}

export class ActionRefused extends Error {}

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
  'git.push': {
    summary: 'Sube el commit del checkout a la rama del PR. Tiene que ser un amend del commit con el que empezaste, sin cambios sin commitear.',
    input: z.object({}),
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
        .describe('Uno por hilo listado'),
      summary: z.string().trim().min(1).max(2_000).describe('Una o dos líneas, en español'),
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
    if (!isThread(id) && !scope.triggers.some((t) => t.id === id && t.kind === 'review')) {
      throw new ActionRefused(`el comentario ${id} no es de los que esta corrida atiende`);
    }
  }
  if (action.name === 'pr.resolve-thread' && !isThread(action.input.commentId)) {
    throw new ActionRefused(`el comentario ${action.input.commentId} no abre ninguno de los hilos que esta corrida atiende`);
  }
  if (action.name === 'git.push') {
    if (!scope.headRef || !scope.startSha || !checkout) throw new ActionRefused('esta corrida no tiene rama a la que subir');
    const state = await checkout();
    if (state.dirty) throw new ActionRefused('hay cambios sin commitear: haz el amend primero');
    if (state.head === scope.startSha) throw new ActionRefused('no hay nada que subir: el commit es el mismo con el que empezaste');
    if (state.parentOfHead !== state.parentOfStart) throw new ActionRefused('el commit tiene que ser un amend del commit con el que empezaste (git commit --amend), no uno nuevo');
  }
  return action;
}
