import { describe, expect, test } from "bun:test";

import { validateHttpsHosts } from "../../src/isolation/egress-policy";

describe("validateHttpsHosts", () => {
  test("accepts exact lowercase DNS names", () => {
    expect(validateHttpsHosts(["registry.npmjs.org", "github.com", "repo1.maven.org"])).toEqual([]);
  });

  test.each([
    ["*.npmjs.org", "wildcards are not allowed"],
    ["10.0.0.1", "IP literals are not allowed"],
    ["[::1]", "IP literals are not allowed"],
    ["::1", "IP literals are not allowed"],
    ["10.0.0.0/8", "CIDRs are not allowed"],
    ["registry.npmjs.org:443", "ports are not allowed"],
    ["https://registry.npmjs.org", "schemes are not allowed"],
    ["registry.npmjs.org.", "trailing dots are not allowed"],
    ["Registry.NPMJS.org", "must be lowercase"],
    ["localhost", "must be a fully qualified DNS name"],
    ["", "must be a fully qualified DNS name"],
    ["api.github.com", "provider APIs are never reachable from agent sandboxes (D6)"],
    ["uploads.github.com", "provider APIs are never reachable from agent sandboxes (D6)"],
  ])("rejects %p", (host, rule) => {
    expect(validateHttpsHosts(["ok.example.com", host])).toEqual([
      { index: 1, message: `agentEgress.httpsHosts[1] "${host}": ${rule}` },
    ]);
  });

  test("rejects duplicates at the later entry", () => {
    expect(validateHttpsHosts(["a.example.com", "b.example.com", "a.example.com"])).toEqual([
      { index: 2, message: 'agentEgress.httpsHosts[2] "a.example.com": duplicate of httpsHosts[0]' },
    ]);
  });
});
