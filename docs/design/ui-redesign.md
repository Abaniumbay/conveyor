# Dashboard redesign: the line control board

Plan for making Conveyor's dashboard elegant and modern without losing any feature. Written from an audit of the live dashboard on 2026-10-01 (desktop 1440×900 and phone 390×844, real board data).

## Subject, audience, job

- **Subject:** an autonomous delivery line. Issues move station by station (refinement → implementation → … → cleanup), worked by named AI agents.
- **Audience:** one technical owner, checking in a few times a day, often on a phone.
- **Primary job:** see in one glance what is moving, what has stopped and why, and what needs the owner. Then open one item and act: answer, message, retry.

## Audit findings

### Broken or wrong (fix regardless of style)

1. **Live updates drop every ~25 s.** The status pill flips to "Reconnecting", and the browser logs `ERR_INCOMPLETE_CHUNKED_ENCODING` on `/events/dashboard`. The journal shows `Bun.serve() timed out a request after 10 seconds`: Bun's default `idleTimeout` (10 s) kills the event stream between messages. Send an SSE comment heartbeat (`: ping\n\n`) at least every 5 s, or set `idleTimeout` for that route.
2. **Stage headers overlap.** In stage column headers, the usage text ("585M in (564M cached) · 1.8M out · 331 runs") is drawn over the stage name.
3. **Stage names come from ids.** `ci` renders as "Ci". Known acronyms need casing; better, let a stage carry a display name.
4. **Acceptance criteria missing.** An example issue has a full checklist in its issue body, but the summary says "No acceptance criteria recorded." Only Conveyor's managed criteria section is parsed. Fall back to `- [ ]` / `- [x]` items under an "Acceptance criteria" heading.
5. **Steering reports show raw Markdown.** `**not**` and backticks appear literally. Render a safe Markdown subset: emphasis, code, lists, links. Apply the same to conversation messages.
6. **The login page has no favicon link**, so browsers request `/favicon.ico` and get a 404.
7. **Stale labels:**
   - The issue summary row says "Cost" but now shows tokens. Rename it "Usage".
   - "Board 254" counts finished items. Count only items that are not done.
8. **Misplaced roll-up.** Roll-up parent #192 is finished but still listed under Implementation's "Roll-up parents". A finished parent belongs in Done.

### Design problems

- **The page has no hierarchy.**
  - Header, agent pills, tabs, a runner strip and nine equal columns all compete.
  - On a phone, the first screen is header and agent pills, then an empty Backlog column.
- **Space goes to empty stations.**
  - Every stage column has the same width whether it holds 0 or 9 items.
  - All live work sits in one column, while merge, deploy, verify, cleanup and done are off-screen to the right.
