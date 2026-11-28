// @vitest-environment happy-dom
/**
 * The bypass observer's copy of a request must fingerprint the same as the
 * request the wrapper sent for a verdict. Both sides are fed the wallet's real
 * message shapes: the wrapper side as `proxy-injected-providers.ts` builds its
 * payload from the dApp's params, the observer side by running the unmodified
 * `bypass-check.ts` on the message the wallet's in-page script posts.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Identifier } from "@lib/identifier";
import { RequestType, type MessageData } from "@lib/types";
import { consumeForwarded, rememberForwarded, resetForwarded } from "../../service-worker/forwarded-requests";

const forwarded: MessageData[] = [];
vi.mock("webextension-polyfill", () => ({ default: { runtime: { connect: () => ({ name: "port" }) } } }));
vi.mock("@lib/messages", () => ({ sendToPortAndDisregard: (_port: unknown, data: MessageData) => { forwarded.push(data); } }));

const PAGE = { tabId: 1, frameId: 0, origin: "https://app.example" };
const ACCOUNT = "0x52908400098527886E0F7030069857D2E4169EE7";
const ROUTER = "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D";
const HOST = location.hostname;

/** What MetaMask's in-page provider posts to its content script for one JSON-RPC call. */
const metamaskPost = (payload: unknown): void => {
  window.dispatchEvent(new MessageEvent("message", { source: window, data: {
    target: Identifier.METAMASK_CONTENT_SCRIPT,
    data: { name: Identifier.METAMASK_PROVIDER, data: payload },
  } }));
};
const rpc = (method: string, params: unknown[], id = 1) => ({ id, jsonrpc: "2.0", method, params });
/** What Coinbase Wallet's in-page script posts for one request. */
const coinbasePost = (request: unknown): void => {
  window.dispatchEvent(new MessageEvent("message", { source: window, data: {
    type: Identifier.COINBASE_WALLET_REQUEST, data: { id: "1", request },
  } }));
};

/** The wrapper's verdict request for `eth_sendTransaction` (checkTransaction). */
const wrapperTx = (tx: Record<string, unknown>, chainId: number, connected = ACCOUNT): MessageData =>
  ({ type: RequestType.TRANSACTION, method: "eth_sendTransaction", chainId, hostname: HOST, transaction: typeof tx.from === "string" ? tx : { ...tx, from: connected } }) as MessageData;

