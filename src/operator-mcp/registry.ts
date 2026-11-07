// The single list of operator MCP tools. A tool module is registered with one line here.

import { conveyorStatus } from "./tools/status";
import type { OperatorTool } from "./tool";

export const OPERATOR_TOOLS: readonly OperatorTool[] = [
  conveyorStatus,
];
