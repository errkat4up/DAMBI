import { AdapterError } from "./errors.js";

// Internal codec only. Transport, batch binding and Fact provenance belong to
// the FactProvider; these helpers never perform I/O or apply policy projections.
export interface BalanceCall {
  readonly chainId: string;
  readonly owner: string;
  readonly token: string;
}

export interface RpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: string;
  readonly method: "eth_chainId" | "eth_blockNumber" | "eth_call";
  readonly params: readonly unknown[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => keys.includes(key));
}

/** Canonical positive EIP-155 reference within CAIP-2's 32-character limit. */
export function parseEip155ChainId(value: unknown): bigint | undefined {
  // Absolute end assertions also reject a final newline (unlike JavaScript $).
  if (typeof value !== "string" || !/^eip155:[1-9][0-9]{0,31}(?![\s\S])/.test(value)) return undefined;
  return BigInt(value.slice(7));
}

function address(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}(?![\s\S])/.test(value);
}

/** Unsupported or malformed individual calls are omitted by the provider. */
export function resolveBalanceCall(
  method: unknown,
  params: unknown,
  supportedChains: ReadonlySet<string>,
): BalanceCall | undefined {
  if (method !== "portfolio.balance" || !record(params)
      || !exactKeys(params, ["chain_id", "owner", "asset"])) return undefined;
  const { chain_id: chainId, owner, asset } = params;
  if (typeof chainId !== "string" || parseEip155ChainId(chainId) === undefined
      || !supportedChains.has(chainId) || !address(owner)
      || !record(asset) || !exactKeys(asset, ["key"]) || !record(asset.key)) return undefined;
  const key = asset.key;
  // The current TokenRef contains only key. Reject extensions (including block
  // selectors) until their semantics are supported, rather than using latest.
  if (!exactKeys(key, ["standard", "chain", "address"]) || key.standard !== "erc20"
      || key.chain !== chainId || !address(key.address)) return undefined;
  return Object.freeze({ chainId, owner: owner.toLowerCase(), token: key.address.toLowerCase() });
}

function assertId(id: string): void {
  if (typeof id !== "string" || id.length === 0) throw new TypeError("RPC request ID must be a nonempty string.");
}

function request(id: string, method: RpcRequest["method"], params: readonly unknown[]): RpcRequest {
  assertId(id);
  return { jsonrpc: "2.0", id, method, params };
}

export function chainIdRequest(id: string): RpcRequest {
  return request(id, "eth_chainId", []);
}

export function blockNumberRequest(id: string): RpcRequest {
  return request(id, "eth_blockNumber", []);
}

export function balanceOfRequest(id: string, call: BalanceCall, blockNumber: bigint): RpcRequest {
  if (typeof blockNumber !== "bigint" || blockNumber < 0n) {
    throw new TypeError("RPC block number must be a nonnegative bigint.");
  }
  return request(id, "eth_call", [
    { to: call.token, data: `0x70a08231${call.owner.slice(2).padStart(64, "0")}` },
    `0x${blockNumber.toString(16)}`,
  ]);
}

function invalidResponse(): never {
  throw new AdapterError("INVALID_RESPONSE", "The endpoint did not return a supported EVM RPC response.");
}

/** Valid RPC failures stay distinct from malformed envelopes and HTTP failures. */
export class RpcResponseError extends Error {
  readonly rpcCode: number;

  constructor(rpcCode: number) {
    // Remote messages/data can echo credentials or arbitrary response contents.
    super("The RPC endpoint rejected the request.");
    this.name = "RpcResponseError";
    this.rpcCode = rpcCode;
  }
}

export function readRpcResult(text: string, expectedId: string): unknown {
  assertId(expectedId);
  let envelope: unknown;
  try { envelope = JSON.parse(text) as unknown; }
  catch { return invalidResponse(); }
  if (!record(envelope) || envelope.jsonrpc !== "2.0" || envelope.id !== expectedId
      || !Object.hasOwn(envelope, "jsonrpc") || !Object.hasOwn(envelope, "id")) return invalidResponse();
  const hasResult = Object.hasOwn(envelope, "result");
  const hasError = Object.hasOwn(envelope, "error");
  if (hasResult === hasError) return invalidResponse();
  if (hasError) {
    const error = envelope.error;
    if (!record(error) || !Object.hasOwn(error, "code") || !Object.hasOwn(error, "message")
        || typeof error.code !== "number" || !Number.isSafeInteger(error.code)
        || typeof error.message !== "string") return invalidResponse();
    throw new RpcResponseError(error.code);
  }
  return envelope.result;
}

/** EIP-1474 Quantity: no leading zeros, unlike a padded ABI Data word. */
export function decodeQuantity(value: unknown): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)(?![\s\S])/.test(value)) return invalidResponse();
  return BigInt(value);
}

/** ERC-20 returns exactly one uint256 ABI word; Core projects balance once. */
export function decodeBalance(value: unknown): { readonly balance: string } {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}(?![\s\S])/.test(value)) return invalidResponse();
  return { balance: `0x${BigInt(value).toString(16)}` };
}
