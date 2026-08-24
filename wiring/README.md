# Wiring

Each graph names service instances and visible runtime pseudo-components, then declares every permitted edge in `domain_wires` or `control_wires`. The orchestrator rejects the graph before starting processes when a contract uses the wrong plane, a producer does not emit it, a consumer does not accept it, or a required lifecycle/failure/completion path is absent.

The graph also declares required/optional status, restart recovery, readiness/drain control paths, operation receipts, provider exit reporting, queue bounds, timeouts, opt-in retry, and dead-letter routing. Omitting one of those relationships removes the capability; the kernel does not synthesize a substitute path.

The two demo graphs are identical except for the manifest occupying the `log-extractor` position. Their shared integration test remains the initial replaceability proof.
