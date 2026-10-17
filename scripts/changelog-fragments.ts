import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const SECTIONS = ["Added", "Changed", "Deprecated", "Removed", "Fixed"] as const;

export type ChangelogSection = (typeof SECTIONS)[number];

export interface ChangelogFragment {
  filename: string;
  issue: number;
  section: ChangelogSection;
  breaking: boolean;
  body: string;
}

function fragmentError(filename: string, message: string): Error {
  return new Error(`changes/${filename}: ${message}`);
}

/** Parses and validates one changelog fragment. */
export function parseChangelogFragment(filename: string, content: string): ChangelogFragment {
  const match = /^(0*[1-9]\d*)-.+\.md$/.exec(filename);
  if (!match) throw fragmentError(filename, "filename must start with a positive issue number and hyphen");

  const normalized = content.replace(/\r\n/g, "\n");
  const frontmatter = /^---\n([\s\S]*?)^---(?:\n|$)/m.exec(normalized);
  if (!frontmatter || frontmatter.index !== 0) throw fragmentError(filename, "must start with --- frontmatter");

  const values = new Map<string, string>();
  const fields = frontmatter[1]!.trimEnd();
  for (const line of fields ? fields.split("\n") : []) {
    const entry = /^([^:\s]+): (.+)$/.exec(line);
    if (!entry) throw fragmentError(filename, "frontmatter must contain key: value lines");
    const [, key, value] = entry;
    if (!key || !value) throw fragmentError(filename, "frontmatter must contain key: value lines");
    if (key !== "section" && key !== "breaking") throw fragmentError(filename, `unknown frontmatter key ${key}`);
    if (values.has(key)) throw fragmentError(filename, `duplicate frontmatter key ${key}`);
    values.set(key, value);
  }

  const section = values.get("section");
  if (!section) throw fragmentError(filename, "missing section");
  if (!SECTIONS.includes(section as ChangelogSection)) throw fragmentError(filename, `unknown section ${section}`);
  const breakingValue = values.get("breaking");
  if (breakingValue !== undefined && breakingValue !== "true") throw fragmentError(filename, "breaking must be true when present");

  const body = normalized.slice(frontmatter[0].length).trim();
  if (!body) throw fragmentError(filename, "body must not be empty");
  return { filename, issue: Number(match[1]), section: section as ChangelogSection, breaking: breakingValue === "true", body };
}

/** Reads every fragment in changes/, returning them in release-note order. */
export async function readChangelogFragments(root: string): Promise<ChangelogFragment[]> {
  const directory = path.join(root, "changes");
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const fragments = await Promise.all(names.sort().map(async (filename) => parseChangelogFragment(filename, await readFile(path.join(directory, filename), "utf8"))));
  return fragments.sort((left, right) => SECTIONS.indexOf(left.section) - SECTIONS.indexOf(right.section) || left.issue - right.issue || left.filename.localeCompare(right.filename));
}

function renderEntry(fragment: ChangelogFragment): string {
  const [first, ...rest] = fragment.body.split("\n");
  return `- ${fragment.breaking ? "**Breaking:** " : ""}${first!}${rest.map((line) => line ? `\n  ${line}` : "\n").join("")}`;
}

/** Renders fragment entries as the body of a dated changelog section. */
export function renderReleaseNotes(fragments: readonly ChangelogFragment[]): string {
  return SECTIONS.flatMap((section) => {
    const entries = fragments.filter((fragment) => fragment.section === section);
    return entries.length === 0 ? [] : [`### ${section}`, entries.map(renderEntry).join("\n\n")];
  }).join("\n\n");
}

/** Renders the Unreleased preview without writing any repository files. */
export function renderUnreleased(fragments: readonly ChangelogFragment[]): string {
  const notes = renderReleaseNotes(fragments);
  return notes ? `## [Unreleased]\n\n${notes}` : "## [Unreleased]";
}
