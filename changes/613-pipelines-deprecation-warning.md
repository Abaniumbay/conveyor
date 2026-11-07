---
section: Deprecated
---

`config check`, `doctor` and the service startup log now warn when a configuration uses `pipelines:` or a repository `pipeline:`. The warning names each file that uses them and points to `conveyor config migrate --stages`. It is only a warning: exit codes and behaviour do not change.
