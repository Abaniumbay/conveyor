/** The one line status and the dashboard show while items wait out a GitHub outage. */
export function githubOutageLine(outage: { since: string; waiting: number }): string {
  return `GitHub unavailable since ${outage.since}, ${outage.waiting} ${outage.waiting === 1 ? "item" : "items"} waiting`;
}
