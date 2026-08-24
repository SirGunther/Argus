# Argus Project Documentation

The canonical Argus project record is:

`C:\dustin-thomason\docs\Argus`

Start with that directory's `README.md`. It indexes:

- the newest-first development changelog;
- the feature and capability catalog;
- the product and layout decision register.

Implementation-bound architecture, schemas, wiring, and tests remain in this repository. Do not create a second authoritative changelog here; update the canonical record after each implementation session.

Phase 2 supervision design and proof evidence live in `Architecture/RuntimeKernelAndPlanes.md` and `Architecture/RuntimeSupervisionEvidence.md`.

Phase 3 identity, ordering, optimistic revision, stale-result, and serial AI-lane rules live in `Architecture/IdentityOrderingAndAiLane.md`.

Phase 4 accepted behavior lives in `Architecture/DesignDecisions.md`; governed Phase 4B contracts/state ownership live in `Architecture/TranscriptContractsAndOwnership.md`; the executable Phase 4C working-document proof lives in `Architecture/TranscriptPipelinePhase4CEvidence.md`; Phase 4D context selection and replacement evidence live in `Architecture/TranscriptContextPhase4DEvidence.md`; Phase 4E behavioral/recovery evidence and its remaining active-history limitation live in `Architecture/TranscriptBehaviorPhase4EEvidence.md`; Phase 4F deterministic transport evidence lives in `Architecture/TranscriptTransportPhase4FEvidence.md`. The checklist is in `TODO.md`, and unresolved technology/product choices are centralized in `PENDING-DECISIONS.md`.

Phase 7 browser-boundary evidence lives in `Architecture/UiBoundaryPhase7Evidence.md`; Phase 8 default-deny permission, enforcement-matrix, fail-closed provider, and deterministic packaging evidence lives in `Architecture/PermissionsPackagingPhase8Evidence.md`. The Phase 8A standalone Electron integration, real capture/STT/model adapters, and Windows packaging are recorded in that same evidence file and ADR-019.

Phase 5A deterministic logged-item ownership evidence lives in `Architecture/LoggedItemPipelinePhase5AEvidence.md`; Phase 5B/5B.1 governed local HTTP/model-lane, explicit classification-context, boundary-hardening, and optional-classification evidence lives in `Architecture/LoggedItemModelPhase5BEvidence.md`; Phase 6 durable/session work and the durable globally shared AI journal remain deferred.

The preserved POC v1 comparison baseline is retained inside this repository at `archive\Argus-POC-v1-2026-08-12`, with its ZIP and SHA-256 sidecar in the same `archive` directory.
