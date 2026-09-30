import type { CheckResult } from "../core/pipeline";
import type { CodexRunnerSchema } from "../config/schema";
import {
  runCodex,
  type CodexMcpConfiguration,
} from "./codex";
import { runCodexCheck } from "./codex-check";
import { runCodexSteering } from "./codex-steering";
import type { RunEnvelope } from "./result";
import type { HarnessErrorKind } from "./harness-error";

export { HarnessError } from "./harness-error";
export type { HarnessErrorKind } from "./harness-error";

export interface McpServerConfiguration {
  command: string;
  args: string[];
}

type CodexEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export interface HarnessRunInput {
  workspace: string;
  artifactsDirectory: string;
  prompt: string;
  instructions: string;
  accessLevel: "read-only" | "workspace-write";
  mcp: McpServerConfiguration;
  model?: string;
  effort?: string;
  timeoutMs?: number;
  interruptGraceMs: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
}

export interface HarnessCheckInput extends HarnessRunInput {
  phase: "enter" | "exit";
}

export interface HarnessSteeringResult {
  summary: string;
  sessionId: string | null;
  usage: RunEnvelope["usage"];
  cost: RunEnvelope["cost"];
  durationMs: number;
  exitCode: number;
}

export interface HarnessCheckResult extends CheckResult {
  sessionId: string | null;
  usage: RunEnvelope["usage"];
  cost: RunEnvelope["cost"];
  durationMs: number;
  exitCode: number;
  stderr: string;
}

export interface AgentHarness {
  runProducer(input: HarnessRunInput): Promise<RunEnvelope>;
  runCheck(input: HarnessCheckInput): Promise<HarnessCheckResult>;
  runSteering(input: HarnessRunInput): Promise<HarnessSteeringResult>;
}

export type HarnessFactory = (configuration: unknown) => AgentHarness;

/**
 * Maps configured runner types to harnesses. The application only depends on
 * this registry and the neutral contract; runner-specific configuration stays
 * inside each registered factory.
 */
export class AgentHarnessRegistry {
  readonly #factories = new Map<string, HarnessFactory>();

  register(type: string, factory: HarnessFactory): this {
    if (!type.trim()) throw new Error("harness type must not be empty");
    this.#factories.set(type, factory);
    return this;
  }

  create(configuration: { type: string }): AgentHarness {
    const factory = this.#factories.get(configuration.type);
    if (!factory) throw new Error(`no agent harness registered for runner type "${configuration.type}"`);
    return factory(configuration);
  }
}

function codexPrompt(input: HarnessRunInput): string {
  return `${input.instructions.trim()}\n\n${input.prompt}`;
}

class CodexHarness implements AgentHarness {
  constructor(private readonly configuration: CodexRunnerSchema) {}

  runProducer(input: HarnessRunInput): Promise<RunEnvelope> {
    return runCodex({
      command: this.configuration.command,
      workspace: input.workspace,
      artifactsDirectory: input.artifactsDirectory,
      prompt: codexPrompt(input),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort as CodexEffort } : {}),
      sandbox: input.accessLevel === "read-only" ? "read-only" : this.configuration.sandbox,
      automaticApprovals: this.configuration.automaticApprovals,
      mcp: input.mcp as CodexMcpConfiguration,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      interruptGraceMs: input.interruptGraceMs,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });
  }

  async runCheck(input: HarnessCheckInput) {
    const result = await runCodexCheck({
      command: this.configuration.command,
      workspace: input.workspace,
      artifactsDirectory: input.artifactsDirectory,
      prompt: codexPrompt(input),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort as CodexEffort } : {}),
      sandbox: "read-only",
      automaticApprovals: false,
      mcp: input.mcp as CodexMcpConfiguration,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      interruptGraceMs: input.interruptGraceMs,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });
    return {
      ...result,
      cost: { amount: 0, currency: "USD", source: "unavailable" as const },
    };
  }

  async runSteering(input: HarnessRunInput): Promise<HarnessSteeringResult> {
    const result = await runCodexSteering({
      command: this.configuration.command,
      workspace: input.workspace,
      prompt: codexPrompt(input),
      ...(input.model ? { model: input.model } : {}),
      ...(input.effort ? { effort: input.effort as CodexEffort } : {}),
      sandbox: input.accessLevel === "read-only" ? "read-only" : this.configuration.sandbox,
      automaticApprovals: this.configuration.automaticApprovals,
      mcp: input.mcp as CodexMcpConfiguration,
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      interruptGraceMs: input.interruptGraceMs,
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    });
    return {
      summary: result.summary,
      sessionId: result.sessionId,
      usage: result.usage,
      cost: { amount: 0, currency: "USD", source: "unavailable" },
      durationMs: result.durationMs,
      exitCode: result.exitCode,
    };
  }
}

export function defaultHarnessRegistry(): AgentHarnessRegistry {
  return new AgentHarnessRegistry().register("codex", (configuration) =>
    new CodexHarness(configuration as CodexRunnerSchema));
}
