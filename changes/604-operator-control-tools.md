---
section: Added
---

Operators can retry, steer, pause, resume and answer questions on items from an MCP client. The `/operator-mcp` endpoint gains `item_retry`, `item_steer`, `item_pause`, `item_resume` and `question_answer`; steering an item with no running agent, or any control of an unknown item, is a tool error.
