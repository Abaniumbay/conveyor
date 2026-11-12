import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "../..");
const tracked = (): string[] => new TextDecoder().decode(Bun.spawnSync(["git", "ls-files", "-z"], { cwd: root }).stdout).split("\0").filter(Boolean);
const textFiles = (pattern: RegExp) => tracked().filter((file) => pattern.test(file)).map((file) => ({ file, text: readFileSync(path.join(root, file), "utf8") }));

/** The number of comma-separated items outside any nested parentheses or brackets. */
function topLevelItems(list: string): number {
  let depth = 0;
  let items = 1;
  for (const character of list) {
    if ("([{".includes(character)) depth += 1;
    else if (")]}".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) items += 1;
  }
  return items;
}

describe("Conveyor is not specific to any shell but bash", () => {
  test("no workflow, CI setup action, source file, script or test installs, requires or names the other shell", () => {
    const other = new RegExp(["z", "sh"].join(""), "i");
    const offenders = textFiles(/^(\.github\/|src\/|scripts\/|tests\/).*\.(ya?ml|ts|tsx|sh)$/).filter(({ text }) => other.test(text)).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  test("no test calls the shell prefix with more than one argument", () => {
    const calls = textFiles(/^tests\/.*\.ts$/).flatMap(({ file, text }) => [...text.matchAll(/Bun\.spawnSync\(\[([^\]]*CLAUDE_CODE_SHELL_PREFIX[^\]]*)\]/g)].map((match) => ({ file, argv: match[1]! })));
    expect(calls.length).toBeGreaterThan(0);
    for (const { argv } of calls) expect(topLevelItems(argv)).toBe(2);
  });
});
