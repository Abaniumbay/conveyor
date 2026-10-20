// The dashboard application's script. A release embeds it (the HTML entry makes `bun build
// --compile` bundle it); a source checkout builds it on first use.

import path from "node:path";

import app from "./app/index.html";

export interface DashboardAppBundle {
  js: string;
  /** Changes with the script, so the browser can cache each version for good. */
  version: string;
}

let pending: Promise<DashboardAppBundle> | null = null;

export function dashboardAppBundle(): Promise<DashboardAppBundle> {
  pending ??= load().catch((error: unknown) => {
    pending = null;
    throw error;
  });
  return pending;
}

async function load(): Promise<DashboardAppBundle> {
  const embedded = app.files?.find((file) => file.loader === "js" && file.isEntry) ?? app.files?.find((file) => file.loader === "js");
  let js: string;
  if (embedded) js = await Bun.file(embedded.path).text();
  else {
    const result = await Bun.build({
      entrypoints: [path.join(import.meta.dir, "app", "main.tsx")],
      target: "browser",
      format: "esm",
      minify: true,
    });
    const output = result.outputs.find((file) => file.kind === "entry-point");
    if (!result.success || !output) throw new AggregateError(result.logs, "the dashboard application did not build");
    js = await output.text();
  }
  return { js, version: Bun.hash(js).toString(36) };
}
