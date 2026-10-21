import { join } from 'node:path';
import { config } from '../config/config.js';
import { readJson, withJson } from '../fs/atomic-json.js';

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
