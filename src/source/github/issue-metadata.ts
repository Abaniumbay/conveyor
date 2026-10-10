// Organization issue types and issue fields: what the owner defines, and validation of what
// refinement writes against it. Pure; the adapter does the GitHub calls.

import { ToolRequestError } from "../../tasks/errors";

export type IssueFieldDataType = "text" | "number" | "date" | "single_select" | "multi_select";

export interface IssueFieldDefinition {
  id: number;
  name: string;
  dataType: IssueFieldDataType;
  /** Option names of a select field. */
  options: string[];
}

export interface IssueFieldValue {
  name: string;
  value: string;
}

export interface ResolvedFieldValue {
  fieldId: number;
  name: string;
  value: string;
}

/** Why a requested type, field or value cannot be written; the message lists the valid choices. */
export class IssueMetadataError extends ToolRequestError {
  override readonly name = "IssueMetadataError";
}

const list = (names: readonly string[]) => (names.length > 0 ? names.join(", ") : "none");
const same = (left: string, right: string) => left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();

/** The organization's own spelling of a type, or an error listing the valid types. */
export function resolveIssueType(valid: readonly string[], requested: string): string {
  const found = valid.find((name) => same(name, requested));
  if (!found) throw new IssueMetadataError(`Unknown issue type "${requested}". Valid issue types: ${list(valid)}`);
  return found;
}

function validDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

/**
 * Validate every value before any is written: the field must be configured for this repository
 * and defined by the organization, a select value must be one of its options, a date must be
 * YYYY-MM-DD. Returns the organization's spelling of each field and option.
 */
export function resolveFieldValues(
  definitions: readonly IssueFieldDefinition[],
  configured: readonly string[],
  values: readonly IssueFieldValue[],
): ResolvedFieldValue[] {
  const seen = new Set<number>();
  return values.map(({ name, value }) => {
    if (!configured.some((allowed) => same(allowed, name))) {
      throw new IssueMetadataError(`Field "${name}" is not writable by refinement in this repository. Writable fields: ${list(configured)}`);
    }
    const definition = definitions.find((field) => same(field.name, name));
    if (!definition) {
      throw new IssueMetadataError(`The organization does not define a field named "${name}". Defined fields: ${list(definitions.map((field) => field.name))}`);
    }
    if (seen.has(definition.id)) throw new IssueMetadataError(`Field "${definition.name}" is given more than once`);
    seen.add(definition.id);
    const text = value.trim();
    if (definition.dataType === "single_select") {
      const option = definition.options.find((candidate) => same(candidate, text));
      if (!option) throw new IssueMetadataError(`"${value}" is not an option of ${definition.name}. Valid options: ${list(definition.options)}`);
      return { fieldId: definition.id, name: definition.name, value: option };
    }
    if (definition.dataType === "date") {
      if (!validDate(text)) throw new IssueMetadataError(`"${value}" is not a valid date for ${definition.name}. Use YYYY-MM-DD`);
    } else if (definition.dataType === "number") {
      if (text.length === 0 || !Number.isFinite(Number(text))) throw new IssueMetadataError(`"${value}" is not a number for ${definition.name}`);
    } else if (definition.dataType === "multi_select") {
      throw new IssueMetadataError(`${definition.name} is a multi-select field, which refinement cannot write`);
    } else if (text.length === 0) throw new IssueMetadataError(`${definition.name} needs a non-empty value`);
    return { fieldId: definition.id, name: definition.name, value: text };
  });
}
