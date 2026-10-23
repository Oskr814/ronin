import type { ClickKind } from '@platform/timing.js';
import { client } from '../api.js';

// From a click to its result on the page (#368): the time the person waits,
// which no request alone says — the write, then what's read again after it.
// Started at the click; `shown` gets what brings the result back, and once
// it's there the time goes to the API, which sums it up with its routes
// ("CLIC comentar"). Never in the way: a failure to send it is dropped.
export function clickTimer(what: ClickKind): (shown: Promise<unknown>) => void {
  const start = performance.now();
  return (shown) => {
    void shown
      .then(() => client.api.timings.$post({ json: { what, ms: Math.round(performance.now() - start) } }))
      .catch(() => {});
  };
}
