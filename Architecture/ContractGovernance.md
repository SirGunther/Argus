# Contract Governance

## Status

Accepted and implemented through the Phase 3 architecture proof on 2026-08-12.

## Problem → requirement → solution

**Problem:** A replaceable service architecture cannot safely evolve when contract ownership, compatibility, validation, size, failure shape, and history are informal.

**Requirement:** A graph must reject contracts it cannot safely understand before domain behavior runs, while preserving replay of older compatible messages and making every breaking decision visible.

**Solution:** The contract catalog is the executable governance authority. It declares semantic versions, plane, owner, schema, payload limit, and changelog for every message type. A single maintained Ajv validator instance compiles JSON Schema once at registry load and validates all envelopes, payloads, manifests, and graphs at the runtime boundary.

## Compatibility policy

Versions use `MAJOR.MINOR.PATCH`.

- A consumer registered for `1.1.0` accepts valid `1.0.x` and `1.1.x` messages.
- A consumer rejects a different major version.
- A consumer rejects a newer minor version because it cannot claim knowledge of that contract.
- Patch changes clarify documentation, examples, or validation defects without intentionally changing the accepted data set.
- Minor changes are backward-compatible and additive only.
- Major changes include removing or renaming a field, making an optional field required, narrowing an accepted value/range, changing meaning, or moving the contract between planes.

Minor 1.1 added the optional envelope `extensions` object. Extension keys must be reverse-domain-style namespaced keys such as `argus.trace.sampled`; extensions may not alter core message semantics.

Minor 1.2 requires UUID-v4 message identity, a stable idempotency key, and a canonical semantic content fingerprint for all newly emitted messages. Retained 1.0 fixtures remain valid under the backward-compatible policy. Identity conflicts fail at the boundary rather than being treated as ordinary duplicates.

## Plane is part of contract identity

The declared `plane` is governed alongside schema and version. Moving a message between `domain` and `control` is always breaking and requires:

1. A new contract major version (or a new message type during migration).
2. Updated producer and consumer ports.
3. Updated graph wires.
4. A changelog entry explaining the migration.
5. Compatibility and negative plane tests.

Payload equality never makes a cross-plane move compatible.

## Ownership and history

Every catalog message entry must declare:

- `owner`: the bounded capability accountable for semantic and lifecycle changes;
- `version`: current semantic version;
- `plane`: domain or control;
- `schema`: machine-readable payload schema;
- `max_payload_bytes`: UTF-8 JSON payload limit;
- `changelog`: append-only, message-specific history.

An owner approves compatibility classification. Generated documentation exposes this metadata but never replaces the source catalog or message history.

## Validation boundary

Argus uses the maintained `ajv` package in the runtime contract registry, not a dedicated validation process in Phase 1.

This keeps validation in the one boundary already responsible for routing trust decisions, compiles schemas once per graph load, and avoids adding a validation-service wire and failure dependency to every message path. Services still perform narrow defensive checks so they remain independently runnable; the registry is the authoritative graph boundary.

A dedicated validation service should be reconsidered only if validation needs independent scaling, a separate trust zone, cross-language remote access, or independently deployable policy. None is demonstrated by this POC.

## Payload size policy

The registry measures `Buffer.byteLength(JSON.stringify(payload), 'utf8')` before accepting an envelope.

- The catalog has a 64 KiB default.
- Every current message declares an explicit limit.
- Context windows receive 256 KiB; individual transcript segments receive 32 KiB.
- Exceeding a limit is a contract-validation failure and the message is not routed.
- Limits apply to payloads, not transport framing. A future transport phase must also enforce a bounded input line before parsing to prevent allocation abuse.

## Canonical failure outcome

`service.failure` is the canonical current failure outcome. It is a control-plane fact emitted by the service that could not complete an operation and routed only over declared supervision wires.

Required shape:

- `outcome: "failure"`;
- service and operation identity;
- optional input message ID;
- stable uppercase error `code`;
- category: validation, conflict, dependency, timeout, unavailable, or internal;
- safe human-readable message;
- explicit retryability;
- optional structured details.

Raw stack traces and secrets do not belong in the message. Diagnostics may contain deeper local detail on standard error. Success remains domain-specific (`logged-item.stored`) or control-specific (`workflow.completed`). `operation.completed` is the terminal receipt used by supervision. `operation.rejected` is a distinct, nonfatal terminal outcome for a stale command, stale derived result, or late ordered input. It clears pending work and remains observable without misrepresenting a valid rejection as component failure.

## Change procedure

1. Edit the schema and catalog metadata.
2. Classify the change as patch, compatible minor, or breaking major.
3. Prepend a message-specific changelog entry.
4. Add/update versioned compatibility fixtures.
5. Run `npm run contracts:check`.
6. Regenerate `contracts/generated/contract-reference.md` with `npm run contracts:docs`.
7. Run the full `npm test` regression gate.
8. Update the canonical Argus project changelog.
