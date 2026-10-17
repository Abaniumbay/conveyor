---
section: Added
---
Every change Conveyor makes is recorded in an event log ([events.md](docs/events.md)). `conveyor
events` prints it (`--issue`, `--type`, `--correlation`, `--since`, `--follow`), every dashboard
and CLI action shares one correlation id with the changes it caused, and `settings.events.sinks`
delivers the log to a JSON-lines file for an external analyzer. Events are kept for
`settings.events.retention` (30 days) and pruned by `conveyor cleanup`.
