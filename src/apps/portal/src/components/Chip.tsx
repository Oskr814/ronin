import { Chip as StateChip } from '../../../../ui/components/Chip.js';
import { STATUS } from '../lib/text.js';

// A request's status, in its color and words.
export function Chip({ status }: { status: string }) {
  const [tone, label] = STATUS[status] ?? ['idle', status];
  return <StateChip tone={tone}>{label}</StateChip>;
}
