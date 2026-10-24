import { getDb } from '@platform/db/db.js';
import { log } from '@platform/logger.js';
import { finishCommand, noteCommand, startCommand } from './store.js';

// How a worker answers what was asked of it (#446): in the command, when it
// was asked from the tablero, or on GitHub as before. `say` writes each
// answer; `failed` marks the one that says why it didn't go, which is how
// the command ends; `done` closes it.
export interface Answerer {
  say(body: string, failed?: boolean): Promise<void>;
  start(): Promise<void>;
  done(): Promise<void>;
}

export function answerer(command: string | undefined, onGithub: (body: string) => Promise<unknown>, what: string): Answerer {
  const db = command ? getDb() : null;
  let failure: string | null = null;
  return {
    async say(body, failed = false) {
      if (failed) failure = body;
      try {
        if (db && command) await noteCommand(db, command, body);
        else await onGithub(body);
      } catch (error) {
        log.error(`${what}: no se pudo responder`, error);
      }
    },
    async start() {
      if (db && command) await startCommand(db, command).catch((error) => log.error(`${what}: no se pudo marcar el comando ${command} como empezado`, error));
    },
    async done() {
      if (db && command) await finishCommand(db, command, failure ? { error: failure } : {}).catch((error) => log.error(`${what}: no se pudo cerrar el comando ${command}`, error));
    },
  };
}
