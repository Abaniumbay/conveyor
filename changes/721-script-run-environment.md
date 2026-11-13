---
section: Changed
breaking: true
---
Script runs (`script.run` steps, legacy script stages and legacy check scripts) no longer inherit the service's whole environment. A script now gets the root's, the repository's, the stage's and its step's `settings.environment` (the step's under `with: { settings: { environment } }`), the service's `HOME` and `TMPDIR`, and `CONVEYOR_RUN_ID`, `CONVEYOR_REPOSITORY_ID`, `CONVEYOR_ITEM_ID` and `CONVEYOR_STAGE_ID`. Before upgrading, check what your scripts read from the environment: a variable outside the root default (`USER`, `LOGNAME`, `PATH`, `TERM`, `COLORTERM`, `LANG`, `LC_ALL` and the proxy variables), such as `SSH_AUTH_SOCK`, `XDG_RUNTIME_DIR`, a token or a deploy setting, must be listed at one of those levels, with an empty value to take the service's.
