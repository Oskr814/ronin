export { listBlockEvents, MAX_BLOCK_EVENTS, recordBlockEvent, type BlockEvent } from '@platform/notify/block-log.js';

// The reasons notifyBlocker gets are sentences (tick.ts, spec-flow.ts), some
// with an error message inside; Métricas groups them the way
// docs/BLOCKING.md does.
const CATEGORIES: Array<[RegExp, string]> = [
  [/necesita información/i, 'Falta información'],
  [/review sin converger/i, 'Review que no converge'],
  [/CI nunca reportó/i, 'CI que nunca termina'],
  [/E2E|falla de CI/i, 'E2E que no converge'],
  [/retarget/i, 'Stack sin retarget'],
  [/checklist de slices|slices sin PR/i, 'Plan vacío o slices huérfanas'],
  [/Excepción no manejada/i, 'Errores repetidos'],
];

export function blockCategory(reason: string): string {
  return CATEGORIES.find(([re]) => re.test(reason))?.[1] ?? 'Otro';
}
