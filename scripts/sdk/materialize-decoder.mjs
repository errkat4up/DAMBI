/** Pure Registry source-context materialization; no I/O or runtime enrichment. */

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isSourcePlaceholder = (value) => typeof value === "string"
  && (value === "$source" || value.startsWith("$source."));
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const SELECTOR_RE = /^0x[0-9a-fA-F]{8}$/;

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cloneValue(nested)]));
  }
  return value;
}

/** Lookup only supplied properties; inherited prototype members are never context. */
export function lookupSourcePath(context, path) {
  let current = context;
  for (const segment of path.split(".")) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || !own(current, index)) return undefined;
      current = current[index];
    } else if (isRecord(current) && own(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

export function substituteSourcePlaceholders(value, context) {
  if (typeof value === "string") {
    if (!value.startsWith("$source.")) return value;
    const resolved = lookupSourcePath(context, value.slice("$source.".length));
    if (resolved === undefined) throw new Error(`unknown source placeholder ${JSON.stringify(value)}`);
    return cloneValue(resolved);
  }
  if (Array.isArray(value)) return value.map((item) => substituteSourcePlaceholders(item, context));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key, substituteSourcePlaceholders(nested, context),
    ]));
  }
  return value;
}

export function sanitizeIdSuffix(value) {
  return value.toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/^-+|-+$/g, "");
}

export function appendIdSuffix(id, suffix) {
  const clean = sanitizeIdSuffix(suffix);
  if (!clean) throw new Error(`source_materialize produced empty id suffix for ${id}`);
  const at = id.lastIndexOf("@");
  return at === -1 ? `${id}/${clean}` : `${id.slice(0, at)}/${clean}${id.slice(at)}`;
}

/** Preserve the Registry resolver contract: authoritative route fields overwrite context. */
export function buildSourceContext(chainId, entry) {
  return {
    ...(entry.context ?? {}),
    address: entry.address,
    chainId,
    id_suffix: entry.id_suffix ?? `${chainId}-${entry.address}`,
  };
}

function materialize(template, context, chainId, address, selector) {
  const substituted = substituteSourcePlaceholders(template, context);
  const { match: _match, source_materialize: _sourceMaterialize, ...rest } = substituted;
  return {
    ...rest,
    id: appendIdSuffix(String(rest.id), String(context.id_suffix)),
    match: { selector, chain_to_addresses: { [String(chainId)]: [address] } },
  };
}

/** Existing build-index behavior for its already validated manifest/resolver input. */
export function buildMaterializedFromSource(bundle, sourced, chainId, entry) {
  return materialize(bundle, buildSourceContext(chainId, entry), chainId, entry.address, sourced.selector);
}

