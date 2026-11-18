---
section: Changed
---
Codex runs with a sandbox network no longer hold the real login. Codex is pointed at the credential relay through its `openai_base_url` setting and holds only a per-run placeholder; the host reads the real ChatGPT or API-key login for every request and refreshes an expired ChatGPT token itself. A login that cannot be routed (an unrecognised record, or a run without a network policy) keeps today's readable private copy, and the run logs a warning that says so.
