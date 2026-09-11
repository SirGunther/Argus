# scribe.guidance-configure history

## 1.0.0

- Introduced the host-to-graph carrier for one session's immutable Scribe guidance snapshot (SCRIBE-05B). The desktop host resolves which guidance a session runs under - the value durably recorded for an existing session, or the current saved setting for a new one - and sends it before that session's first batch, so an edit to the global setting applies to the next new session and can never be substituted into a pending, in-flight, stopped/resumable, retried, or recovered session. `additional_guidance` is bounded at 2,000 characters and may be empty, which means the protected instruction runs alone. `guidance_fingerprint` pins the exact value so a conflicting resend for the same session is a visible conflict rather than a silent replacement. The payload carries no credential and no provider configuration.
