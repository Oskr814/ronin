import { describe, it, expect, afterEach } from 'vitest';

for (const name of ['RONIN_GITHUB_TOKEN', 'RONIN_GITHUB_LOGIN', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'NOTIFY_TO', 'RUNNER_ID']) {
  process.env[name] ??= 'x';
}
delete process.env.AGENT_MODEL;
delete process.env.AGENT_EFFORT;

const { agentModelFor, agentEffortFor, defaultAgentModel, reviewWorkerModel } = await import('./config.js');
const { withActiveRepo } = await import('../agents/repo-context.js');

const limitedAccount = {
  productRepo: 'Bmedical/bmedical',
  productRepoPath: '/tmp/bmedical',
  agent: { model: 'sonnet', effort: 'medium', models: { 'external-review': 'opus' }, efforts: { 'fix-review': 'high' }, reviewWorkerModel: 'haiku' },
};

afterEach(() => {
  delete process.env.AGENT_MODEL_FIX_REVIEW;
  delete process.env.AGENT_MODEL_UPDATE_CHANGELOG;
  delete process.env.AGENT_EFFORT_UPDATE_CHANGELOG;
});

describe('agentModelFor / agentEffortFor', () => {
  it('runs update-changelog on haiku and every other task on the global default', () => {
    expect(agentModelFor('update-changelog')).toBe('haiku');
    expect(agentModelFor('external-review')).toBe('opus');
    expect(agentEffortFor('update-changelog')).toBe('high');
  });

  it('lets AGENT_MODEL_<TASK_TYPE> / AGENT_EFFORT_<TASK_TYPE> override one task type', () => {
    process.env.AGENT_MODEL_FIX_REVIEW = 'sonnet';
    process.env.AGENT_MODEL_UPDATE_CHANGELOG = 'sonnet';
    process.env.AGENT_EFFORT_UPDATE_CHANGELOG = 'low';
    expect(agentModelFor('fix-review')).toBe('sonnet');
    expect(agentModelFor('update-changelog')).toBe('sonnet');
    expect(agentEffortFor('update-changelog')).toBe('low');
    expect(agentModelFor('fix-e2e')).toBe('opus');
  });

  it('treats an empty override as "use the Claude config", like the global ones', () => {
    process.env.AGENT_MODEL_UPDATE_CHANGELOG = '';
    expect(agentModelFor('update-changelog')).toBe('');
  });
});

describe('per-account defaults (repos.json agent block)', () => {
  it("replaces the global default with the repo's own, but keeps the per-task defaults", async () => {
    await withActiveRepo(limitedAccount, async () => {
      expect(defaultAgentModel()).toBe('sonnet');
      expect(agentModelFor('fix-review')).toBe('sonnet');
      expect(agentModelFor('update-changelog')).toBe('haiku');
      expect(agentEffortFor('fix-e2e')).toBe('medium');
      expect(reviewWorkerModel()).toBe('haiku');
    });
  });

  it("lets the repo's per-task value win over everything, AGENT_MODEL_<TASK_TYPE> included", async () => {
    process.env.AGENT_MODEL_FIX_REVIEW = 'opus';
    await withActiveRepo(limitedAccount, async () => {
      expect(agentModelFor('external-review')).toBe('opus');
      expect(agentEffortFor('fix-review')).toBe('high');
      expect(agentModelFor('fix-review')).toBe('opus');
    });
  });

  it('leaves the global defaults for a repo without an agent block, and outside any repo', async () => {
    await withActiveRepo({ productRepo: 'a/b', productRepoPath: '/tmp/a' }, async () => {
      expect(agentModelFor('fix-review')).toBe('opus');
      expect(reviewWorkerModel()).toBe('sonnet');
    });
    expect(agentModelFor('fix-review')).toBe('opus');
  });
});
