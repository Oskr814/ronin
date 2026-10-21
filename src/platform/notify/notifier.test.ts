import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/config.js', () => ({
  config: {
    gmailUser: 'ronin@example.com',
    gmailAppPassword: 'app-password',
    notifyTo: 'human@example.com',
  },
}));

const sendMail = vi.fn();
const createTransport = vi.fn(() => ({ sendMail }));
vi.mock('nodemailer', () => ({
  default: { createTransport: () => createTransport() },
}));

const recordBlock = vi.fn();
vi.mock('../state/local-state.js', () => ({ recordBlock: (...args: unknown[]) => recordBlock(...args) }));
const recordBlockEvent = vi.fn();
vi.mock('./block-log.js', () => ({ recordBlockEvent: (...args: unknown[]) => recordBlockEvent(...args) }));

const { notifyBlocker, blockedItemNumber } = await import('./notifier.js');

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue(undefined);
  recordBlock.mockResolvedValue(undefined);
  recordBlockEvent.mockResolvedValue(undefined);
});

describe('notifyBlocker', () => {
  it('sends an email with the blocker details', async () => {
    await notifyBlocker({ issueUrl: 'https://x/issues/1', prUrl: 'https://x/pull/2', reason: 'algo se rompió' });

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'human@example.com', subject: expect.stringContaining('algo se rompió') }),
    );
  });

  // Regression: an earlier version let a transport failure here propagate,
  // which crashed callers outside runIssueStep's safety net (e.g.
  // discoverAssignedSpecs/discoverAssignedIssues in tick.ts) over nothing more
  // than a failed *notification about* an unrelated failure.
  it('never rejects when the mail transport fails', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP timeout'));

    await expect(notifyBlocker({ issueUrl: 'https://x/issues/1', reason: 'algo se rompió' })).resolves.toBeUndefined();
  });
});

describe('notifyBlocker — reason kept for the dashboard', () => {
  it('keeps the reason under the blocked issue', async () => {
    await notifyBlocker({ issueUrl: 'https://github.com/a/b/issues/401', prUrl: 'https://github.com/a/b/pull/409', reason: 'e2e falla 3 veces', excerpt: 'PR #409, 3 intentos' });
    expect(recordBlock).toHaveBeenCalledWith(401, {
      reason: 'e2e falla 3 veces',
      url: 'https://github.com/a/b/issues/401',
      prUrl: 'https://github.com/a/b/pull/409',
      excerpt: 'PR #409, 3 intentos',
      at: expect.any(String),
    }, expect.any(Number));
  });

  it('also records it for the metrics, with its repo (#222)', async () => {
    await notifyBlocker({ issueUrl: 'https://github.com/a/b/issues/401', reason: 'e2e falla 3 veces' });
    expect(recordBlockEvent).toHaveBeenCalledWith({ repo: 'a/b', item: 401, reason: 'e2e falla 3 veces', at: expect.any(String) });
  });

  it('still sends the email when the metrics record fails', async () => {
    recordBlockEvent.mockRejectedValueOnce(new Error('disk full'));
    await expect(notifyBlocker({ issueUrl: 'https://github.com/a/b/issues/1', reason: 'x' })).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalled();
  });

  it('keeps nothing for a release, which has no issue or PR', async () => {
    await notifyBlocker({ issueUrl: 'https://github.com/a/b/releases/tag/v1.2.3', reason: 'changelog falló' });
    expect(recordBlock).not.toHaveBeenCalled();
    expect(recordBlockEvent).not.toHaveBeenCalled();
    expect(sendMail).toHaveBeenCalled();
  });

  it('still sends the email when the reason cannot be kept', async () => {
    recordBlock.mockRejectedValueOnce(new Error('disk full'));
    await expect(notifyBlocker({ issueUrl: 'https://github.com/a/b/issues/1', reason: 'x' })).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalled();
  });
});

describe('blockedItemNumber', () => {
  it('reads the number of an issue or a PR', () => {
    expect(blockedItemNumber('https://github.com/a/b/issues/401')).toBe(401);
    expect(blockedItemNumber('https://github.com/a/b/pull/74')).toBe(74);
    expect(blockedItemNumber('https://github.com/a/b/pull/74#issuecomment-1')).toBe(74);
  });

  it('is null for anything else', () => {
    expect(blockedItemNumber('https://github.com/a/b/releases/tag/v1.2.3')).toBeNull();
    expect(blockedItemNumber('https://github.com/a/b/issues/12abc')).toBeNull();
  });
});

