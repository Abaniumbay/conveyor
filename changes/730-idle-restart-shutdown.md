---
section: Fixed
---
A restart with no stage running no longer waits out the shutdown timeout on an open dashboard live stream or steering event stream: both end when shutdown begins. When a shutdown does time out, the log now names the step it was in (service close, web server stop or MCP socket stop) and, during service close, the busy conditions still set.
