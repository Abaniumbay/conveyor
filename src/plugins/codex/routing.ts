// Decides how a Codex run authenticates. A login Conveyor can route stays on the host: the harness
// is pointed at the credential relay through Codex's `openai_base_url` setting, which carries both
// the ChatGPT backend and the API calls, and holds only a per-run placeholder. Token refresh
// happens on the host (credential-source.ts). Anything else keeps a private copy of the login and
// the run says so.

import { stat } from "node:fs/promises";
import path from "node:path";

import type { CredentialRelayPolicy, EgressInput } from "../../isolation/run-network";
import { codexCredentialSource, jwtClaims, parseRecord, type CodexLoginMode } from "./credential-source";
import { log } from "../../log/logger";
import { prepareCodexEnvironment, readRegularFile, serviceCodexHome } from "./home";

export const CHATGPT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
export const API_UPSTREAM = "https://api.openai.com/v1";
/** Variables Codex reads an API key from; a routed run holds the placeholder under each name it was given. */
export const API_KEY_VARIABLES = ["CODEX_API_KEY", "OPENAI_API_KEY"] as const;

/** Test seams: where the host forwards to and refreshes against, and the trust anchor for both. */
export interface CodexRoutingSeams {
  chatgptUpstream?: string;
  apiUpstream?: string;
  tokenUrl?: string;
  ca?: string | Buffer;
}

export type CodexRoute =
  | {
      routed: true;
      mode: CodexLoginMode | "environment";
      policy: CredentialRelayPolicy;
      /** The record the run's home gets in place of the login, for a given placeholder; absent: no record. */
      sandboxRecord?: (placeholder: string) => string;
      /** Variables of the run's environment that hold the placeholder instead of a real key. */
      placeholderVariables: string[];
    }
  | { routed: false; reason: string; /** Whether the run's commands can read a real login. */ exposed: boolean };

const FAR_FUTURE_SECONDS = 4_102_444_800; // 2100-01-01

