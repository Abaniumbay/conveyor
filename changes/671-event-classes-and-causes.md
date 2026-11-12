---
section: Added
---
Every event now has a class: `fact` (a change Conveyor recorded), `ingest` (what a plugin such as GitHub observed, for example a webhook delivery) or `trace` (what the service is doing). Two trace events show the service's own activity: `scheduler.decided` and `timer.fired`; traces are kept for a day. An event recorded in reaction to another names its cause, and `conveyor events --caused-by <seq>` follows the chain; `conveyor events --class` filters by class, and every line shows the class. Event sinks receive facts and observations by default; a sink can select traces with `classes` and events that may carry user-written text with `includeContent`.
