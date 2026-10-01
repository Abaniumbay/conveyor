// The neutral agent harness contract. A harness runs one agent turn and returns the run
// envelope; session resume is an optional capability (D2/C4): correctness never depends on it.

import type { HarnessCapabilities, HarnessResumeInput } from "../tasks/context";
import type { RunEnvelope } from "../runner/result";
import type { EgressInput } from "../isolation/run-network";

export interface HarnessRunInput {
  /** The runner's executable. */
  command: string;
  workspace: string;
  artifactsDirectory: string;
  prompt: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  automaticApprovals: boolean;
  /** The scoped MCP server the agent talks to. */
  mcp: { command: string; args: string[] };
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  /** Network isolation policy for the run; absent keeps the legacy (environment-only) behaviour. */
  egress?: EgressInput;
}

export interface Harness {
  id: string;
  capabilities: HarnessCapabilities;
  run(input: HarnessRunInput & HarnessResumeInput): Promise<RunEnvelope>;
}

export type { HarnessCapabilities, HarnessResumeInput };
