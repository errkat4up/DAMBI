import { CoreError } from "../types/errors.js";
import type { CallOptions } from "../types/options.js";
import { field, record } from "./json.js";

const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")!.get!;
const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;

export function signalFrom(options?: CallOptions): AbortSignal | undefined {
  try {
    if (options === undefined) return undefined;
    const value = field(record(options, "INVALID_CONFIG"), "signal", false, "INVALID_CONFIG");
    if (value === undefined) return undefined;
    // The platform getter checks the internal brand, including other realms.
    Reflect.apply(abortedGetter, value, []);
    return value as AbortSignal;
  } catch {
    throw new CoreError("INVALID_CONFIG", "options.signal must be an AbortSignal.");
  }
}

export function checkAbort(signal: AbortSignal | undefined): void {
  if (signal && Reflect.apply(abortedGetter, signal, [])) {
    throw new CoreError("ABORTED", "The operation was cancelled.");
  }
}

export interface PendingOperation<T> {
  readonly promise: Promise<T>;
  cancel(error: CoreError): void;
}

/** Abort/timeout settles independently of a port that ignores cancellation. */
export function startOperation<T>(
  work: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  external?: AbortSignal,
): PendingOperation<T> {
  const controller = new AbortController();
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolve!: (value: T) => void;
  let reject!: (error: CoreError) => void;
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail; });
  const cleanup = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    if (external) Reflect.apply(removeListener, external, ["abort", onAbort]);
  };
  const cancel = (error: CoreError): void => {
    if (settled) return;
    settled = true;
    cleanup();
    try { controller.abort(); } finally { reject(error); }
  };
  const onAbort = (): void => cancel(new CoreError("ABORTED", "The operation was cancelled."));
  if (external) Reflect.apply(addListener, external, ["abort", onAbort, { once: true }]);
  try { checkAbort(external); } catch { onAbort(); }

  // setTimeout clamps larger values to 1ms in Node. Keep long valid durations
  // in bounded segments rather than turning them into immediate timeouts.
  const arm = (remaining: number): void => {
    const delay = Math.min(remaining, 2_147_483_647);
    timer = setTimeout(() => {
      if (settled) return;
      if (remaining > delay) arm(remaining - delay);
      else cancel(new CoreError("TIMEOUT", "The policy operation timed out."));
    }, delay);
  };
  if (!settled) arm(timeoutMs);
  void Promise.resolve().then(async () => {
    if (settled) return;
    try {
      const value = await work(controller.signal);
      if (!settled) { settled = true; cleanup(); resolve(value); }
    } catch (error) {
      if (!settled) {
        settled = true;
        cleanup();
        // Also stop sibling initialization work after one branch fails.
        controller.abort();
        reject(error instanceof CoreError ? error
          : new CoreError("ENGINE_ERROR", "The Core operation could not complete."));
      }
    }
  });
  return { promise, cancel };
}
