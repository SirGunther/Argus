# Argus Active Assistant — UI Proof of Concept

This is a zero-build HTML/CSS/JavaScript prototype for evaluating the Active Assistant desktop interface.

## Run

Open `index.html` directly in a modern browser. No package installation or local server is required.

For the smoothest clipboard behavior, serve the directory from a local server:

```powershell
npx serve .
```

## Included interactions

- Record, stop/resume, and explicit close/finalization states
- Simulated incoming transcript and neutral logged items while recording
- Editable transcript and logged content with local browser autosave
- Persistent row selection, select-all, individual copy, and ordered batch copy
- Configurable timestamp inclusion for copied text
- Independent auto-scroll behavior and jump-to-live controls for both panes
- Transcript source ranges on every logged item; selecting a range reveals the contributing transcript rows
- Top-center notifications that stay clear of incoming live content
- Session details drawer, storage preview, and finalization confirmation
- Responsive stacked-pane fallback for narrower windows

The architecture decision record in `Architecture/DesignDecisions.md` explains why extraction and optional classification are separate operations, how idle-time enrichment should work, and which transcript context belongs in each payload.

The session folder action is intentionally represented as a UI behavior in this browser-only POC. A packaged desktop application can connect that control to the operating system shell.

## Executable architecture experiment

The repository also contains a dependency-free Node proof of the atomic architecture described in `Architecture/`.

It demonstrates:

- one isolated process per service;
- explicit service manifests and default-deny domain/control wires;
- visible runtime pseudo-components for lifecycle, supervision, results, and completion;
- versioned message payload contracts;
- contract validation at the orchestration boundary;
- structured traces on standard error;
- a transcript-to-logged-item vertical slice;
- two interchangeable log-extractor implementations;
- tests for service contracts, invalid wiring, integration, and replaceability.

Only raw process-hosting mechanics remain intrinsic to the runtime kernel. See `Architecture/RuntimeKernelAndPlanes.md` for the exhaustive authority boundary and proof invariants.

Run with Node 22 or newer:

```powershell
node --test tests/service-contract.test.mjs tests/wiring.test.mjs tests/integration.test.mjs
node runtime/orchestrator.mjs wiring/demo.concise.json
node runtime/orchestrator.mjs wiring/demo.passthrough.json
```

No package installation is required. See `Architecture/FeasibilityReview.md` for the assessment and `TODO.md` for the prioritized build sequence.
