---
section: Changed
breaking: true
---
The Reports view and its API now default to the last 30 days instead of all time. Scripts or clients that read `/api/v1/views/reports` without a `period` and need the all-time report must pass `?period=all`. A new **By week** table shows delivered items, first-pass rate and average returns per item for each UTC ISO week of the selected period and repository.
