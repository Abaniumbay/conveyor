import { runCodex } from "../runner/codex";
import type { Harness } from "./types";

/** Codex as a harness. Sessions are persisted so `codex exec resume <SESSION_ID>` can continue them. */
export const codexHarness: Harness = {
  id: "codex",
  capabilities: { sessionResume: true },
  run: ({ answeredQuestion: _answeredQuestion, ...input }) => runCodex({ ...input, persistSession: true }),
};
