import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { RULES, findViolations, importSpecifiers, violationKey, violationsOf } from "../../scripts/architecture-boundaries";

const ROOT = path.join(import.meta.dir, "../..");
const ALLOWLIST = path.join(ROOT, "scripts/architecture-allowlist.json");

const FILES = new Set([
  "src/core/scheduler.ts",
  "src/plugins/github/shared/adapter.ts",
  "src/plugins/github/shared/events.ts",
  "src/plugins/codex/harness.ts",
  "src/plugins/index.ts",
  "src/harness/types.ts",
  "src/runner/claude-code.ts",
  "src/cli/commands/serve.ts",
  "src/db/store.ts",
  "src/plugins/github/items/index.ts",
  "src/plugins/github/shared/transport.ts",
  "src/plugins/jira/items/index.ts",
]);

const keys = (file: string, source: string) => violationsOf(file, source, FILES).map(violationKey);

describe("architecture boundaries", () => {
  test("src/ crosses no boundary beyond scripts/architecture-allowlist.json", async () => {
    const allowed = new Set<string>(JSON.parse(await readFile(ALLOWLIST, "utf8")));
    const actual = (await findViolations(ROOT)).map(violationKey);
    const added = actual.filter((key) => !allowed.has(key));
    const gone = [...allowed].filter((key) => !actual.includes(key));
    const problems = [
      ...added.map((key) => `new boundary violation: ${key}\n  ${RULES[key.split(" ")[0] as keyof typeof RULES]}`),
      ...gone.map((key) => `fixed, so delete it from scripts/architecture-allowlist.json: ${key}`),
    ];
    if (problems.length > 0) throw new Error(problems.join("\n"));
  });

  test("a core module importing a provider implementation is a violation", () => {
    expect(keys("src/core/scheduler.ts", 'import { GitHubAdapter } from "../plugins/github/shared/adapter";'))
      .toEqual(["implementation-import src/core/scheduler.ts -> src/plugins/github/shared/adapter.ts"]);
  });

  test("a type-only import of an implementation is a violation", () => {
    expect(keys("src/core/scheduler.ts", 'import type { GitHubAdapter } from "../plugins/github/shared/adapter";'))
      .toEqual(["implementation-import src/core/scheduler.ts -> src/plugins/github/shared/adapter.ts"]);
  });

  test("importing a harness implementation outside the composition root is a violation", () => {
    expect(keys("src/core/scheduler.ts", 'import { codexHarness } from "../plugins/codex/harness";'))
      .toEqual(["implementation-import src/core/scheduler.ts -> src/plugins/codex/harness.ts"]);
  });

  test("importing a port is not a violation", () => {
    expect(keys("src/core/scheduler.ts", 'import type { Harness } from "../harness/types";')).toEqual([]);
  });

  test("the composition root may import implementations", () => {
    expect(keys("src/cli/commands/serve.ts", 'import { GitHubAdapter } from "../../plugins/github/shared/adapter";')).toEqual([]);
  });

  test("an implementation may import its own provider's modules", () => {
    expect(keys("src/plugins/github/shared/adapter.ts", 'import { normalizeGitHubEvent } from "./events";')).toEqual([]);
  });

  test("the plugin list may import every plugin", () => {
    expect(keys("src/plugins/index.ts", 'import { codexHarness } from "./codex/harness";\nimport { GitHubAdapter } from "./github/shared/adapter";')).toEqual([]);
  });

  test("a plugin importing another plugin is a violation", () => {
    expect(keys("src/plugins/jira/items/index.ts", 'import { transport } from "../../github/shared/transport";'))
      .toEqual(["plugin-import src/plugins/jira/items/index.ts -> src/plugins/github/shared/transport.ts"]);
  });

  test("a plugin may import its own provider's shared code", () => {
    expect(keys("src/plugins/github/items/index.ts", 'import { transport } from "../shared/transport";')).toEqual([]);
  });

  test("bun:sqlite outside src/db is a violation", () => {
    expect(keys("src/core/scheduler.ts", 'import { Database } from "bun:sqlite";'))
      .toEqual(["sqlite-access src/core/scheduler.ts -> bun:sqlite"]);
  });

  test("calling .sqlite() outside src/db is a violation", () => {
    expect(keys("src/core/scheduler.ts", "const rows = store.sqlite().query('select 1').all();"))
      .toEqual(["sqlite-access src/core/scheduler.ts -> .sqlite()"]);
  });

  test("src/db may use SQLite directly", () => {
    expect(keys("src/db/store.ts", 'import { Database } from "bun:sqlite";\nthis.sqlite();')).toEqual([]);
  });

  test("an import mentioned only in a comment is not a violation", () => {
    expect(keys("src/core/scheduler.ts", '// import { GitHubAdapter } from "../plugins/github/shared/adapter";\n/* import "../plugins/codex/harness"; */')).toEqual([]);
  });

  test("re-exports, side-effect and dynamic imports are scanned", () => {
    expect(importSpecifiers('export { a } from "./a";\nimport "./b";\nconst c = await import("./c");')).toEqual(["./a", "./b", "./c"]);
  });
});
