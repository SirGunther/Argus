import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { assertCatalogGovernance, assertMessageGovernance, compareContractVersions } from './contract-governance.mjs';
import { assertCurrentMessageIdentity } from './message-identity.mjs';
import { validatePayloadInvariants } from '../contracts/payload-invariants.mjs';

const require = createRequire(import.meta.url);
const Ajv = require('ajv');

export class ContractValidationError extends Error {
  constructor(messageType, errors) {
    super(`Contract validation failed for ${messageType}: ${errors.join('; ')}`);
    this.name = 'ContractValidationError';
    this.messageType = messageType;
    this.errors = errors;
  }
}

export async function loadContractRegistry(catalogPath) {
  const absoluteCatalogPath = path.resolve(catalogPath);
  const catalogDirectory = path.dirname(absoluteCatalogPath);
  const catalog = await readJson(absoluteCatalogPath);
  assertCatalogGovernance(catalog);

  const ajv = new Ajv({ allErrors: true, strict: true });
  const envelopeSchema = await readJson(path.resolve(catalogDirectory, catalog.envelope));
  const validateEnvelopeShape = ajv.compile(envelopeSchema);
  const messageSchemas = new Map();
  const artifactSchemas = new Map();

  for (const [artifactType, relativeSchemaPath] of Object.entries(catalog.artifacts || {})) {
    artifactSchemas.set(artifactType, ajv.compile(await readJson(path.resolve(catalogDirectory, relativeSchemaPath))));
  }

  for (const [messageType, definition] of Object.entries(catalog.messages)) {
    assertMessageGovernance(messageType, definition, catalog.governance);
    messageSchemas.set(messageType, {
      ...definition,
      validate: ajv.compile(await readJson(path.resolve(catalogDirectory, definition.schema)))
    });
  }

  return {
    catalog,
    hasMessageType(messageType) {
      return messageSchemas.has(messageType);
    },
    planeFor(messageType) {
      return messageSchemas.get(messageType)?.plane;
    },
    definitionFor(messageType) {
      return messageSchemas.get(messageType);
    },
    validateEnvelope(message) {
      const errors = runValidator(validateEnvelopeShape, message);
      if (!errors.length && !messageSchemas.has(message.message_type)) {
        errors.push(`$.message_type has no registered payload contract: ${message.message_type}`);
      }
      if (!errors.length) {
        const definition = messageSchemas.get(message.message_type);
        if (message.plane !== definition.plane) {
          errors.push(`$.plane must be ${definition.plane} for ${message.message_type}; received ${message.plane}`);
        }
        const compatibility = compareContractVersions(message.schema_version, definition.version);
        if (!compatibility.compatible) errors.push(`$.schema_version ${compatibility.reason}`);
        const payloadBytes = byteLength(message.payload);
        if (payloadBytes > definition.max_payload_bytes) {
          errors.push(`$.payload is ${payloadBytes} bytes; maximum for ${message.message_type} is ${definition.max_payload_bytes} bytes`);
        }
        errors.push(...runValidator(definition.validate, message.payload, '$.payload'));
        if (!errors.length) errors.push(...validatePayloadInvariants(message.message_type, message.payload));
        try {
          assertCurrentMessageIdentity(message);
        } catch (error) {
          errors.push(`$.identity ${error.code || 'INVALID_IDENTITY'}: ${error.message}`);
        }
      }
      return errors;
    },
    assertEnvelope(message) {
      const errors = this.validateEnvelope(message);
      if (errors.length) throw new ContractValidationError(message?.message_type || 'unknown', errors);
      return message;
    },
    validateArtifact(artifactType, artifact) {
      const validate = artifactSchemas.get(artifactType);
      if (!validate) return [`No registered artifact contract: ${artifactType}`];
      return runValidator(validate, artifact);
    },
    assertArtifact(artifactType, artifact) {
      const errors = this.validateArtifact(artifactType, artifact);
      if (errors.length) throw new ContractValidationError(artifactType, errors);
      return artifact;
    }
  };
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function runValidator(validate, value, prefix = '$') {
  if (validate(value)) return [];
  return (validate.errors || []).map((error) => {
    const location = `${prefix}${error.instancePath || ''}`.replaceAll('/', '.');
    if (error.keyword === 'required') return `${location}.${error.params.missingProperty} is required`;
    if (error.keyword === 'additionalProperties') return `${location}.${error.params.additionalProperty} is not allowed`;
    return `${location} ${error.message}`;
  });
}
