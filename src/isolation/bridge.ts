// Runs INSIDE the sandbox's network namespace: forwards loopback ports to Unix sockets, then runs
// the wrapped command and mirrors its exit. Started as `conveyor __bridge '<{"forwards":[{port,socket}],"command":[...]}>'`.
import net from "node:net";

interface Spec {
  forwards: Array<{ port: number; socket: string }>;
  command: string[];
}

function forward(port: number, socketPath: string): Promise<net.Server> {
  const server = net.createServer((client) => {
    const upstream = net.connect(socketPath);
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

async function bridge(argument: string | undefined): Promise<number> {
  const spec = JSON.parse(argument ?? "") as Spec;
  await Promise.all(spec.forwards.map((entry) => forward(entry.port, entry.socket)));
  const child = Bun.spawn(spec.command, { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => child.kill(signal));
  const code = await child.exited;
  return child.signalCode ? 128 + (({ SIGTERM: 15, SIGINT: 2, SIGHUP: 1, SIGKILL: 9 } as Record<string, number>)[child.signalCode] ?? 1) : code;
}

/** Runs the bridge and exits with the wrapped command's status (125 when the bridge itself fails). */
export async function runBridge(argument: string | undefined): Promise<never> {
  try {
    process.exit(await bridge(argument));
  } catch (error) {
    console.error(`sandbox bridge failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(125);
  }
}
