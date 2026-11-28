import { beforeEach, describe, expect, it } from "vitest";
import { RequestType, type MessageData } from "@lib/types";
import { FORWARDED_TTL_MS, consumeForwarded, discardForwarded, rememberForwarded, resetForwarded, sourceOf } from "../forwarded-requests";

const PAGE = { tabId: 3, frameId: 0, origin: "https://app.example" };
const FROM = "0x52908400098527886E0F7030069857D2E4169EE7";
const TO = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const tx = (transaction: Record<string, unknown>, extra: Record<string, unknown> = {}): MessageData =>
  ({ type: RequestType.TRANSACTION, method: "eth_sendTransaction", chainId: 1, hostname: "app.example", transaction, ...extra }) as MessageData;

describe("forwarded request fingerprints", () => {
  beforeEach(() => resetForwarded());

  it("normalises addresses, calldata and value", () => {
    rememberForwarded(PAGE, tx({ from: FROM, to: TO, data: "0xABCDEF", value: "0x0de0b6b3a7640000" }));
    expect(consumeForwarded(PAGE, tx({ from: FROM.toLowerCase(), to: TO.toLowerCase(), data: "0xabcdef", value: "0xDE0B6B3A7640000" }))).toBe(true);
  });

  it("treats a missing value as 0 and missing calldata as empty", () => {
    for (const [stored, seen] of [[undefined, "0x0"], ["0x00", undefined], ["0", "0x00"], [0, "0"]] as const) {
      rememberForwarded(PAGE, tx({ from: FROM, to: TO, value: stored }));
      expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO, data: "0x", value: seen }))).toBe(true);
    }
  });

  it("treats unprefixed wei as decimal and retains precision", () => {
    for (const wei of [16n, 9007199254740993n]) {
      const amount = (value: string) => tx({ from: FROM, to: TO, value });
      rememberForwarded(PAGE, amount(wei.toString()));
      expect(consumeForwarded(PAGE, amount("10"))).toBe(false);
      expect(consumeForwarded(PAGE, amount("0x" + wei.toString(16)))).toBe(true);
    }
  });

  it("does not match a different amount, recipient, calldata or sender", () => {
    const base = { from: FROM, to: TO, data: "0xabcdef", value: "0x1" };
    rememberForwarded(PAGE, tx(base));
    expect(consumeForwarded(PAGE, tx({ ...base, value: "0x2" }))).toBe(false);
    expect(consumeForwarded(PAGE, tx({ ...base, to: FROM }))).toBe(false);
    expect(consumeForwarded(PAGE, tx({ ...base, data: "0xabcdee" }))).toBe(false);
    expect(consumeForwarded(PAGE, tx({ ...base, from: TO }))).toBe(false);
    expect(consumeForwarded(PAGE, tx(base))).toBe(true);
  });

  it("requires a matching confirmed chain", () => {
    rememberForwarded(PAGE, tx({ from: FROM, to: TO, value: "0x1" }, { chainId: 8453 }));
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO, value: "0x1" }, { chainId: 1 }))).toBe(false);
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO, value: "0x1" }, { chainId: 0 }))).toBe(false);
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO, value: "0x1" }, { chainId: 8453 }))).toBe(true);
  });

  it("is consumed by one bypass message", () => {
    rememberForwarded(PAGE, tx({ from: FROM, to: TO }));
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO }))).toBe(true);
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO }))).toBe(false);
  });

  it("retracts a stale approval only for its own request and browser frame", () => {
    const value = tx({ from: FROM, to: TO });
    rememberForwarded(PAGE, value, 10, "old");
    rememberForwarded(PAGE, value, 10, "other");
    discardForwarded({ ...PAGE, frameId: 2 }, "other");
    discardForwarded(PAGE, "old");
    expect(consumeForwarded(PAGE, value, 11)).toBe(true);
    expect(consumeForwarded(PAGE, value, 11)).toBe(false);
  });

  it("lives two minutes", () => {
    rememberForwarded(PAGE, tx({ from: FROM, to: TO }), 1_000);
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO }), 1_000 + FORWARDED_TTL_MS)).toBe(false);
    rememberForwarded(PAGE, tx({ from: FROM, to: TO }), 1_000);
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO }), 1_000 + FORWARDED_TTL_MS - 1)).toBe(true);
  });

  it("is scoped to the tab and the page origin", () => {
    rememberForwarded(PAGE, tx({ from: FROM, to: TO }));
    expect(consumeForwarded({ ...PAGE, frameId: 1 }, tx({ from: FROM, to: TO }))).toBe(false);
    expect(consumeForwarded({ ...PAGE, tabId: 4 }, tx({ from: FROM, to: TO }))).toBe(false);
    expect(consumeForwarded({ ...PAGE, origin: "https://other.example" }, tx({ from: FROM, to: TO }))).toBe(false);
    expect(consumeForwarded(undefined, tx({ from: FROM, to: TO }))).toBe(false);
    expect(consumeForwarded(PAGE, tx({ from: FROM, to: TO }))).toBe(true);
  });

  it("matches signatures by signer and payload, whatever the key order", () => {
    const typed = (typedData: unknown, address = FROM): MessageData =>
      ({ type: RequestType.TYPED_SIGNATURE, method: "eth_signTypedData_v4", chainId: 1, hostname: "app.example", address, typedData }) as MessageData;
    rememberForwarded(PAGE, typed({ domain: { name: "X", chainId: 1 }, primaryType: "Permit", message: { a: 1, b: "2" } }));
    expect(consumeForwarded(PAGE, typed({ primaryType: "Permit", message: { b: "2", a: 1 }, domain: { chainId: 1, name: "X" } }, FROM.toLowerCase()))).toBe(true);
    rememberForwarded(PAGE, typed({ primaryType: "Permit", message: { a: 1 } }));
    expect(consumeForwarded(PAGE, typed({ primaryType: "Permit", message: { a: 2 } }))).toBe(false);
    expect(consumeForwarded(PAGE, typed({ primaryType: "Permit", message: { a: 1 } }, TO))).toBe(false);

    const untyped = (message: string): MessageData => ({ type: RequestType.UNTYPED_SIGNATURE, method: "personal_sign", chainId: 1, address: FROM, hostname: "app.example", message }) as MessageData;
    rememberForwarded(PAGE, untyped("0x48656c6c6f"));
    expect(consumeForwarded(PAGE, { ...untyped("0x48656c6c6f"), method: "eth_sign" } as MessageData)).toBe(false);
    expect(consumeForwarded(PAGE, { ...untyped("0x48656c6c6f"), address: TO } as MessageData)).toBe(false);
    expect(consumeForwarded(PAGE, untyped("0x48656c6c6e"))).toBe(false);
    expect(consumeForwarded(PAGE, untyped("0x48656c6c6f"))).toBe(true);
    // A signature never matches a transaction.
    rememberForwarded(PAGE, untyped("0x"));
    expect(consumeForwarded(PAGE, tx({}))).toBe(false);
  });

  it("takes the tab and origin from the browser's sender, and needs both", () => {
    expect(sourceOf({ tab: { id: 5 }, frameId: 4, url: "https://app.example/swap?x=1" })).toEqual({ tabId: 5, frameId: 4, origin: "https://app.example" });
    expect(sourceOf({ tab: { id: 5 }, frameId: 4, origin: "https://frame.example", url: "https://app.example/" })).toEqual({ tabId: 5, frameId: 4, origin: "https://frame.example" });
    expect(sourceOf({ url: "https://app.example/" })).toBeUndefined();
    expect(sourceOf({ tab: { id: 5 } })).toBeUndefined();
    expect(sourceOf(undefined)).toBeUndefined();
  });
});
