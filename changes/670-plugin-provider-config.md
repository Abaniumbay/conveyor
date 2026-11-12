---
section: Changed
---
Item source, code host and CI provider settings are now defined by the plugin their `type` names: GitHub's `webhookPath`, `autoConfigureWebhook` and `webhookSecret`, and GitHub Actions' `triggers`, are validated by those plugins when the configuration loads. Existing configurations load unchanged. A provider `type` that no plugin provides is now reported as `no items plugin provides type "…"` with the types this build knows.