function assertStaticJson(value, path, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null || ancestors.has(value)) {
    throw new Error(`${path}: expected static JSON data`);
  }
  const prototype = Object.getPrototypeOf(value);
  if ((!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0) {
    throw new Error(`${path}: expected static JSON data`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length) throw new Error(`${path}: expected a dense JSON array`);
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor?.enumerable || !own(descriptor, "value")) {
        throw new Error(`${path}/${i}: expected a JSON array value`);
      }
      assertStaticJson(descriptor.value, `${path}/${i}`, ancestors);
    }
  } else {
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable || !own(descriptor, "value")) throw new Error(`${path}/${key}: expected a JSON value`);
      assertStaticJson(descriptor.value, `${path}/${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

function assertNoSource(value, path, allowValues = false) {
  if (isSourcePlaceholder(value) && !allowValues) throw new Error(`${path}: unresolved $source placeholder`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSource(item, `${path}/${index}`, allowValues));
  } else if (isRecord(value)) {
    for (const [key, nested] of Object.entries(value)) {
      if (isSourcePlaceholder(key)) throw new Error(`${path}/${key}: $source placeholder keys are unsupported`);
      assertNoSource(nested, `${path}/${key}`, allowValues);
    }
  }
}

// Core validates expression structure at installation, but not the literal
// token/pool values inside an Action body. Check the selected static sources
// here; this does not establish market observations or pool math semantics.
function assertPoolContext(source, context) {
  const address = (value) => typeof value === "string" && ADDRESS_RE.test(value)
    && !/^0x0{40}$/.test(value);
  const tokens = (values, count) => Array.isArray(values)
    && (count === undefined ? values.length >= 2 : values.length === count)
    && values.every(address)
    && new Set(values.map((value) => value.toLowerCase())).size === values.length;
  if (source === "curve:factory_stable_ng_2coin_mainnet") {
    if (context.n_coins !== 2 || !tokens(context.coins, 2)) {
      throw new Error("context: Curve requires n_coins=2 and two distinct valid coin addresses");
    }
  } else if (source === "balancer_v3:pool_tokens") {
    if (!isRecord(context.pool_tokens) || Object.keys(context.pool_tokens).length === 0
      || Object.entries(context.pool_tokens).some(([pool, values]) =>
        !address(pool) || pool !== pool.toLowerCase() || !tokens(values))) {
      throw new Error("context: Balancer requires a nonempty lowercase pool-to-token-address map");
    }
  } else if (source === "uniswap:v3_pool_candidates") {
    if (!tokens([context.token0, context.token1], 2)
      || !Number.isInteger(context.fee_tier_bp) || context.fee_tier_bp < 0 || context.fee_tier_bp > 0xffffffff) {
      throw new Error("context: Uniswap requires distinct valid token addresses and a u32 fee_tier_bp");
    }
  }
}

/**
 * Strict boundary for selected, pinned SDK inputs. The Registry source-context
 * document is a build input, not a Core decoder snapshot. Normal inputs
 * produce the same bundle as Registry/API materialization.
 */
export function materializeSelectedDecoder(template, contextDoc) {
  assertStaticJson(template, "template");
  assertStaticJson(contextDoc, "context");
  assertNoSource(template, "template", true);
  assertNoSource(contextDoc, "context");
  if (!isRecord(template) || template.type !== "adapter_action" || template.schema_version !== "3"
    || typeof template.id !== "string" || template.id.length === 0) {
    throw new Error("template: expected a schema-3 adapter bundle with id");
  }
  const match = template.match;
  if (!isRecord(match) || typeof match.selector !== "string" || !SELECTOR_RE.test(match.selector)
    || typeof match.chain_to_addresses_source !== "string" || match.chain_to_addresses_source.length === 0
    || !Array.isArray(match.chain_ids) || match.chain_ids.length === 0
    || match.chain_ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
    || new Set(match.chain_ids).size !== match.chain_ids.length
    || Object.keys(match).some((key) => !["selector", "chain_to_addresses_source", "chain_ids"].includes(key))) {
    throw new Error("template: expected a source match with selector and allowed chain_ids");
  }
  const declaration = template.source_materialize;
  if (!isRecord(declaration) || declaration.kind !== "per_address_context"
    || declaration.source !== match.chain_to_addresses_source) {
    throw new Error("template: source_materialize must declare the matching per_address_context source");
  }
  if (!isRecord(contextDoc) || contextDoc.schema_version !== "3-source-context" || !isRecord(contextDoc.context)
    || Object.keys(contextDoc).some((key) => !["schema_version", "source", "chain_id", "address", "context"].includes(key))) {
    throw new Error("context: expected a 3-source-context document");
  }
  if (contextDoc.source !== match.chain_to_addresses_source) throw new Error("context: source does not match template");
  if (!Number.isSafeInteger(contextDoc.chain_id) || !match.chain_ids.includes(contextDoc.chain_id)) {
    throw new Error("context: chain_id is not allowed by template");
  }
  if (typeof contextDoc.address !== "string" || !ADDRESS_RE.test(contextDoc.address)) {
    throw new Error("context: invalid address");
  }
  const context = contextDoc.context;
  if (context.chainId !== contextDoc.chain_id) throw new Error("context: chainId contradicts chain_id");
  if (typeof context.address !== "string" || !ADDRESS_RE.test(context.address)
    || context.address.toLowerCase() !== contextDoc.address.toLowerCase()) {
    throw new Error("context: address contradicts document address");
  }
  if (typeof context.id_suffix !== "string" || context.id_suffix.length === 0) {
    throw new Error("context: id_suffix is required");
  }
  assertPoolContext(contextDoc.source, context);
  const bundle = materialize(template, context, contextDoc.chain_id, contextDoc.address.toLowerCase(), match.selector);
  assertNoSource(bundle, "bundle");
  return bundle;
}
