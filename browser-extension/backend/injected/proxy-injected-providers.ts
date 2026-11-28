import { WindowPostMessageStream } from "@metamask/post-message-stream";
import { ethErrors } from "eth-rpc-errors";
import { Identifier, PROVIDER_MARKER } from "@lib/identifier";
import {
  sendRequestAndAwaitDecision,
  sendToStreamAndDisregard,
} from "@lib/messages";
import { createVerdictReceiver } from "@lib/verdict-channel";
import { RequestType } from "@lib/types";
import { walletAddress as looksLikeAddress, walletChainId as parseChainId, signatureFields } from "@lib/wallet-request-fields";
import type {
  ExecutionReportOutcome,
  ExecutionReportPayload,
  MessageData,
} from "@lib/types";

declare global {
  interface Window {
    ethereum?: Eip1193Provider;
    coinbaseWalletExtension?: Eip1193Provider;
    [key: string]: unknown;
  }
}

interface Eip1193Provider {
  request?: (request: JsonRpcRequest) => Promise<unknown>;
  send?: (...args: unknown[]) => unknown;
  sendAsync?: (...args: unknown[]) => unknown;
  chainId?: string | number;
  on?: (event: string, listener: (...args: unknown[]) => void) => unknown;
  providers?: Eip1193Provider[];
  constructor?: { name?: string };
  [PROVIDER_MARKER]?: boolean;
}

interface JsonRpcRequest {
  id?: string | number;
  jsonrpc?: string;
  method?: string;
  params?: unknown;
}

type JsonRpcCallback = (error: unknown, response?: unknown) => void;
type ProviderRequest = NonNullable<Eip1193Provider["request"]>;

type WritableStream = WindowPostMessageStream & {
  write(data: unknown): void;
};

interface InstallState {
  eip6963Listener?: (event: Event) => void;
  pollHandle: number | undefined;
}

const INSTALL_STATE = Symbol.for("__dambi_provider_proxy_install_state__");
const windowWithInstallState = window as unknown as Record<
  PropertyKey,
  unknown
>;
const installState = (windowWithInstallState[INSTALL_STATE] ?? {
  pollHandle: undefined,
}) as InstallState;
if (installState.eip6963Listener) {
  window.removeEventListener(
    "eip6963:announceProvider",
    installState.eip6963Listener,
  );
}
if (installState.pollHandle !== undefined) {
  window.clearInterval(installState.pollHandle);
}
windowWithInstallState[INSTALL_STATE] = installState;

const stream = new WindowPostMessageStream({
  name: Identifier.INPAGE,
  target: Identifier.CONTENT_SCRIPT,
}) as WritableStream;

// C1: verdicts are read ONLY from the authenticated MessageChannel the ISOLATED
// bridge transfers at document_start — never from the page-observable stream —
// so a same-realm page cannot forge an `allow`. See `@lib/verdict-channel`.
const verdictReceiver = createVerdictReceiver(Identifier.VERDICT_PORT_INIT);

const REJECT_TX = ethErrors.provider.userRejectedRequest(
  "Dambi: transaction blocked: policy evaluation unavailable",
);
const REJECT_SIG = ethErrors.provider.userRejectedRequest(
  "Dambi: signature blocked: policy evaluation unavailable",
);

// A top-level wallet invocation shares one chain observation and one list of
// approved calls, including nested batch members. Concurrent invocations get
// separate scopes; the IDs only retire duplicate-observation fingerprints.
interface WalletApprovalScope {
  provider: Eip1193Provider;
  approved: string[];
  chain?: {
    id: number | undefined;
    revision: number | undefined;
    action: "transaction" | "signature";
  };
}

function assertApprovalChain({ provider, chain }: WalletApprovalScope): void {
  if (chain && (chain.id !== knownChainId(provider) || chain.revision !== chainIdRevisions.get(provider))) {
    unavailableChain(chain.action);
  }
}

