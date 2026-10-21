import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { log } from '../core/logger.js';
import { sees, type Access } from '../server/api/access.js';
import { HISTORY_DAYS } from '../server/api/dashboard-data.js';
import { forgetGithub } from '../server/api/dashboard-github.js';
import { MAX_UPLOAD_BODY, MeetingUploadError, meetingDetail, meetingOriginal, meetingRow, parseUpload } from '../server/api/dashboard-meetings.js';
import { ApproveError, approveMeeting, discardMeeting } from '../server/api/dashboard-meetings-approve.js';
import { GithubUserError } from '../server/api/github-as-user.js';
import { refusal, visibleRepos, visibleRuns } from '../server/api/visible.js';
import { body, jsonBody, onError, type DashboardEnv } from '../apps/api/http/hono.js';
import { launchMeetingWorker, retryMeeting } from './launch.js';
import { createMeeting, DuplicateMeeting, getMeeting, listMeetings } from './meetings.js';

// Reuniones (#62) from the dashboard, in Hono (#235, stage 6) — server/
// dashboard-app.ts mounts them under /api/reuniones:
//   GET  /                the meetings whose notes were uploaded, of the repos it sees (dashboard-meetings.ts)
//   POST /                uploads one: the notes as a file or pasted
//   GET  /<n>             one of them, with its notes' text
//   GET  /<n>/original    the file as it was uploaded, to download
//   POST /<n>/reintentar  reads it again, after its reading failed
//   POST /<n>/aprobar     creates what the person chose of its proposals, as them (dashboard-meetings-approve.ts)
//   POST /<n>/descartar   sets the rest of it aside

const MISSING = { error: 'no existe esa reunión' };

// A meeting of a repo the session sees, or none: one it doesn't see is one
// that isn't there.
async function visibleMeeting(access: Access, n: string) {
  const meeting = /^\d+$/.test(n) ? await getMeeting(Number(n)) : undefined;
  return meeting && sees(access, meeting.repo) ? meeting : undefined;
}

// A change only as JSON, which a plain HTML form can't send.
const asJson = (c: Context) => ((c.req.header('content-type') ?? '').startsWith('application/json') ? null : c.json({ error: 'se espera JSON' }, 415));

// ronin reads it right away; if the launch fails, the tick does.
const launch = (n: number) => launchMeetingWorker(n).catch((error) => log.error(`reuniones: no se pudo lanzar el worker de R-${n}`, error));

export function meetingsRoutes() {
  const upload = z.record(z.string(), z.unknown());
  return new Hono<DashboardEnv>()
    .onError(onError([MeetingUploadError, ApproveError, GithubUserError]))
    .get('/', async (c) => {
      const access = c.env.access;
      const meetings = (await listMeetings()).filter((m) => sees(access, m.repo));
      return c.json({ meetings: meetings.map(meetingRow).sort((a, b) => b.number - a.number) }, 200);
    })
    .post('/', async (c, next) => asJson(c) ?? next(), jsonBody(MAX_UPLOAD_BODY, 'el pedido no llegó bien, o el archivo pesa más de 10 MB'), body(upload), async (c) => {
      const given = c.req.valid('json');
      // Before reading the notes: a repo it sees but can't upload to.
      const refused = typeof given.repo === 'string' && sees(c.env.access, given.repo) ? refusal(c, c.env.access, given.repo, 'notas') : null;
      if (refused) return refused;
      try {
        const meeting = await createMeeting(await parseUpload(given, await visibleRepos(c.env.access), c.env.session.login));
        await launch(meeting.number);
        return c.json(meetingRow((await getMeeting(meeting.number)) ?? meeting), 200);
      } catch (error) {
        if (error instanceof DuplicateMeeting) return c.json({ error: error.message, number: error.number }, 409);
        throw error;
      }
    })
    .get('/:n', async (c) => {
      const meeting = await visibleMeeting(c.env.access, c.req.param('n'));
      if (!meeting) return c.json(MISSING, 404);
      return c.json(await meetingDetail(meeting, await visibleRuns(c.env.access, HISTORY_DAYS)), 200);
    })
    .get('/:n/original', async (c) => {
      const meeting = await visibleMeeting(c.env.access, c.req.param('n'));
      if (!meeting) return c.json(MISSING, 404);
      const original = await meetingOriginal(meeting);
      if (!original) return c.json({ error: 'esas notas se pegaron: no hay archivo' }, 404);
      return c.body(new Uint8Array(original.data), 200, original.headers);
    })
    .post('/:n/reintentar', async (c) => {
      const meeting = await visibleMeeting(c.env.access, c.req.param('n'));
      if (!meeting) return c.json(MISSING, 404);
      const refused = refusal(c, c.env.access, meeting.repo, 'notas');
      if (refused) return refused;
      if (!(await retryMeeting(meeting.number, c.env.session.login))) return c.json({ error: 'esa reunión no falló: no hay nada que reintentar' }, 409);
      await launch(meeting.number);
      return c.json({ ok: true }, 200);
    })
    .post('/:n/descartar', async (c) => {
      const refusedAsJson = asJson(c);
      if (refusedAsJson) return refusedAsJson;
      const meeting = await visibleMeeting(c.env.access, c.req.param('n'));
      if (!meeting) return c.json(MISSING, 404);
      const refused = refusal(c, c.env.access, meeting.repo, 'aprobar');
      if (refused) return refused;
      await discardMeeting(meeting.number, c.env.session.login);
      return c.json({ status: 'discarded' }, 200);
    })
    .post('/:n/aprobar', async (c, next) => asJson(c) ?? next(), jsonBody(512 * 1024, 'el pedido no llegó bien'), body(z.object({ items: z.unknown().optional() })), async (c) => {
      const meeting = await visibleMeeting(c.env.access, c.req.param('n'));
      const entry = meeting && (await visibleRepos(c.env.access)).find((e) => e.productRepo === meeting.repo);
      if (!meeting || !entry) return c.json(MISSING, 404);
      const refused = refusal(c, c.env.access, meeting.repo, 'aprobar');
      if (refused) return refused;
      const outcome = await approveMeeting(entry, meeting.number, c.env.session, c.req.valid('json').items);
      // The next snapshot lists the new issues.
      forgetGithub(entry.productRepo);
      return c.json(outcome, 200);
    });
}
