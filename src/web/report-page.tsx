// The Reports view: delivery, usage and time per repository, month, stage and item. Charts are plain
// HTML bars (one series, one hue each) with a focusable tooltip; every chart sits beside a table of
// the same numbers.

import type { ReportItemRow, ReportPeriod, ReportTotals, ReportViewModel } from "./types";

export const REPORT_PERIOD_VALUES: readonly ReportPeriod[] = ["7d", "30d", "90d", "12m", "all"];

const PERIOD_LABELS: Record<ReportPeriod, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "12m": "12 months", all: "All time" };

export function reportHref(repository: string | null, period: ReportPeriod): string {
  const base = repository ? `/reports/${encodeURIComponent(repository)}` : "/reports";
  return period === "all" ? base : `${base}?period=${period}`;
}

function issueHref(repository: string, number: number): string {
  return `/issues/${encodeURIComponent(repository)}/${number}`;
}

export function formatCompact(value: number): string {
  for (const [size, unit] of [[1e9, "B"], [1e6, "M"], [1e3, "K"]] as const) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${unit}`;
    }
  }
  return String(Math.round(value));
}

/** A duration at a glance: 45 s, 12 min, 3.4 h, 2.1 d. */
export function formatSpan(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  if (ms < 86_400_000) return `${(ms / 3_600_000).toFixed(1)} h`;
  return `${(ms / 86_400_000).toFixed(1)} d`;
}

const orDash = <T,>(value: T | null, format: (value: T) => string) => (value === null ? "–" : format(value));
const percent = (value: number) => `${Math.round(value * 100)}%`;
const tokensOf = (totals: Pick<ReportTotals, "inputTokens" | "outputTokens">) => totals.inputTokens + totals.outputTokens;

function Tile({ label, value, detail }: { label: string; value: string; detail?: string | undefined }) {
  return (
    <div class="report-tile">
      <dt>{label}</dt>
      <dd><span class="report-tile-value">{value}</span>{detail && <span class="report-tile-detail">{detail}</span>}</dd>
    </div>
  );
}

function Kpis({ totals }: { totals: ReportTotals }) {
  const tokens = tokensOf(totals);
  return (
    <dl class="report-kpis" aria-label="Headline figures">
      <Tile label="Items delivered" value={String(totals.delivered)} detail={`${totals.inProgress} in progress`} />
      <Tile label="Tokens" value={formatCompact(tokens)} detail={totals.inputTokens > 0 ? `${percent(totals.cachedTokens / totals.inputTokens)} of input cached` : undefined} />
      <Tile label="Runs" value={String(totals.runs)} detail={totals.failedRuns > 0 ? `${totals.failedRuns} did not succeed` : undefined} />
      <Tile label="Agent time" value={formatSpan(totals.agentMs)} />
      <Tile label="Tokens per item" value={orDash(totals.avgTokensPerItem, formatCompact)} detail={orDash(totals.avgRunsPerItem, (runs) => `${runs.toFixed(1)} runs`)} />
      <Tile label="Lead time per item" value={orDash(totals.avgLeadMs, formatSpan)} detail="enrolled to done" />
      <Tile label="Waiting for you per item" value={orDash(totals.avgWaitingForYouMs, formatSpan)} detail="while stopped" />
      <Tile label="First-pass rate" value={orDash(totals.firstPassRate, percent)} detail={orDash(totals.avgReturnsPerItem, (returns) => `${returns.toFixed(1)} returns per item`)} />
    </dl>
  );
}

interface Bar { label: string; value: number; display: string; tip?: string }

/** Horizontal bars, one series: label, bar, value at the tip. */
function BarChart({ title, caption, bars }: { title: string; caption?: string; bars: readonly Bar[] }) {
  const max = Math.max(...bars.map((bar) => bar.value), 0);
  return (
    <figure class="report-chart">
      <figcaption><strong>{title}</strong>{caption && <span>{caption}</span>}</figcaption>
      {bars.length === 0 || max === 0
        ? <p class="report-empty">Nothing recorded in this period.</p>
        : (
          <ol class="report-bars">
            {bars.map((bar) => (
              <li key={bar.label}>
                <span class="report-bar-label">{bar.label}</span>
                <span class="report-bar-track">
                  {bar.value > 0 && <span class="report-bar" style={`width:${Math.max(1, (bar.value / max) * 100)}%`} tabIndex={0} data-tip={bar.tip ?? `${bar.label}: ${bar.display}`} aria-label={bar.tip ?? `${bar.label}: ${bar.display}`} />}
                </span>
                <span class="report-bar-value">{bar.display}</span>
              </li>
            ))}
          </ol>
        )}
    </figure>
  );
}

/** Columns over time, one series, with three hairline gridlines and the value on each cap. */
function ColumnChart({ title, caption, columns, format }: { title: string; caption?: string; columns: readonly Bar[]; format: (value: number) => string }) {
  const max = Math.max(...columns.map((column) => column.value), 0);
  const ticks = max === 0 ? [] : [max, max / 2, 0];
  return (
    <figure class="report-chart">
      <figcaption><strong>{title}</strong>{caption && <span>{caption}</span>}</figcaption>
      {columns.length === 0 || max === 0
        ? <p class="report-empty">Nothing recorded in this period.</p>
        : (
          <div class="report-columns-frame">
            <ol class="report-ticks" aria-hidden="true">{ticks.map((tick) => <li key={tick}>{format(tick)}</li>)}</ol>
            <ol class="report-columns">
              {columns.map((column) => (
                <li key={column.label}>
                  <span class="report-column-plot">
                    {column.value > 0 && (
                      <span class="report-column" style={`height:${Math.max(1, (column.value / max) * 100)}%`} tabIndex={0} data-tip={column.tip ?? `${column.label}: ${column.display}`} aria-label={column.tip ?? `${column.label}: ${column.display}`}>
                        <span class="report-column-value">{column.display}</span>
                      </span>
                    )}
                  </span>
                  <span class="report-column-label">{column.label}</span>
                </li>
              ))}
            </ol>
          </div>
        )}
    </figure>
  );
}

function monthLabel(month: string): string {
  const [year, number] = month.split("-");
  const name = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(number) - 1] ?? month;
  return `${name} ${year}`;
}

function Filters({ report }: { report: ReportViewModel }) {
  return (
    <div class="report-filters">
      <nav aria-label="Period">
        {(Object.keys(PERIOD_LABELS) as ReportPeriod[]).map((period) => (
          <a key={period} href={reportHref(report.repository, period)} class={period === report.period ? "report-chip report-chip--active" : "report-chip"} aria-current={period === report.period ? "page" : undefined}>{PERIOD_LABELS[period]}</a>
        ))}
      </nav>
      <nav aria-label="Repository">
        <a href={reportHref(null, report.period)} class={report.repository === null ? "report-chip report-chip--active" : "report-chip"} aria-current={report.repository === null ? "page" : undefined}>All repositories</a>
        {report.repositories.map((repository) => (
          <a key={repository} href={reportHref(repository, report.period)} class={repository === report.repository ? "report-chip report-chip--active" : "report-chip"} aria-current={repository === report.repository ? "page" : undefined}>{repository}</a>
        ))}
      </nav>
    </div>
  );
}

function RepositoryTable({ report }: { report: ReportViewModel }) {
  return (
    <section class="report-section" aria-labelledby="report-repositories">
      <h3 id="report-repositories">By repository</h3>
      <div class="report-table-wrap">
        <table class="report-table">
          <thead><tr><th scope="col">Repository</th><th scope="col">Delivered</th><th scope="col">In progress</th><th scope="col">Runs</th><th scope="col">Tokens</th><th scope="col">Agent time</th><th scope="col">Tokens per item</th><th scope="col">Lead time per item</th><th scope="col">Returns per item</th><th scope="col">First pass</th></tr></thead>
          <tbody>
            {report.byRepository.map((row) => (
              <tr key={row.id}>
                <th scope="row"><a href={reportHref(row.id, report.period)}>{row.id}</a></th>
                <td>{row.delivered}</td><td>{row.inProgress}</td><td>{row.runs}</td>
                <td>{formatCompact(tokensOf(row))}</td><td>{formatSpan(row.agentMs)}</td>
                <td>{orDash(row.avgTokensPerItem, formatCompact)}</td><td>{orDash(row.avgLeadMs, formatSpan)}</td>
                <td>{orDash(row.avgReturnsPerItem, (value) => value.toFixed(1))}</td><td>{orDash(row.firstPassRate, percent)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Months({ report }: { report: ReportViewModel }) {
  const months = report.byMonth;
  return (
    <section class="report-section" aria-labelledby="report-months">
      <h3 id="report-months">By month</h3>
      <div class="report-chart-row">
        <ColumnChart title="Items delivered" columns={months.map((row) => ({ label: monthLabel(row.month), value: row.delivered, display: String(row.delivered) }))} format={(value) => String(Math.round(value))} />
        <ColumnChart title="Tokens" caption="input and output" columns={months.map((row) => ({ label: monthLabel(row.month), value: row.tokens, display: formatCompact(row.tokens) }))} format={formatCompact} />
        <ColumnChart title="Tokens per delivered item" columns={months.flatMap((row) => row.avgTokensPerItem === null ? [] : [{ label: monthLabel(row.month), value: row.avgTokensPerItem, display: formatCompact(row.avgTokensPerItem) }])} format={formatCompact} />
      </div>
      <div class="report-table-wrap">
        <table class="report-table">
          <thead><tr><th scope="col">Month</th><th scope="col">Delivered</th><th scope="col">Runs</th><th scope="col">Tokens</th><th scope="col">Agent time</th><th scope="col">Tokens per item</th><th scope="col">Lead time per item</th></tr></thead>
          <tbody>
            {months.map((row) => (
              <tr key={row.month}>
                <th scope="row">{monthLabel(row.month)}</th><td>{row.delivered}</td><td>{row.runs}</td><td>{formatCompact(row.tokens)}</td>
                <td>{formatSpan(row.agentMs)}</td><td>{orDash(row.avgTokensPerItem, formatCompact)}</td><td>{orDash(row.avgLeadMs, formatSpan)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TimeAndStages({ report }: { report: ReportViewModel }) {
  const totals = report.totals;
  const phases: Bar[] = totals.avgLeadMs === null ? [] : [
    { label: "Agents working", value: totals.avgAgentMs ?? 0, display: formatSpan(totals.avgAgentMs ?? 0) },
    { label: "Waiting on CI and checks", value: totals.avgChecksWaitMs ?? 0, display: formatSpan(totals.avgChecksWaitMs ?? 0) },
    { label: "Waiting for you", value: totals.avgWaitingForYouMs ?? 0, display: formatSpan(totals.avgWaitingForYouMs ?? 0) },
    { label: "Queued and other", value: totals.avgQueuedMs ?? 0, display: formatSpan(totals.avgQueuedMs ?? 0) },
  ];
  return (
    <section class="report-section" aria-labelledby="report-time">
      <h3 id="report-time">Where the time and tokens go</h3>
      <div class="report-chart-row">
        <BarChart title="Time per delivered item" caption={orDash(totals.avgLeadMs, (lead) => `average lead time ${formatSpan(lead)}`)} bars={phases} />
        <BarChart title="Tokens by stage" bars={report.byStage.map((stage) => ({ label: stage.name, value: stage.tokens, display: formatCompact(stage.tokens) }))} />
        <BarChart title="Agent time by stage" bars={report.byStage.map((stage) => ({ label: stage.name, value: stage.agentMs, display: formatSpan(stage.agentMs) }))} />
      </div>
      <div class="report-table-wrap">
        <table class="report-table">
          <thead><tr><th scope="col">Stage</th><th scope="col">Runs</th><th scope="col">Did not succeed</th><th scope="col">Tokens</th><th scope="col">Agent time</th><th scope="col">Average run</th></tr></thead>
          <tbody>
            {report.byStage.map((stage) => (
              <tr key={stage.id}>
                <th scope="row">{stage.name}</th><td>{stage.runs}</td><td>{stage.failedRuns}</td><td>{formatCompact(stage.tokens)}</td>
                <td>{formatSpan(stage.agentMs)}</td><td>{orDash(stage.avgRunMs, formatSpan)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function stateLabel(item: ReportItemRow): string {
  if (item.state === "done") return "Done";
  return item.state.replaceAll(/[-_]/g, " ").replace(/^./, (letter) => letter.toUpperCase());
}

function Items({ report }: { report: ReportViewModel }) {
  return (
    <section class="report-section" aria-labelledby="report-items">
      <h3 id="report-items">Items</h3>
      {report.items.length === 0
        ? <p class="report-empty">No item was active in this period.</p>
        : (
          <div class="report-table-wrap">
            <table class="report-table report-table--items">
              <thead><tr><th scope="col">Item</th><th scope="col">State</th><th scope="col">Lead time</th><th scope="col">Agent time</th><th scope="col">Waiting on checks</th><th scope="col">Waiting for you</th><th scope="col">Runs</th><th scope="col">Tokens</th><th scope="col">Returns</th><th scope="col">Stops</th></tr></thead>
              <tbody>
                {report.items.map((item) => (
                  <tr key={item.number}>
                    <th scope="row"><a href={issueHref(item.repository, item.number)}>#{item.number}</a> <span class="report-item-title">{item.title}</span></th>
                    <td>{stateLabel(item)}</td><td>{orDash(item.leadMs, formatSpan)}</td><td>{formatSpan(item.agentMs)}</td>
                    <td>{formatSpan(item.checksWaitMs)}</td><td>{formatSpan(item.waitingForYouMs)}</td><td>{item.runs}</td>
                    <td>{formatCompact(item.tokens)}</td><td>{item.returns}</td><td>{item.stops}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </section>
  );
}

export function Reports({ report }: { report: ReportViewModel }) {
  return (
    <section class="report" aria-labelledby="report-heading">
      <header class="section-heading report-heading">
        <div>
          <h2 id="report-heading">{report.repository ? `Reports · ${report.repository}` : "Reports"}</h2>
          <p>Delivery, usage and time{report.since ? ` over the last ${PERIOD_LABELS[report.period]}` : ""}. An item counts as delivered when it finishes its last stage; per-item figures cover its whole life.</p>
        </div>
      </header>
      <Filters report={report} />
      <Kpis totals={report.totals} />
      {report.repository === null && <RepositoryTable report={report} />}
      {report.repository !== null && <Items report={report} />}
      <TimeAndStages report={report} />
      <Months report={report} />
      <p class="report-notes">
        Agent time is the wall time of runs. Waiting on CI and checks is time a stage spent parked on CI, a deploy or a dependency; waiting for you is time an item spent stopped (blocked, needs input, error) until it resumed; queued and other is the rest of the lead time.
        {report.importedWithoutHistory > 0 && ` ${report.importedWithoutHistory} items imported as done without a recorded delivery are left out.`}
      </p>
    </section>
  );
}
