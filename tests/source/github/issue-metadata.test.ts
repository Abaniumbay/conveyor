import { describe, expect, test } from "bun:test";

import {
  IssueMetadataError,
  resolveFieldValues,
  resolveIssueType,
  type IssueFieldDefinition,
} from "../../../src/source/github/issue-metadata";

const fields: IssueFieldDefinition[] = [
  { id: 1, name: "Effort", dataType: "single_select", options: ["High", "Medium", "Low"] },
  { id: 2, name: "Target date", dataType: "date", options: [] },
  { id: 3, name: "Points", dataType: "number", options: [] },
  { id: 4, name: "Notes", dataType: "text", options: [] },
  { id: 5, name: "Labels", dataType: "multi_select", options: ["a"] },
];
const all = ["Effort", "Target date", "Points", "Notes", "Labels", "Priority"];

describe("resolveIssueType", () => {
  test("returns the organization's spelling and lists valid types for an unknown one", () => {
    expect(resolveIssueType(["Task", "Bug"], " bug ")).toBe("Bug");
    expect(() => resolveIssueType(["Task", "Bug"], "Epic")).toThrow('Unknown issue type "Epic". Valid issue types: Task, Bug');
  });
});

describe("resolveFieldValues", () => {
  const resolve = (name: string, value: string, configured = all) => resolveFieldValues(fields, configured, [{ name, value }]);

  test("resolves ids and spelling for each data type", () => {
    expect(resolve("effort", "medium")).toEqual([{ fieldId: 1, name: "Effort", value: "Medium" }]);
    expect(resolve("Target date", "2026-10-31")).toEqual([{ fieldId: 2, name: "Target date", value: "2026-10-31" }]);
    expect(resolve("Points", "3.5")[0]!.value).toBe("3.5");
    expect(resolve("Notes", " hi ")[0]!.value).toBe("hi");
  });

  test("rejects an unconfigured field, listing the writable ones", () => {
    expect(() => resolve("Target date", "2026-10-31", ["Effort"])).toThrow('Field "Target date" is not writable by refinement in this repository. Writable fields: Effort');
  });

  test("rejects a field the organization does not define, listing the defined ones", () => {
    expect(() => resolve("Priority", "High")).toThrow('does not define a field named "Priority". Defined fields: Effort, Target date, Points, Notes, Labels');
  });

  test("rejects an unknown option, a bad date and a bad number", () => {
    expect(() => resolve("Effort", "Huge")).toThrow('not an option of Effort. Valid options: High, Medium, Low');
    for (const bad of ["2026-13-01", "2026-02-30", "tomorrow", "2026-1-1"]) expect(() => resolve("Target date", bad)).toThrow("Use YYYY-MM-DD");
    expect(() => resolve("Points", "many")).toThrow("not a number");
    expect(() => resolve("Labels", "a")).toThrow("multi-select");
    expect(() => resolve("Effort", "High")).not.toThrow();
  });

  test("validates every value before returning any", () => {
    expect(() => resolveFieldValues(fields, all, [{ name: "Effort", value: "Low" }, { name: "Effort", value: "Huge" }])).toThrow(IssueMetadataError);
  });
});
