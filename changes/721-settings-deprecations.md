---
section: Deprecated
---
An agent's `env` is now its `settings.environment`, an agent's `harnessSettings` (and the older `codexConfig`) are now the harness keys of its `settings`, and a pi runner's `credentialVariables` is now its harness entry's `settings.environment` (names with empty values). The old names keep working, with a warning from `config check`, `doctor` and the service log. A harness entry's `settings` also hold harness keys every agent of that harness inherits, such as Codex's `model_auto_compact_token_limit`.
