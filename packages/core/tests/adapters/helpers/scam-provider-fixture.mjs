import assert from "node:assert/strict";
import { V2_SYNC_TOPIC } from "../../../dist/adapters/scam-pool-history.js";

const quantity = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const blockHash = (n) => `0x${word(BigInt(n) + 10_000n)}`;
const addressWord = (value) => `0x${value.slice(2).padStart(64, "0")}`;

/** Synthetic raw JSON-RPC only. Actual builders and provider perform every
 * normalization step; no FactBatch or algorithm result is fabricated here.
 * Factory deployment support is an explicit test declaration, not GIWA proof.
 */
export function scamProviderRpcFixture({ now, chainId, factory, pool, token, quoteToken, failure } = {}) {
  const calls = [];
  const referenceHeight = 1_000n;
  const head = referenceHeight + 2n;
  const originSec = BigInt(now / 1_000) - head;
  const header = (n) => ({ number: quantity(n), hash: blockHash(n), parentHash: blockHash(n - 1n),
    timestamp: quantity(originSec + n) });
  const sync = (n, reserveQuote) => ({ address: pool, blockNumber: quantity(n), blockHash: blockHash(n),
    transactionHash: `0x${word(n + 100_000n)}`, transactionIndex: "0x0", logIndex: "0x0",
    topics: [V2_SYNC_TOPIC], data: `0x${word(1_000)}${word(reserveQuote)}`, removed: false });
  const logs = [sync(996n, 1_200), sync(998n, 1_000)];
  let referenceReads = 0;
  let failureObserved = false;
  const fetch = async (_url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push(rpc);
    const ok = (result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    if (rpc.method === "eth_chainId") return ok(quantity(chainId));
    if (rpc.method === "eth_getBlockByNumber") {
      const n = rpc.params[0] === "latest" ? head : BigInt(rpc.params[0]);
      const value = header(n);
      if (n === referenceHeight && ++referenceReads > 1 && failure === "reorg") {
        failureObserved = true;
        value.hash = `0x${"ee".repeat(32)}`;
      }
      return ok(value);
    }
    if (rpc.method === "eth_getCode") return ok("0x6000");
    if (rpc.method === "eth_getLogs") {
      const { address, fromBlock, toBlock, topics } = rpc.params[0];
      if (address === pool && failure === "missing_history") {
        failureObserved = true;
        return new Response("synthetic archive unavailable", { status: 500 });
      }
      if (address === pool && failure === "timeout") {
        failureObserved = true;
        return new Promise((_resolve, reject) => {
          const aborted = () => reject(new DOMException("Synthetic request cancelled", "AbortError"));
          if (init.signal.aborted) aborted();
          else init.signal.addEventListener("abort", aborted, { once: true });
        });
      }
      return ok(logs.filter((log) => log.address === address && topics[0].includes(log.topics[0])
        && BigInt(log.blockNumber) >= BigInt(fromBlock) && BigInt(log.blockNumber) <= BigInt(toBlock)));
    }
    if (rpc.method === "eth_call") {
      const selector = rpc.params[0].data.slice(0, 10);
      const result = {
        "0x0dfe1681": addressWord(token), "0xd21220a7": addressWord(quoteToken),
        "0xc45a0155": addressWord(factory), "0xe6a43905": addressWord(pool),
        "0x0902f1ac": `0x${word(1_000)}${word(1_000)}${word(0)}`,
        "0x313ce567": `0x${word(18)}`,
      }[selector];
      assert.notEqual(result, undefined, `Unexpected synthetic selector: ${selector}`);
      return ok(result);
    }
    throw new Error(`Unexpected synthetic RPC method: ${rpc.method}`);
  };
  return {
    calls, get failureObserved() { return failureObserved; },
    rpc: { chainId, endpoint: { rpcUrl: "https://rpc.invalid/sf4-5" }, factories: [factory], quoteTokens: [quoteToken],
      fetch, clock: { now: () => now },
      limits: { maxRequests: 100, maxResponseBytes: 65_536, maxTotalResponseBytes: 1_000_000,
        maxLogs: 1_000, maxBlocksPerQuery: 10_000, concurrency: 2, maxRetries: 0, retryDelayMs: 0 } },
    factorySupport: [{ id: "sf4-5-synthetic-v2", chainId, factory, abi: "uniswap_v2",
      nonRecreationSupportId: "sf4-5-synthetic-nonrecreating" }],
    history: { maxPoints: 1_000, maxLogs: 1_000, maxBlockLookups: 100, blockTimeHintMs: 1_000 },
    profile: { maxEvents: 1_000, maxLogs: 1_000, maxBlockLookups: 100, blockTimeHintMs: 1_000 },
  };
}
