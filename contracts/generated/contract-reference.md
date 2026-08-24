# Generated Contract Reference

> Generated from `contracts/catalog.json` and payload schemas. Do not edit by hand.

## Governance

- Catalog version: `1.9.0`
- Compatibility: `backward-compatible-minor`
- Plane changes: `breaking`
- Validator: `ajv-draft-07-runtime-boundary`
- Default payload limit: 64 KiB

## Inventory

| Message | Plane | Version | Owner | Max payload |
| --- | --- | --- | --- | ---: |
| `audio.chunk` | domain | `1.2.0` | `audio/capture` | 32 KiB |
| `audio.flush` | domain | `1.2.0` | `audio/capture` | 16 KiB |
| `transcript.partial` | domain | `1.2.0` | `transcript/stt` | 32 KiB |
| `transcript.word-committed` | domain | `1.2.0` | `transcript/stt` | 32 KiB |
| `transcript.word-correction-proposed` | domain | `1.2.0` | `transcript/contextual-correction` | 32 KiB |
| `transcript.utterance-boundary` | domain | `1.2.0` | `transcript/stt` | 16 KiB |
| `transcript.correction-request` | domain | `1.2.0` | `transcript/active-state` | 64 KiB |
| `transcript.correction-resolved` | domain | `1.2.0` | `transcript/contextual-correction` | 64 KiB |
| `transcript.segment-update` | domain | `1.2.0` | `transcript/active-state` | 32 KiB |
| `transcript.segment-stored` | domain | `1.3.0` | `transcript/active-state` | 64 KiB |
| `transcript.history-append` | domain | `1.3.0` | `transcript/permanent-history` | 64 KiB |
| `transcript.history-appended` | domain | `1.2.0` | `transcript/permanent-history` | 16 KiB |
| `transcript.context-policy` | control | `1.2.0` | `transcript/context-selection` | 32 KiB |
| `operation.rejected` | control | `1.2.0` | `runtime/operation-outcomes` | 16 KiB |
| `ai.work-request` | control | `1.4.0` | `runtime/ai-scheduling` | 256 KiB |
| `ai.work-completed` | control | `1.4.0` | `runtime/ai-scheduling` | 256 KiB |
| `logged-item.update` | domain | `1.3.0` | `logged-items/active-owner` | 64 KiB |
| `classification.suggestion` | domain | `1.2.0` | `logged-items/classification` | 64 KiB |
| `classification.suggestion-accepted` | domain | `1.2.0` | `logged-items/storage` | 64 KiB |
| `lifecycle.start` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `lifecycle.health-check` | control | `1.2.0` | `runtime/supervision` | 8 KiB |
| `service.health` | control | `1.2.0` | `runtime/supervision` | 8 KiB |
| `lifecycle.drain` | control | `1.2.0` | `runtime/supervision` | 8 KiB |
| `service.drained` | control | `1.2.0` | `runtime/supervision` | 8 KiB |
| `operation.completed` | control | `1.2.0` | `runtime/supervision` | 8 KiB |
| `service.exited` | control | `1.2.0` | `runtime/provider-boundary` | 8 KiB |
| `dead-letter.message` | control | `1.2.0` | `runtime/supervision` | 512 KiB |
| `service.failure` | control | `1.2.0` | `runtime/supervision` | 32 KiB |
| `workflow.completed` | control | `1.2.0` | `runtime/run-control` | 8 KiB |
| `transcript.segment` | domain | `1.4.0` | `transcript/active-state` | 32 KiB |
| `transcript.context-window` | domain | `1.4.0` | `transcript/context-selection` | 256 KiB |
| `logged-item.draft` | domain | `1.3.0` | `logged-items/extraction` | 64 KiB |
| `logged-item.stored` | domain | `1.3.0` | `logged-items/active-owner` | 64 KiB |
| `logged-item.history-append` | domain | `1.0.0` | `logged-items/permanent-history` | 64 KiB |
| `logged-item.history-appended` | domain | `1.0.0` | `logged-items/permanent-history` | 16 KiB |
| `logged-item.update-proposed` | domain | `1.0.0` | `logged-items/proposal-provider` | 64 KiB |
| `logged-item.proposal-resolve` | domain | `1.0.0` | `logged-items/user-command` | 16 KiB |
| `logged-item.proposal-resolved` | domain | `1.0.0` | `logged-items/active-owner` | 16 KiB |
| `session.record` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.recorded` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.stop` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.stopped` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.resume` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.resumed` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.close` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.closed` | control | `1.2.0` | `runtime/session-lifecycle` | 16 KiB |
| `session.folder-locate` | control | `1.2.0` | `runtime/session-folder-locator` | 16 KiB |
| `session.folder-located` | control | `1.2.0` | `runtime/session-folder-locator` | 16 KiB |
| `ui.command` | control | `1.0.0` | `ui/bridge` | 32 KiB |
| `ui.command-result` | control | `1.0.0` | `ui/bridge` | 16 KiB |
| `ui.session-status` | domain | `1.0.0` | `ui/projection` | 16 KiB |
| `ui.transcript-row` | domain | `1.0.0` | `ui/projection` | 32 KiB |
| `ui.logged-item-row` | domain | `1.0.0` | `ui/projection` | 32 KiB |
| `ui.service-status` | control | `1.0.0` | `ui/projection` | 16 KiB |

## `audio.chunk`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `audio/capture`
- Schema: [`audio-chunk.schema.json`](../audio-chunk.schema.json)
- History: [`history/audio.chunk.md`](../history/audio.chunk.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `chunk_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `sequence` | yes | integer | minimum 0 |
| `start_time` | yes | string | min length 1 |
| `end_time` | yes | string | min length 1 |
| `format` | yes | object | requires `encoding`, `sample_rate_hz`, `channels`, `bits_per_sample`, `byte_order` |
| `sample_count` | yes | integer | minimum 1 |
| `byte_length` | yes | integer | minimum 2 |
| `audio_base64` | yes | string | min length 4 |
| `checksum` | yes | string | — |

