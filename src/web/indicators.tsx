// The one renderer for stored status indicators: a compact chip on the board card and a section in
// the item details. Both read the same IndicatorViewModel, so a new indicator source needs no markup.

import { Fragment } from "preact";

import { formatDuration } from "./format";
import type { IndicatorViewModel, IssueCardViewModel } from "./types";

function safeHref(value: string | null): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** State is carried by a symbol and a word as well as by color. */
export function IndicatorChips({ issue }: { issue: IssueCardViewModel }) {
  if (issue.indicators.length === 0) return null;
  return (
    <div class="indicator-chips">
      {issue.indicators.map((indicator) => (
        <span class={`indicator-chip indicator-chip--${indicator.state}`} data-indicator={indicator.id} title={`${indicator.label} ${indicator.stateWord}: ${indicator.detail}`} key={indicator.id}>
          <span aria-hidden="true">{indicator.label} {indicator.symbol} {indicator.progress}</span>
          <span class="sr-only">{indicator.label} {indicator.stateWord}, {indicator.progress}</span>
        </span>
      ))}
    </div>
  );
}

function RunTimes({ entry }: { entry: IndicatorViewModel["entries"][number] }) {
  return (
    <Fragment>
      <span class="indicator-entry-start">{entry.startedAt ? <time dateTime={entry.startedAt} data-local-time>…</time> : "start unavailable"}</span>
      <span class="indicator-entry-duration">{entry.durationMs === null ? "duration unavailable" : `${entry.live ? "running for " : ""}${formatDuration(entry.durationMs)}`}</span>
    </Fragment>
  );
}

function IndicatorSection({ indicator }: { indicator: IndicatorViewModel }) {
  const url = safeHref(indicator.url);
  const reference = indicator.reference;
  const referenceUrl = safeHref(reference?.url ?? null);
  return (
    <section class={`indicator indicator--${indicator.state}`} data-indicator={indicator.id} aria-label={`${indicator.label} status`}>
      <h3>
        {url ? <a href={url} target="_blank" rel="noopener noreferrer">{indicator.label}</a> : indicator.label}{" "}
        <span class={`indicator-state indicator-state--${indicator.state}`}>{indicator.symbol} {indicator.stateWord}</span>
      </h3>
      <p class="indicator-detail">
        {indicator.detail}
        {reference && <> · {referenceUrl ? <a href={referenceUrl} target="_blank" rel="noopener noreferrer"><code>{reference.label}</code></a> : <code>{reference.label}</code>}</>}
        {" "}· observed <time dateTime={indicator.observedAt} data-local-time>…</time>
      </p>
      {indicator.entries.length > 0 && (
        <ul class="indicator-entries">
          {indicator.entries.map((entry) => {
            const href = safeHref(entry.url);
            return (
              <li class={`indicator-entry indicator-entry--${entry.state}`} key={entry.name}>
                <span class="indicator-entry-name">{href ? <a href={href} target="_blank" rel="noopener noreferrer">{entry.name}</a> : entry.name}</span>
                <span class="indicator-entry-state">{entry.state}</span>
                <RunTimes entry={entry} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export function IndicatorDetails({ issue }: { issue: IssueCardViewModel }) {
  if (issue.indicators.length === 0) return null;
  return <div class="indicators">{issue.indicators.map((indicator) => <IndicatorSection indicator={indicator} key={indicator.id} />)}</div>;
}
