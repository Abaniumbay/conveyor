---
section: Added
---

The dashboard has a live model API: `GET /api/v1/snapshot` returns everything the board shows as JSON, and `GET /api/v1/stream` sends field-level patches as items change. The model is rebuilt once per burst of changes for all open dashboards together, so more open dashboards no longer mean more work on the server per change.