## `audio.flush`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `audio/capture`
- Schema: [`audio-flush.schema.json`](../audio-flush.schema.json)
- History: [`history/audio.flush.md`](../history/audio.flush.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `session_id` | yes | string | min length 1 |
| `requested_at` | yes | string | min length 1 |
| `reason` | no | any | `pause`, `flush` |

## `transcript.partial`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/stt`
- Schema: [`transcript-partial.schema.json`](../transcript-partial.schema.json)
- History: [`history/transcript.partial.md`](../history/transcript.partial.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `projection_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `utterance_id` | yes | string | min length 1 |
| `revision` | yes | integer | minimum 0 |
| `replaces_revision` | no | integer | minimum 0 |
| `start_time` | yes | string | min length 1 |
| `end_time` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `stability` | yes | number | minimum 0 |
| `covered_chunk_ids` | yes | array<string> | min items 1 |

## `transcript.word-committed`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/stt`
- Schema: [`transcript-word-committed.schema.json`](../transcript-word-committed.schema.json)
- History: [`history/transcript.word-committed.md`](../history/transcript.word-committed.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `word_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `utterance_id` | yes | string | min length 1 |
| `sequence` | yes | integer | minimum 0 |
| `start_time` | yes | string | min length 1 |
| `end_time` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `confidence` | yes | number | minimum 0 |
| `evidence` | yes | object | requires `provider`, `chunk_ids`, `alternatives` |

## `transcript.word-correction-proposed`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/contextual-correction`
- Schema: [`transcript-word-correction-proposed.schema.json`](../transcript-word-correction-proposed.schema.json)
- History: [`history/transcript.word-correction-proposed.md`](../history/transcript.word-correction-proposed.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `proposal_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `target_word_id` | yes | string | min length 1 |
| `target_word_sequence` | yes | integer | minimum 0 |
| `expected_text` | yes | string | min length 1 |
| `proposed_text` | yes | string | min length 1 |
| `confidence` | yes | number | minimum 0 |
| `basis` | yes | string | `acoustic-similarity`, `contextual-meaning`, `acoustic-and-contextual` |
| `alternatives` | no | array<object> | — |
| `context` | yes | object | requires `first_word_id`, `last_word_id` |
| `generator` | yes | object | requires `kind`, `implementation`, `policy_profile`, `instruction_version` |

## `transcript.utterance-boundary`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/stt`
- Schema: [`transcript-utterance-boundary.schema.json`](../transcript-utterance-boundary.schema.json)
- History: [`history/transcript.utterance-boundary.md`](../history/transcript.utterance-boundary.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `boundary_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `utterance_id` | yes | string | min length 1 |
| `reason` | yes | string | `pause`, `size`, `latency`, `flush` |
| `first_word_sequence` | yes | integer | minimum 0 |
| `last_word_sequence` | yes | integer | minimum 0 |
| `start_time` | yes | string | min length 1 |
| `end_time` | yes | string | min length 1 |
| `punctuation_hint` | yes | string | `statement`, `question`, `exclamation`, `unknown` |
| `source_chunk_ids` | yes | array<string> | min items 1 |

## `transcript.correction-request`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/active-state`
- Schema: [`transcript-correction-request.schema.json`](../transcript-correction-request.schema.json)
- History: [`history/transcript.correction-request.md`](../history/transcript.correction-request.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `request_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `utterance_id` | yes | string | min length 1 |
| `boundary_id` | yes | string | min length 1 |
| `words` | yes | array<object> | min items 1 |
| `formatting_hint` | yes | string | `statement`, `question`, `exclamation`, `unknown` |
| `policy` | yes | object | requires `profile`, `instruction_version`, `automatic_acceptance_threshold`, `max_context_words` |

## `transcript.correction-resolved`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/contextual-correction`
- Schema: [`transcript-correction-resolved.schema.json`](../transcript-correction-resolved.schema.json)
- History: [`history/transcript.correction-resolved.md`](../history/transcript.correction-resolved.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `request_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `utterance_id` | yes | string | min length 1 |
| `boundary_id` | yes | string | min length 1 |
| `proposals` | yes | array<object> | — |
| `formatting` | yes | object | requires `terminal_mark`, `capitalize_first_word`, `confidence` |
| `punctuation_after` | no | array<object> | — |
| `generator` | yes | object | requires `implementation`, `policy_profile`, `instruction_version` |

## `transcript.segment-update`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/active-state`
- Schema: [`transcript-segment-update.schema.json`](../transcript-segment-update.schema.json)
- History: [`history/transcript.segment-update.md`](../history/transcript.segment-update.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `segment_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `expected_revision` | yes | integer | minimum 0 |
| `text` | yes | string | min length 1 |
| `updated_at` | yes | string | min length 1 |
| `editor` | yes | string | `user`, `authorized-system` |

## `transcript.segment-stored`

- Plane: `domain`
- Version: `1.3.0`
- Owner: `transcript/active-state`
- Schema: [`transcript-segment-stored.schema.json`](../transcript-segment-stored.schema.json)
- History: [`history/transcript.segment-stored.md`](../history/transcript.segment-stored.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `segment_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `sequence` | yes | integer | minimum 0 |
| `revision` | yes | integer | minimum 0 |
| `start_time` | yes | string | min length 1 |
| `end_time` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `original_stt_text` | yes | string | min length 1 |
| `boundary` | yes | string | `continuation`, `pause`, `size`, `latency`, `flush` |
| `word_provenance` | yes | array<object> | min items 1 |
| `formatting` | no | object | requires `source`, `provisional_until_finalized` |
| `review_flags` | no | array<object> | — |
| `stored_at` | yes | string | min length 1 |

## `transcript.history-append`

- Plane: `domain`
- Version: `1.3.0`
- Owner: `transcript/permanent-history`
- Schema: [`transcript-history-append.schema.json`](../transcript-history-append.schema.json)
- History: [`history/transcript.history-append.md`](../history/transcript.history-append.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `history_entry_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `segment` | yes | object | requires `segment_id`, `session_id`, `sequence`, `revision`, `start_time`, `end_time`, `text`, `original_stt_text`, `boundary`, `word_provenance`, `stored_at` |
| `requested_at` | yes | string | min length 1 |

## `transcript.history-appended`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `transcript/permanent-history`
- Schema: [`transcript-history-appended.schema.json`](../transcript-history-appended.schema.json)
- History: [`history/transcript.history-appended.md`](../history/transcript.history-appended.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `history_entry_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `segment_id` | yes | string | min length 1 |
| `segment_revision` | yes | integer | minimum 0 |
| `appended_at` | yes | string | min length 1 |

## `transcript.context-policy`

- Plane: `control`
- Version: `1.2.0`
- Owner: `transcript/context-selection`
- Schema: [`transcript-context-policy.schema.json`](../transcript-context-policy.schema.json)
- History: [`history/transcript.context-policy.md`](../history/transcript.context-policy.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `policy_id` | yes | string | min length 1 |
| `policy_version` | yes | string | — |
| `session_id` | yes | string | min length 1 |
| `triggers` | yes | object | requires `pause_enabled`, `max_source_segments`, `max_source_chars`, `topic_boundary_after_sequences`, `max_latency_ms` |
| `context` | yes | object | requires `lookback_segment_count`, `forward_segment_count`, `max_context_chars` |
| `generation` | yes | object | requires `policy_profile`, `instruction_version` |

## `operation.rejected`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/operation-outcomes`
- Schema: [`operation-rejected.schema.json`](../operation-rejected.schema.json)
- History: [`history/operation.rejected.md`](../history/operation.rejected.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `service` | yes | string | min length 1 |
| `operation` | yes | string | min length 1 |
| `input_message_id` | yes | string | min length 1 |
| `outcome` | yes | any | — |
| `reason` | yes | object | requires `code`, `message` |

## `ai.work-request`

- Plane: `control`
- Version: `1.4.0`
- Owner: `runtime/ai-scheduling`
- Schema: [`ai-work-request.schema.json`](../ai-work-request.schema.json)
- History: [`history/ai.work-request.md`](../history/ai.work-request.md)
- Maximum payload: 256 KiB (262144 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `work_id` | yes | string | min length 1 |
| `workload` | yes | string | `transcription`, `transcript-correction-formatting`, `logged-item-extraction`, `classification-enrichment` |
| `session_id` | yes | string | min length 1 |
| `sequence` | yes | integer | minimum 0 |
| `queued_at` | yes | string | min length 1 |
| `input` | yes | any | — |
| `recovery` | no | object | requires `max_attempts` |

## `ai.work-completed`

- Plane: `control`
- Version: `1.4.0`
- Owner: `runtime/ai-scheduling`
- Schema: [`ai-work-completed.schema.json`](../ai-work-completed.schema.json)
- History: [`history/ai.work-completed.md`](../history/ai.work-completed.md)
- Maximum payload: 256 KiB (262144 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `work_id` | yes | string | min length 1 |
| `workload` | yes | string | `transcription`, `transcript-correction-formatting`, `logged-item-extraction`, `classification-enrichment` |
| `session_id` | yes | string | min length 1 |
| `sequence` | yes | integer | minimum 0 |
| `attempt` | yes | integer | minimum 1 |
| `completed_at` | yes | string | min length 1 |
| `result` | yes | any | — |

## `logged-item.update`

- Plane: `domain`
- Version: `1.3.0`
- Owner: `logged-items/active-owner`
- Schema: [`logged-item-update.schema.json`](../logged-item-update.schema.json)
- History: [`history/logged-item.update.md`](../history/logged-item.update.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `expected_revision` | yes | integer | minimum 0 |
| `text` | yes | string | min length 1 |
| `updated_at` | yes | string | min length 1 |
| `editor` | no | string | — |

## `classification.suggestion`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `logged-items/classification`
- Schema: [`classification-suggestion.schema.json`](../classification-suggestion.schema.json)
- History: [`history/classification.suggestion.md`](../history/classification.suggestion.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `item_revision` | yes | integer | minimum 0 |
| `suggested_classification` | yes | string | `task`, `note`, `observation`, `idea` |
| `confidence` | yes | number | minimum 0 |
| `evidence_segment_ids` | yes | array<string> | min items 1 |

## `classification.suggestion-accepted`

- Plane: `domain`
- Version: `1.2.0`
- Owner: `logged-items/storage`
- Schema: [`classification-suggestion-accepted.schema.json`](../classification-suggestion-accepted.schema.json)
- History: [`history/classification.suggestion-accepted.md`](../history/classification.suggestion-accepted.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `item_revision` | yes | integer | minimum 0 |
| `suggested_classification` | yes | string | `task`, `note`, `observation`, `idea` |
| `accepted_at` | yes | string | min length 1 |

## `lifecycle.start`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`lifecycle-start.schema.json`](../lifecycle-start.schema.json)
- History: [`history/lifecycle.start.md`](../history/lifecycle.start.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `session_id` | yes | string | min length 1 |
| `configuration` | no | object | — |

## `lifecycle.health-check`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/supervision`
- Schema: [`lifecycle-health-check.schema.json`](../lifecycle-health-check.schema.json)
- History: [`history/lifecycle.health-check.md`](../history/lifecycle.health-check.md)
- Maximum payload: 8 KiB (8192 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `probe_id` | yes | string | min length 1 |

## `service.health`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/supervision`
- Schema: [`service-health.schema.json`](../service-health.schema.json)
- History: [`history/service.health.md`](../history/service.health.md)
- Maximum payload: 8 KiB (8192 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `service` | yes | string | min length 1 |
| `probe_id` | yes | string | min length 1 |
| `status` | yes | string | `ready`, `not_ready` |
| `runtime_kind` | yes | string | min length 1 |
| `rss_bytes` | yes | integer | minimum 0 |

## `lifecycle.drain`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/supervision`
- Schema: [`lifecycle-drain.schema.json`](../lifecycle-drain.schema.json)
- History: [`history/lifecycle.drain.md`](../history/lifecycle.drain.md)
- Maximum payload: 8 KiB (8192 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `reason` | yes | string | `completed`, `failed`, `cancelled` |
| `deadline_ms` | yes | integer | minimum 1 |

## `service.drained`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/supervision`
- Schema: [`service-drained.schema.json`](../service-drained.schema.json)
- History: [`history/service.drained.md`](../history/service.drained.md)
- Maximum payload: 8 KiB (8192 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `service` | yes | string | min length 1 |
| `pending_operations` | yes | integer | minimum 0 |

## `operation.completed`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/supervision`
- Schema: [`operation-completed.schema.json`](../operation-completed.schema.json)
- History: [`history/operation.completed.md`](../history/operation.completed.md)
- Maximum payload: 8 KiB (8192 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `service` | yes | string | min length 1 |
| `operation` | yes | string | min length 1 |
| `input_message_id` | yes | string | min length 1 |
| `outcome` | yes | any | — |
| `duplicate` | no | boolean | — |

## `service.exited`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/provider-boundary`
- Schema: [`service-exited.schema.json`](../service-exited.schema.json)
- History: [`history/service.exited.md`](../history/service.exited.md)
- Maximum payload: 8 KiB (8192 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `service_instance` | yes | string | min length 1 |
| `runtime_kind` | yes | string | min length 1 |
| `expected` | yes | boolean | — |
| `exit_code` | no | integer,null | — |
| `signal` | no | string,null | — |

## `dead-letter.message`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/supervision`
- Schema: [`dead-letter-message.schema.json`](../dead-letter-message.schema.json)
- History: [`history/dead-letter.message.md`](../history/dead-letter.message.md)
- Maximum payload: 512 KiB (524288 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `source_wire` | yes | string | min length 1 |
| `target_service` | yes | string | min length 1 |
| `attempts` | yes | integer | minimum 1 |
| `original_message` | yes | object | — |
| `failure` | yes | object | — |

## `service.failure`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/supervision`
- Schema: [`service-failure.schema.json`](../service-failure.schema.json)
- History: [`history/service.failure.md`](../history/service.failure.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `service` | yes | string | min length 1 |
| `operation` | yes | string | min length 1 |
| `outcome` | yes | string | `failure` |
| `input_message_id` | no | string | min length 1 |
| `error` | yes | object | requires `code`, `category`, `message`, `retryable` |

## `workflow.completed`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/run-control`
- Schema: [`workflow-completed.schema.json`](../workflow-completed.schema.json)
- History: [`history/workflow.completed.md`](../history/workflow.completed.md)
- Maximum payload: 8 KiB (8192 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `workflow_id` | yes | string | min length 1 |
| `status` | yes | string | `completed` |
| `result_message_id` | yes | string | min length 1 |

## `transcript.segment`

- Plane: `domain`
- Version: `1.4.0`
- Owner: `transcript/active-state`
- Schema: [`transcript-segment.schema.json`](../transcript-segment.schema.json)
- History: [`history/transcript.segment.md`](../history/transcript.segment.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `segment_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `sequence` | yes | integer | minimum 0 |
| `start_time` | yes | string | min length 1 |
| `end_time` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `boundary` | yes | string | `continuation`, `pause`, `size`, `latency`, `flush` |
| `revision` | no | integer | minimum 0 |
| `original_stt_text` | no | string | min length 1 |
| `word_provenance` | no | array<object> | min items 1 |
| `formatting` | no | object | requires `source`, `provisional_until_finalized` |
| `review_flags` | no | array<object> | — |

## `transcript.context-window`

- Plane: `domain`
- Version: `1.4.0`
- Owner: `transcript/context-selection`
- Schema: [`context-window.schema.json`](../context-window.schema.json)
- History: [`history/transcript.context-window.md`](../history/transcript.context-window.md)
- Maximum payload: 256 KiB (262144 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `window_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `reason` | yes | string | `pause`, `size`, `topic`, `latency`, `flush` |
| `triggered_reasons` | no | array<string> | min items 1 |
| `segments` | yes | array<object> | min items 1 |
| `source` | yes | object | requires `first_segment_id`, `last_segment_id`, `start_time`, `end_time` |
| `context_segments` | no | array<object> | — |
| `selection` | no | object | requires `policy_id`, `policy_version`, `trigger_observed_at_sequence`, `source_segment_count`, `source_char_count`, `elapsed_ms` |
| `generation_directive` | no | object | requires `purpose`, `policy_profile`, `instruction_version`, `context_scope` |

## `logged-item.draft`

- Plane: `domain`
- Version: `1.3.0`
- Owner: `logged-items/extraction`
- Schema: [`logged-item-draft.schema.json`](../logged-item-draft.schema.json)
- History: [`history/logged-item.draft.md`](../history/logged-item.draft.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `created_at` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `revision` | yes | integer | minimum 0 |
| `revision_id` | no | string | min length 1 |
| `source` | yes | object | requires `first_segment_id`, `last_segment_id`, `start_time`, `end_time` |
| `generator` | yes | object | requires `implementation`, `input_window_id` |

## `logged-item.stored`

- Plane: `domain`
- Version: `1.3.0`
- Owner: `logged-items/active-owner`
- Schema: [`logged-item-stored.schema.json`](../logged-item-stored.schema.json)
- History: [`history/logged-item.stored.md`](../history/logged-item.stored.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `stored_at` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `revision` | yes | integer | minimum 0 |
| `revision_id` | no | string | min length 1 |
| `source` | yes | object | requires `first_segment_id`, `last_segment_id`, `start_time`, `end_time` |
| `generator` | no | object | requires `implementation`, `input_window_id` |

## `logged-item.history-append`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `logged-items/permanent-history`
- Schema: [`logged-item-history-append.schema.json`](../logged-item-history-append.schema.json)
- History: [`history/logged-item.history-append.md`](../history/logged-item.history-append.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `history_entry_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `item` | yes | any | — |
| `requested_at` | yes | string | min length 1 |

## `logged-item.history-appended`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `logged-items/permanent-history`
- Schema: [`logged-item-history-appended.schema.json`](../logged-item-history-appended.schema.json)
- History: [`history/logged-item.history-appended.md`](../history/logged-item.history-appended.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `history_entry_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `item_id` | yes | string | min length 1 |
| `revision` | yes | integer | minimum 0 |
| `revision_id` | yes | string | min length 1 |
| `appended_at` | yes | string | min length 1 |

## `logged-item.update-proposed`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `logged-items/proposal-provider`
- Schema: [`logged-item-update-proposed.schema.json`](../logged-item-update-proposed.schema.json)
- History: [`history/logged-item.update-proposed.md`](../history/logged-item.update-proposed.md)
- Maximum payload: 64 KiB (65536 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `proposal_id` | yes | string | min length 1 |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `base_revision` | yes | integer | minimum 0 |
| `proposed_text` | yes | string | min length 1 |
| `proposed_at` | yes | string | min length 1 |
| `generator` | yes | object | requires `implementation` |

## `logged-item.proposal-resolve`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `logged-items/user-command`
- Schema: [`logged-item-proposal-resolve.schema.json`](../logged-item-proposal-resolve.schema.json)
- History: [`history/logged-item.proposal-resolve.md`](../history/logged-item.proposal-resolve.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `proposal_id` | yes | string | min length 1 |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `expected_revision` | yes | integer | minimum 0 |
| `decision` | yes | string | `accepted`, `rejected` |
| `resolved_at` | yes | string | min length 1 |
| `resolver` | yes | string | — |

## `logged-item.proposal-resolved`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `logged-items/active-owner`
- Schema: [`logged-item-proposal-resolved.schema.json`](../logged-item-proposal-resolved.schema.json)
- History: [`history/logged-item.proposal-resolved.md`](../history/logged-item.proposal-resolved.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `proposal_id` | yes | string | min length 1 |
| `item_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `decision` | yes | string | `accepted`, `rejected` |
| `resolved_at` | yes | string | min length 1 |
| `result_revision` | yes | integer | minimum 0 |

## `session.record`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-record.schema.json`](../session-record.schema.json)
- History: [`history/session.record.md`](../history/session.record.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `requested_at` | yes | string | min length 1 |
| `label` | no | string | — |

## `session.recorded`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-recorded.schema.json`](../session-recorded.schema.json)
- History: [`history/session.recorded.md`](../history/session.recorded.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `state` | yes | any | — |
| `session_revision` | yes | integer | minimum 1 |
| `completed_at` | yes | string | min length 1 |
| `active_relative_path` | yes | string | min length 1 |
| `permanent_relative_path` | yes | string | min length 1 |

## `session.stop`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-stop.schema.json`](../session-stop.schema.json)
- History: [`history/session.stop.md`](../history/session.stop.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `requested_at` | yes | string | min length 1 |

## `session.stopped`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-stopped.schema.json`](../session-stopped.schema.json)
- History: [`history/session.stopped.md`](../history/session.stopped.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `state` | yes | any | — |
| `session_revision` | yes | integer | minimum 1 |
| `completed_at` | yes | string | min length 1 |

## `session.resume`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-resume.schema.json`](../session-resume.schema.json)
- History: [`history/session.resume.md`](../history/session.resume.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `requested_at` | yes | string | min length 1 |

## `session.resumed`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-resumed.schema.json`](../session-resumed.schema.json)
- History: [`history/session.resumed.md`](../history/session.resumed.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `state` | yes | any | — |
| `session_revision` | yes | integer | minimum 1 |
| `completed_at` | yes | string | min length 1 |

## `session.close`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-close.schema.json`](../session-close.schema.json)
- History: [`history/session.close.md`](../history/session.close.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `requested_at` | yes | string | min length 1 |

## `session.closed`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-lifecycle`
- Schema: [`session-closed.schema.json`](../session-closed.schema.json)
- History: [`history/session.closed.md`](../history/session.closed.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `state` | yes | any | — |
| `session_revision` | yes | integer | minimum 1 |
| `completed_at` | yes | string | min length 1 |
| `finalization_phase` | yes | any | — |
| `transcript_history_count` | yes | integer | minimum 0 |
| `logged_item_history_count` | yes | integer | minimum 0 |
| `close_evidence_id` | yes | string | min length 1 |

## `session.folder-locate`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-folder-locator`
- Schema: [`session-folder-locate.schema.json`](../session-folder-locate.schema.json)
- History: [`history/session.folder-locate.md`](../history/session.folder-locate.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `requested_at` | yes | string | min length 1 |

## `session.folder-located`

- Plane: `control`
- Version: `1.2.0`
- Owner: `runtime/session-folder-locator`
- Schema: [`session-folder-located.schema.json`](../session-folder-located.schema.json)
- History: [`history/session.folder-located.md`](../history/session.folder-located.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `operation_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `active_path` | yes | string | min length 1 |
| `permanent_path` | yes | string | min length 1 |
| `active_relative_path` | yes | string | min length 1 |
| `permanent_relative_path` | yes | string | min length 1 |

## `ui.command`

- Plane: `control`
- Version: `1.0.0`
- Owner: `ui/bridge`
- Schema: [`ui-command.schema.json`](../ui-command.schema.json)
- History: [`history/ui.command.md`](../history/ui.command.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `command_id` | yes | string | min length 1 |
| `session_id` | yes | string | — |
| `command` | yes | any | `transcript.edit`, `logged-item.edit`, `session.new`, `session.record`, `session.stop`, `session.resume`, `session.close`, `copy`, `copy-session-path`, `open-folder` |
| `segment_id` | no | string | min length 1 |
| `item_id` | no | string | min length 1 |
| `expected_revision` | no | integer | minimum 0 |
| `text` | no | string | min length 1 |
| `kind` | no | any | `transcript`, `logged-item` |
| `item_ids` | no | array<string> | min items 1 |
| `include_timestamps` | no | boolean | — |

## `ui.command-result`

- Plane: `control`
- Version: `1.0.0`
- Owner: `ui/bridge`
- Schema: [`ui-command-result.schema.json`](../ui-command-result.schema.json)
- History: [`history/ui.command-result.md`](../history/ui.command-result.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `command_id` | yes | string | min length 1 |
| `session_id` | yes | string | min length 1 |
| `command` | yes | string | min length 1 |
| `status` | yes | any | `accepted`, `rejected` |
| `owner` | no | string | min length 1 |
| `resource_id` | no | string | min length 1 |
| `revision` | no | integer | minimum 0 |
| `code` | no | string | — |
| `message` | yes | string | min length 1 |
| `pending` | no | boolean | — |

## `ui.session-status`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `ui/projection`
- Schema: [`ui-session-status.schema.json`](../ui-session-status.schema.json)
- History: [`history/ui.session-status.md`](../history/ui.session-status.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `session_id` | yes | string | min length 1 |
| `state` | yes | any | `recording`, `stopped`, `closed` |
| `elapsed_seconds` | yes | integer | minimum 0 |
| `created_at` | yes | string | min length 1 |
| `duration_seconds` | yes | integer | minimum 0 |
| `transcript_count` | yes | integer | minimum 0 |
| `logged_item_count` | yes | integer | minimum 0 |

## `ui.transcript-row`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `ui/projection`
- Schema: [`ui-transcript-row.schema.json`](../ui-transcript-row.schema.json)
- History: [`history/ui.transcript-row.md`](../history/ui.transcript-row.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `session_id` | yes | string | min length 1 |
| `segment_id` | yes | string | min length 1 |
| `revision` | yes | integer | minimum 0 |
| `sequence` | yes | integer | minimum 0 |
| `start_time` | yes | string | min length 1 |
| `end_time` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `provisional` | yes | boolean | — |
| `read_only` | yes | boolean | — |
| `review_flags` | yes | array<object> | — |

## `ui.logged-item-row`

- Plane: `domain`
- Version: `1.0.0`
- Owner: `ui/projection`
- Schema: [`ui-logged-item-row.schema.json`](../ui-logged-item-row.schema.json)
- History: [`history/ui.logged-item-row.md`](../history/ui.logged-item-row.md)
- Maximum payload: 32 KiB (32768 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `session_id` | yes | string | min length 1 |
| `item_id` | yes | string | min length 1 |
| `revision` | yes | integer | minimum 0 |
| `revision_id` | yes | string | min length 1 |
| `logged_at` | yes | string | min length 1 |
| `text` | yes | string | min length 1 |
| `source` | yes | object | requires `first_segment_id`, `last_segment_id`, `start_time`, `end_time` |
| `classification_suggestion` | yes | object,null | — |

## `ui.service-status`

- Plane: `control`
- Version: `1.0.0`
- Owner: `ui/projection`
- Schema: [`ui-service-status.schema.json`](../ui-service-status.schema.json)
- History: [`history/ui.service-status.md`](../history/ui.service-status.md)
- Maximum payload: 16 KiB (16384 bytes)

| Field | Required | Type | Constraint |
| --- | --- | --- | --- |
| `capability` | yes | any | `microphone`, `stt`, `model`, `orchestration`, `transcript`, `logged-item-pipeline`, `storage-session`, `clipboard`, `folder-opening`, `classification` |
| `status` | yes | any | `available`, `degraded`, `unavailable` |
| `message` | yes | string | min length 1 |
| `retryable` | yes | boolean | — |
| `updated_at` | yes | string | min length 1 |
