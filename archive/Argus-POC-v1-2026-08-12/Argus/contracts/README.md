# Contracts

`catalog.json` maps every routable `message_type` to its versioned payload schema. `envelope.schema.json` defines metadata carried by every message. The catalog also registers executable architecture contracts for service manifests and wiring graphs.

Every registered message declares its `domain` or `control` plane. The plane is repeated in the envelope and must match the catalog. Moving a contract between planes is a breaking change.

The initial runtime validates the JSON Schema subset used by these contracts: object, array, string, number/integer, boolean, required fields, enums, minimums, item counts, and additional-property rules. Services also perform local boundary checks so they remain independently runnable.

The lightweight validator is deliberate for the zero-dependency proof. Choosing a full schema validator and formal compatibility policy remains a to-do before production use.
