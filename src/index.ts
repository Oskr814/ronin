// Entrypoint for a single supervisor tick. Intended to be invoked repeatedly
// by a loop running in a persistent tmux session on honelab (e.g. a `while
// true; do pnpm tick; sleep <n>; done` shell, so each tick is its own process
// and no state leaks between runs beyond what's in GitHub).
import { tick } from './tick.js';

tick()
  .then(() => {
    console.log('tick complete');
  })
  .catch((error) => {
    console.error('tick failed:', error);
    process.exitCode = 1;
  });
