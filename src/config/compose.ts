// Composes the single configuration entrypoint (conveyor.yaml) from Home Assistant-style tags:
// `!include <file>`, `!include_dir_named <dir>`, `!include_dir_merge_named <dir>` and
// `!secret <key>`. Each tag is replaced by the content it names; every included value remembers the
// file it came from so relative paths resolve against that file and errors name it.

import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseDocument, type ScalarTag } from "yaml";

import { ConfigError } from "./errors";

const TAGS = ["!include", "!include_dir_named", "!include_dir_merge_named", "!secret"] as const;
type TagName = (typeof TAGS)[number];

/** The prefix that selects a packaged default instead of a file next to the declaring file. */
export const BUILTIN_PREFIX = "builtin:";

class TagReference {
  constructor(readonly tag: TagName, readonly argument: string) {}
}

const customTags: ScalarTag[] = TAGS.map((tag) => ({
  tag,
  identify: (value: unknown) => value instanceof TagReference && value.tag === tag,
  resolve: (argument: string) => new TagReference(tag, argument.trim()) as never,
}));

/** Where a composed value came from: `file` defined everything under `path` in the composed document. */
export interface ConfigOrigin {
  path: readonly string[];
  /** Where the file's own root landed, when not at `path` (a file merged by `!include_dir_merge_named`). */
  root?: readonly string[];
  file: string;
}

export interface ComposedConfig {
  document: Record<string, unknown>;
  /** Every file that contributed, the entrypoint first; the root origin has the empty path. */
  origins: ConfigOrigin[];
  /** Values substituted for `!secret`, so displays and exports can redact them. */
  secrets: string[];
  /** Each `!secret` key used, with its value as written (a string or a number), for migration. */
  secretKeys: Record<string, string | number>;
}

export interface ComposeOptions {
  /** Resolves `builtin:<path>` to a readable file; required when a builtin include is used. */
  builtin?: (relative: string) => Promise<string>;
  /** Put secretPlaceholder(key) where each `!secret` was, instead of its value (for migration). */
  secretPlaceholders?: boolean;
}

/** Stands for `!secret <key>` in a composed document; no configuration value can contain NUL. */
export function secretPlaceholder(key: string): string {
  return `\u0000conveyor-secret:${key}\u0000`;
}

/** The key a placeholder stands for, or null for any other value. */
export function placeholderKey(value: unknown): string | null {
  return typeof value === "string" ? /^\u0000conveyor-secret:(.+)\u0000$/.exec(value)?.[1] ?? null : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof TagReference);
}

/** The file being read, and the key path in the composed document where its root landed. */
interface Location {
  file: string;
  root: readonly string[];
}

function keyPath(segments: readonly string[]): string {
  return segments.length === 0 ? "(root)" : segments.join(".");
}

class Composer {
  readonly origins: ConfigOrigin[] = [];
  readonly secrets = new Set<string>();
  readonly secretKeys = new Map<string, string | number>();
  #secretValues: Record<string, unknown> | null = null;

  constructor(readonly entrypoint: string, readonly options: ComposeOptions) {}

  /** A file name for messages: relative to the entrypoint's directory when it is inside it. */
  display(file: string): string {
    const relative = path.relative(path.dirname(this.entrypoint), file);
    return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : file;
  }

  /** Throws with the file and the key path inside it (`at.root` is where the file's root landed). */
  fail(at: Location, segments: readonly string[], message: string): never {
    throw new ConfigError(`${this.display(at.file)}: ${keyPath(segments.slice(at.root.length))}: ${message}`);
  }

