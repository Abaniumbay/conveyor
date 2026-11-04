---
section: Fixed
---

An issue enrolled while another issue's dependencies were being read no longer loses its title and body. Before, the relationship pass could store it as an empty placeholder; Conveyor then ignored the real text as an edit with no verifiable editor, and refinement saw an empty issue. To recover an issue that already shows an empty title and body, edit its title and body once on GitHub from a trusted account.
