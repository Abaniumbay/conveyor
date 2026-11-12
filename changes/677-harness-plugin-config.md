---
section: Changed
---
Harness settings are now defined by the harness plugin a runner's `type` names: the Codex runner's `command`, `sandbox`, `automaticApprovals` and `controlPlaneHosts`, and the Claude Code runner's `command`, `configDir` and `controlPlaneHosts`, are validated by those plugins when the configuration loads, and the plugins decide which agents a harness can run. Existing configurations load unchanged and keep their configuration hash. A runner `type` that no harness provides is now reported as `no harness plugin provides type "…"` with the types this build knows.
