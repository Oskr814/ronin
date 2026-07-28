import { ensureWorktree } from './worktree.js';
import { runClaudeHeadless } from './claude-runner.js';
import { getPullRequestStatus } from './github.js';
import { config } from './config.js';

export type AgentTask =
  | { type: 'plan'; issueNumber: number; specPath: string }
  | { type: 'implement-slice'; issueNumber: number; sliceIndex: number }
  | { type: 'fix-review'; issueNumber: number; prNumber: number }
  | { type: 'fix-e2e'; issueNumber: number; prNumber: number };

function repoUrl(): string {
  return `https://github.com/${config.productRepo}`;
}

// Placeholder slug — once tick.ts parses real slice titles out of the issue
// checklist (still a TODO there), this should use a slug derived from the
// title instead of the raw index, for readable branch/PR names.
function sliceBranch(issueNumber: number, sliceIndex: number): string {
  return `valeria/${issueNumber}/slice-${sliceIndex + 1}`;
}

async function buildTask(task: AgentTask): Promise<{ branch: string; prompt: string }> {
  switch (task.type) {
    case 'plan':
      return {
        branch: `valeria/${task.issueNumber}/plan`,
        prompt: [
          `Sos ValerIA, un agente autónomo trabajando sobre el issue de tracking #${task.issueNumber} en ${repoUrl()}.`,
          `Leé el spec en "${task.specPath}" (dentro de este mismo checkout).`,
          'Diseñá el plan de implementación troceado en slices pequeñas e independientemente revisables (usá el skill de planificación si está disponible).',
          `Reescribí el body del issue #${task.issueNumber} (gh issue edit ${task.issueNumber} --body-file <archivo>) reemplazando el checklist de templates/tracking-issue.md con las slices reales, una línea por slice en el formato "- [ ] Slice N: <título> — PR: _pendiente_".`,
          'No implementes código todavía — esta tarea es solo el plan.',
        ].join('\n'),
      };

    case 'implement-slice':
      return {
        branch: sliceBranch(task.issueNumber, task.sliceIndex),
        prompt: [
          `Sos ValerIA, un agente autónomo trabajando sobre el issue de tracking #${task.issueNumber} en ${repoUrl()}.`,
          `Leé el checklist de slices en el issue (gh issue view ${task.issueNumber}) e implementá la slice número ${task.sliceIndex + 1}.`,
          'Seguí las convenciones de CLAUDE.md de este repo, incluyendo los requisitos de testing.',
          'Al terminar: corré los tests relevantes, hacé commit y push de esta branch, abrí un PR contra main (gh pr create) describiendo la slice, y actualizá la línea correspondiente del checklist del issue con el número de PR.',
        ].join('\n'),
      };

    case 'fix-review': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `Sos ValerIA. El PR #${task.prNumber} (issue de tracking #${task.issueNumber}) tiene comentarios de review sin resolver.`,
          `Leélos con "gh pr view ${task.prNumber} --comments", aplicá los cambios necesarios siguiendo las convenciones de CLAUDE.md, y hacé commit y push a esta misma branch.`,
          'Si algún comentario contradice lo que el spec pide explícitamente, no lo apliques — dejá el PR como está y no toques nada más; esto requiere una decisión humana.',
        ].join('\n'),
      };
    }

    case 'fix-e2e': {
      const pr = await getPullRequestStatus(task.prNumber);
      return {
        branch: pr.headRefName,
        prompt: [
          `Sos ValerIA. Los checks de CI/e2e (Playwright) están fallando en el PR #${task.prNumber} (issue de tracking #${task.issueNumber}).`,
          'Investigá la causa, arreglala, y hacé commit y push a esta misma branch.',
        ].join('\n'),
      };
    }
  }
}

export async function runAgentTask(task: AgentTask): Promise<void> {
  const { branch, prompt } = await buildTask(task);
  const worktreeDir = await ensureWorktree(branch);
  await runClaudeHeadless(worktreeDir, prompt);
}
