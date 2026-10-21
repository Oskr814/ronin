import { join } from 'node:path';
import { config } from '../../platform/config/config.js';
import { readJson, withJson } from '../../platform/fs/atomic-json.js';

// Every block ronin raised (#222), with its reason: the local state keeps
// only each item's latest, and only while it's recent (BLOCK_MAX_AGE_MS), so
// Métricas would lose why ronin blocked as soon as it got unblocked.
// Appended by notifyBlocker, never pruned but past MAX_BLOCK_EVENTS.

export interface BlockEvent {
  repo: string;
  item: number;
  reason: string;
  at: string;
}

interface BlockFile {
  blocks: BlockEvent[];
}

// Years of blocks at any pace ronin has had; past it, the oldest go.
export const MAX_BLOCK_EVENTS = 5000;

const path = () => join(config.metrics.dataDir, 'bloqueos.json');
const empty = (): BlockFile => ({ blocks: [] });

export function recordBlockEvent(event: BlockEvent): Promise<void> {
  return withJson(path(), empty, (file) => {
    file.blocks.push(event);
    if (file.blocks.length > MAX_BLOCK_EVENTS) file.blocks.splice(0, file.blocks.length - MAX_BLOCK_EVENTS);
  });
}

export async function listBlockEvents(): Promise<BlockEvent[]> {
  return (await readJson(path(), empty)).blocks;
}

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
