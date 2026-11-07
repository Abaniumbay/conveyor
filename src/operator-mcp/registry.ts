// The single list of operator MCP tools. A tool module is registered with one line here.

import { itemPause, itemResume, itemRetry, itemSteer, questionAnswer } from "./tools/control";
import { conveyorStatus } from "./tools/status";
import type { OperatorTool } from "./tool";

export const OPERATOR_TOOLS: readonly OperatorTool[] = [
  conveyorStatus,
  itemRetry,
  itemSteer,
  itemPause,
  itemResume,
  questionAnswer,
];
