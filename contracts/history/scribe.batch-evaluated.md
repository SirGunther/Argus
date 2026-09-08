# scribe.batch-evaluated history

## 1.0.0

- Introduced the governed carrier that transmits one settled `scribe_batch_evaluated` artifact from the extraction boundary back to the Scribe coordinator. The payload is a single required `batch` object referencing `argus.scribe-batch-evaluated.v1` by `$ref`; the artifact shape is not redefined here.
- All three settled outcomes are now reachable over a real message: `empty-evaluated` (zero items), `items-recorded` (the complete item set plus the owner-confirmed `acknowledgement.logged_item_ids`), and `failed` (with `error.code/category/message/retryable`). Before this contract only the failed outcome had a carrier, through `service.failure`, so a valid zero-item or multi-item settlement had no governed way to reach the coordinator and advance its durable cursor.
- The payload deliberately does not repeat `session_id` or any other field the artifact already carries: `batch.batch_identity` is the authoritative identity, and the envelope's `correlation_id` carries the session. A duplicated routing key would be a forgeable divergence the payload schema cannot detect (this repository's Ajv configuration has no `$data` support).
- Registered on the `domain` plane to match `scribe.batch-admitted` and the existing `logged-item.draft`/`logged-item.stored` precedent: an evaluated batch is a session evidence fact, not AI-lane scheduling.