- **Cards are dominated by finished dependencies.** A card lists every blocker, mostly struck through as already done (#161's card is ~70% strikethrough). The useful fact, what it is waiting on now, is buried.
- **State is told several ways at once:** left border colour, pill, "Activity: implementation · ready" text and a dot. None of them is the obvious one.
- **Template chrome:**
  - ALL-CAPS eyebrows ("CONVEYOR" above "Conveyor", "ROLL-UP PARENTS", "ISSUES", "AGENTS");
  - meta strings joined with middle dots everywhere;
  - the same rounded card with the same soft shadow for every container.
- **The item dialog is a 690 px modal.** The conversation, the most-read surface, gets a narrow scrolling box, and short summaries leave half the dialog empty.
- **Unclear naming.** The "Agent" tab (the steering operator) and the "Agents" strip (profiles) are easy to confuse.

## Design direction: the line

Conveyor *is* a production line, so the dashboard reads like the control board of one. Stations sit along a track, each with an andon light that says whether it runs, waits or has stopped.

### Tokens

| Token | Value | Use |
|---|---|---|
| `--concrete` | `#E8EBE8` | page background (cool, slightly green concrete; not cream) |
| `--panel` | `#F8F9F7` | station and inspector surfaces |
| `--ink` | `#1C2328` | text |
| `--steel` | `#5D6970` | secondary text, rules |
| `--run` | `#1E8A5A` | andon green: running or passing |
| `--wait` | `#B8720E` | andon amber: queued, waiting on CI or a dependency, backing off |
| `--stop` | `#BD3B26` | andon red: blocked, error, needs input or intervention |
| `--signal` | `#2A5BD7` | the one interactive accent: links, primary buttons, focus ring |

- Andon colours are used **only** for state, never for decoration.
- Dark mode is out of scope; keep `color-scheme: light`.

### Type

- **IBM Plex Sans** for everything (400, 500, 600). It has industrial heritage and good tabular numerals. Self-host it from `@fontsource/ibm-plex-sans`; the app serves its own assets and loads no external CDN.
- **IBM Plex Mono** only inside technical logs and for commit SHAs.
- **Scale:** 13 / 15 / 18 / 24 / 32 px. Body 15 px with 1.5 line height. Numbers in counts and usage use `font-variant-numeric: tabular-nums`.
- **Sentence case everywhere.** No all-caps labels and no letter-spaced eyebrows.

### Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Conveyor   ● live   1 of 4 runners   664M in · 2.2M out      Agents ▾  Sign out │  header: one row
├──────────────────────────────────────────────────────────────────────────────┤
│  THE LINE                                                                    │
│  Backlog ─ Refinement ─ Implementation ━━━━━━━ CI ─ Review ─ Merge ─ … ─ Done │  stations on one track
│    0          0              9  ●●○ ▲2            0     0       0        47    │  count + andon lights
├──────────────────────────────────────────────────────────────────────────────┤
│ Needs you (3)                                                                │  only when non-empty
│  ▲ #161 Live duels — plumbing…   blocked · Mitra wants local Flutter evidence  [Open] │
│  ? #157 asks: Accept a near-win board for the 2048 test?          [Answer]        │
├──────────────────────────────────────────────────────────────────────────────┤
│ Implementation (9)                     │ Refinement │ CI │ Review │ …          │  board: busy stations wide,
│ ┌ #157 Async duels for Minesweeper…  ┐ │     0      │ 0  │   0    │            │  empty stations collapse to
│ │ ● working · Kaveh · 3 h 4 m        │ │            │    │        │            │  narrow labelled rails
│ │ waiting on —                       │ │            │    │        │            │
│ └────────────────────────────────────┘ │            │    │        │            │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **The line is the hero, and the one bold element.**
  - A single horizontal track across the top, with each station as a node: its name, its count, and up to three andon dots for its items' states.
  - The station holding a running item shows a slowly moving belt texture on its track segment. This is the page's only ambient motion; it is disabled under `prefers-reduced-motion`.
  - Clicking a station scrolls the board to that column.
  - On phones the line becomes a compact vertical list of stations with counts, and it is the first thing on screen.
- **"Needs you" panel.**
  - Lists open questions and stopped items, each with its reason in plain words and the one action that clears it.
  - It replaces the scattered question block, is hidden when empty, and links to the item.
- **Board.**
  - Kanban columns stay, including backlog drag-to-reorder, pagination, Done and roll-up grouping.
  - A column with no items collapses to a narrow vertical rail showing its name and "0". Columns with items share the remaining width.
- **Card.**
  - Shows the id and title, then **one** status line: an andon dot, the state in words, the agent working on it or the reason it stopped, and how long it has been in that state.
  - Dependencies show only what the item is still waiting on: "waiting on #161". Finished ones move to the inspector.
  - Roll-up parents get a "Roll-up · 5 children, 2 done" line in place of a different card colour.
- **Inspector replaces the modal dialog.**
  - A right-side panel, full height and about 560 px wide, so the board stays visible on desktop. On phones it is full screen.
  - Same four tabs (Summary, Conversation, Journey, Technical logs), with the same deep links (`?issue=`, `?tab=`).
  - The conversation fills the panel height, and the composer is pinned to the bottom.
- **Header.**
  - One row: wordmark, connection state, runner capacity, total usage, an "Agents" menu (profiles) and Sign out.
  - Server metrics (memory, disk, uptime) move into a popover on the connection indicator.
  - The "Agent" tab is renamed **"Operator"**, after the steering agent's role.
- **Agent profile pages** get the same tokens and header. Each profile shows its stations on a miniature of the line.

### Principles

1. **One visual answer per question.** State is shown by the andon colour plus a word; there are no extra pills, borders or "Activity:" prefixes saying the same thing.
2. **Show what matters now; put history in the inspector.** That covers finished dependencies, past runs and old CI.
3. **Width follows work.** Empty stations take no space.
4. **Plain words.** "Waiting on CI for 7c0ea55", not "ci · active · ready".
5. **Quality floor:**
   - keyboard focus visible (`--signal` ring);
   - every action reachable by keyboard, with drag-reorder keeping its up/down buttons;
   - WCAG AA contrast;
   - works from 360 px wide;
   - `prefers-reduced-motion` honoured.

## Features that must survive (checklist)

- Login and logout; session, CSRF and the same-origin rules are unchanged.
- **Board and backlog:**
  - stage columns, Backlog and Done;
  - backlog drag-to-reorder and up/down buttons (`/backlog/move`);
  - per-column pagination;
  - roll-up parent grouping;
  - working-now highlight.
- **Views:** the "Label problems" view for invalid labels; the steering Operator view (compose, live event stream, recent runs, `?view=agent&run=`).
- **Live state:** questions with their answer forms, the active-work and runner capacity display, and the live server status (SSE `status` events). Live refresh keeps its revisions: dashboard, conversation, activity.
- **Issue inspector:**
  - Summary covers relationships, criteria, labels, usage and duration.
  - Conversation can be read and posted to.
  - Journey shows the stage history.
  - Technical logs are paginated and have "load more".
  - Deep links and browser back/forward (`popstate`) keep working.
- **Agents:** the `/agents` list, `/agents/:id` profiles and the dashboard agent list.
- **API routes:** findings dismissal (`POST /api/issues/:id/findings/:fid/dismiss`) and every existing `/api/*` route keep their behaviour.
- **Client hooks:** all `data-*` hooks used by `src/web/client.ts` either keep working or are renamed together with the client.
- **Tests:**
  - Every test under `tests/web/` and `tests/app/dashboard.test.ts` passes.
  - Tests may be updated only where markup changed, and never to drop a behaviour check.

## Implementation notes

- **Files:** `src/web/styles.ts`, `src/web/render.tsx`, `src/web/agent-pages.tsx`, `src/web/client.ts` and `src/web/server.ts` (SSE heartbeat, font asset routes, favicon). Add `src/web/markdown.ts` for safe Markdown rendering: escape first, then a whitelist; no raw HTML.
- **No new framework.** Keep Preact server rendering, the existing client script and plain CSS with custom properties. Fonts come from `@fontsource/ibm-plex-sans` and `@fontsource/ibm-plex-mono` (woff2 only), served by the app with a long cache.
- **Order of work:**
  1. Fix the broken items (findings 1–8), each with a test.
  2. Add the tokens and type.
  3. Header and the line.
  4. Needs you.
  5. Board, collapsing columns and the new card.
  6. The inspector.
  7. Operator view and agent pages.
  8. Phone layout.
  9. Screenshots at 1440×900 and 390×844 for the PR.
- **Gate:** `bun test` and `bunx tsc --noEmit` pass after every step.

## Follow-up: a generic waiting status

Owner request (2026-10-01): waiting must be visible. Today a parked item shows only "Activity: implementation · ready"; its wait reason is shown on the card only when the item stopped, and in the dialog as "Source note".

Any pending task produces the same record: the pending message, `pending_since`, `wake_at` and `deadline_at` on the stage cursor and execution (`src/engine/journal.ts`). Show it generically, with no special case per kind of wait (CI, dependency, mergeability, a timed retry or backoff, an external webhook):

- **View model:** `waiting: { reason, since, nextCheckAt, deadline } | null` for every parked item, built from the journal (`pendingMessage`, cursor times). The infrastructure retry backoff ("will retry in …") uses the same shape.
- **Card:** an amber andon and one line: the reason in plain words, then "for 12 min · next check 14:53 · gives up 22:48". Times are local; "gives up" is omitted when there is no deadline.
- **Inspector Summary:** the same, plus the stage and task instance waiting (for example "implementation › ciGate").
- **The line:** each station counts its waiting items under the amber light, separate from running (green) and stopped (red).
- **Waits on the owner** (an agent's open question) go to "Needs you" instead.

## Follow-up: the journey shows "now"

Owner report (2026-10-01): an item's journey ended with "Implementation stopped" while the item was active again. The engine now records `resumed` and `restarted` entries (PR #41). The journey also opens with a "Now" line, built from the item's current state rather than the history: the stage, the state (running, waiting with its reason, stopped with its reason) and since when. History entries below it stay in time order.
