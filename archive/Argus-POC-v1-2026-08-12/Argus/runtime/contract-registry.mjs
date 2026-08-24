import { readFile } from 'node:fs/promises';
import path from 'node:path';

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
  const envelopeSchema = await readJson(path.resolve(catalogDirectory, catalog.envelope));
  const messageSchemas = new Map();
  const artifactSchemas = new Map();

  for (const [artifactType, relativeSchemaPath] of Object.entries(catalog.artifacts || {})) {
    artifactSchemas.set(artifactType, await readJson(path.resolve(catalogDirectory, relativeSchemaPath)));
  }

  for (const [messageType, definition] of Object.entries(catalog.messages)) {
    messageSchemas.set(messageType, {
      plane: definition.plane,
      schema: await readJson(path.resolve(catalogDirectory, definition.schema))
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
    validateEnvelope(message) {
      const errors = validateAgainstSchema(message, envelopeSchema, '$');
      if (!errors.length && !messageSchemas.has(message.message_type)) {
        errors.push(`$.message_type has no registered payload contract: ${message.message_type}`);
      }
      if (!errors.length) {
        const definition = messageSchemas.get(message.message_type);
        if (message.plane !== definition.plane) {
          errors.push(`$.plane must be ${definition.plane} for ${message.message_type}; received ${message.plane}`);
        }
        errors.push(...validateAgainstSchema(message.payload, definition.schema, '$.payload'));
      }
      return errors;
    },
    assertEnvelope(message) {
      const errors = this.validateEnvelope(message);
      if (errors.length) throw new ContractValidationError(message?.message_type || 'unknown', errors);
      return message;
    },
    validateArtifact(artifactType, artifact) {
      const schema = artifactSchemas.get(artifactType);
      if (!schema) return [`No registered artifact contract: ${artifactType}`];
      return validateAgainstSchema(artifact, schema, '$');
    },
    assertArtifact(artifactType, artifact) {
      const errors = this.validateArtifact(artifactType, artifact);
      if (errors.length) throw new ContractValidationError(artifactType, errors);
      return artifact;
    }
  };
}

export function validateAgainstSchema(value, schema, location = '$') {
  const errors = [];
  const expectedType = schema.type;

  if (expectedType && !matchesType(value, expectedType)) {
    return [`${location} must be ${expectedType}; received ${describeType(value)}`];
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${location} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`);
  }

  if (expectedType === 'string' && schema.minLength !== undefined && value.length < schema.minLength) {
    errors.push(`${location} must contain at least ${schema.minLength} character(s)`);
  }

  if ((expectedType === 'number' || expectedType === 'integer') && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${location} must be at least ${schema.minimum}`);
  }

  if (expectedType === 'array') {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} item(s)`);
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items, `${location}[${index}]`)));
    }
  }

  if (expectedType === 'object') {
    const required = schema.required || [];
    for (const property of required) {
      if (!Object.prototype.hasOwnProperty.call(value, property)) errors.push(`${location}.${property} is required`);
    }

    const properties = schema.properties || {};
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, property)) {
        errors.push(...validateAgainstSchema(value[property], propertySchema, `${location}.${property}`));
      }
    }

    if (schema.additionalProperties === false) {
      for (const property of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(properties, property)) errors.push(`${location}.${property} is not allowed`);
      }
    }
  }

  return errors;
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function matchesType(value, expectedType) {
  switch (expectedType) {
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'array': return Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    default: return true;
  }
}

function describeType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
