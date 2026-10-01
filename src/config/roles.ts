import { ConfigError } from "./errors";

type Document = Record<string, unknown>;

function isObject(value: unknown): value is Document {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PROVIDER_ROLES = { items: "sources", code: "codeHosts", ci: "ci" } as const;
const AGENT_RENAMES = { harness: "runner", access: "workspaceAccess" } as const;
const REPOSITORY_RENAMES = { items: "source", code: "codeHost" } as const;

function rename(holder: Document, from: string, to: string, where: string): void {
  if (!(from in holder)) return;
  if (to in holder) throw new ConfigError(`${where} uses both "${from}" and "${to}"; use only "${from}"`);
  holder[to] = holder[from];
  delete holder[from];
}

function renameEntries(entries: unknown, renames: Record<string, string>, section: string): void {
  if (!isObject(entries)) return;
  for (const [name, entry] of Object.entries(entries)) {
    if (!isObject(entry)) continue;
    for (const [from, to] of Object.entries(renames)) rename(entry, from, to, `${section}.${name}`);
  }
}

/**
 * Translates the canonical provider-role names (providers.items/code/ci, harnesses,
 * agent harness/access, repository items/code) to the internal model. Pure: returns a
 * new document. Using an old and a new name for the same thing is an error.
 */
export function normalizeRoleNames(input: Document): Document {
  const document = structuredClone(input);

  if ("providers" in document) {
    const providers = document.providers;
    if (!isObject(providers)) throw new ConfigError("providers must be an object");
    delete document.providers;
    for (const role of Object.keys(providers)) {
      if (!(role in PROVIDER_ROLES)) {
        throw new ConfigError(`providers.${role} is not a provider role; use items, code or ci`);
      }
    }
    for (const [role, section] of Object.entries(PROVIDER_ROLES)) {
      if (!(role in providers)) continue;
      if (section in document) {
        throw new ConfigError(`configuration uses both "providers.${role}" and "${section}"; use only "providers.${role}"`);
      }
      document[section] = providers[role];
    }

    const items = providers.items;
    if (isObject(items)) {
      const names = Object.keys(items);
      const labelled = names.filter((name) => isObject(items[name]) && "labels" in (items[name] as Document));
      if (labelled.length > 0) {
        if ("labels" in document) {
          throw new ConfigError(`configuration uses both "providers.items.${labelled[0]}.labels" and "labels"; use only one`);
        }
        const first = labelled[0]!;
        const labels = (items[first] as Document).labels;
        for (const name of names) {
          const entry = items[name];
          if (!isObject(entry) || !("labels" in entry) || !Bun.deepEquals(entry.labels, labels, true)) {
            throw new ConfigError(
              `providers.items.${name}.labels must equal providers.items.${first}.labels: every item provider shares one labels block`,
            );
          }
        }
        for (const name of names) delete (items[name] as Document).labels;
        document.labels = labels;
      }
    }
  }

  rename(document, "harnesses", "runners", "configuration");
  renameEntries(document.agents, AGENT_RENAMES, "agents");
  renameEntries(document.repositories, REPOSITORY_RENAMES, "repositories");
  return document;
}

const CONCEPTS: [canonical: string, legacy: string][] = [
  ["providers.items", "sources"],
  ["providers.code", "codeHosts"],
  ["providers.ci", "ci"],
  ["harnesses", "runners"],
];

export interface NamedDocument {
  filename: string;
  document: Document;
}

/**
 * Normalises every document and enforces role-name consistency across all of them: a
 * concept may not appear in both forms in any two files, and every item provider in
 * every file shares one labels block, which becomes the single top-level `labels`.
 */
export function normalizeRoleDocuments(documents: NamedDocument[]): NamedDocument[] {
  for (const [canonical, legacy] of CONCEPTS) {
    const role = canonical.split(".")[1];
    const canonicalFile = documents.find(({ document }) =>
      role ? isObject(document.providers) && role in document.providers : canonical in document,
    )?.filename;
    const legacyFile = documents.find(({ document }) => legacy in document)?.filename;
    if (canonicalFile && legacyFile) {
      throw new ConfigError(
        `configuration uses both "${canonical}" (in ${canonicalFile}) and "${legacy}" (in ${legacyFile}); use only "${canonical}"`,
      );
    }
  }

  const providers: { filename: string; name: string; labels: unknown; labelled: boolean }[] = [];
  for (const { filename, document } of documents) {
    const items = isObject(document.providers) ? document.providers.items : undefined;
    if (!isObject(items)) continue;
    for (const [name, entry] of Object.entries(items)) {
      const labelled = isObject(entry) && "labels" in entry;
      providers.push({ filename, name, labelled, labels: labelled ? (entry as Document).labels : undefined });
    }
  }
  const first = providers.find((provider) => provider.labelled);
  if (first) {
    const topLevel = documents.find(({ document }) => "labels" in document);
    if (topLevel) {
      throw new ConfigError(
        `configuration uses both "providers.items.${first.name}.labels" (in ${first.filename}) and "labels" (in ${topLevel.filename}); use only one`,
      );
    }
    for (const provider of providers) {
      if (!provider.labelled || !Bun.deepEquals(provider.labels, first.labels, true)) {
        throw new ConfigError(
          `providers.items.${provider.name}.labels (${provider.filename}) must equal providers.items.${first.name}.labels (${first.filename}): every item provider shares one labels block`,
        );
      }
    }
  }

  let labelsKept = false;
  return documents.map(({ filename, document }) => {
    const normalised = normalizeRoleNames(document);
    const derived =
      isObject(document.providers) &&
      isObject(document.providers.items) &&
      Object.values(document.providers.items).some((entry) => isObject(entry) && "labels" in entry);
    if (derived) {
      if (labelsKept) delete normalised.labels;
      labelsKept = true;
    }
    return { filename, document: normalised };
  });
}
