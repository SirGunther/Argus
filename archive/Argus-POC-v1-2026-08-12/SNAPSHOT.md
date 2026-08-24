# Argus Executable Architecture POC Snapshot

## Snapshot identity

| Field | Value |
| --- | --- |
| Snapshot | `Argus-POC-v1-2026-08-12` |
| Captured | 2026-08-12, America/New_York |
| Source | `C:\Users\dktho\OneDrive\PDProjects\Argus` |
| Runtime used | Node.js 24.11.1 |
| Source files | 47 |
| Source bytes | 188,103 |
| Test result | 20 passed, 0 failed |

This directory is a historical snapshot, not the live development project. Continue implementation in the original `Argus` folder. Do not update this copy to match later work; create a new named snapshot instead.

## Purpose

This archive preserves the first executable proof of the Argus atomic architecture after its domain/control-plane ambiguity was resolved. It exists for later comparison with the final system: structure, contracts, ergonomics, performance, failure behavior, and architectural drift can all be evaluated against this baseline.

## What this POC proves

- Each application service is a separate Node process.
- Services do not import implementations from neighboring services.
- Service manifests are validated executable contracts.
- Connectivity is default-deny and exists only through declared wires.
- Domain and control contracts occupy separate manifest ports and graph wires.
- Runtime responsibilities are visible as `@session-controller`, `@supervisor`, `@result-collector`, and `@run-controller`.
- The runtime kernel has a documented finite intrinsic authority.
- Invalid payloads and invalid topology are rejected explicitly.
- Transcript provenance survives context selection, extraction, and storage.
- Two extractor implementations can occupy the same graph position without changing downstream services.
- Removing lifecycle, failure, result, or completion wiring makes the corresponding capability unavailable.
- A real emitted `service.failure` travels through its declared control wire to the visible supervisor.

## Intentionally unresolved at this snapshot

- Contract versioning, ownership, compatibility policy, and deprecation governance
- Full JSON Schema implementation choice
- Payload size limits
- Health/readiness, bounded queues, backpressure, retry, dead-letter, and restart policies
- Duplicate, late, and out-of-order message handling
- Persistent transcript, logged-item, and session state
- Crash recovery and idempotent session finalization
- Real audio capture, speech recognition, and model adapters
- UI-to-service projection boundary
- Per-service operating-system permissions
- Production packaging and transport selection

See `Argus/TODO.md` for the complete build sequence as it existed at capture time.

## Historical strengths to compare

- Unusually clear authority boundaries
- Visible and inspectable application topology
- Black-box component testing
- Replaceability demonstrated through behavior rather than asserted in documentation
- Failure and provenance identities carried through messages
- Zero dependency installation for the architectural proof

## Historical weaknesses to compare

- Process and protocol boilerplate is duplicated across services.
- The lightweight schema validator implements only the subset needed by the POC.
- Standard input/output transport has limited queue and backpressure semantics.
- Runtime pseudo-component behavior is implemented inside the kernel, even though its ports and wiring are visible.
- In-memory storage does not prove persistence or recovery behavior.
- The experiment has not yet measured memory cost, startup cost, throughput, or routing latency as process count grows.
- Raw process exit remains a kernel-observed operating-system event; its future policy contract is unresolved.

## Verify this snapshot

From the snapshot directory:

```powershell
cd .\Argus
node --test tests/service-contract.test.mjs tests/wiring.test.mjs tests/integration.test.mjs
node runtime/orchestrator.mjs wiring/demo.concise.json
node runtime/orchestrator.mjs wiring/demo.passthrough.json
```

Expected architectural test summary:

```text
tests 20
pass 20
fail 0
```

To verify file integrity, recompute SHA-256 for each file listed in `SHA256SUMS.txt`. The ZIP’s checksum is stored beside the ZIP rather than inside this folder.

## Archive policy

The folder and ZIP are marked read-only as an accidental-edit deterrent. This is not cryptographic immutability. The SHA-256 manifest makes later changes detectable; durable version history should eventually move into source control or append-only artifact storage.

