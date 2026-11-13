// The neutral agent harness contract. A harness runs one agent turn and returns the run
// envelope; session resume is an optional capability (D2/C4): correctness never depends on it.
// A harness plugin (src/plugins/<harness>/) implements it and declares its profile, so the core
// prepares a run without knowing which harness it is.

import type { CheckResult } from "../core/pipeline";
import type { HarnessCapabilities, HarnessResumeInput } from "../tasks/context";
import type { RunEnvelope } from "../runner/result";
import type { EgressInput } from "../isolation/run-network";
import type { ToolNameGuidance } from "../mcp/guidance";
import type { QuotaWindows } from "../usage/quota";

type Effort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

/** How the harness starts the run's scoped Conveyor MCP server. */
export interface HarnessMcpConfiguration {
  command: string;
  args: string[];
}

export interface HarnessRunInput {
  /** The runner's executable. */
  command: string;
  workspace: string;
  artifactsDirectory: string;
  prompt: string;
  model?: string;
  effort?: Effort;
  sandbox: SandboxMode;
  automaticApprovals: boolean;
  /** The scoped MCP server the agent talks to. */
  mcp: HarnessMcpConfiguration;
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  /** Network isolation policy for the run; absent keeps the legacy (environment-only) behaviour. */
  egress?: EgressInput;
  /** `false` withholds the shell (only for a harness whose profile allows it); absent keeps it. */
  shell?: false;
  /** Live web search, plus network for the agent's commands under workspace-write. */
  network?: boolean;
  /** Directories outside the workspace that the agent's commands may write (workspace-write only). */
  writableRoots?: string[];
  /** Resolved, validated SDK and toolchain directories the agent may read but never write. */
  toolchainPaths?: string[];
  /** Persistent item scratch, or omitted for disposable runner-owned scratch. */
  temporaryDirectory?: string;
  /** The agent's `harnessSettings` (only for a harness whose plugin takes them). */
  config?: Record<string, string | number | boolean>;
  /** MCP servers beside Conveyor's own. */
  mcpServers?: Record<string, { command: string; args: string[]; env: Record<string, string>; startupTimeoutSec?: number; enabledTools?: string[] }>;
}

/** A legacy verifier check: one read-only agent turn that returns a check decision. */
export interface CheckRunInput {
  command: string;
  workspace: string;
  artifactsDirectory: string;
  prompt: string;
  model?: string;
  effort?: Effort;
  sandbox: SandboxMode;
  automaticApprovals: boolean;
  mcp: HarnessMcpConfiguration;
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  /** Network isolation policy; absent keeps the legacy (environment-only) behaviour. */
  egress?: EgressInput;
  writableRoots?: string[];
  /** Persistent item scratch, or omitted for disposable runner-owned scratch. */
  temporaryDirectory?: string;
}

export interface CheckRunResult extends CheckResult {
  sessionId: string | null;
  usage: RunEnvelope["usage"];
  durationMs: number;
  exitCode: number;
  stderr: string;
  cleanupError?: string;
}

/** An Operator (steering) run: one agent turn that answers a person's or the schedule's request. */
export interface SteeringRunInput {
  command: string;
  workspace: string;
  /** Per-run directory that hosts the sanitized home. */
  artifactsDirectory: string;
  prompt: string;
  model?: string;
  effort?: Effort;
  sandbox: SandboxMode;
  automaticApprovals: boolean;
  mcp?: HarnessMcpConfiguration;
  env?: Record<string, string>;
  timeoutMs?: number;
  interruptGraceMs?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
  egress?: EgressInput;
  writableRoots?: string[];
  /** Run with only a fresh scratch filesystem instead of a steering workspace mount. */
  filesystem?: "scratch";
  /** Omit for disposable workspace-free scratch. */
  temporaryDirectory?: string;
}

export interface SteeringRunResult {
  summary: string;
  sessionId: string | null;
  usage: RunEnvelope["usage"];
  durationMs: number;
  exitCode: number;
  stderr: string;
  cleanupError?: string;
}

/**
 * What a harness declares about itself, so the core prepares its runs from data instead of
 * branching on the runner type. The harness's own launch (command line, shell confinement,
 * control-plane proxy) stays inside its plugin, which picks it from src/isolation.
 */
export interface HarnessProfile {
  /** The harness's name in messages to the operator, such as "Codex". */
  readonly name: string;
  /** Hosts the harness process itself reaches when egress is enforced and the runner names no `controlPlaneHosts`. */
  readonly controlPlaneHosts: readonly string[];
  /** Service environment variables that carry the harness's own login and state: kept for the harness process, never for the agent's commands. */
  readonly controlPlaneEnvironment: readonly string[];
  /** The variable that points the harness at the runner's `configDir` (its login and sessions), or null when it takes none. */
  readonly configDirectoryVariable: string | null;
  /**
   * Where a run's sandbox mode and approvals come from: `runner` uses the runner's `sandbox` and
   * `automaticApprovals` settings (a read-only agent stays read-only); `access` derives the mode from
   * the agent's access alone (workspace-write or read-only) and never approves automatically.
   */
  readonly sandbox: "runner" | "access";
  /** Whether an agent may withhold the shell (`shell: false`); a harness that reaches files only through its shell never gets the field. */
  readonly optionalShell: boolean;
  /** Whether it can run a confined agent (`access: confined`: only a fresh scratch filesystem). */
  readonly confinedAccess: boolean;
  /**
   * Whether a workspace-write agent needs `network: true`: the harness process needs the network for
   * its own API calls, and its commands cannot yet be cut off from it.
   */
  readonly workspaceWriteNeedsNetwork: boolean;
  /**
   * Lines the agent's tool guidance adds about how this harness shows Conveyor's tools to the agent
   * (such as the names they are called by), given the granted canonical names; absent: none.
   */
  readonly toolNameGuidance?: ToolNameGuidance;
}

/** What a harness's quota reader may read about the runner it reports for. */
export interface HarnessQuotaInput {
  /** The stored harness events of the agents that use the runner; read only when asked for. */
  harnessEvents(): readonly { payload: unknown; createdAt: string }[];
}

export interface Harness {
  id: string;
  capabilities: HarnessCapabilities;
  profile: HarnessProfile;
  /** The remaining usage of a runner of this harness, shown on the dashboard; absent when the harness reports none. */
  quota?(input: HarnessQuotaInput): QuotaWindows;
  run(input: HarnessRunInput & HarnessResumeInput): Promise<RunEnvelope>;
  /** A legacy stage's producer turn, whose session is not kept; absent when the harness runs no legacy stages. */
  runEphemeral?(input: HarnessRunInput): Promise<RunEnvelope>;
  /** A legacy verifier check; absent when the harness runs no legacy checks. */
  check?(input: CheckRunInput): Promise<CheckRunResult>;
  /** An Operator (steering) run; absent when the harness cannot run the Operator. */
  steer?(input: SteeringRunInput): Promise<SteeringRunResult>;
}

export type { HarnessCapabilities, HarnessResumeInput };
