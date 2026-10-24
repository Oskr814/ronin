// What the page says of each state of a request, and small formats.

// The chip next to a request: its color and its words.
export const STATUS: Record<string, [string, string]> = {
  thinking: ['run', 'ronin lo está revisando'],
  asking: ['warn', 'Espera tu respuesta'],
  interviewing: ['warn', 'Espera tus respuestas'],
  confirming: ['warn', 'Revisa el resumen'],
  answered: ['idle', 'Respondido'],
  minor: ['run', 'Preparando prototipo'],
  // A prototype, or a proposal in words only (#409).
  proposed: ['warn', 'Espera tu aprobación'],
  reproducing: ['run', 'Reproduciendo el error'],
  'awaiting-dev': ['run', 'El equipo lo revisa'],
  approved: ['run', 'En desarrollo'],
  fixing: ['run', 'En corrección'],
  done: ['ok', 'Listo'],
  resolved: ['ok', 'Resuelto'],
  declined: ['idle', 'Cerrado'],
  cancelled: ['idle', 'Cancelado'],
  big: ['idle', 'Con el equipo'],
};

// The filters over the person's requests in the side list (#422), like the
// tablero's: what waits for them first, then what ronin or the team has, then
// what ended (a question ronin answered, too). Each one with its icon's path.
export const FILTERS: { id: string; label: string; statuses: string[]; icon: string }[] = [
  { id: 'yours', label: 'Esperando tu respuesta', statuses: ['asking', 'interviewing', 'confirming', 'proposed'], icon: 'M4 20c1-4 4-6 8-6s7 2 8 6M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8' },
  { id: 'ronin', label: 'En curso', statuses: ['thinking', 'minor', 'reproducing'], icon: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M12 8v4l3 2' },
  { id: 'team', label: 'Con el equipo', statuses: ['awaiting-dev', 'big', 'approved', 'fixing'], icon: 'M3 19c.7-3 2.8-4.5 6-4.5s5.3 1.5 6 4.5M9 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6M16 6a3 3 0 0 1 0 5.5M18 14.6c1.6.5 2.6 2 3 4.4' },
  { id: 'done', label: 'Listos', statuses: ['done', 'resolved', 'answered'], icon: 'm5 12.5 4.5 4.5L19 7.5' },
  { id: 'closed', label: 'Cancelados', statuses: ['cancelled', 'declined'], icon: 'M12 4a8 8 0 1 0 0 16 8 8 0 0 0 0-16M6.5 6.5l11 11' },
];

// Under a request the person can't write on: why.
export const CLOSED: Record<string, string> = {
  thinking: 'ronin está revisando tu pedido. Puedes cerrar la página: te avisamos por correo.',
  minor: 'ronin está armando el prototipo. Puedes cerrar la página: te avisamos por correo cuando esté listo.',
  reproducing: 'ronin está reproduciendo el error. Puedes cerrar la página: te avisamos por correo.',
  'awaiting-dev': 'El equipo de desarrollo está revisando tu pedido antes de hacerlo. Te avisamos por correo cuando esté listo.',
  approved: 'El equipo aprobó tu pedido: ronin hace el cambio. Te avisamos por correo cuando esté listo.',
  fixing: 'El equipo aprobó el arreglo: ronin está corrigiendo el error. Te avisamos por correo cuando esté listo.',
  done: 'Listo: el cambio sale en la próxima actualización de la aplicación.',
  resolved: 'El equipo de desarrollo resolvió este pedido.',
  declined: 'El equipo de desarrollo decidió no hacer este pedido por ahora. Puedes enviar uno nuevo cuando quieras.',
  cancelled: 'Cancelaste este pedido.',
  big: 'El equipo de desarrollo tiene este pedido. Te avisamos por correo cuando esté resuelto.',
};

// Cancelled on its own (#404), instead of «Cancelaste este pedido».
export const EXPIRED: Record<string, string> = {
  unanswered: 'Cancelamos este pedido porque no tuvimos respuesta a tiempo. Si todavía lo necesitas, puedes enviar uno nuevo.',
  answered: 'Cerramos este pedido. Si necesitas algo más, puedes enviar uno nuevo.',
};

// While the team has it (#353): the team may write, so the page asks again
// now and then, slower than while ronin works.
export const TEAM_HELD = ['awaiting-dev', 'approved', 'fixing', 'big'];
export const TEAM_POLL_MS = 15_000;
// How the team signs to the person.
export const TEAM_NAME = 'Equipo de desarrollo';

// While ronin works on a request: what it's doing, and how long it takes.
// Its page asks again every few seconds meanwhile.
export const WORKING: Record<string, [string, string]> = {
  thinking: ['ronin está revisando tu pedido…', 'Lee lo que escribiste y revisa la aplicación. Suele tardar unos minutos.'],
  minor: ['ronin está armando el prototipo…', 'Abre la aplicación, hace el cambio de prueba y toma capturas de antes y después. Suele tardar entre 5 y 15 minutos.'],
  reproducing: ['ronin está reproduciendo el error…', 'Abre una copia de la aplicación con datos de prueba y sigue tus pasos. Suele tardar entre 5 y 15 minutos.'],
};

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
export const hhmm = (iso: string) => new Date(iso).toLocaleString('es', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// "Te quedan 2 pedidos", "Te queda 1 ajuste".
export const left = (n: number, one: string, many: string) => `Te ${n === 1 ? `queda 1 ${one}` : `quedan ${n} ${many}`}`;
