# Component Authoring Guide

This guide defines the minimum shape of a drop-in component for the Argus architecture proof.

## Component boundary

A component is a standalone executable plus a `service.json` manifest. It receives newline-delimited JSON envelopes on standard input, emits domain envelopes on standard output, and emits operational traces on standard error.

It must not import implementation code from another service.

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
    "command": "node",
    "entrypoint": "index.mjs"
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

## Adding the component to a graph

1. Add the component manifest to `services` in a wiring graph.
2. Add each permitted producer-to-consumer edge to `domain_wires` or `control_wires`.
3. Run the wiring tests. A missing declaration or incompatible endpoint must fail before any process starts.
4. Run the component independently with a known message fixture.
5. Validate every output against the contract registry.
6. Run the complete graph.

Merely placing a component in `services/` gives it no authority and no connectivity. Runtime-owned capabilities are visible pseudo-components in the reserved `@` namespace.

## Replacement test

A replacement is compatible when:

- its manifest accepts and emits the contracts required by the same graph position;
- its outputs validate against the same schemas;
- downstream services and wires require no changes;
- the same integration assertions pass;
- any changed side effects or state ownership are explicitly reviewed.

`log-extractor-concise` and `log-extractor-passthrough` are the first executable example.

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
