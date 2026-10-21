import type { Mail } from '../../core/notifier.js';
import type { Meeting } from './meetings.js';

// The email to the repo's team when ronin proposes work out of a meeting
// (#62): what it proposes and what it set aside, and the link to review it.
// Never the notes themselves, nor what they say word for word: those stay
// on the dashboard.

export const MEETINGS_FROM_NAME = 'ronin · Reuniones';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function meetingMail(meeting: Meeting, to: string, dashboardUrl: string): Mail {
  const p = meeting.proposals!;
  const issues = p.issues.length + p.projects.reduce((sum, x) => sum + x.issues.length, 0);
  const counts = [
    p.projects.length ? plural(p.projects.length, 'proyecto', 'proyectos') : null,
    issues ? plural(issues, 'issue', 'issues') : null,
    p.comments.length ? plural(p.comments.length, 'comentario', 'comentarios') : null,
  ].filter(Boolean).join(', ').replace(/, ([^,]*)$/, ' y $1');
  const link = dashboardUrl ? `${dashboardUrl}/reuniones/${meeting.number}` : null;
  const text = [
    `${meeting.by} subió las notas de la reunión "${meeting.title}" (R-${meeting.number}) y ronin propone esto para ${meeting.repo}:`,
    p.summary ? `De qué se habló: ${p.summary}` : null,
    p.projects.length ? `Proyectos nuevos en Linear:\n${p.projects.map((x) => `- ${x.name}, con ${plural(x.issues.length, 'issue', 'issues')}`).join('\n')}` : null,
    p.issues.length ? `Issues:\n${p.issues.map((x) => `- ${x.title}`).join('\n')}` : null,
    p.comments.length ? `En issues que ya existen:\n${p.comments.map((x) => `- #${x.issue} ${x.issueTitle}`).join('\n')}` : null,
    p.discarded.length ? `Descartado:\n${p.discarded.map((x) => `- ${x.topic}: ${x.why}`).join('\n')}` : null,
    `Nada se crea hasta que alguien lo apruebe${link ? `: ${link}` : ' en el tablero, en Reuniones.'}`,
  ].filter(Boolean).join('\n\n');
  return { to, subject: `[ronin] Reunión "${meeting.title}": ${counts} por revisar`, text };
}
