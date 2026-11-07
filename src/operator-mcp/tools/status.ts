import { z } from "zod";

import { defineOperatorTool } from "../tool";

export const conveyorStatus = defineOperatorTool({
  name: "conveyor_status",
  description: "Report the running Conveyor service's status: version, readiness, draining, runners, active work, stopped items and open questions.",
  inputSchema: z.object({}).strict(),
  handler: ({ facade }) => facade.status(),
});
