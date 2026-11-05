import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { classifyUpstreamError } from "../../src/tasks/upstream-error";

describe("classifyUpstreamError", () => {
  test("classifies a GitHub HTTP 502 as transient", () => {
    expect(classifyUpstreamError(new Error("gh: HTTP 502: Bad Gateway"))).toMatchObject({ kind: "transient", upstream: "github", status: 502 });
  });

  test("classifies a GraphQL internal failure as transient", () => {
    expect(classifyUpstreamError(new Error("Something went wrong while executing your query. Please include 0ABC in any report")).kind).toBe("transient");
  });

  test("classifies a commit_refs_rules push rejection as transient", () => {
    const error = new Error("git push failed:\n remote: fatal error in commit_refs_rules\n ! [remote rejected] main -> main (failure)");
    expect(classifyUpstreamError(error)).toMatchObject({ kind: "transient", upstream: "github" });
    expect(classifyUpstreamError(new Error("push rejected: Internal Server Error")).kind).toBe("transient");
  });

  test("classifies truncated JSON and HTTP 429 as transient", () => {
    expect(classifyUpstreamError(new SyntaxError("Unexpected end of JSON input")).kind).toBe("transient");
    expect(classifyUpstreamError(new Error("gh: HTTP 429: secondary rate limit"))).toMatchObject({ kind: "transient", status: 429 });
  });

  test("classifies an unrecognised error as permanent", () => {
    expect(classifyUpstreamError(new Error("column foo does not exist"))).toEqual({ kind: "permanent", detail: "column foo does not exist" });
    expect(classifyUpstreamError("weird").kind).toBe("permanent");
    expect(classifyUpstreamError(new Error("gh: HTTP 404: Not Found")).kind).toBe("permanent");
  });

  test("keeps only the first line and removes GitHub tokens from detail", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const pat = `github_pat_${"B".repeat(30)}`;
    const detail = classifyUpstreamError(new Error(`HTTP 500 for https://x-access-token:${token}@github.com/o/r.git with ${pat} Authorization: Bearer ${token}\nsecret second line`)).detail;
    expect(detail).not.toContain(token);
    expect(detail).not.toContain(pat);
    expect(detail).not.toContain("second line");
    expect(detail).toContain("[redacted]");
  });
});

describe("shipped agent instructions", () => {
  test("tell agents not to diagnose a transient failure and to stop with GitHub unavailable", async () => {
    for (const file of ["kaveh", "darya", "omid", "reviewer", "breakdown-reviewer", "work-breakdown"]) {
      const text = await readFile(path.join(import.meta.dir, `../../examples/config/instructions/${file}.md`), "utf8");
      expect(text).toContain('`kind` is `"transient"`');
      expect(text).toContain("do not diagnose");
      expect(text).toContain("GitHub unavailable");
    }
  });
});
