import type { CallOptions } from "../types/options.js";
import { AdapterError } from "./errors.js";

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;

export function assertNotAborted(signal?: AbortSignal): void {
  if (signal && Reflect.apply(abortedGetter, signal, [])) {
    throw new AdapterError("ABORTED", "The adapter request was cancelled.");
  }
}

export function callSignal(options?: CallOptions): AbortSignal | undefined {
  try {
    if (options === undefined) return undefined;
    if (options === null || typeof options !== "object" || Array.isArray(options)) throw new Error();
    const signal = options.signal;
    if (signal !== undefined) Reflect.apply(abortedGetter, signal, []);
    return signal;
  } catch {
    throw new AdapterError("INVALID_CONFIG", "Call options require a valid AbortSignal.");
  }
}

/** Read decoded HTTP body bytes with a hard limit, including chunked responses. */
export function fetchText(
  fetcher: typeof globalThis.fetch, url: string, init: RequestInit, maxBytes: number, signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const cancelBody = (): void => {
      try {
        // Cancellation must not wait on an uncooperative injected stream.
        void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => {});
      } catch { /* The transport may already have released or closed its body. */ }
    };
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
    const fail = (error: AdapterError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      cancelBody();
      reject(error);
    };
    const onAbort = (): void => fail(new AdapterError("ABORTED", "The adapter request was cancelled."));
    signal?.addEventListener("abort", onAbort, { once: true });
    try { assertNotAborted(signal); } catch { onAbort(); }
    if (settled) return;

    void (async () => {
      try {
        response = await fetcher(url, { ...init, signal });
        // Also discard late responses from injected fetch implementations that
        // do not honor the signal. Each call owns its own response and reader.
        if (settled) { cancelBody(); return; }
        assertNotAborted(signal);
        if (response.status !== 200) {
          throw new AdapterError("HTTP_ERROR", "The endpoint returned an unsuccessful HTTP status.", response.status);
        }
        const declared = response.headers.get("content-length");
        if (declared !== null) {
          if (!/^[0-9]+$/.test(declared)) {
            throw new AdapterError("INVALID_RESPONSE", "The endpoint returned an invalid response length.");
          }
          if (BigInt(declared) > BigInt(maxBytes)) {
            throw new AdapterError("RESPONSE_TOO_LARGE", "The response exceeds the configured byte limit.");
          }
        }
        if (!response.body) throw new AdapterError("INVALID_RESPONSE", "The endpoint returned no response body.");
        reader = response.body.getReader();
        // Preserve a leading BOM so the strict JSON wrapper parser rejects it.
        const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
        const parts: string[] = [];
        let bytes = 0;
        for (;;) {
          const chunk = await reader.read();
          if (settled) return;
          assertNotAborted(signal);
          if (chunk.done) break;
          if (chunk.value.byteLength > maxBytes - bytes) {
            throw new AdapterError("RESPONSE_TOO_LARGE", "The response exceeds the configured byte limit.");
          }
          bytes += chunk.value.byteLength;
          try { parts.push(decoder.decode(chunk.value, { stream: true })); }
          catch { throw new AdapterError("INVALID_RESPONSE", "The response is not valid UTF-8."); }
        }
        try { parts.push(decoder.decode()); }
        catch { throw new AdapterError("INVALID_RESPONSE", "The response is not valid UTF-8."); }
        const text = parts.join("");
        settled = true;
        cleanup();
        resolve(text);
      } catch (error) {
        fail(error instanceof AdapterError ? error
          : new AdapterError("NETWORK_ERROR", "The endpoint response could not be received."));
      } finally {
        try { reader?.releaseLock(); } catch { /* Ignore cleanup after a failed read. */ }
      }
    })();
  });
}