function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part(claims)}.${part("relay")}`;
}

/** What Codex reads of the ChatGPT login besides tokens: a stub identity, never the real id token. */
function chatgptSandboxRecord(record: Record<string, unknown>, placeholder: string): string {
  const tokens = record.tokens as Record<string, unknown>;
  const auth = jwtClaims(typeof tokens.id_token === "string" ? tokens.id_token : "")?.["https://api.openai.com/auth"];
  const identity = typeof auth === "object" && auth !== null ? (auth as Record<string, unknown>) : {};
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : identity.chatgpt_account_id;
  const claims = {
    exp: FAR_FUTURE_SECONDS,
    "https://api.openai.com/auth": {
      ...(typeof accountId === "string" ? { chatgpt_account_id: accountId } : {}),
      ...(typeof identity.chatgpt_plan_type === "string" ? { chatgpt_plan_type: identity.chatgpt_plan_type } : {}),
    },
  };
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: unsignedJwt(claims),
      access_token: placeholder,
      // Not a working token: the host refreshes, and the run is never given the means to.
      refresh_token: "conveyor-relay-no-refresh",
      ...(typeof accountId === "string" ? { account_id: accountId } : {}),
    },
    last_refresh: new Date().toISOString(),
  });
}

/**
 * The route a run takes. Needs the run's network to host the relay (`egress`); without it, or for a
 * login whose shape is not recognised, the run keeps today's private copy and `exposed` is true.
 */
export async function planCodexRoute(options: {
  serviceHome: string;
  variables?: Record<string, string> | undefined;
  egress: EgressInput | undefined;
  seams?: CodexRoutingSeams | undefined;
}): Promise<CodexRoute> {
  const { seams } = options;
  const common = { ...(seams?.ca ? { ca: seams.ca } : {}) };
  const content = await readRegularFile(path.join(options.serviceHome, "auth.json")).catch(() => undefined);
  const record = parseRecord(content);
  // What an unrouted run would put in front of its commands: any file at auth.json (the private copy
  // follows symlinks, so a symlinked record counts) and any key variable the harness is given.
  const recordPresent = await stat(path.join(options.serviceHome, "auth.json")).then(() => true, () => false);
  const environmentKey = API_KEY_VARIABLES.map((name) => options.variables?.[name]).find((value) => value);
  const exposed = recordPresent || Boolean(environmentKey);
  if (!options.egress) return { routed: false, exposed, reason: "the run has no sandbox network (no agentEgress) to host the credential relay" };

  if (environmentKey) {
    return {
      routed: true,
      mode: "environment",
      policy: { upstream: seams?.apiUpstream ?? API_UPSTREAM, credential: () => environmentKey, ...common },
      placeholderVariables: API_KEY_VARIABLES.filter((name) => options.variables?.[name]),
    };
  }
  if (!recordPresent) return { routed: false, exposed: false, reason: "no Codex login is configured" };

  const tokens = record?.tokens;
  const hasTokens = typeof tokens === "object" && tokens !== null && !Array.isArray(tokens);
  const accessToken = hasTokens ? (tokens as Record<string, unknown>).access_token : undefined;
  const refreshToken = hasTokens ? (tokens as Record<string, unknown>).refresh_token : undefined;
  const mode = record?.auth_mode;
  if (record && (mode === "chatgpt" || mode === undefined) && typeof accessToken === "string" && accessToken && typeof refreshToken === "string" && refreshToken) {
    return {
      routed: true,
      mode: "chatgpt",
      policy: {
        upstream: seams?.chatgptUpstream ?? CHATGPT_UPSTREAM,
        credential: codexCredentialSource({ serviceHome: options.serviceHome, mode: "chatgpt", tokenUrl: seams?.tokenUrl, ca: seams?.ca }),
        ...common,
      },
      sandboxRecord: (placeholder) => chatgptSandboxRecord(record, placeholder),
      placeholderVariables: [],
    };
  }
  if (record && (mode === "apikey" || (mode === undefined && !hasTokens)) && typeof record.OPENAI_API_KEY === "string" && record.OPENAI_API_KEY) {
    return {
      routed: true,
      mode: "apikey",
      policy: {
        upstream: seams?.apiUpstream ?? API_UPSTREAM,
        credential: codexCredentialSource({ serviceHome: options.serviceHome, mode: "apikey" }),
        ...common,
      },
      sandboxRecord: (placeholder) => JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: placeholder }),
      placeholderVariables: [],
    };
  }
  return { routed: false, exposed: true, reason: record ? `the login record has an unsupported shape (auth_mode ${JSON.stringify(typeof mode === "string" ? mode : null)})` : "the login record is not a readable JSON object" };
}

/**
 * Plans the route and prepares the run's environment: the one place every Codex entry point (run,
 * check, steering) sets up its authentication, so none is left unrouted without saying so.
 */
export async function prepareCodexRun(options: {
  artifactsDirectory: string;
  workspace: string;
  variables?: Record<string, string> | undefined;
  egress: EgressInput | undefined;
  seams?: CodexRoutingSeams | undefined;
  resumeSessionId?: string | undefined;
}): Promise<{ route: CodexRoute; environment: Record<string, string>; promoteAuth: boolean }> {
  const route = await planCodexRoute({ serviceHome: serviceCodexHome(options.variables), variables: options.variables, egress: options.egress, seams: options.seams });
  if (!route.routed && route.exposed) {
    log.warn("Codex login is not routed through the credential relay and stays readable by the run's commands", { artifactsDirectory: options.artifactsDirectory, reason: route.reason });
  }
  const prepared = await prepareCodexEnvironment({
    artifactsDirectory: options.artifactsDirectory,
    workspace: options.workspace,
    variables: options.variables,
    resumeSessionId: options.resumeSessionId,
    routed: route.routed,
  });
  const environment = route.routed ? Object.fromEntries(Object.entries(prepared).filter(([name]) => !route.placeholderVariables.includes(name))) : prepared;
  return { route, environment, promoteAuth: !route.routed };
}
