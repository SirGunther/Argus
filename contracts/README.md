# Contracts

The catalog is the executable source of truth for message plane, semantic version, owner, schema, maximum payload size, and message-specific changelog.

See `../Architecture/ContractGovernance.md` for the compatibility and failure policies. Do not hand-edit `generated/contract-reference.md`; regenerate it from the catalog and schemas.

```powershell
npm run contracts:check
npm run contracts:docs
npm run contracts:docs:check
```

Compatibility fixtures live under `tests/fixtures/contracts/<message-type>/<version>/valid.json`. They are retained when the catalog advances so newer consumers continuously prove backward compatibility.

`catalog.json` maps every routable `message_type` to its versioned payload schema. `envelope.schema.json` defines metadata carried by every message. The catalog also registers executable architecture contracts for service manifests and wiring graphs.

Every registered message declares its `domain` or `control` plane. The plane is repeated in the envelope and must match the catalog. Moving a contract between planes is a breaking change.

The runtime compiles Draft 7 JSON Schema with Ajv. Phase 4B also registers a narrow semantic-invariant validator for `audio.chunk`, because equality among decoded byte length, PCM16 sample count, canonical base64, and the byte checksum is not expressible in the payload schema. Services still perform local defensive checks so they remain independently runnable.

Phase 4B contract and ownership rationale lives in `../Architecture/TranscriptContractsAndOwnership.md`; retryable and terminal operation mappings live in `operation-outcomes.md`.
