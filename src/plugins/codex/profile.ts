import type { HarnessProfile } from "../../harness/types";
import { CODEX_CONTROL_PLANE } from "../../isolation/environment";
import { CODEX_CONTROL_PLANE_HOSTS } from "../../isolation/run-network";

/**
 * Codex runs with the runner's sandbox and approvals, reaches files only through its shell, takes
 * extra settings and can run confined agents. Its login stays in its own home (`CODEX_HOME`), copied
 * privately for each run.
 */
export const codexProfile: HarnessProfile = {
  name: "Codex",
  controlPlaneHosts: CODEX_CONTROL_PLANE_HOSTS,
  controlPlaneEnvironment: CODEX_CONTROL_PLANE,
  configDirectoryVariable: null,
  sandbox: "runner",
  optionalShell: false,
  extraSettings: true,
  confinedAccess: true,
  workspaceWriteNeedsNetwork: false,
};
