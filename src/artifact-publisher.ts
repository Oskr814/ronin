import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { config } from './config.js';
import { activeRepo } from './repo-context.js';
import { log } from './logger.js';

const execFileAsync = promisify(execFile);

// Publishes an HTML file as a Claude Artifact and returns its URL — see
// docs/DESIGN.md §11.5. `claude -p` has no Artifact tool (checked in the
// 2026-10-11 spike) but a background session does, so this starts one whose
// only job is to publish the file, reads the URL from its log, and deletes
// it. The session runs from ronin's own checkout: without a TTY, Claude
// can't ask to trust a directory, so it has to be one already trusted.

const URL_RE = /RONIN_ARTIFACT_URL=\S*?(https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+)/;
const BG_ID_RE = /backgrounded\s*·\s*([0-9a-f]{6,})/i;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]|\x1b[78]/g;

export function parseArtifactUrl(logText: string): string | undefined {
  return logText.replace(ANSI_RE, '').match(URL_RE)?.[1];
}

export function parseBackgroundId(stdout: string): string | undefined {
  return stdout.replace(ANSI_RE, '').match(BG_ID_RE)?.[1];
}

// Images the HTML references by a local path become data: URIs, so the
// published page carries its screenshots with it.
export async function inlineLocalImages(html: string, baseDir: string): Promise<string> {
  const mime: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
  const refs = [...html.matchAll(/src=["']([^"':]+\.(?:png|jpe?g|webp|gif))["']/gi)].map((m) => m[1]);
  let result = html;
  for (const ref of new Set(refs)) {
    const path = resolve(baseDir, ref);
    try {
      const data = await readFile(path);
      result = result.split(ref).join(`data:${mime[extname(path).toLowerCase()]};base64,${data.toString('base64')}`);
    } catch {
      log.info(`artifact: no encontré la imagen ${ref} referenciada por el mockup`);
    }
  }
  return result;
}

function claudeEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const claudeConfigDir = activeRepo().claudeConfigDir ?? config.claudeConfigDir;
  if (claudeConfigDir) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return env;
}

async function claude(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(config.claudeCommand, args, { env: claudeEnv(), cwd: process.cwd(), maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

async function sessionFinished(id: string): Promise<boolean> {
  const sessions = JSON.parse(await claude(['agents', '--json'])) as Array<{ id?: string; status?: string; state?: string }>;
  const session = sessions.find((s) => s.id === id);
  return !session || session.state === 'done' || session.status === 'idle';
}

export interface PublishOptions {
  title: string;
  timeoutMs?: number;
}

export async function publishArtifact(htmlPath: string, opts: PublishOptions): Promise<string> {
  // Inside ronin's checkout: the publishing session only reads files under
  // its own working directory.
  const stagingDir = join(process.cwd(), 'logs', 'artifacts');
  await mkdir(stagingDir, { recursive: true });
  const staged = join(stagingDir, `${Date.now()}-${basename(htmlPath)}`);
  await writeFile(staged, await inlineLocalImages(await readFile(htmlPath, 'utf8'), dirname(htmlPath)));

  const prompt = [
    `Publish the file ${staged} as an Artifact with the Artifact tool, exactly as it is: do not edit it, do not load any skill, do not create any other file. Use icon "design" and the title "${opts.title.replaceAll('"', "'")}".`,
    'When it is published, print exactly one line: RONIN_ARTIFACT_URL=<the url>. Do nothing else.',
  ].join(' ');
  const stdout = await claude(['--bg', '-n', `ronin-artifact-${Date.now()}`, '--permission-mode', 'bypassPermissions', '--model', 'sonnet', prompt]);
  const id = parseBackgroundId(stdout);
  if (!id) throw new Error(`no pude leer el id de la sesión en background: ${stdout.slice(0, 300)}`);

  const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
  try {
    while (Date.now() < deadline) {
      const url = parseArtifactUrl(await claude(['logs', id]).catch(() => ''));
      if (url) return url;
      if (await sessionFinished(id).catch(() => false)) {
        const last = parseArtifactUrl(await claude(['logs', id]).catch(() => ''));
        if (last) return last;
        throw new Error('la sesión terminó sin publicar el Artifact');
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
    throw new Error('la publicación del Artifact no terminó a tiempo');
  } finally {
    await claude(['stop', id]).catch(() => {});
    await claude(['rm', id]).catch((error) => log.error(`artifact: no se pudo borrar la sesión ${id}`, error));
  }
}
