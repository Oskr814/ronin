import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import matter from 'gray-matter';
import { config } from './config.js';

export interface SpecFrontmatter {
  status: 'draft' | 'ready' | 'in-progress' | 'blocked' | 'done';
  issue: number | null;
}

export interface SpecFile {
  absolutePath: string;
  relativePath: string;
  title: string;
  frontmatter: SpecFrontmatter;
}

async function walkMarkdownFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) return walkMarkdownFiles(full);
      return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
    }),
  );
  return files.flat();
}

async function parseSpec(absolutePath: string): Promise<SpecFile | null> {
  const raw = await readFile(absolutePath, 'utf8');
  const { data, content } = matter(raw);
  if (!data.status) return null; // not a frontmatter-managed spec, ignore

  const titleMatch = content.match(/^#\s+(.+)$/m);
  return {
    absolutePath,
    relativePath: relative(config.productRepoPath, absolutePath),
    title: titleMatch?.[1] ?? absolutePath,
    frontmatter: {
      status: data.status,
      issue: data.issue ?? null,
    },
  };
}

export async function scanReadySpecs(): Promise<SpecFile[]> {
  const specDirAbs = join(config.productRepoPath, config.specDir);
  const files = await walkMarkdownFiles(specDirAbs);
  const specs = await Promise.all(files.map(parseSpec));
  return specs.filter((spec): spec is SpecFile => spec !== null && spec.frontmatter.status === 'ready' && spec.frontmatter.issue === null);
}

// Called right after the tracking issue is created, so the frontmatter mirror
// never lags behind GitHub — see docs/DESIGN.md §1.
export async function linkSpecToIssue(spec: SpecFile, issueNumber: number): Promise<void> {
  const raw = await readFile(spec.absolutePath, 'utf8');
  const parsed = matter(raw);
  parsed.data.status = 'in-progress';
  parsed.data.issue = issueNumber;
  await writeFile(spec.absolutePath, matter.stringify(parsed.content, parsed.data), 'utf8');
}
