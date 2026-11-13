import { runPi } from "./pi";
import { piProfile } from "./profile";
import type { Harness } from "../../harness/types";

/** pi as a harness (agent runs only). Sessions persist in the service's agent directory so `--session` can continue them. */
export const piHarness: Harness = {
  id: "pi",
  capabilities: { sessionResume: true },
  profile: piProfile,
  run: ({ answeredQuestion: _answeredQuestion, ...input }) => runPi(input),
};
