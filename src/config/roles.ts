import { ConfigError } from "./load";

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
