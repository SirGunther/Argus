# `scribe.recovery-restored` changelog

## 1.0.0 — 2026-09-08

Introduced the bounded durable checkpoint response with authoritative hydrated pending, in-flight, and background transcript evidence.

## 1.0.0 — 2026-09-11 (SCRIBE-05 correction)

`pending_segments` now carries up to 16 rows instead of 2, and the optional `pending_complete`
flag reports whether more authoritative rows remain after the ones in this message.

Recovery rebuilds pending evidence from authoritative transcript history rather than only from the
checkpoint's two-row remainder, so a session interrupted with a full batch in flight and further
rows queued legitimately has more than two rows to restore. The two-row ceiling belongs to
`scribe_checkpoint.pending_partial` — the stranded-remainder artifact — not to a recovery backlog.
An absent `pending_complete` means the message carries every remaining row, which keeps every
message written before this change valid and unchanged.

Rows beyond one page are not truncated: the coordinator drains the page, its durable cursor
advances, and it asks for recovery again. The cursor is the paging key, so
`scribe.recovery-request` is unchanged.
