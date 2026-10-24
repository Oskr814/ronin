import type { Me } from '../api.js';

// Approving, the person may mark it prioritario (#430): it goes first for
// the team, who also gets an email. Why it can't wait is required. Up to
// the day's limit; without one left, the box is off and says when it comes back.

export type Impact = 'blocks' | 'customers' | 'deadline';
export interface PriorityDraft {
  on: boolean;
  impact: Impact | null;
  deadline: string;
  reason: string;
}
export const NO_PRIORITY: PriorityDraft = { on: false, impact: null, deadline: '', reason: '' };

const IMPACTS: [Impact, string][] = [
  ['blocks', 'Detiene el trabajo: sin esto no podemos hacer una tarea'],
  ['customers', 'Afecta a clientes'],
  ['deadline', 'Tiene fecha límite'],
];
export const MAX_PRIORITY_REASON = 500;

// What's missing to send it, or null; and what goes to the API.
export function priorityProblem(p: PriorityDraft): string | null {
  if (!p.on) return null;
  if (!p.impact) return 'Elige por qué no puede esperar.';
  if (p.impact === 'deadline' && !p.deadline) return 'Elige la fecha límite.';
  if (!p.reason.trim()) return 'Cuéntale al equipo qué pasa si no está a tiempo.';
  return null;
}
export const priorityPayload = (p: PriorityDraft) => (p.on && p.impact ? { impact: p.impact, reason: p.reason.trim(), ...(p.impact === 'deadline' ? { deadline: p.deadline } : {}) } : undefined);

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function PriorityOption({ me, value, onChange }: { me: Me; value: PriorityDraft; onChange: (next: PriorityDraft) => void }) {
  const { priorityUsed, priorityLimit } = me.today;
  if (priorityLimit <= 0) return null;
  const left = Math.max(0, priorityLimit - priorityUsed);
  const off = left === 0 && !value.on;
  const set = (patch: Partial<PriorityDraft>) => onChange({ ...value, ...patch });
  return (
    <div className={`prio-opt${off ? ' off' : ''}`}>
      <label>
        <input type="checkbox" checked={value.on} disabled={off} onChange={(e) => set({ on: e.target.checked })} />
        <span><b>Es prioritario</b><small>{off
          ? `Ya marcaste ${priorityLimit === 1 ? 'tu pedido prioritario' : `tus ${priorityLimit} pedidos prioritarios`} de hoy. Mañana puedes marcar otro.`
          : 'El equipo lo ve antes que los demás y le llega un aviso por correo. Úsalo solo si de verdad no puede esperar.'}</small></span>
        <span className="left">{left} de {priorityLimit} hoy</span>
      </label>
      {value.on && (
        <div className="prio-why">
          <span className="q" id="prio-q">¿Por qué no puede esperar?</span>
          <div className="opts" role="radiogroup" aria-labelledby="prio-q">
            {IMPACTS.map(([id, label]) => (
              <div key={id} className="opt">
                <label><input type="radio" name="prio-impact" checked={value.impact === id} onChange={() => set({ impact: id })} />{label}</label>
                {id === 'deadline' && value.impact === 'deadline' && <input type="date" min={today()} value={value.deadline} aria-label="Fecha límite" onChange={(e) => set({ deadline: e.target.value })} />}
              </div>
            ))}
          </div>
          <textarea rows={2} maxLength={MAX_PRIORITY_REASON} placeholder="Cuéntale al equipo qué pasa si no está a tiempo" aria-label="Por qué es prioritario" value={value.reason} onChange={(e) => set({ reason: e.target.value })} />
          <p className="hint">El equipo puede quitarle la prioridad si no la ve: te dice por qué y el pedido sigue como uno normal.</p>
        </div>
      )}
    </div>
  );
}
