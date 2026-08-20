<!--
Template used by the supervisor to generate a spec's tracking issue.
{{...}} placeholders are filled in when the issue is created via `gh issue create`.
Don't hand-edit an existing issue's body against this shape — change the template instead.
-->

## Spec

{{spec_links}}

<!-- One link per .md file the spec PR added under the configured spec dir
     (e.g. a design doc plus one or more plan docs) — see
     getSpecPathsFromPr in src/github.ts. All of them are context for
     planning, not just the first one. -->

## Slices

- [ ] Slice 1: {{slice_1_title}} — PR: _pending_
- [ ] Slice 2: {{slice_2_title}} — PR: _pending_

<!-- One line per slice in the plan. The supervisor checks a slice off once
     its PR is merged, and replaces "_pending_" with "#<number>" once the
     PR is open — see src/checklist.ts. -->

## Blocker

_(empty while there is no blocker)_

<!-- Filled in with the concrete reason and the relevant link (PR, e2e log,
     review comment) at the same moment the `ronin:blocked` label is
     applied. Never leave the label set without this section filled in. -->
