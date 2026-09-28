import { CoreError, type CoreErrorCode } from "../types/errors.js";
import type { CheckRequest } from "../types/request.js";

type DataRecord = Record<string, unknown>;

/** Raw UTF-8 length, distinct from its escaped JSON-string representation. */
export function textBytes(value: string, code: CoreErrorCode, maxBytes: number): void {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new CoreError(code, "Unpaired Unicode surrogate.");
      bytes += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new CoreError(code, "Unpaired Unicode surrogate.");
    } else {
      bytes += unit < 128 ? 1 : unit < 2048 ? 2 : 3;
    }
    if (bytes > maxBytes) throw new CoreError("LIMIT_EXCEEDED", "Text input exceeds its UTF-8 byte limit.");
  }
}

export function record(value: unknown, code: CoreErrorCode): DataRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CoreError(code, "Expected a plain data object.");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new CoreError(code, "Non-plain objects are not accepted.");
  }
  return value as DataRecord;
}

/** Reads a data descriptor without invoking an accessor or inherited property. */
export function field(
  value: object, key: string, required: boolean, code: CoreErrorCode,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && !("value" in descriptor)) {
    throw new CoreError(code, "Accessors are not accepted in data inputs.");
  }
  const result: unknown = descriptor?.value;
  if (required && result === undefined) {
    throw new CoreError(code, "A required data field is missing.");
  }
  return result;
}

/** Copy before serialization: no getters, toJSON calls, cycles, or coercion. */
export function copyJson(value: unknown, code: CoreErrorCode, maxBytes: number): unknown {
  let remaining = maxBytes;
  const ancestors = new Set<object>();
  const invalid = (message: string): never => { throw new CoreError(code, message); };
  const add = (bytes: number): void => {
    remaining -= bytes;
    if (remaining < 0) throw new CoreError("LIMIT_EXCEEDED", "JSON input exceeds its byte limit.");
  };
  const string = (input: string): string => {
    add(2);
    for (let i = 0; i < input.length; i++) {
      const unit = input.charCodeAt(i);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = input.charCodeAt(++i);
        if (!(next >= 0xdc00 && next <= 0xdfff)) invalid("Unpaired Unicode surrogate.");
        add(4);
      } else if (unit >= 0xdc00 && unit <= 0xdfff) {
        invalid("Unpaired Unicode surrogate.");
      } else if (unit === 34 || unit === 92) {
        add(2);
      } else if (unit < 32) {
        add([8, 9, 10, 12, 13].includes(unit) ? 2 : 6);
      } else {
        add(unit < 128 ? 1 : unit < 2048 ? 2 : 3);
      }
    }
    return input;
  };
  const copy = (input: unknown, depth: number): unknown => {
    if (input === null) { add(4); return null; }
    if (typeof input === "string") return string(input);
    if (typeof input === "boolean") { add(input ? 4 : 5); return input; }
    if (typeof input === "number") {
      if (!Number.isFinite(input) || (Number.isInteger(input) && !Number.isSafeInteger(input))) {
        invalid("Numbers must be finite and integers must be JS-safe.");
      }
      add(JSON.stringify(input).length);
      return input;
    }
    if (typeof input !== "object") invalid("Only JSON data is accepted.");
    if (depth >= 128) throw new CoreError("LIMIT_EXCEEDED", "JSON nesting exceeds the depth limit.");
    const object = input as object;
    if (ancestors.has(object)) invalid("Cyclic data is not accepted.");
    ancestors.add(object);
    try {
      add(2);
      if (Array.isArray(object)) {
        const prototype = Object.getPrototypeOf(object);
        if (prototype !== Array.prototype && prototype !== null) invalid("Non-plain arrays are not accepted.");
        const lengthDescriptor = Object.getOwnPropertyDescriptor(object, "length");
        const length: unknown = lengthDescriptor?.value;
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || length > 0xffff_ffff) {
          invalid("Array length must be a valid data property.");
        }
        const size = length as number;
        if (size > remaining + 1) add(size);
        const descriptors = Object.getOwnPropertyDescriptors(object);
        const keys = Reflect.ownKeys(descriptors);
        if (keys.length !== size + 1) invalid("Arrays must contain only contiguous JSON elements.");
        const result: unknown[] = [];
        // Prevent inherited toJSON hooks when this private copy is serialized.
        Object.setPrototypeOf(result, null);
        for (let i = 0; i < size; i++) {
          const descriptor = descriptors[String(i)];
          if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
            invalid("Array holes and accessors are not accepted.");
          }
          if (i) add(1);
          result[i] = copy(descriptor.value, depth + 1);
        }
        return result;
      }
      record(object, code);
      const result: DataRecord = Object.create(null) as DataRecord;
      const descriptors = Object.getOwnPropertyDescriptors(object);
      let count = 0;
      for (const key of Reflect.ownKeys(descriptors)) {
        if (typeof key !== "string") invalid("Symbol keys are not JSON data.");
        const descriptor = descriptors[key as string];
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          invalid("Hidden properties and accessors are not accepted.");
        }
        if (count++) add(1);
        string(key as string);
        add(1);
        result[key as string] = copy(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(object);
    }
  };
  try {
    return copy(value, 0);
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError(code, "Input data could not be copied safely.");
  }
}

export function requestJson(input: CheckRequest, maxBytes: number): string {
  try {
    const source = record(input, "INVALID_REQUEST");
    const kind = field(source, "kind", true, "INVALID_REQUEST");
    if (typeof kind !== "string") throw new CoreError("INVALID_REQUEST", "Request kind must be a string.");
    let required: readonly string[];
    let optional: readonly string[];
    switch (kind) {
      case "transaction": required = ["chainId", "from"]; optional = ["to", "data", "value"]; break;
      case "typed_signature": required = ["chainId", "from", "typedData"]; optional = []; break;
      case "untyped_signature": required = ["message"]; optional = ["from"]; break;
      case "venue_order": required = ["from", "order"]; optional = ["chainId"]; break;
      default: throw new CoreError("UNSUPPORTED_REQUEST", "This request kind is not supported.");
    }
    const selected: DataRecord = Object.create(null) as DataRecord;
    selected.kind = kind;
    for (const key of [...required, ...optional]) {
      const value = field(source, key, required.includes(key), "INVALID_REQUEST");
      if (value === undefined) continue;
      if (key !== "typedData" && key !== "order" && typeof value !== "string") {
        throw new CoreError("INVALID_REQUEST", "Request text fields must be strings.");
      }
      selected[key] = value;
    }
    return JSON.stringify(copyJson(selected, "INVALID_REQUEST", maxBytes));
  } catch (error) {
    if (error instanceof CoreError) throw error;
    throw new CoreError("INVALID_REQUEST", "Request data could not be copied safely.");
  }
}

export function freezeTree<T>(value: T): T {
  const pending: unknown[] = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current !== "object" || current === null || Object.isFrozen(current)) continue;
    for (const child of Object.values(current)) pending.push(child);
    Object.freeze(current);
  }
  return value;
}
