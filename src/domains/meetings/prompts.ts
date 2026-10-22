import { dirname } from 'node:path';
import type { AgentTask, PreparedTask } from '@platform/agents/agent-task.js';
import { fence, repoUrl } from '@platform/agents/prompts.js';
import { LIMITS } from './proposals.js';

// What the agent is told to read a meeting's notes (#62); platform/agents/agent-task.ts
// runs it and read.ts checks what it wrote (proposals.ts).

export interface MeetingTask {
  // Read only, on a detached checkout of the base branch: it proposes, the
  // supervisor writes nothing anywhere until someone approves.
  type: 'meeting-read';
  meetingNumber: number;
  title: string;
  checkoutDir: string;
  // The notes, one line per numbered line ("[12] …").
  notesPath: string;
  // The open issues, Linear's projects, cycles and people, and what other
  // meetings already proposed (read.ts writes it).
  contextPath: string;
  outputPath: string;
  // Whether the repo uses Linear: without it there are no projects.
  linear: boolean;
}

export function meetingTask(task: MeetingTask): AgentTask & MeetingTask {
  return { ...task, prepare: async () => buildMeetingTask(task) };
}

// How to read them and what to write is the skill's (read-meeting, #257);
// this is the run: the meeting, its files, Linear or not, and the limits.
function buildMeetingTask(task: MeetingTask): PreparedTask {
  const n = task.meetingNumber;
  return {
    branch: `meeting-read@R-${n}`,
    checkout: { kind: 'dir', dir: task.checkoutDir },
    // It only reads (the notes, their context and the code) and writes its
    // proposals (#257): sealed, as the agent's user. The notes and their
    // context are in its output directory, which it gets for the run.
    sealed: { outputDir: dirname(task.outputPath) },
    label: `reunión R-${n}`,
    tag: `R-${n}`,
    prompt: [
      `Usa la skill ronin:read-meeting. Eres ronin, en ${repoUrl()}: la reunión R-${n}, ${fence('TITLE', task.title)}.`,
      `Las notas: ${task.notesPath}. Su contexto: ${task.contextPath}.`,
      task.linear ? 'El repo usa Linear.' : 'El repo no usa Linear: no hay proyectos.',
      `Como mucho ${task.linear ? `${LIMITS.projects} proyectos, ` : ''}${LIMITS.issues} issues y ${LIMITS.comments} comentarios.`,
      `Tu salida, el JSON de la skill: ${task.outputPath}`,
    ].join('\n\n'),
  };
}
