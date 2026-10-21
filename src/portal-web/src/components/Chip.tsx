import { STATUS } from '../lib/text.js';

// A request's status, in its color and words.
export function Chip({ status }: { status: string }) {
  const [cls, label] = STATUS[status] ?? ['idle', status];
  return <span className={`chip ${cls}`}>{label}</span>;
}
