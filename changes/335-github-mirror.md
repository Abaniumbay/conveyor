---
section: Changed
---
Conveyor keeps a copy of what it reads from GitHub in its database and answers every read from it.
Only an item it does not hold, or one older than its lifetime (`settings.githubCache`: an hour for
issues, pull requests and permissions, 15 minutes for running checks, finished checks kept), is read
from GitHub. Webhook deliveries and Conveyor's own writes keep the copy current, and a restart reads
nothing it already holds. Merging no longer waits for GitHub to compute mergeability: the merge
decides. On the offline benchmark, an agent's 30 tool calls during review now cost no GitHub
request (92 calls before), a 20-minute CI wait 21 (44), and one item's delivery 22 (45).
