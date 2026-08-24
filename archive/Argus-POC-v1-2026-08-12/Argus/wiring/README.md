# Wiring

Each graph names service instances and visible runtime pseudo-components, then declares every permitted edge in `domain_wires` or `control_wires`. The orchestrator rejects the graph before starting processes when a contract uses the wrong plane, a producer does not emit it, a consumer does not accept it, or a required lifecycle/failure/completion path is absent.

The two demo graphs are identical except for the manifest occupying the `log-extractor` position. Their shared integration test is the initial replaceability proof.