describe("bypass observer copy vs. the wrapper's request", () => {
  // Registered once: the observer's listeners stay on the window for the whole file.
  beforeAll(async () => { await import("../bypass-check"); });
  beforeEach(() => {
    window.dispatchEvent(new MessageEvent("message", { source: window, data: {
      target: Identifier.METAMASK_INPAGE,
      data: { name: Identifier.METAMASK_PROVIDER, data: { method: "metamask_chainChanged", params: { chainId: "0x2105" } } },
    } }));
    forwarded.length = 0;
    resetForwarded();
  });

  it("MetaMask eth_sendTransaction: a swap on another chain", () => {
    const tx = { from: ACCOUNT, to: ROUTER, value: "0x2386f26fc10000", data: "0x7FF36AB5" + "00".repeat(64), gas: "0x30d40" };
    rememberForwarded(PAGE, wrapperTx(tx, 8453));
    metamaskPost(rpc("eth_sendTransaction", [tx]));
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]).toMatchObject({ bypassed: true, chainId: 8453 }); // the observer never saw a chainChanged
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(true);
  });

  it("MetaMask eth_sendTransaction: missing signer remains observable", () => {
    // The wrapper fills `from` in for its verdict request; the wallet gets the dApp's object.
    const tx = { to: ROUTER, data: "0xa9059cbb" + "11".repeat(64) };
    rememberForwarded(PAGE, wrapperTx(tx, 8453));
    metamaskPost(rpc("eth_sendTransaction", [tx]));
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(false);
  });

  it("MetaMask batch: each transaction in the batch is matched on its own", () => {
    const a = { from: ACCOUNT, to: ROUTER, value: "0x1", data: "0x" };
    const b = { from: ACCOUNT, to: ROUTER, value: "0x2", data: "0x" };
    rememberForwarded(PAGE, wrapperTx(a, 8453));
    metamaskPost([rpc("eth_sendTransaction", [a], 1), rpc("eth_sendTransaction", [b], 2)]);
    expect(forwarded).toHaveLength(2);
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(true);
    expect(consumeForwarded(PAGE, forwarded[1]!)).toBe(false); // never allowed by the wrapper
  });

  it("MetaMask eth_signTypedData_v4: the dApp passes JSON text, the observer parses it", () => {
    const typedData = JSON.stringify({
      types: { EIP712Domain: [{ name: "name", type: "string" }], Permit: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }] },
      primaryType: "Permit", domain: { name: "Token", chainId: 8453, verifyingContract: ROUTER },
      message: { spender: ROUTER, value: "115792089237316195423570985008687907853269984665640564039457584007913129639935" },
    });
    // checkTypedSignature: params are [signer, typedData]; the payload goes on as given.
    rememberForwarded(PAGE, { type: RequestType.TYPED_SIGNATURE, method: "eth_signTypedData_v4", chainId: 8453, hostname: HOST, address: ACCOUNT, typedData } as MessageData);
    metamaskPost(rpc("eth_signTypedData_v4", [ACCOUNT.toLowerCase(), typedData]));
    expect(forwarded[0]).toMatchObject({ type: RequestType.TYPED_SIGNATURE, bypassed: true });
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(true);
  });

  it("MetaMask personal_sign: [message, account]", () => {
    const message = "0x5369676e20696e";
    rememberForwarded(PAGE, { type: RequestType.UNTYPED_SIGNATURE, method: "personal_sign", address: ACCOUNT, chainId: 8453, hostname: HOST, message } as MessageData);
    metamaskPost(rpc("personal_sign", [message, ACCOUNT]));
    expect(forwarded[0]).toMatchObject({ type: RequestType.UNTYPED_SIGNATURE, bypassed: true });
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(true);
  });

  it("Coinbase signEthereumTransaction: the observer preserves integer wei without a hex round-trip", () => {
    const tx = { from: ACCOUNT, to: ROUTER, value: "0x38d7ea4c68000", data: "0xabcdef" };
    rememberForwarded(PAGE, wrapperTx(tx, 8453));
    coinbasePost({ method: "signEthereumTransaction", params: {
      fromAddress: ACCOUNT, toAddress: ROUTER, weiValue: "1000000000000000", shouldSubmit: true, data: "0xabcdef", chainId: 8453,
    } });
    expect(forwarded[0]).toMatchObject({ bypassed: true, transaction: { value: "1000000000000000" } });
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(true);
  });

  it("Coinbase preserves exact values above the JavaScript safe integer range", () => {
    const wei = 1234567890123456789n;
    const tx = { from: ACCOUNT, to: ROUTER, value: "0x" + wei.toString(16), data: "0x" };
    rememberForwarded(PAGE, wrapperTx(tx, 1));
    coinbasePost({ method: "signEthereumTransaction", params: { fromAddress: ACCOUNT, toAddress: ROUTER, shouldSubmit: true, weiValue: wei.toString(), data: "0x", chainId: 1 } });
    expect(forwarded[0]).toMatchObject({transaction:{value:wei.toString()}});
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(true);
  });

  it("Coinbase signatures without authoritative chain/version remain observations", () => {
    const typed = { primaryType: "Order", domain: { chainId: 1, name: "X" }, message: { amount: "1" } };
    rememberForwarded(PAGE, { type: RequestType.TYPED_SIGNATURE, method: "eth_signTypedData_v4", chainId: 1, hostname: HOST, address: ACCOUNT, typedData: typed } as MessageData);
    coinbasePost({ method: "signEthereumMessage", params: { address: ACCOUNT, typedDataJson: JSON.stringify(typed) } });
    expect(consumeForwarded(PAGE, forwarded[0]!)).toBe(false);

    rememberForwarded(PAGE, { type: RequestType.UNTYPED_SIGNATURE, method: "personal_sign", address: ACCOUNT, chainId: 8453, hostname: HOST, message: "0x68656c6c6f" } as MessageData);
    coinbasePost({ method: "signEthereumMessage", params: { address: ACCOUNT, message: "0x68656c6c6f" } });
    expect(consumeForwarded(PAGE, forwarded[1]!)).toBe(false);
  });
});
