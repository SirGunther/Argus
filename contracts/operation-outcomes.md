# Phase 4 Transcript Operation Outcomes

Every input terminates as `operation.completed`, `operation.rejected`, or `service.failure`. Retry belongs to the exact wire and explicit recovery policy; a service never retries a neighbor privately.

| Boundary | Condition | Code | Category | Retryable | Terminal behavior |
| --- | --- | --- | --- | --- | --- |
| Audio capture/registry | Schema, PCM format, length, base64, or checksum invalid | `INVALID_AUDIO_CHUNK` | validation | no | Reject before STT; discard bytes. |
| Audio ordering | Expected chunk is missing | `SEQUENCE_GAP` | conflict | yes | Do not advance the session stream; declared wire policy may retry. |
| Audio ordering | Older non-duplicate chunk arrives | `LATE_MESSAGE` | rejection | no | Observe and terminate without STT work. |
| STT | Provider/model temporarily unavailable while bytes still exist | `STT_UNAVAILABLE` | unavailable | yes | Retry only under an explicit audio wire policy. |
| STT | Provider/model terminal failure or bytes already released | `STT_FAILED` / `AUDIO_EXPIRED` | dependency | no | Report failure; never infer a hidden audio archive. |
| Active transcript | Partial revision is stale | `STALE_PROJECTION` | rejection | no | Keep the current provisional row. |
| Active transcript | Committed-word sequence has a gap | `SEQUENCE_GAP` | conflict | yes | Do not assemble later words yet. |
| Active transcript | Correction targets missing/stale word evidence | `STALE_CORRECTION` | rejection | no | Preserve the current rendered projection and original evidence. |
| Active transcript | Segment edit uses stale expected revision | `STALE_REVISION` | rejection | no | Do not mutate the segment. |
| Permanent history | Exact append replays | success with `duplicate: true` | — | — | Return the recorded receipt without a second entry. |
| Permanent history | Same entry/key carries different content | `IDEMPOTENT_INPUT_CONFLICT` | conflict | no, fatal | Stop the integrity boundary; do not append. |
| Permanent history | Append storage temporarily unavailable | `HISTORY_UNAVAILABLE` | unavailable | yes | Retry only on a declared history wire; append remains idempotent. |

The fake Phase 4 components must implement these names or a more specific governed code without changing their retryability. Durable history recovery is Phase 6; Phase 4 proves the contract and in-memory ownership boundary only.
