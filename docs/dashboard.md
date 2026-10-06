# Dashboard

The dashboard is where you watch and steer delivery: the board, each item's story, the agents, reports and the operator. It is served by `conveyor serve` (default `http://127.0.0.1:7788`) and needs a signed-in account (`conveyor init` creates the first).

The board shows backlog, configured stages, completed work, active runner capacity, dependency/child relationships, warnings, questions, and per-stage usage (tokens in and out, plus the dollar amount when the harness reports one; subscription harnesses do not). Issue dialogs separate four concerns:

- **Summary** — current state, relationships, criteria, labels, token usage (and cost when known), and duration.
- **Conversation** — concise owner and agent handoff messages that survive future runs.
- **Journey** — stage transitions, corrections, stops, and their reasons.
- **Technical logs** — paginated raw run events for debugging.

Above the board, every configured agent links to a read-only profile page (`/agents/<id>`; `/agents` lists them all) showing its harness, model, effort, workspace access, the pipeline stages it works in, its granted tools, and its instructions.

**Reports** (`/reports`, drill into one repository with `/reports/<repository>`, filter with `?period=7d|30d|90d|12m`, all time by default) show delivery, usage and time: items delivered and in progress, runs (and how many did not succeed), tokens and their cached share, agent time, and per delivered item the average tokens, runs, lead time (enrolled to done), returns and first-pass rate. It breaks an item's lead time into agents working, waiting on CI and checks, waiting for you (stopped) and queued, and shows tokens and agent time per stage, per repository and per month. A repository's page lists its items with the same figures, each linking to the item. An item counts as delivered when it finishes its last stage; done items imported without that record are left out and counted in a note.

The optional steering agent is intentionally quieter than the technical log. Only explicit MCP progress and the final report are shown; commands, tool calls, raw output, and private reasoning are not rendered.

![Conveyor user-facing agent progress](screenshots/agent-progress.png)

## Browser push notifications

Serve the dashboard over HTTPS (a reverse proxy can provide TLS), then configure `web.push` with a VAPID public/private key pair and an `https:` or `mailto:` contact subject. Generate a pair with `bunx web-push generate-vapid-keys`, and keep the private key in `secrets.yaml`. Restart Conveyor after changing the keys. Without all three values, the dashboard still works and shows push as unavailable.

Signed-in users can opt in separately to new questions, newly stopped issues, and issues reaching done from **Notifications** in the dashboard. Every category starts off. Enabling a category asks the browser for notification permission and registers that browser; users can turn categories off at any time, and turning all of them off or signing out removes that browser's server-side subscription. Push requires HTTPS, service workers, the Push API, and the Notifications API. Browsers that do not implement those APIs, or that restrict push for installed web apps, cannot receive alerts; the settings page reports unsupported or denied permission states.
