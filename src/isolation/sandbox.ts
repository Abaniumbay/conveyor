import path from "node:path";

export const PROXY_VARIABLES = [
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "npm_config_https_proxy", "npm_config_proxy",
] as const;

export interface SandboxOptions {
  /** The command to run inside the network namespace. */
  argv: readonly string[];
  /** Its environment; proxy variables are added or replaced. */
  env: Record<string, string>;
  /** Unix socket of the data-plane (command) egress proxy. */
  dataProxySocket: string;
  /** Unix socket of the token-authenticated control-plane proxy; the wrapped command itself uses it. */
  controlProxySocket?: string;
  /** Required with `controlProxySocket`. */
  controlToken?: string;
  /** Forward this exact loopback port to the service's MCP-only Unix socket. */
  mcp?: { port: number; socket: string };
}

export interface SandboxedCommand {
  argv: string[];
  env: Record<string, string>;
  /** Proxy environment for commands the wrapped process runs (data-plane proxy). */
  dataEnv: Record<string, string>;
}

const BRIDGE = path.join(import.meta.dir, "bridge.ts");

function proxyEnvironment(proxy: string, mcp: boolean): Record<string, string> {
  const noProxy = mcp ? "127.0.0.1" : "";
  return {
    HTTPS_PROXY: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy,
    https_proxy: proxy, http_proxy: proxy, all_proxy: proxy,
    npm_config_https_proxy: proxy, npm_config_proxy: proxy,
    NO_PROXY: noProxy, no_proxy: noProxy,
  };
}

/**
 * Wraps a command in `bwrap --unshare-net`: the namespace has only a loopback, so the only way out
 * is the bridge, which forwards loopback ports to the per-run proxy Unix sockets (and, optionally,
 * the one MCP port) and then runs the command with the proxy environment set.
 */
export function sandboxCommand(options: SandboxOptions): SandboxedCommand {
  const taken = new Set<number>(options.mcp ? [options.mcp.port] : []);
  const freePort = (preferred: number): number => {
    let port = preferred;
    while (taken.has(port)) port += 2;
    taken.add(port);
    return port;
  };
  const dataPort = freePort(3128);
  const forwards = [{ port: dataPort, socket: options.dataProxySocket }];
  const dataEnv = proxyEnvironment(`http://127.0.0.1:${dataPort}`, Boolean(options.mcp));
  let commandEnv = dataEnv;
  if (options.controlProxySocket) {
    if (!options.controlToken) throw new Error("a control-plane proxy requires a token");
    const controlPort = freePort(3129);
    forwards.push({ port: controlPort, socket: options.controlProxySocket });
    const credentials = `conveyor:${encodeURIComponent(options.controlToken)}`;
    const control = `http://${credentials}@127.0.0.1:${controlPort}`;
    commandEnv = {
      ...proxyEnvironment(control, Boolean(options.mcp)),
      HTTP_PROXY: "", http_proxy: "", ALL_PROXY: "", all_proxy: "",
      npm_config_proxy: "", npm_config_https_proxy: "",
    };
  }
  if (options.mcp) forwards.push({ port: options.mcp.port, socket: options.mcp.socket });
  const spec = JSON.stringify({ forwards, command: options.argv });
  return {
    argv: ["bwrap", "--unshare-net", "--die-with-parent", "--dev-bind", "/", "/", "--", process.execPath, BRIDGE, spec],
    env: { ...options.env, ...commandEnv },
    dataEnv,
  };
}
