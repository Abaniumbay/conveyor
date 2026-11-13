import type { HarnessProfile } from "../../harness/types";
import { CODEX_CONTROL_PLANE } from "./home";
import { CODEX_CONTROL_PLANE_HOSTS } from "./launch";
import { codexToolNameGuidance } from "./guidance";

/**
 * Codex runs with the runner's sandbox and approvals, reaches files only through its shell and can
 * run confined agents; its agents call Conveyor's tools by normalized names in code execution. Its
 * login stays in its own home (`CODEX_HOME`), copied privately for each run.
 */
export const codexProfile: HarnessProfile = {
  name: "Codex",
  controlPlaneHosts: CODEX_CONTROL_PLANE_HOSTS,
  controlPlaneEnvironment: CODEX_CONTROL_PLANE,
  configDirectoryVariable: null,
  sandbox: "runner",
  optionalShell: false,
  confinedAccess: true,
  workspaceWriteNeedsNetwork: false,
  toolNameGuidance: codexToolNameGuidance,
};
