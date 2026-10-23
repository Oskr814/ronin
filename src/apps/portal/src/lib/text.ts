// What the page says of each state of a request, and small formats.

// The chip next to a request: its color and its words.
export const STATUS: Record<string, [string, string]> = {
  thinking: ['run', 'ronin lo está revisando'],
  asking: ['warn', 'Espera tu respuesta'],
  interviewing: ['warn', 'Espera tus respuestas'],
  confirming: ['warn', 'Revisa el resumen'],
  answered: ['idle', 'Respondido'],
  minor: ['run', 'Preparando prototipo'],
  proposed: ['warn', 'Prototipo listo'],
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
