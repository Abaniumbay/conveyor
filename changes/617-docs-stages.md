---
section: Changed
---

The documentation and the example configuration describe the installation stage list, `overrides.stages.<stageId>` and `skip: true`; `pipelines:` is described only in "Migrating from pipelines" in `docs/configuration.md`. `examples/config/pipelines.yaml` is replaced by `stages.yaml`, `builtin:pipelines.yaml` is gone, and `conveyor init` now writes `stages: !include builtin:stages.yaml`.
