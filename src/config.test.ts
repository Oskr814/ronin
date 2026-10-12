import { describe, it, expect, afterEach } from 'vitest';

for (const name of ['RONIN_GITHUB_TOKEN', 'RONIN_GITHUB_LOGIN', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'NOTIFY_TO', 'RUNNER_ID']) {
  process.env[name] ??= 'x';
}
delete process.env.AGENT_MODEL;
delete process.env.AGENT_EFFORT;

const { agentModelFor, agentEffortFor } = await import('./config.js');

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
