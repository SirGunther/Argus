# `ai.provider-configure`

Plane: `control`
Owner: `runtime/ai-provider-settings`
Version: `1.0.0`

The trusted Electron host sends the one active, validated provider configuration to the serial AI
model lane at runtime. Non-secret settings are persisted by the host separately. When an external
provider is active, the optional credential value is delivered only in this in-memory control
message to the authorized model adapter; it is never returned to the renderer, persisted in the
settings JSON, or included in model-request provenance or diagnostics.
