---
section: Fixed
---
The criterion test check now finds tests whose names are written with escaped quotes, backslashes or template literals, and it matches a plain test title containing a dot (such as `AC-1.2 does x`) as a whole name instead of splitting it. A malformed `\u{` escape in a linked test file no longer hangs or crashes the check.
