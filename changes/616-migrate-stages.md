---
section: Added
---

`conveyor config migrate --stages` converts the pipelines of a configuration file into one `stages:` list, turning each repository's differences into `overrides` and `skip: true`, writes `*.migrated.yaml` beside the original and prints `config compare` for every repository. Pipelines that order the same stages differently stop the command without writing anything.
