import { CoreError, type CoreDiagnostic } from "../types/errors.js";
import type { CheckRequest, UnsupportedRequest } from "../types/request.js";
import type { Verdict } from "../types/verdict.js";
import { copyJson, freezeTree } from "./json.js";

export interface HookDispatcher {
  pending(request: CheckRequest | UnsupportedRequest): void;
  verdict(verdict: Verdict): void;
  diagnostic(event: CoreDiagnostic): void;
  awaitingUser(): void;
}

type HookName = "onPending" | "onVerdict" | "onDiagnostic" | "onAwaitingUser";
type Callback = (...args: unknown[]) => unknown;

function capture(input: object, name: HookName): Callback | undefined {
  let owner: object | null = input;
  for (let depth = 0; owner !== null && depth < 128; depth++) {
    const descriptor = Object.getOwnPropertyDescriptor(owner, name);
    if (descriptor) {
      if (!("value" in descriptor)) throw new CoreError("INVALID_CONFIG", "Hook accessors are not accepted.");
      if (descriptor.value === undefined) return undefined;
      if (typeof descriptor.value !== "function") {
        throw new CoreError("INVALID_CONFIG", "Configured hooks must be callable data methods.");
      }
      const callback = descriptor.value as Callback;
      return (...args) => Reflect.apply(callback, input, args);
    }
    owner = Object.getPrototypeOf(owner) as object | null;
  }
  if (owner !== null) throw new CoreError("INVALID_CONFIG", "Hook prototype nesting is too deep.");
  return undefined;
}

function immutable(value: unknown): unknown {
  // Serialize only the safe private copy. JSON.parse restores ordinary arrays
  // for consumers while deep freeze protects Core's independently held input.
  const copy = copyJson(value, "ENGINE_ERROR", Number.MAX_SAFE_INTEGER);
  return freezeTree(JSON.parse(JSON.stringify(copy)) as unknown);
}

/** Capture once; later host mutations cannot replace notification callbacks. */
export function captureHooks(input: unknown): HookDispatcher {
  let callbacks: Partial<Record<HookName, Callback>> = Object.create(null) as Partial<Record<HookName, Callback>>;
  if (input !== undefined) {
    try {
      if ((typeof input !== "object" || input === null) && typeof input !== "function") {
        throw new CoreError("INVALID_CONFIG", "Hooks must be an object of callbacks.");
      }
      const receiver = input as object;
      callbacks = {
        onPending: capture(receiver, "onPending"),
        onVerdict: capture(receiver, "onVerdict"),
        onDiagnostic: capture(receiver, "onDiagnostic"),
        onAwaitingUser: capture(receiver, "onAwaitingUser"),
      };
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("INVALID_CONFIG", "Hooks could not be captured safely.");
    }
  }

  const report = (name: HookName): void => {
    notify("onDiagnostic", {
      code: "hook_error",
      message: `${name} could not complete its notification.`,
    });
  };
  const notify = (name: HookName, value?: unknown): void => {
    const callback = callbacks[name];
    if (!callback) return;
    try {
      const result = name === "onAwaitingUser" ? callback() : callback(immutable(value));
      // Never await host hooks. Also assimilate thenables so late rejections
      // cannot become unhandled rejections or change the returned verdict.
      void Promise.resolve(result).then(undefined, () => {
        if (name !== "onDiagnostic") report(name);
      });
    } catch {
      // Diagnostic failures are terminal: no recursive diagnostic notification.
      if (name !== "onDiagnostic") report(name);
    }
  };
  return Object.freeze({
    pending: (request: CheckRequest | UnsupportedRequest) => notify("onPending", request),
    verdict: (verdict: Verdict) => notify("onVerdict", verdict),
    diagnostic: (event: CoreDiagnostic) => notify("onDiagnostic", event),
    awaitingUser: () => notify("onAwaitingUser"),
  });
}
