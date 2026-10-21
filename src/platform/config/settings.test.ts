import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../logger.js', () => ({ log: { info: vi.fn(), error: vi.fn() } }));

const { applySettings, envValue, invalidValue, readSettingsSync, settingDef, settingsView } = await import('./settings.js');

const target = () => ({ dashboard: { sessionDays: 0, githubTtlSeconds: 0 }, portal: { dailyLimit: 0, sessionDays: 0 } });

describe('applySettings', () => {
  it('puts the dashboard\'s value over .env, and .env over the default', () => {
    const config = target();
    applySettings(config, { values: { 'portal.dailyLimit': 8 } }, { PORTAL_DAILY_LIMIT: '5', DASHBOARD_SESSION_DAYS: '14' });
    expect(config.portal.dailyLimit).toBe(8);
    expect(config.dashboard.sessionDays).toBe(14);
    expect(config.portal.sessionDays).toBe(30);
  });

  it('goes back to .env\'s once the dashboard\'s value is gone', () => {
    const config = target();
    applySettings(config, { values: { 'portal.dailyLimit': 8 } }, { PORTAL_DAILY_LIMIT: '5' });
    applySettings(config, { values: {} }, { PORTAL_DAILY_LIMIT: '5' });
    expect(config.portal.dailyLimit).toBe(5);
  });

  it('ignores a saved value out of range (the file edited by hand) and uses .env\'s', () => {
    const config = target();
    applySettings(config, { values: { 'portal.dailyLimit': 1000 } }, { PORTAL_DAILY_LIMIT: '5' });
    expect(config.portal.dailyLimit).toBe(5);
  });
});

describe('settingsView', () => {
  it('says where each value comes from, and what it would be without the dashboard', () => {
    const view = settingsView({ values: { 'portal.dailyLimit': 8 } }, { PORTAL_DAILY_LIMIT: '5' });
    expect(view.find((s) => s.key === 'portal.dailyLimit')).toMatchObject({ value: 8, source: 'tablero', base: 5, baseSource: 'env', env: 'PORTAL_DAILY_LIMIT' });
    expect(view.find((s) => s.key === 'portal.sessionDays')).toMatchObject({ value: 30, source: 'defecto', base: 30, baseSource: 'defecto' });
  });
});

describe('values', () => {
  it('takes only whole numbers in range, and reads .env as a number', () => {
    const def = settingDef('portal.dailyLimit')!;
    expect(invalidValue(def, 3)).toBeNull();
    expect(invalidValue(def, 2.5)).toMatch(/entero/);
    expect(invalidValue(def, '3')).toMatch(/entero/);
    expect(invalidValue(def, 101)).toMatch(/entre 0 y 100/);
    expect(envValue(def, { PORTAL_DAILY_LIMIT: ' ' })).toBeUndefined();
    expect(envValue(def, { PORTAL_DAILY_LIMIT: 'x' })).toBeUndefined();
    expect(envValue(def, { PORTAL_DAILY_LIMIT: '7' })).toBe(7);
  });
});

describe('readSettingsSync', () => {
  it('reads nothing changed from a missing or broken file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ronin-settings-'));
    expect(readSettingsSync(dir)).toEqual({ values: {} });
    writeFileSync(join(dir, 'settings.json'), '{ roto');
    expect(readSettingsSync(dir)).toEqual({ values: {} });
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ values: { 'portal.dailyLimit': 9 } }));
    expect(readSettingsSync(dir)).toEqual({ values: { 'portal.dailyLimit': 9 } });
  });
});

describe('other kinds', () => {
  it('reads .env as each kind does, scales minutes and keeps only valid task choices', () => {
    const config: Record<string, unknown> = { dashboard: {}, portal: {} };
    applySettings(config, { values: { 'agent.handlerTimeoutMinutes': 60 }, tasks: { plan: { model: 'sonnet', effort: 'nope' }, inventada: { model: 'opus' } } }, { AGENT_MODEL: '', EXPLORE_PUBLISH_EVIDENCE: 'false', PREVIEW_PREPARE_DATA: 'quizás', AGENT_TASK_TIMEOUT_MINUTES: '45' });
    expect(config).toMatchObject({ agentModel: '', explorePublishEvidence: false, previewPrepareData: true, agentTaskTimeoutMs: 45 * 60_000, eventHandlerTimeoutMs: 60 * 60_000, taskOverrides: { plan: { model: 'sonnet' } } });
    expect(config.taskOverrides).not.toHaveProperty('inventada');
  });
});