async function confirmWalletAction(
  scope: WalletApprovalScope,
  data: Extract<MessageData, { type: RequestType.TRANSACTION | RequestType.TYPED_SIGNATURE | RequestType.UNTYPED_SIGNATURE }>,
): Promise<boolean> {
  const { provider } = scope;
  const action = data.type === RequestType.TRANSACTION ? "transaction" : "signature";
  const currentChain = knownChainId(provider);
  scope.chain ??= { id: currentChain, revision: chainIdRevisions.get(provider), action };
  assertApprovalChain(scope);
  // EIP-5792 may name a target chain explicitly; its enclosing invocation
  // still pins the observed provider revision across all confirmations.
  if (data.method !== "wallet_sendCalls" && currentChain !== data.chainId) unavailableChain(action);
  const decision = await sendRequestAndAwaitDecision(stream, verdictReceiver, data);
  if (decision.data === true) {
    scope.approved.push(decision.requestId);
    assertApprovalChain(scope);
    return true;
  }
  const detail = decision.rejection === "user_cancelled"
    ? "rejected by user"
    : decision.rejection === "policy_denied"
      ? "blocked by policy"
      : "blocked: policy evaluation unavailable";
  throw ethErrors.provider.userRejectedRequest(`Dambi: ${action} ${detail}`);
}

const TYPED_SIGNATURE_METHODS = new Set([
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
]);
const UNTYPED_SIGNATURE_METHODS = new Set(["eth_sign", "personal_sign"]);

const chainIdCache = new WeakMap<object, number>();
// An event supersedes both the provider field and reads started before it.
// Keep the revision even for invalid events: unknown must invalidate old facts.
const chainIdRevisions = new WeakMap<object, number>();
const chainIdListeners = new WeakSet<object>();
const wrappedProviders = new WeakSet<object>();
const unwrappableProviders = new WeakSet<object>();
const reannouncedProviders = new WeakSet<object>();
const transactionActors = new WeakMap<object, string>();
const walletSendCallsActors = new WeakMap<object, string>();

function asProvider(value: unknown): Eip1193Provider | undefined {
  return value && typeof value === "object"
    ? (value as Eip1193Provider)
    : undefined;
}

