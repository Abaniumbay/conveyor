import { z } from "zod";

/** Source-provider API hosts: never reachable from agent sandboxes. */
export const FORBIDDEN_PROVIDER_HOSTS: readonly string[] = ["api.github.com", "uploads.github.com"];

export interface HostIssue {
  index: number;
  message: string;
}

const DNS_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function hostRule(host: string): string | null {
  if (host.includes("*")) return "wildcards are not allowed";
  if (host.includes("://")) return "schemes are not allowed";
  if (host.includes("/")) return /^[0-9a-f:.]+\/\d+$/i.test(host) ? "CIDRs are not allowed" : "paths are not allowed";
  if (host.startsWith("[") || host.includes("::") || /^[0-9a-f:]+$/i.test(host) && host.includes(":")) {
    return "IP literals are not allowed";
  }
  if (/^\d+(\.\d+){3}$/.test(host)) return "IP literals are not allowed";
  if (host.includes(":")) return "ports are not allowed";
  if (host.endsWith(".")) return "trailing dots are not allowed";
  if (host !== host.toLowerCase()) return "must be lowercase";
  if (FORBIDDEN_PROVIDER_HOSTS.includes(host)) return "provider APIs are never reachable from agent sandboxes (D6)";
  const labels = host.split(".");
  if (labels.length < 2 || !labels.every((label) => label.length <= 63 && DNS_LABEL.test(label))) {
    return "must be a fully qualified DNS name";
  }
  return null;
}

/** Validates `agentEgress.httpsHosts`; returns one issue per offending entry. */
export function validateHttpsHosts(hosts: readonly string[]): HostIssue[] {
  const issues: HostIssue[] = [];
  const firstSeen = new Map<string, number>();
  hosts.forEach((host, index) => {
    const fail = (rule: string) =>
      issues.push({ index, message: `agentEgress.httpsHosts[${index}] "${host}": ${rule}` });
    const rule = hostRule(host);
    if (rule) return fail(rule);
    const earlier = firstSeen.get(host);
    if (earlier !== undefined) return fail(`duplicate of httpsHosts[${earlier}]`);
    firstSeen.set(host, index);
  });
  return issues;
}

export const agentEgressSchema = z
  .object({
    allowLoopbackMcp: z.boolean().default(true),
    httpsHosts: z.array(z.string()).default([]),
  })
  .strict()
  .superRefine((egress, context) => {
    for (const issue of validateHttpsHosts(egress.httpsHosts)) {
      context.addIssue({ code: "custom", path: ["httpsHosts"], message: issue.message });
    }
  });

export type AgentEgressConfig = z.output<typeof agentEgressSchema>;
