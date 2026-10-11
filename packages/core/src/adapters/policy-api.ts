import type { PolicySource, SignedPolicyBundle } from "../ports/policy.js";
import type { CallOptions } from "../types/options.js";
import { AdapterError } from "./errors.js";
import { assertNotAborted, callSignal, fetchText } from "./http.js";

export interface PolicyApiSourceOptions {
  /** API origin only. HTTPS, or loopback HTTP for local development. */
  readonly baseUrl: string;
  /** Limit for the entire HTTP wrapper, distinct from Core's payload limit. */
  readonly maxResponseBytes: number;
  readonly profile?: "default";
  /** Server sequence selection; not an additional Core trust constraint. */
  readonly version?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly fetch?: typeof globalThis.fetch;
}

interface SourceConfig {
  readonly url: string;
  readonly maxBytes: number;
  readonly headers: Headers;
  readonly fetcher: typeof globalThis.fetch;
}

function ownConfig(options: PolicyApiSourceOptions): SourceConfig {
  try {
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const { baseUrl, maxResponseBytes, profile = "default", version, headers: supplied, fetch: injected } = options;
    // Check the input before URL normalization can erase a path such as /a/..
    // or silently trim whitespace from a credential-bearing configuration.
    if (typeof baseUrl !== "string" || !/^https?:\/\/[^/?#\s@\\]+\/?$/i.test(baseUrl)) throw new Error();
    const url = new URL(baseUrl);
    const loopback = url.hostname === "localhost" || url.hostname === "[::1]"
      || /^127(?:\.[0-9]{1,3}){3}$/.test(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
        || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error();
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1 || profile !== "default") throw new Error();
    if (version !== undefined && (!Number.isSafeInteger(version) || version < 1)) throw new Error();
    const headers = new Headers();
    if (supplied !== undefined) {
      if (supplied === null || typeof supplied !== "object" || Array.isArray(supplied)) throw new Error();
      for (const [name, value] of Object.entries(supplied)) {
        if (typeof value !== "string") throw new Error();
        headers.set(name, value);
      }
    }
    // Conditional requests belong to this source's ETag state, not host
    // headers that could produce a 304 without a matching cached envelope.
    if (headers.has("if-none-match") || headers.has("if-modified-since")) throw new Error();
    headers.set("accept", "application/json");
    const fetcher = injected === undefined ? globalThis.fetch.bind(globalThis) : injected;
    if (typeof fetcher !== "function") throw new Error();
    url.pathname = "/v1/bundle";
    url.searchParams.set("profile", profile);
    if (version !== undefined) url.searchParams.set("version", String(version));
    return { url: url.href, maxBytes: maxResponseBytes, headers, fetcher };
  } catch {
    throw new AdapterError("INVALID_CONFIG", "Policy API source configuration is invalid.");
  }
}

function invalidWrapper(): never {
  throw new AdapterError("INVALID_RESPONSE", "The endpoint did not return a supported policy wrapper.");
}

/** Only the three string fields of the wire envelope, never the signed B JSON. */
function parseWrapper(text: string): SignedPolicyBundle {
  let at = 0;
  const whitespace = (): void => {
    while (at < text.length && /[ \t\r\n]/.test(text[at])) at++;
  };
  const take = (character: string): void => {
    whitespace();
    if (text[at++] !== character) invalidWrapper();
  };
  const string = (): string => {
    whitespace();
    const start = at;
    if (text[at++] !== '"') invalidWrapper();
    while (at < text.length) {
      const character = text[at++];
      if (character === "\\") at++;
      else if (character === '"') {
        // JSON.parse validates escapes and control characters in this one
        // string token. Decode keys before checking duplicates as well.
        try { return JSON.parse(text.slice(start, at)) as string; }
        catch { invalidWrapper(); }
      }
    }
    return invalidWrapper();
  };
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  take("{");
  whitespace();
  if (text[at] !== "}") {
    for (;;) {
      const key = string();
      if (!["payload", "signature", "key_id"].includes(key) || Object.hasOwn(fields, key)) invalidWrapper();
      take(":");
      fields[key] = string();
      whitespace();
      if (text[at] === "}") break;
      take(",");
    }
  }
  take("}");
  whitespace();
  if (at !== text.length || !Object.hasOwn(fields, "payload") || !Object.hasOwn(fields, "signature")) invalidWrapper();
  const bundle: SignedPolicyBundle = Object.hasOwn(fields, "key_id")
    ? { payload: fields.payload, signature: fields.signature, keyId: fields.key_id }
    : { payload: fields.payload, signature: fields.signature };
  return Object.freeze(bundle);
}

interface CachedEnvelope {
  readonly etag: string;
  readonly bundle: SignedPolicyBundle;
}

// One HTTP entity-tag, preserved exactly (including weak tags). An absent,
// inaccessible or malformed tag disables conditional reuse for that response.
function usableETag(value: string | null): value is string {
  return value !== null && /^(?:W\/)?"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
}

/** Transport cache only. Core rechecks signature, expiry and sequence on every fetch. */
export function createPolicyApiSource(options: PolicyApiSourceOptions): PolicySource {
  const config = ownConfig(options);
  let cached: CachedEnvelope | undefined;
  let latestRequest: object | undefined;
  return Object.freeze({
    async fetch(options?: CallOptions): Promise<SignedPolicyBundle> {
      const signal = callSignal(options);
      assertNotAborted(signal);
      const request = {};
      latestRequest = request;
      const previous = cached;
      const headers = new Headers(config.headers);
      if (previous) headers.set("if-none-match", previous.etag);
      const response = await fetchText(config.fetcher, config.url, {
        method: "GET",
        headers,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
      }, config.maxBytes, signal, previous !== undefined);
      assertNotAborted(signal);
      if (response.status === 304) {
        if (!previous) throw new AdapterError("HTTP_ERROR", "No policy wrapper matches this response.", 304);
        // Do not substitute a newer envelope or publish an old captured pair.
        return previous.bundle;
      }
      const bundle = parseWrapper(response.text);
      if (latestRequest === request) {
        // A later request owns publication even if it fails or is cancelled.
        // Malformed wrappers never reach this assignment; unverified signatures
        // may, since trust validation belongs to the consuming Core instance.
        cached = usableETag(response.etag) ? { etag: response.etag, bundle } : undefined;
      }
      return bundle;
    },
  });
}
