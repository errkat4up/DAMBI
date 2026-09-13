// Fixture-only evaluator for the keywords used by policy-wire.schema.json.
// Not a general JSON Schema library or the C3 strict parser/security boundary.
import { readFileSync } from "node:fs";

export const schema = JSON.parse(readFileSync(new URL("../policy-wire.schema.json", import.meta.url), "utf8"));
const keywords = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description", "type", "const",
  "required", "properties", "additionalProperties", "items", "minItems",
  "minLength", "pattern", "minimum", "maximum",
]);
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

function definition(ref) {
  const name = ref?.match(/^#\/\$defs\/([^/]+)$/)?.[1];
  if (!name || !Object.hasOwn(schema.$defs, name)) throw new Error(`Unsupported schema reference: ${ref}`);
  return schema.$defs[name];
}

function inspect(node) {
  if (!object(node)) throw new Error("Only object schemas are supported by this fixture helper");
  for (const key of Object.keys(node)) {
    if (!keywords.has(key)) throw new Error(`Unsupported schema keyword: ${key}`);
  }
  if (node.$ref) definition(node.$ref);
  for (const child of Object.values(node.$defs ?? {})) inspect(child);
  for (const child of Object.values(node.properties ?? {})) inspect(child);
  if (node.items) inspect(node.items);
  if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean") {
    throw new Error("Schema-valued additionalProperties requires extending the fixture helper");
  }
}
inspect(schema); // Fail on unsupported extensions instead of silently skipping their checks.

function matches(type, value) {
  switch (type) {
    case "null": return value === null;
    case "object": return object(value);
    case "array": return Array.isArray(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "string": return typeof value === "string";
    case "boolean": return typeof value === "boolean";
    default: throw new Error(`Unsupported schema type: ${type}`);
  }
}

function validate(node, value, path, errors) {
  if (node.$ref) validate(definition(node.$ref), value, path, errors);
  const types = node.type === undefined ? [] : Array.isArray(node.type) ? node.type : [node.type];
  if (types.length && !types.some(type => matches(type, value))) {
    errors.push(`${path}: type`);
    return;
  }
  // This contract uses only scalar const values.
  if (Object.hasOwn(node, "const") && value !== node.const) errors.push(`${path}: const`);
  if (typeof value === "string") {
    if (node.minLength !== undefined && [...value].length < node.minLength) errors.push(`${path}: minLength`);
    if (node.pattern !== undefined && !new RegExp(node.pattern, "u").test(value)) errors.push(`${path}: pattern`);
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: minimum`);
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path}: maximum`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path}: minItems`);
    if (node.items) value.forEach((item, index) => validate(node.items, item, `${path}/${index}`, errors));
  }
  if (object(value)) {
    for (const key of node.required ?? []) {
      if (!Object.hasOwn(value, key)) errors.push(`${path}/${key}: required`);
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      if (Object.hasOwn(value, key)) validate(child, value[key], `${path}/${key}`, errors);
    }
    if (node.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(node.properties ?? {}, key)) errors.push(`${path}/${key}: additionalProperties`);
      }
    }
  }
}

export function structureErrors(envelope) {
  const errors = [];
  validate(schema, envelope, "$", errors);
  if (typeof envelope?.payload !== "string") return errors;
  let payload;
  try {
    payload = JSON.parse(envelope.payload);
  } catch {
    return [...errors, "$/payload: invalid_json"];
  }
  validate(schema.$defs.payload, payload, "$/payload", errors);
  return errors;
}
