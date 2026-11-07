---
section: Fixed
---

Refinement can split an item into children that depend on each other again. Since 0.17.0, creating a child with dependencies failed with "The issue body changed while its managed section was being updated." and left an unlabelled child issue behind on each attempt.
