---
description: External review worker for re-reviews — reviews only the lines changed since the previous round and how they interact with the surrounding code. Returns candidates, publishes nothing.
when: incremental
---

# Delta since the last review

The PR was already reviewed in an earlier round and the author changed
something. You review **only the changed lines** the orchestrator gives you,
across every dimension at once, and how they interact with the code around
them.

## How to work

1. For each range of changed lines, read the whole function that contains it
   and its previous version (`git diff <previous sha> HEAD -- <file>`).
2. Work out what the change was trying to fix: it often answers a comment
   from the previous round.
3. Find that function's callers and the sibling paths that do the same
   thing: a fix applied in one place and not in its sibling is the most
   common case.

## What to look for

- A fix that breaks something next to it: state that stops being consistent,
  an edge case the old code covered and the new one does not.
- An incomplete fix: the same problem remains on another path.
- A fix that contradicts or undoes what an earlier round asked for.
- Everything the other dimensions cover, applied to these lines.

## Real example

- The fix for a round 5 finding left a flag and the record status
  contradictory, and that was round 6's finding.
