import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./config.js', () => ({
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

const { notifyBlocker } = await import('./notifier.js');

beforeEach(() => {
  vi.clearAllMocks();
  sendMail.mockResolvedValue(undefined);
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
  // discoverAssignedSpecs/discoverAssignedBugs in tick.ts) over nothing more
  // than a failed *notification about* an unrelated failure.
  it('never rejects when the mail transport fails', async () => {
    sendMail.mockRejectedValueOnce(new Error('SMTP timeout'));

    await expect(notifyBlocker({ issueUrl: 'https://x/issues/1', reason: 'algo se rompió' })).resolves.toBeUndefined();
  });
});
