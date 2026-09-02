# Component Authoring Guide

This guide defines the minimum shape of a drop-in component for the Argus architecture proof.

## Component boundary

A component is a standalone executable plus a `service.json` manifest. It receives newline-delimited JSON envelopes on standard input, emits domain envelopes on standard output, and emits operational traces on standard error.

It must not import implementation code from another service.

The current launcher accepts Node components only, and it launches them under the Node permission model using the authority the manifest declares. The accepted system direction is polyglot and container-capable; see `../POLYGLOT-RUNTIME-STRATEGY.md` before changing manifest runtime fields, process launching, transport, packaging, or permissions. Do not describe native/container execution as implemented until the cross-runtime proof criteria there pass.

```text
service directory
├── service.json
└── index.mjs
```

## Manifest

```json
{
  "service_name": "example-service",
  "version": "1.0.0",
  "runtime": {
    "kind": "node",
    "entrypoint": "index.mjs",
    "includes": ["example-helper.mjs"],
    "environment": { "allow": ["ARGUS_SESSION_ROOT"] }
  },
  "permissions": {
    "filesystem": { "read": ["session-root"], "write": ["session-root"] }
  },
  "ports": {
    "domain": {
      "accepts": ["example.input"],
      "emits": ["example.output"]
    },
    "control": {
      "accepts": [],
      "emits": ["service.failure"]
    }
  },
  "state": "none",
  "side_effects": []
}
```

The runtime validates this against `contracts/service-manifest.schema.json`. Accepted and emitted types must exist in the contract catalog and must appear on the correct plane before they can be wired.

## Declaring authority

`permissions` is required and default-deny. A component that needs nothing declares `"permissions": {}`, and that is the common case — 16 of the 23 shipped components hold no authority at all. An omitted class, an omitted scope list, and an explicit `false` all mean the same thing: none.

| Class | Shape | Notes |
| --- | --- | --- |
| `filesystem` | `{ "read": ["session-root", "stt-runtime"], "write": ["session-root"] }` | `session-root` is read/write; `stt-runtime` is read-only and maps to the provisioned Whisper executable and model. Raw host paths are never accepted, so a manifest cannot express traversal. Requires the matching environment variables in `runtime.environment.allow`. |
| `network` | `{ "outbound": ["loopback-http"] }` | Required before `ARGUS_MODEL_ENDPOINT` may be allowlisted. `listen` is refused. |
| `process`, `worker`, `addons`, `wasi` | `{ "granted": true }` | Mapped to real Node permission flags. |
| `microphone`, `clipboard` | `{ "granted": true }` | **Refused** — no installed provider or component adapter can honor them (`AUD-002`, ADR-017). |
| `model_credentials` | `{ "granted": true }` | **Reserved** — accepted only for `serial-ai-model-lane`, where the Electron host injects an OS-backed credential at runtime (`ADR-020`). |

`resources.max_heap_mb` is applied as a Node heap ceiling. `resources.memory_mb` and `resources.cpu_limit` are refused outside a container runtime.

Declare every file the component ships. `runtime.includes` lists helper modules beside the entrypoint; packaging refuses a component directory containing a file no declaration accounts for. `npm run package:graph` builds the deterministic inventory that enforces this.

## Process protocol

1. Read one complete JSON envelope per input line.
2. Validate inputs at the local service boundary.
3. Perform exactly the capability named by the service.
4. Write one complete JSON envelope per output line.
5. Write no diagnostic or human-readable text to standard output.
6. Write structured operation traces to standard error.
7. Convert internal errors into `service.failure` outputs.
8. Remain alive until standard input closes; release owned state on exit.

Every output includes:

```text
message_id
plane
message_type
timestamp
producer
correlation_id
schema_version
payload
```

Use `causation_id` when one input message directly caused the output.

For a graph-hosted process, `producer` is the graph service-instance ID injected by the trusted runtime provider (`ARGUS_SERVICE_INSTANCE_ID` for Node). It is not the reusable manifest `service_name`. The kernel rejects a mismatched producer so several instances of one implementation cannot collide in the global message/idempotency namespace. Independent execution may fall back to `service_name` for component tests.

## Adding the component to a graph

1. Add the component manifest to `services` in a wiring graph.
2. Add each permitted producer-to-consumer edge to `domain_wires` or `control_wires`.
3. Run the wiring tests. A missing declaration or incompatible endpoint must fail before any process starts.
4. Run the component independently with a known message fixture.
5. Validate every output against the contract registry.
6. Run the complete graph.

Merely placing a component in `services/` gives it no authority and no connectivity. Runtime-owned capabilities are visible pseudo-components in the reserved `@` namespace. A component also receives no filesystem authority merely because `ARGUS_SESSION_ROOT` exists; the environment key and the corresponding side effect must be declared in its manifest.

## Replacement test

A replacement is compatible when:

- its manifest accepts and emits the contracts required by the same graph position;
- its outputs validate against the same schemas;
- downstream services and wires require no changes;
- the same integration assertions pass;
- any changed side effects or state ownership are explicitly reviewed.

`log-extractor-concise` and `log-extractor-passthrough` are the first executable example.

A future cross-language replacement must additionally pass the shared compatibility fixtures and runtime-neutral lifecycle/conformance suite without changing its consumers or graph wires.

## Pull-in checklist

- [ ] One capability with a clear name
- [ ] Independent executable entrypoint
- [ ] Valid manifest
- [ ] Explicit accepted contracts
- [ ] Explicit emitted contracts
- [ ] Explicit state ownership
- [ ] Explicit side effects
- [ ] Local valid-input test
- [ ] Local invalid-input/failure test
- [ ] Contract-valid outputs
- [ ] Structured traces
- [ ] Declared graph wires
- [ ] Integration test
- [ ] Replacement test where the capability is critical
