import { useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import { useHost } from '../../host.js';
import { DAY_MS, repoShort } from '../../lib/format.js';
import { LinearIcon } from '../../lib/github.js';
import { BUCKETS, BURN, burnGeometry, cycleName, dayMonth, endDay, type Cycle } from './model.js';

// A repo's current Linear cycle: its issues by where they stand, and its burn-up.
export function CycleCard({ c, several, now }: { c: Cycle; several: boolean; now: number }) {
  const left = Math.ceil((Date.parse(c.endsAt) - now) / DAY_MS);
  const counts = BUCKETS.map(([k, label, color]) => [k, label, color, c.issues.filter((i) => i.bucket === k).length] as const).filter(([, , , n]) => n);
  const total = c.issues.length || 1;
  return (
    <div className="card"><h2><LinearIcon /> {cycleName(c)}{several ? ` · ${repoShort(c.repo)}` : ''}<span className="c">{dayMonth(c.startsAt)} – {endDay(c.endsAt)} · {left > 1 ? `quedan ${left} días` : left === 1 ? 'termina mañana' : 'termina hoy'}</span></h2>
      <div className="stack">{counts.map(([k, label, color, n]) => <i key={k} style={{ width: `${(n / total) * 100}%`, background: color }} title={`${n} ${label}`} />)}</div>
      <div className="legend">{counts.map(([k, label, color, n]) => <span key={k}><i style={{ background: color }} /><b>{n}</b> {label}</span>)}</div>
      <Burn c={c} now={now} />
    </div>
  );
}

// Issues in the cycle against issues done, day by day, with the day under
// the pointer.
function Burn({ c, now }: { c: Cycle; now: number }) {
  const [hover, setHover] = useState<{ d: number; px: number; width: number } | null>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (hover && tipRef.current) tipRef.current.style.left = `${Math.min(hover.px + 12, hover.width - tipRef.current.offsetWidth)}px`;
  }, [hover]);
  const scope = c.scopeHistory;
  const done = c.doneHistory;
  if (!scope.length) return null;
  const { W, H } = BURN;
  const { total, max, x, y } = burnGeometry(c);
  const last = scope.length - 1;
  const line = (arr: number[]) => arr.map((v, d) => `${d ? 'L' : 'M'}${x(d).toFixed(1)},${y(v).toFixed(1)}`).join('');
  const area = `${line(done)}L${x(last).toFixed(1)},${y(0)}L${x(0)},${y(0)}Z`;
  // Linear's history can lag a day or two behind: today gets its own mark.
  const today = Math.max(0, Math.min(total, (now - Date.parse(c.startsAt)) / DAY_MS));
  const labels: Array<[number, string, 'start' | 'end' | 'middle']> = [[0, dayMonth(c.startsAt), 'start'], [total, endDay(c.endsAt), 'end']];
  if (x(today) - x(0) > 30 && x(total) - x(today) > 30) labels.push([today, 'hoy', 'middle']);
  // End labels, pulled apart when the two values are close.
  let ys = y(scope[last]) + 4;
  let yd = y(done[last] ?? 0) + 4;
  if (yd - ys < 13) {
    const mid = (ys + yd) / 2;
    ys = mid - 6.5;
    yd = mid + 6.5;
  }
  const move = (e: PointerEvent<SVGRectElement>) => {
    const rect = e.currentTarget.ownerSVGElement!.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let d = 0;
    for (let k = 0; k <= last; k++) if (Math.abs(x(k) - vx) < Math.abs(x(d) - vx)) d = k;
    setHover(vx > x(last) + 20 ? null : { d, px: (x(d) / W) * rect.width, width: rect.width });
  };
  const key = (color: string, text: string) => <div><span className="k" style={{ background: color }} />{text}</div>;
  return (
    <div className="burn">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${cycleName(c)}: ${scope[last]} issues en el ciclo y ${done[last] ?? 0} hechos`}>
        {[0, max / 2, max].map((v) => <g key={v}><line x1={BURN.l} x2={W - BURN.r} y1={y(v)} y2={y(v)} stroke="var(--rule)" /><text x={BURN.l - 6} y={y(v) + 3.5} textAnchor="end">{v}</text></g>)}
        {labels.map(([d, text, anchor]) => <text key={text} x={x(d)} y={H - 4} textAnchor={anchor}>{text}</text>)}
        <line x1={x(today)} x2={x(today)} y1={BURN.t} y2={H - BURN.b} stroke="var(--faint)" strokeDasharray="3 3" />
        <path d={area} fill="var(--ok)" opacity=".12" />
        <path d={line(scope)} fill="none" stroke="var(--muted)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={line(done)} fill="none" stroke="var(--ok)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last)} cy={y(scope[last])} r="4" fill="var(--muted)" stroke="var(--panel)" strokeWidth="2" />
        <circle cx={x(last)} cy={y(done[last] ?? 0)} r="4" fill="var(--ok)" stroke="var(--panel)" strokeWidth="2" />
        <text className="end" x={x(last) + 8} y={ys}>{scope[last]} en el ciclo</text>
        <text className="end" x={x(last) + 8} y={yd}>{done[last] ?? 0} hechos</text>
        <line className="cross" x1={hover ? x(hover.d) : 0} x2={hover ? x(hover.d) : 0} y1={BURN.t} y2={H - BURN.b} stroke="var(--faint)" visibility={hover ? 'visible' : 'hidden'} />
        <rect className="hit" x={BURN.l} y="0" width={W - BURN.l - BURN.r} height={H} fill="transparent" onPointerMove={move} onPointerLeave={() => setHover(null)} />
      </svg>
      <div className="btip" hidden={!hover} ref={tipRef} style={{ top: '8px' }}>
        {hover && <><b>{dayMonth(new Date(Date.parse(c.startsAt) + hover.d * DAY_MS).toISOString())}</b>{key('var(--muted)', `${scope[hover.d]} en el ciclo`)}{key('var(--ok)', `${done[hover.d] ?? 0} hechos`)}</>}
      </div>
      <div className="lg"><span><i style={{ background: 'var(--muted)' }} />issues en el ciclo</span><span><i style={{ background: 'var(--ok)' }} />hechos</span></div>
    </div>
  );
}

// The cycle by project (a project's row filters the sidebar by it) and by
// who has what's left.
export function Breakdown({ c }: { c: Cycle }) {
  const host = useHost();
  const project = host.project();
  const swatch = (color: string) => <i style={{ background: color }} />;
  const groups = new Map<string, Cycle['issues']>();
  for (const issue of c.issues) {
    const key = issue.project?.id ?? '';
    groups.set(key, [...(groups.get(key) ?? []), issue]);
  }
  const maxP = Math.max(...[...groups.values()].map((g) => g.length), 1);
  const projects = [...groups].sort((a, b) => Number(a[0] === '') - Number(b[0] === '') || b[1].length - a[1].length).map(([id, issues]) => {
    const segs = BUCKETS.map(([k, , color]) => {
      const n = issues.filter((i) => i.bucket === k).length;
      return n ? <i key={k} style={{ width: `${(n / maxP) * 100}%`, background: color }} /> : null;
    });
    const parts = (name: string, color: string) => <><span className="bn">{swatch(color)}<span>{name}</span></span><span className="bb">{segs}</span><span className="bc">{issues.length}</span></>;
    return id
      ? <button key={id} className="brow" aria-pressed={project === id} title="Filtrar la lista por este proyecto" onClick={() => host.setProject(project === id ? '' : id)}>{parts(issues[0].project!.name, host.projectColor(id))}</button>
      : <div key="" className="brow">{parts('Sin proyecto', 'var(--proj-other)')}</div>;
  });
  const open = c.issues.filter((i) => i.bucket !== 'done');
  const owners = new Map<string, number>();
  for (const issue of open) owners.set(issue.owner, (owners.get(issue.owner) ?? 0) + 1);
  const people = [...owners].sort((a, b) => Number(b[0] === 'ronin') - Number(a[0] === 'ronin') || Number(a[0] === '') - Number(b[0] === '') || b[1] - a[1]);
  const maxO = Math.max(...people.map(([, n]) => n), 1);
  const ronin = owners.get('ronin') ?? 0;
  return (
    <div className="card">
      <div className="side-list"><h3>Por proyecto, en el ciclo</h3>{projects.length ? projects : <p className="note">El ciclo no tiene issues.</p>}</div>
      <div className="side-list"><h3>Quién tiene qué, de lo que falta</h3>
        {people.length ? people.map(([owner, n]) => {
          const color = owner === 'ronin' ? 'var(--hanko)' : 'var(--faint)';
          return <div key={owner} className="brow"><span className="bn">{swatch(color)}<span>{owner || 'sin asignar'}</span></span><span className="bb"><i style={{ width: `${(n / maxO) * 100}%`, background: color }} /></span><span className="bc">{n}</span></div>;
        }) : <p className="note">Todo el ciclo está hecho.</p>}
        {open.length > 0 && <p className="note">ronin tiene {ronin} de los {open.length} issues que faltan del ciclo.</p>}
      </div>
    </div>
  );
}
