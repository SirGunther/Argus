# `scribe.session-flushed` 1.0.0

Initial terminal acknowledgement for a governed Scribe Close request.

Emitted by the Scribe coordinator once a `scribe.session-closing` request has reached a terminal
state for that session. `accepted: true` means every finalized row through `admitted_through` was
processed, acknowledged by the Logged Item owner, journaled, and durably checkpointed, and
`pending_rows` is zero — only then may the session be sealed. `accepted: false` carries the exact
`error` and leaves the session unsealed rather than losing the outstanding rows; a stalled batch
reports its terminal failure here instead of failing silently.