  async parse(file: string, chain: readonly string[]): Promise<unknown> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const included = chain.length > 0 ? ` (included from ${chain.map((entry) => this.display(entry)).join(" -> ")})` : "";
      throw new ConfigError(`cannot read ${this.display(file)}${included}: ${code === "ENOENT" ? "file does not exist" : error instanceof Error ? error.message : String(error)}`);
    }
    const document = parseDocument(text, { customTags, prettyErrors: false });
    if (document.errors.length > 0) {
      throw new ConfigError(`cannot parse ${this.display(file)}: ${document.errors.map((error) => error.message).join("; ")}`);
    }
    return document.toJS({ maxAliasCount: -1 });
  }

  async load(file: string, segments: readonly string[], chain: readonly string[]): Promise<unknown> {
    if (chain.includes(file)) {
      throw new ConfigError(`include cycle: ${[...chain, file].map((entry) => this.display(entry)).join(" -> ")}`);
    }
    this.origins.push({ path: segments, file });
    const parsed = await this.parse(file, chain);
    return this.resolve(parsed, { file, root: segments }, segments, [...chain, file]);
  }

  async target(argument: string, at: Location, segments: readonly string[], tag: TagName): Promise<string> {
    if (!argument) this.fail(at, segments, `${tag} needs a path`);
    if (argument.startsWith(BUILTIN_PREFIX)) {
      if (tag !== "!include") this.fail(at, segments, `${tag} does not support ${BUILTIN_PREFIX} paths`);
      if (!this.options.builtin) this.fail(at, segments, `${argument} is not available here`);
      return this.options.builtin(argument.slice(BUILTIN_PREFIX.length));
    }
    return path.resolve(path.dirname(at.file), argument);
  }

  async yamlFiles(directory: string, at: Location, segments: readonly string[], tag: TagName): Promise<string[]> {
    const info = await stat(directory).catch(() => undefined);
    if (!info?.isDirectory()) this.fail(at, segments, `${tag} ${this.display(directory)} is not a directory`);
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => path.join(directory, entry.name))
      .sort();
  }

  async secret(key: string, at: Location, segments: readonly string[]): Promise<unknown> {
    if (!key) this.fail(at, segments, "!secret needs a key");
    const secretsFile = path.join(path.dirname(this.entrypoint), "secrets.yaml");
    if (!this.#secretValues) {
      const exists = await stat(secretsFile).catch(() => undefined);
      if (!exists) this.fail(at, segments, `!secret ${key}: ${this.display(secretsFile)} does not exist`);
      const parsed = await this.parse(secretsFile, []);
      if (!isObject(parsed)) throw new ConfigError(`${this.display(secretsFile)} must contain a YAML map of secret names to values`);
      this.#secretValues = parsed;
    }
    if (!Object.hasOwn(this.#secretValues, key)) {
      this.fail(at, segments, `!secret ${key} is not defined in ${this.display(secretsFile)}`);
    }
    const value = this.#secretValues[key];
    if (typeof value !== "string" && typeof value !== "number") {
      this.fail(at, segments, `!secret ${key} must be a string or a number in ${this.display(secretsFile)}`);
    }
    if (String(value).length > 0) this.secrets.add(String(value));
    this.secretKeys.set(key, value);
    return this.options.secretPlaceholders ? secretPlaceholder(key) : value;
  }

  async resolve(value: unknown, at: Location, segments: readonly string[], chain: readonly string[]): Promise<unknown> {
    if (value instanceof TagReference) return this.resolveTag(value, at, segments, chain);
    if (Array.isArray(value)) {
      const items: unknown[] = [];
      for (const [index, item] of value.entries()) items.push(await this.resolve(item, at, [...segments, String(index)], chain));
      return items;
    }
    if (isObject(value)) {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value)) result[key] = await this.resolve(item, at, [...segments, key], chain);
      return result;
    }
    return value;
  }

  async resolveTag(reference: TagReference, at: Location, segments: readonly string[], chain: readonly string[]): Promise<unknown> {
    if (reference.tag === "!secret") return this.secret(reference.argument, at, segments);
    const target = await this.target(reference.argument, at, segments, reference.tag);
    if (reference.tag === "!include") return this.load(target, segments, chain);

    const result: Record<string, unknown> = {};
    const sources = new Map<string, string>();
    for (const member of await this.yamlFiles(target, at, segments, reference.tag)) {
      if (reference.tag === "!include_dir_named") {
        const key = path.basename(member).replace(/\.ya?ml$/i, "");
        const prior = sources.get(key);
        if (prior) this.fail(at, segments, `duplicate key "${key}" from ${this.display(member)}: also defined by ${this.display(prior)}`);
        sources.set(key, member);
        result[key] = await this.load(member, [...segments, key], chain);
        continue;
      }
      // !include_dir_merge_named: each file is a map whose entries are merged into one.
      if (chain.includes(member)) {
        throw new ConfigError(`include cycle: ${[...chain, member].map((entry) => this.display(entry)).join(" -> ")}`);
      }
      const parsed = await this.parse(member, chain);
      if (parsed === null || parsed === undefined) continue;
      const memberAt: Location = { file: member, root: segments };
      if (!isObject(parsed)) this.fail(memberAt, segments, `${reference.tag} needs every file to contain a map`);
      for (const [key, item] of Object.entries(parsed)) {
        const prior = sources.get(key);
        if (prior) this.fail(memberAt, [...segments, key], `duplicate key: also defined by ${this.display(prior)}`);
        sources.set(key, member);
        this.origins.push({ path: [...segments, key], root: segments, file: member });
        result[key] = await this.resolve(item, memberAt, [...segments, key], [...chain, member]);
      }
    }
    return result;
  }
}

/** Reads the entrypoint and every file its tags name, and returns the composed document. */
export async function composeConfig(entrypoint: string, options: ComposeOptions = {}): Promise<ComposedConfig> {
  const file = path.resolve(entrypoint);
  const composer = new Composer(file, options);
  const document = await composer.load(file, [], []);
  if (!isObject(document)) throw new ConfigError(`${composer.display(file)} must contain a YAML map at its root`);
  return { document, origins: composer.origins, secrets: [...composer.secrets], secretKeys: Object.fromEntries(composer.secretKeys) };
}

/** True when a YAML file uses one of the composition tags (a quick textual check). */
export function usesCompositionTags(text: string): boolean {
  return /(^|[\s:\-[,])!(include|include_dir_named|include_dir_merge_named|secret)\b/m.test(text);
}

/** The origin that owns `segments`: the one with the longest matching path prefix. */
export function originOf(origins: readonly ConfigOrigin[], segments: readonly string[]): ConfigOrigin | undefined {
  let best: ConfigOrigin | undefined;
  for (const origin of origins) {
    if (origin.path.length > segments.length) continue;
    if (!origin.path.every((segment, index) => segments[index] === segment)) continue;
    if (!best || origin.path.length >= best.path.length) best = origin;
  }
  return best;
}

/** Replaces every occurrence of a secret value inside strings with a redaction marker. */
export function redactSecrets<T>(value: T, secrets: readonly string[]): T {
  const ordered = [...secrets].filter(Boolean).sort((left, right) => right.length - left.length);
  if (ordered.length === 0) return value;
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return ordered.reduce((text, secret) => text.split(secret).join("<redacted>"), item);
    if (typeof item === "number" && ordered.includes(String(item))) return "<redacted>";
    if (Array.isArray(item)) return item.map(visit);
    if (typeof item === "object" && item !== null) return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    return item;
  };
  return visit(value) as T;
}
