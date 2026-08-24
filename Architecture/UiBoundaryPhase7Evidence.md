# Phase 7 UI Boundary Evidence

## Status

Implemented as one cohesive batch on 2026-08-19. The HTML POC now consumes only validated browser projections from a loopback-only Node bridge. It does not read service memory, storage files, session folders, or internal journals.

## Projection contracts

The catalog now registers 53 governed messages, including these browser-facing contracts:

| Contract | Purpose | Authority exposed |
| --- | --- | --- |
| `ui.session-status` | Session state, elapsed time, counts, and identity | Read-only lifecycle projection |
| `ui.transcript-row` | Provisional/final transcript rows, revision identity, review flags | Read-only projection; finalized edits route to transcript owner |
| `ui.logged-item-row` | Logged text, revision identity, and exact source range | Read-only projection; edits route to logged-item owner |
| `ui.service-status` | Individual service/capability availability and retryability | Read-only degraded-state projection |
| `ui.command` | Closed inbound command vocabulary | Browser-to-bridge request boundary |
| `ui.command-result` | Accepted/rejected result required by the UI | Read-only outcome projection |

`ui.logged-item-row.source` requires stable `first_segment_id` and `last_segment_id` plus exact start/end timestamps. The browser highlights source rows by those IDs and never infers provenance from timestamps. A missing source is rendered as rejected/degraded.

## Bridge and ownership

`npm.cmd run demo:ui` starts `ui/bridge.mjs`, which binds only to `127.0.0.1` by default. It serves an allowlist of the HTML/CSS/browser module and three API surfaces: bootstrap projections, SSE projection events, and validated commands. There is no arbitrary file route, path parameter, authentication, remote host, framework, or added package.

Transcript and logged-item edits are accepted only with the current expected revision. The deterministic owner adapters return `STALE_REVISION`, validation, provisional-read-only, missing-identity, and session-conflict outcomes without overwriting newer state. Command IDs are fingerprinted and replayed idempotently; contradictory reuse is rejected.

Copy commands carry ordered row identities and the UI timestamp preference. The bridge resolves current text and routes it through a replaceable clipboard capability. Folder commands carry only the session identity; the authorized folder capability resolves the configured session location. Deterministic tests use fakes and never touch the real clipboard or Explorer.

## UI-owned state

Selection, select-all, timestamp preference, independent transcript/logged-item following, unseen counts, jump-to-live, expanded presentation, and transient toasts remain in `app.js`/`ui/ui-state.mjs`. They are not sent as authoritative transcript, logged-item, or session records. Incoming live content auto-scrolls only the pane already following live content.

Provisional transcript rows are read-only. Finalized rows become editable only after the owner projection is accepted. Classification is represented as an optional suggestion field and does not authorize or block logged-item editing.

## Degraded behavior

The bridge exposes independent status chips for transcript, logged-item pipeline, storage/session, clipboard, folder opening, and optional classification. The deterministic browser demo intentionally reports in-memory storage/session and optional classification as unavailable. Clipboard and folder availability reflect the installed host capability. A classification failure does not disable transcript or logged-item editing.

## Focused evidence

```text
node --test tests/ui-boundary.test.mjs tests/ui-dom-bindings.test.mjs  # 7 passing
npm.cmd run demo:ui:smoke                    # 24 projections + lifecycle/edit/copy command flow
npm.cmd test                                  # 114 passing
npm.cmd run contracts:check                   # 53 governed messages
npm.cmd run contracts:docs:check              # current
```

The focused tests prove valid/invalid projections and commands, no arbitrary path command, accepted/stale owner edits, ordered copy and session-identity folder routing through fakes, independent UI selection/auto-scroll, deterministic loopback startup, and complete required-element registry/selector alignment. The complete regression passed 114 tests; contract governance passed for 53 messages; generated documentation is current.

## 2026-08-21 browser validation correction

Hands-on review exposed a startup exception before bootstrap: `app.js` used `els.includeTimestamps` without registering the existing `#includeTimestamps` element. The correction registers and guards all required singleton UI elements with a named startup error, maps the UI's internal `derived` copy kind to the governed `logged-item` command value, and exposes the local bridge itself as an explicit connecting/available/unavailable footer status. The Stop control now identifies itself as session-recording control, while the README identifies terminal `Ctrl+C` as the bridge shutdown action.

A transient Playwright 1.62.1 run against installed Google Chrome passed 1/1 in 11.7 seconds. It exercised browser bootstrap and SSE, deterministic live transcript and logged-item arrival, transcript/logged-item edits, exact provenance highlighting, selection, timestamped and untimestamped copy through a fake capability, Stop preservation, Resume, Close sealing, top-positioned toasts, disconnect visibility, and zero page errors. Playwright remains absent from the project dependency graph. D1 through D5 remain user-revalidation decisions rather than being changed by automation.

## Deliberate limits

This remains a deterministic local POC. It does not add Electron, Tauri, a desktop package, authentication, remote hosting, a database, real microphone/STT/model integrations, broad Phase 8 permissions, or Phase 9 observability. `APP-001` remains unresolved. `UI-001` remains evidence-needed because the implementation preserves review flags and a quiet degraded treatment but does not select a final ambiguity-review visual treatment.
