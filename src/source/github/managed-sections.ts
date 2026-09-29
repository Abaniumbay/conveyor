import { createHash } from "node:crypto";

/** The only issue-body blocks this module considers Conveyor-owned. */
export type ManagedSectionName = "acceptance-criteria" | "dependencies";

export interface ManagedSectionsSnapshot {
  /** SHA-256 of the entire body; pass this back when writing to reject stale edits. */
  revision: string;
  /** Unwrapped Markdown for each section. An absent block has an undefined value. */
  sections: Record<ManagedSectionName, string | undefined>;
}

export class ManagedSectionError extends Error {
  override readonly name = "ManagedSectionError";
}

const SECTION_NAMES: readonly ManagedSectionName[] = [
  "acceptance-criteria",
  "dependencies",
];

interface MarkerLine {
  name: ManagedSectionName;
  kind: "start" | "end";
  start: number;
  contentEnd: number;
  next: number;
}

function bodyRevision(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/** Parse both supported blocks, rejecting incomplete, repeated, or crossed markers. */
export function parseManagedSections(body: string): ManagedSectionsSnapshot {
  const markers: MarkerLine[] = [];
  const occurrences = new Map<ManagedSectionName, { start: MarkerLine[]; end: MarkerLine[] }>(
    SECTION_NAMES.map((name) => [name, { start: [], end: [] }]),
  );

  let offset = 0;
  for (const line of body.matchAll(/[^\r\n]*(?:\r\n|\n|\r|$)/g)) {
    const raw = line[0];
    if (raw.length === 0) break;
    const contentEnd = offset + raw.replace(/(?:\r\n|\n|\r)$/, "").length;
    const text = body.slice(offset, contentEnd).trim();
    const match = /^<!-- conveyor:(acceptance-criteria|dependencies):(start|end) -->$/.exec(text);
    if (match) {
      const marker: MarkerLine = {
        name: match[1] as ManagedSectionName,
        kind: match[2] as "start" | "end",
        start: offset,
        contentEnd,
        next: offset + raw.length,
      };
      markers.push(marker);
      occurrences.get(marker.name)?.[marker.kind].push(marker);
    } else {
      for (const name of SECTION_NAMES) {
        if (text.includes(`conveyor:${name}:`)) {
          throw new ManagedSectionError(`malformed ${name} managed-section marker`);
        }
      }
    }
    offset += raw.length;
    if (offset >= body.length) break;
  }

  const ranges: Array<{ name: ManagedSectionName; start: MarkerLine; end: MarkerLine }> = [];
  const sections: Record<ManagedSectionName, string | undefined> = {
    "acceptance-criteria": undefined,
    dependencies: undefined,
  };
  for (const name of SECTION_NAMES) {
    const found = occurrences.get(name)!;
    if (found.start.length > 1 || found.end.length > 1) {
      throw new ManagedSectionError(`duplicate ${name} managed-section marker`);
    }
    if (found.start.length !== found.end.length) {
      throw new ManagedSectionError(`incomplete ${name} managed section`);
    }
    if (found.start.length === 0) continue;
    const start = found.start[0]!;
    const end = found.end[0]!;
    if (start.start >= end.start) {
      throw new ManagedSectionError(`reversed ${name} managed-section markers`);
    }
    sections[name] = body.slice(start.next, end.start).replace(/(?:\r\n|\n|\r)$/, "");
    ranges.push({ name, start, end });
  }
  ranges.sort((left, right) => left.start.start - right.start.start);
  for (let index = 1; index < ranges.length; index += 1) {
    if (ranges[index]!.start.start < ranges[index - 1]!.end.start) {
      throw new ManagedSectionError("managed sections overlap or are nested");
    }
  }

  return { revision: bodyRevision(body), sections };
}

/** Replace or append one managed block only when the caller's body revision is current. */
export function upsertManagedSection(
  body: string,
  name: ManagedSectionName,
  markdown: string,
  expectedRevision: string,
): string {
  if (bodyRevision(body) !== expectedRevision) {
    throw new ManagedSectionError("issue body changed since it was read; refusing stale update");
  }
  const parsed = parseManagedSections(body);
  const starts = [...body.matchAll(new RegExp(`^[ \\t]*<!-- conveyor:${name}:start -->[ \\t]*\\r?$`, "gm"))];
  const ends = [...body.matchAll(new RegExp(`^[ \\t]*<!-- conveyor:${name}:end -->[ \\t]*\\r?$`, "gm"))];
  const newline = body.includes("\r\n") ? "\r\n" : "\n";
  const content = markdown.replace(/\r\n|\r/g, "\n").replace(/\n/g, newline).replace(/\n$/, "");

  if (parsed.sections[name] === undefined) {
    const separator = body.length === 0 ? "" : body.endsWith("\n") || body.endsWith("\r") ? newline : `${newline}${newline}`;
    const updated = `${body}${separator}<!-- conveyor:${name}:start -->${newline}${content}${content ? newline : ""}<!-- conveyor:${name}:end -->${newline}`;
    parseManagedSections(updated);
    return updated;
  }

  const startAt = starts[0]?.index;
  const endAt = ends[0]?.index;
  if (startAt === undefined || endAt === undefined) {
    throw new ManagedSectionError(`could not locate parsed ${name} managed section`);
  }
  const startLineEnd = body.indexOf("\n", startAt);
  const replaceFrom = startLineEnd === -1 ? body.length : startLineEnd + 1;
  const endLineStart = body.lastIndexOf("\n", endAt);
  const replaceTo = endLineStart === -1 ? 0 : endLineStart + 1;
  const updated = `${body.slice(0, replaceFrom)}${content}${content ? newline : ""}${body.slice(replaceTo)}`;
  parseManagedSections(updated);
  return updated;
}

export interface AcceptanceCriterion {
  id: string;
  text: string;
  completed?: boolean;
}

/** Render stable, single-line checklist entries that can be reordered safely. */
export function formatAcceptanceCriteria(criteria: readonly AcceptanceCriterion[]): string {
  const ids = new Set<string>();
  return criteria.map(({ id, text, completed = false }) => {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || ids.has(id)) {
      throw new ManagedSectionError(`invalid or duplicate acceptance-criterion ID: ${id}`);
    }
    ids.add(id);
    const safeText = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    if (safeText.length === 0 || safeText.includes("<!-- conveyor:criterion:")) {
      throw new ManagedSectionError(`invalid text for acceptance criterion ${id}`);
    }
    return `- [${completed ? "x" : " "}] ${safeText} <!-- conveyor:criterion:${id} -->`;
  }).join("\n");
}

export interface DependencyReference {
  number: number;
  /** Optional owner/repository prefix for a cross-repository issue reference. */
  repository?: string;
}

/** Render dependency references in the supplied sibling order. */
export function formatDependencies(dependencies: readonly DependencyReference[]): string {
  return dependencies.map(({ number, repository }) => {
    if (!Number.isSafeInteger(number) || number <= 0) {
      throw new ManagedSectionError(`invalid dependency issue number: ${number}`);
    }
    if (repository !== undefined && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
      throw new ManagedSectionError(`invalid dependency repository: ${repository}`);
    }
    return `- ${repository ? `${repository}#` : "#"}${number}`;
  }).join("\n");
}