function paramsArray(params: unknown): unknown[] {
  if (Array.isArray(params)) return params;
  return params === undefined ? [] : [params];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function unavailableChain(action: "transaction" | "signature"): never {
  throw ethErrors.provider.userRejectedRequest(
    `Dambi: ${action} blocked: policy evaluation unavailable`,
  );
}

function rememberChainId(
  provider: Eip1193Provider,
  value: unknown,
): number | undefined {
  const parsed = parseChainId(value);
  if (parsed !== undefined) chainIdCache.set(provider, parsed);
  else chainIdCache.delete(provider);
  return parsed;
}

function installChainIdListener(provider: Eip1193Provider): void {
  if (chainIdListeners.has(provider) || typeof provider.on !== "function")
    return;
  try {
    provider.on("chainChanged", (chainId) => {
      chainIdRevisions.set(provider, (chainIdRevisions.get(provider) ?? 0) + 1);
      rememberChainId(provider, chainId);
    });
    chainIdListeners.add(provider);
  } catch {
    // Some provider shims expose `on` but reject unknown listeners.
  }
}

async function readChainId(
  provider: Eip1193Provider,
  request: ProviderRequest | undefined = provider.request,
  action: "transaction" | "signature" = "transaction",
): Promise<number> {
  const known = knownChainId(provider);
  if (known !== undefined) return known;
  // A malformed current observation is not permission to reuse an old chain.
  if (chainIdRevisions.has(provider) || provider.chainId !== undefined) {
    return unavailableChain(action);
  }
  if (typeof request !== "function") return unavailableChain(action);

  const revision = chainIdRevisions.get(provider);
  let timer: number | undefined;
  let result: unknown;
  try {
    result = await Promise.race([
      Reflect.apply(request, provider, [{ method: "eth_chainId" }]),
      new Promise<never>((_, reject) => {
        timer = window.setTimeout(
          () => reject(new Error("Dambi: chainId timeout")),
          1_500,
        );
      }),
    ]);
  } catch {
    // A chainChanged event received during a failed read still wins below.
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
  const chainId = chainIdRevisions.get(provider) !== revision
    ? chainIdCache.get(provider)
    : rememberChainId(provider, result);
  return chainId ?? unavailableChain(action);
}

async function readConnectedAccount(
  provider: Eip1193Provider,
  request: ProviderRequest | undefined = provider.request,
): Promise<string | undefined> {
  try {
    if (typeof request !== "function") return undefined;
    const result = await Promise.race([
      Reflect.apply(request, provider, [{ method: "eth_accounts" }]),
      new Promise<never>((_, reject) => {
        window.setTimeout(
          () => reject(new Error("Dambi: accounts timeout")),
          1_500,
        );
      }),
    ]);
    if (!Array.isArray(result)) return undefined;
    const account = result.find(looksLikeAddress);
    return typeof account === "string" ? account : undefined;
  } catch {
    return undefined;
  }
}

async function checkTransaction(
  scope: WalletApprovalScope,
  params: unknown[],
  method: string,
  chainIdOverride?: number,
  readRequest?: ProviderRequest,
): Promise<boolean> {
  const { provider } = scope;
  const [transaction] = params;
  const tx = asRecord(transaction);
  if (!tx) return false;
  const chainId = chainIdOverride ?? (await readChainId(provider, readRequest));
  const from = looksLikeAddress(tx.from)
    ? String(tx.from)
    : await readConnectedAccount(provider, readRequest);
  if (!from) return false;
  transactionActors.set(tx, from);
  const policyTransaction =
    tx.from === from
      ? tx
      : {
          ...tx,
          from,
        };

  const data = {
    type: RequestType.TRANSACTION,
    method,
    chainId,
    hostname: location.hostname,
    transaction: policyTransaction,
  } as Extract<MessageData, { type: RequestType.TRANSACTION }>;

  return confirmWalletAction(scope, data);
}

async function checkWalletSendCalls(
  scope: WalletApprovalScope,
  params: unknown[],
  readRequest?: ProviderRequest,
): Promise<boolean> {
  const { provider } = scope;
  const envelope = asRecord(params[0]);
  if (!envelope) return false;
  const calls = Array.isArray(envelope.calls) ? envelope.calls : null;
  if (!calls) return false;
  if (calls.length === 0) return true;

  const chainId = envelope.chainId === undefined
    ? await readChainId(provider, readRequest)
    : parseChainId(envelope.chainId) ?? unavailableChain("transaction");
  const walletFrom = looksLikeAddress(envelope.from)
    ? String(envelope.from)
    : await readConnectedAccount(provider, readRequest);
  if (!walletFrom) return false;
  walletSendCallsActors.set(envelope, walletFrom);

  for (let i = 0; i < calls.length; i++) {
    const call = asRecord(calls[i]);
    if (!call) {
      return false;
    }
    const callFields = { ...call };
    delete callFields.from;

    const transaction: Record<string, unknown> = {
      ...callFields,
      from: walletFrom,
    };
    const isCallAllowed = await checkTransaction(
      scope,
      [transaction],
      "wallet_sendCalls",
      chainId,
      readRequest,
    );
    if (!isCallAllowed) return false;
  }

  return true;
}

async function checkTypedSignature(
  scope: WalletApprovalScope,
  params: unknown[],
  method: string,
  readRequest?: ProviderRequest,
): Promise<boolean> {
  const { provider } = scope;
  const { address, message: typedData } = signatureFields(method, params);
  if (typedData === undefined || typedData === null) return true;
  const chainId = await readChainId(provider, readRequest, "signature");

  return confirmWalletAction(scope, {
    type: RequestType.TYPED_SIGNATURE,
    // Keep the zero-address routing fallback, but do not publish complete
    // correlation metadata for a fabricated signer. Absent method remains the
    // conservative legacy shape; it must not be treated as a normal match.
    ...(address ? { method } : {}),
    chainId,
    hostname: location.hostname,
    address: address ?? `0x${"0".repeat(40)}`,
    typedData,
  });
}

async function checkUntypedSignature(
  scope: WalletApprovalScope,
  params: unknown[],
  method: string,
  readRequest?: ProviderRequest,
): Promise<boolean> {
  const { provider } = scope;
  const { address, message } = signatureFields(method, params);
  if (message === undefined || message === null) return true;
  const chainId = await readChainId(provider, readRequest, "signature");

  return confirmWalletAction(scope, {
    type: RequestType.UNTYPED_SIGNATURE,
    method,
    ...(address ? { address } : {}),
    chainId,
    hostname: location.hostname,
    message: String(message),
  });
}

function metaMaskBatchRequests(params: unknown[]): JsonRpcRequest[] {
  const [first] = params;
  const candidate = Array.isArray(first) ? first : params;
  const requests: JsonRpcRequest[] = [];
  for (const item of candidate) {
    const record = asRecord(item);
    if (record) requests.push(record as JsonRpcRequest);
  }
  return requests;
}

async function checkMetaMaskBatch(
  scope: WalletApprovalScope,
  params: unknown[],
  readRequest?: ProviderRequest,
): Promise<void> {
  for (const request of metaMaskBatchRequests(params)) {
    await ensureAllowed(
      scope,
      request.method,
      paramsArray(request.params),
      readRequest,
    );
  }
}

async function ensureAllowed(
  scope: WalletApprovalScope,
  method: string | undefined,
  params: unknown[],
  readRequest?: ProviderRequest,
): Promise<void> {
  if (method === "eth_sendTransaction" || method === "eth_signTransaction") {
    // N8: sign-without-broadcast still requires transaction evaluation, but
    // retain its actual method rather than claiming it was a send.
    const isOk = await checkTransaction(
      scope,
      params,
      method,
      undefined,
      readRequest,
    );
    if (!isOk) throw REJECT_TX;
    return;
  }

  if (method === "wallet_sendCalls") {
    const isOk = await checkWalletSendCalls(scope, params, readRequest);
    if (!isOk) throw REJECT_TX;
    return;
  }

  if (method === "metamask_batch") {
    await checkMetaMaskBatch(scope, params, readRequest);
    return;
  }

  if (method && TYPED_SIGNATURE_METHODS.has(method)) {
    const isOk = await checkTypedSignature(scope, params, method, readRequest);
    if (!isOk) throw REJECT_SIG;
    return;
  }

  if (method && UNTYPED_SIGNATURE_METHODS.has(method)) {
    const isOk = await checkUntypedSignature(scope, params, method, readRequest);
    if (!isOk) throw REJECT_SIG;
    return;
  }

  if (method === "eth_sendRawTransaction") {
    logRawTransaction(params);
  }
}

function logRawTransaction(params: unknown[]): void {
  const raw = String(params[0] ?? "");
  console.warn("Dambi: eth_sendRawTransaction pass-through advisory", {
    hostname: location.hostname,
    rawPreview: raw.slice(0, 18),
  });
  stream.write({
    requestId: `raw-tx-${raw.slice(0, 18)}`,
    data: {
      type: "raw-transaction-advisory",
      hostname: location.hostname,
      rawPreview: raw.slice(0, 18),
    },
  });
}

function chainCaip2(chainId: number): string {
  return `eip155:${chainId}`;
}

function knownChainId(provider: Eip1193Provider): number | undefined {
  if (chainIdRevisions.has(provider)) return chainIdCache.get(provider);
  if (provider.chainId !== undefined) {
    return rememberChainId(provider, provider.chainId);
  }
  return chainIdCache.get(provider);
}

function resultChainId(
  provider: Eip1193Provider,
  method: string | undefined,
  params: unknown[],
): number | undefined {
  if (method === "wallet_sendCalls") {
    return parseChainId(asRecord(params[0])?.chainId) ?? knownChainId(provider);
  }
  return knownChainId(provider);
}

function signatureAddress(method: string, params: unknown[]): string | undefined {
  return signatureFields(method, params).address;
}

function evaluatedTransactionAddress(params: unknown[]): string | undefined {
  const tx = asRecord(params[0]);
  if (!tx) return undefined;
  const from = tx.from;
  if (looksLikeAddress(from)) return String(from);
  return transactionActors.get(tx);
}

function evaluatedWalletSendCallsAddress(params: unknown[]): string | undefined {
  const envelope = asRecord(params[0]);
  if (!envelope) return undefined;
  const from = envelope.from;
  if (looksLikeAddress(from)) return String(from);
  return walletSendCallsActors.get(envelope);
}

function reportWalletId(
  provider: Eip1193Provider,
  method: string | undefined,
  params: unknown[],
): ExecutionReportPayload["wallet_id"] | undefined {
  const address =
    method === "eth_sendTransaction"
      ? evaluatedTransactionAddress(params)
      : method === "wallet_sendCalls"
      ? evaluatedWalletSendCallsAddress(params)
      : method &&
          (TYPED_SIGNATURE_METHODS.has(method) ||
            UNTYPED_SIGNATURE_METHODS.has(method))
        ? signatureAddress(method, params)
        : undefined;
  const chainId = resultChainId(provider, method, params);
  if (!address || chainId === undefined) return undefined;
  return {
    address,
    chains: [chainCaip2(chainId)],
  };
}

function errorReason(error: unknown): string | undefined {
  if (error instanceof Error && error.message) return error.message;
  const record = asRecord(error);
  if (typeof record?.message === "string") return record.message;
  if (typeof record?.reason === "string") return record.reason;
  if (typeof error === "string" && error.length > 0) return error;
  return undefined;
}

function successOutcome(
  provider: Eip1193Provider,
  method: string | undefined,
  result: unknown,
): ExecutionReportOutcome | undefined {
  if (method === "eth_sendTransaction" && typeof result === "string") {
    const chainId = knownChainId(provider);
    if (chainId === undefined) return undefined;
    return {
      kind: "onchain_submitted",
      chain: chainCaip2(chainId),
      tx_hash: result,
    };
  }
  if (method === "wallet_sendCalls") {
    return {
      kind: "wallet_confirmed",
      method,
    };
  }
  if (
    method &&
    (TYPED_SIGNATURE_METHODS.has(method) ||
      UNTYPED_SIGNATURE_METHODS.has(method)) &&
    typeof result === "string"
  ) {
    return {
      kind: "wallet_signed",
      signature: result,
    };
  }
  return undefined;
}

function rejectedOutcome(
  method: string | undefined,
  error: unknown,
): ExecutionReportOutcome | undefined {
  if (
    method === "eth_sendTransaction" ||
    method === "wallet_sendCalls" ||
    (method &&
      (TYPED_SIGNATURE_METHODS.has(method) ||
        UNTYPED_SIGNATURE_METHODS.has(method)))
  ) {
    const outcome: ExecutionReportOutcome = {
      kind: "wallet_rejected",
    };
    const reason = errorReason(error);
    if (reason !== undefined) outcome.reason = reason;
    return outcome;
  }
  return undefined;
}

function reportProviderOutcome(
  provider: Eip1193Provider,
  method: string | undefined,
  params: unknown[],
  outcome: ExecutionReportOutcome | undefined,
): void {
  if (!outcome) return;
  const report: ExecutionReportPayload = {
    type: RequestType.EXECUTION_REPORT,
    hostname: location.hostname,
    outcome,
    metadata: {
      source: "provider-proxy",
      method,
    },
  };
  const walletId = reportWalletId(provider, method, params);
  if (walletId) report.wallet_id = walletId;
  sendToStreamAndDisregard(stream, report);
}

async function forwardProviderResult<T>(
  provider: Eip1193Provider,
  method: string | undefined,
  params: unknown[],
  invoke: () => T | Promise<T>,
): Promise<T> {
  try {
    const result = await invoke();
    reportProviderOutcome(
      provider,
      method,
      params,
      successOutcome(provider, method, result),
    );
    return result;
  } catch (error) {
    reportProviderOutcome(provider, method, params, rejectedOutcome(method, error));
    throw error;
  }
}

function wrapProviderCallback(
  provider: Eip1193Provider,
  method: string | undefined,
  params: unknown[],
  callback: JsonRpcCallback,
): JsonRpcCallback {
  return (error, response) => {
    const responseRecord = asRecord(response);
    const responseError = responseRecord?.error;
    if (error !== null && error !== undefined) {
      reportProviderOutcome(provider, method, params, rejectedOutcome(method, error));
    } else if (responseError !== undefined) {
      reportProviderOutcome(
        provider,
        method,
        params,
        rejectedOutcome(method, responseError),
      );
    } else {
      reportProviderOutcome(
        provider,
        method,
        params,
        successOutcome(provider, method, responseRecord?.result ?? response),
      );
    }
    callback(error, response);
  };
}

function rejectJsonRpc(
  callback: JsonRpcCallback,
  request: JsonRpcRequest,
  error: unknown,
): void {
  callback(error, {
    id: request.id,
    jsonrpc: request.jsonrpc ?? "2.0",
    error,
  });
}

function reportFrozenProvider(provider: Eip1193Provider, error: unknown): void {
  console.error("Dambi: provider is frozen and cannot be wrapped", error);
  stream.write({
    requestId: `frozen-provider-${Date.now().toString(16)}`,
    data: {
      type: "provider-frozen-warning",
      hostname: location.hostname,
      providerName: provider.constructor?.name ?? "unknown",
    },
  });
}

// Marker on the wrapped function itself. Lets the polling loop detect
// when MetaMask (or another late-injecting provider) re-defined
// `provider.request` back to native after we'd already wrapped it —
// in which case we re-wrap. Tracking only on the provider object via
// PROVIDER_MARKER is not enough: the marker survives even when the
// wrapped methods were stomped, leaving us with a "wrapped" object
// whose request is the unwrapped native one.
const WRAP_MARKER = Symbol.for("__dambi_wrapper__");
const WRAP_TARGET = Symbol.for("__dambi_wrapper_target__");
type WithMarker<T> = T & { [WRAP_MARKER]?: true; [WRAP_TARGET]?: T };

function isAlreadyWrapped(fn: unknown): boolean {
  return (
    typeof fn === "function" &&
    (fn as WithMarker<Function>)[WRAP_MARKER] === true
  );
}

function unwrapFunction<T extends Function>(fn: T): T {
  return (fn as WithMarker<T>)[WRAP_TARGET] ?? fn;
}

function proxyEthereumProvider(provider: Eip1193Provider | undefined): boolean {
  if (!provider) return false;
  if (unwrappableProviders.has(provider)) return false;
  // Already wrapped AND our wrap is still in place → nothing to do.
  if (
    wrappedProviders.has(provider) &&
    isAlreadyWrapped(provider.request) &&
    (typeof provider.sendAsync !== "function" ||
      isAlreadyWrapped(provider.sendAsync)) &&
    (typeof provider.send !== "function" || isAlreadyWrapped(provider.send))
  ) {
    installChainIdListener(provider);
    return true;
  }

  if (typeof provider.request !== "function") {
    reportFrozenProvider(provider, new Error("provider.request is required"));
    unwrappableProviders.add(provider);
    return false;
  }

  // If a previous wrap was stomped, peel back to the underlying native
  // methods so we don't double-wrap our own wrapper. (Our wrapper holds
  // the original via its closure, so we can't recover it from the
  // stomped state — but the live `provider.request` is the native one
  // again, which is exactly what we want.)
  const originalRequest = unwrapFunction(provider.request);
  const originalSendAsync =
    typeof provider.sendAsync === "function"
      ? unwrapFunction(provider.sendAsync)
      : undefined;
  const originalSend =
    typeof provider.send === "function"
      ? unwrapFunction(provider.send)
      : undefined;
  installChainIdListener(provider);

  // Validate immediately before calling the native wallet, with no await
  // between the final chain check and delivery. A rejected native call has
  // already been handed off and can still produce an observation.
  const wallet = provider;
  async function gateAndForward(payload: unknown, forward: () => unknown) {
    const scope: WalletApprovalScope = { provider: wallet, approved: [] };
    try {
      for (const item of Array.isArray(payload) ? payload : [payload]) {
        const request = asRecord(item) as JsonRpcRequest | undefined;
        if (request) {
          await ensureAllowed(scope, request.method, paramsArray(request.params), originalRequest);
        }
      }
      assertApprovalChain(scope);
    } catch (error) {
      for (const requestId of scope.approved) {
        try {
          sendToStreamAndDisregard(stream, {
            type: "discard-forwarded", hostname: location.hostname, originalRequestId: requestId,
          });
        } catch {
          // A disconnected bridge cannot deliver cleanup. Its bounded cache
          // expires; retain the actual per-request refusal for the dApp.
        }
      }
      throw error;
    }
    return forward();
  }

  const proxiedRequest = new Proxy(originalRequest, {
    apply: (target, _thisArg, args) => {
      const payload = args[0];
      if (Array.isArray(payload)) return gateAndForward(payload, () => Reflect.apply(target, wallet, args));
      const request = (payload ?? {}) as JsonRpcRequest;
      return gateAndForward(request, () => forwardProviderResult(
        wallet, request.method, paramsArray(request.params), () => Reflect.apply(target, wallet, args),
      ));
    },
  });

  // Legacy callbacks and promise-based calls share the same gate. Preserve the
  // receiver expected by stateful injected wallets and keep batch arrays intact.
  const forwardLegacy = (target: (...args: unknown[]) => unknown, args: unknown[]) => {
    const [payload, callback] = args;
    const batch = Array.isArray(payload);
    const request = (batch ? {} : payload ?? {}) as JsonRpcRequest;
    const params = paramsArray(request.params);
    if (typeof callback === "function") {
      const respond = callback as JsonRpcCallback;
      const forwarded = batch ? args : [
        request, wrapProviderCallback(wallet, request.method, params, respond), ...args.slice(2),
      ];
      void gateAndForward(payload, () => {
        Reflect.apply(target, wallet, forwarded);
      }).catch((error) => rejectJsonRpc(respond, request, error));
      return undefined;
    }
    if (!batch && !request.method) return Reflect.apply(target, wallet, args);
    return gateAndForward(payload, () => {
      const invoke = () => Reflect.apply(target, wallet, args);
      return batch ? invoke() : forwardProviderResult(wallet, request.method, params, invoke);
    });
  };

  const proxiedSendAsync = typeof originalSendAsync === "function"
    ? new Proxy(originalSendAsync, { apply: (target, _thisArg, args) => forwardLegacy(target, args) })
    : undefined;

  const proxiedSend = typeof originalSend === "function"
    ? new Proxy(originalSend, {
        apply: (target, _thisArg, args) => {
          const [payload, callbackOrParams] = args;
          if (typeof payload === "string") return wallet.request?.({ method: payload, params: callbackOrParams });
          if (!Array.isArray(payload) && typeof callbackOrParams === "function" && typeof wallet.sendAsync === "function") {
            return wallet.sendAsync(payload, callbackOrParams);
          }
          return forwardLegacy(target, args);
        },
      })
    : undefined;

  // Tag wrapped functions so subsequent poll passes can detect mutation.
  (proxiedRequest as WithMarker<typeof proxiedRequest>)[WRAP_MARKER] = true;
  (proxiedRequest as WithMarker<typeof proxiedRequest>)[WRAP_TARGET] =
    originalRequest as typeof proxiedRequest;
  if (proxiedSendAsync)
    (proxiedSendAsync as WithMarker<typeof proxiedSendAsync>)[WRAP_MARKER] =
      true;
  if (proxiedSendAsync)
    (proxiedSendAsync as WithMarker<typeof proxiedSendAsync>)[WRAP_TARGET] =
      originalSendAsync as typeof proxiedSendAsync;
  if (proxiedSend) {
    (proxiedSend as WithMarker<typeof proxiedSend>)[WRAP_MARKER] = true;
    (proxiedSend as WithMarker<typeof proxiedSend>)[WRAP_TARGET] =
      originalSend as typeof proxiedSend;
  }

  try {
    Object.defineProperty(provider, "request", {
      configurable: true,
      value: proxiedRequest,
      writable: true,
    });

    if (proxiedSendAsync) {
      Object.defineProperty(provider, "sendAsync", {
        configurable: true,
        value: proxiedSendAsync,
        writable: true,
      });
    }

    if (proxiedSend) {
      Object.defineProperty(provider, "send", {
        configurable: true,
        value: proxiedSend,
        writable: true,
      });
    }
  } catch (error) {
    unwrappableProviders.add(provider);
    reportFrozenProvider(provider, error);
    return false;
  }

  wrappedProviders.add(provider);
  try {
    Object.defineProperty(provider, PROVIDER_MARKER, {
      configurable: false,
      value: true,
      writable: false,
    });
  } catch {
    // WeakSet idempotency still prevents double-wrapping in this realm.
  }
  return true;
}

const KNOWN_SOURCES = [
  "ethereum",
  "coinbaseWalletExtension",
  "eth",
  "rsk",
  "bsc",
  "polygon",
  "arbitrum",
  "fuse",
  "avalanche",
  "optimism",
] as const;

function proxyProviderTree(provider: Eip1193Provider | undefined): boolean {
  if (!provider) return false;
  const wrapped = proxyEthereumProvider(provider);
  if (Array.isArray(provider.providers)) {
    for (const subProvider of provider.providers) {
      proxyEthereumProvider(subProvider);
    }
  }
  return wrapped;
}

function installEthereumAccessorHook(): void {
  const descriptor = Object.getOwnPropertyDescriptor(window, "ethereum");
  if (descriptor && !descriptor.configurable) {
    proxyProviderTree(asProvider(window.ethereum));
    return;
  }

  const originalGet = descriptor?.get;
  const originalSet = descriptor?.set;
  let assignedValue =
    descriptor && "value" in descriptor ? descriptor.value : window.ethereum;
  const existing = originalGet ? originalGet.call(window) : assignedValue;

  Object.defineProperty(window, "ethereum", {
    configurable: true,
    enumerable: descriptor?.enumerable ?? true,
    get() {
      return originalGet ? originalGet.call(window) : assignedValue;
    },
    set(value) {
      if (originalSet) {
        originalSet.call(window, value);
      } else {
        assignedValue = value;
      }
      proxyProviderTree(asProvider(value));
    },
  });

  proxyProviderTree(asProvider(existing));
}

function discoverAndProxyAll(): void {
  for (const key of KNOWN_SOURCES) {
    const provider = asProvider(window[key]);
    if (!provider) continue;
    proxyProviderTree(provider);
  }
}

const DAMBI_RDNS = "dev.dambi.wrapper";
const FALLBACK_ICON =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4//8/AwAI/AL+T1pNCgAAAABJRU5ErkJggg==";

function reannounceWrapped(detail: unknown): void {
  const providerDetail = detail as {
    info?: { uuid?: string; name?: string; icon?: string; rdns?: string };
    provider?: Eip1193Provider;
  };
  const provider = asProvider(providerDetail.provider);
  if (!provider || reannouncedProviders.has(provider)) return;

  if (!proxyEthereumProvider(provider)) return;
  reannouncedProviders.add(provider);

  const info = Object.freeze({
    uuid: `dambi-${providerDetail.info?.uuid ?? Math.random().toString(36).slice(2)}`,
    name: `Dambi (wraps ${providerDetail.info?.name ?? "provider"})`,
    icon: providerDetail.info?.icon ?? FALLBACK_ICON,
    rdns: DAMBI_RDNS,
  });

  window.dispatchEvent(
    new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    }),
  );
}

const eip6963Listener = (event: Event) => {
  const detail = (event as CustomEvent).detail;
  if (detail?.info?.rdns === DAMBI_RDNS) return;
  reannounceWrapped(detail);
};
installState.eip6963Listener = eip6963Listener;
window.addEventListener("eip6963:announceProvider", eip6963Listener);

installEthereumAccessorHook();
window.dispatchEvent(new Event("eip6963:requestProvider"));

discoverAndProxyAll();
const pollDeadline = Date.now() + 30_000;
let pollHandle: number | undefined = window.setInterval(() => {
  discoverAndProxyAll();
  if (Date.now() > pollDeadline && pollHandle !== undefined) {
    window.clearInterval(pollHandle);
    if (installState.pollHandle === pollHandle) {
      installState.pollHandle = undefined;
    }
    pollHandle = undefined;
  }
}, 100);
installState.pollHandle = pollHandle;
