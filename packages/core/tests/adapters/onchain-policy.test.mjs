import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError, createOnchainPolicySource } from "@dambi/core/adapters";
import { keccak256 } from "../../dist/adapters/onchain-policy.js";
import { fakeRpc, options, encodeRead, NOW, HASH } from "../../../../fixtures/sdk/onchain-policy/fake-rpc.mjs";

const code = (expected) => (error) => error instanceof AdapterError && error.code === expected;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("Keccak uses Ethereum padding and selectors, not SHA3", () => {
  assert.equal(keccak256(new Uint8Array()), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256(new TextEncoder().encode("transfer(address,uint256)")).slice(0, 10), "0xa9059cbb");
});

test("configuration is explicit and copied before any request", async (t) => {
  const rpc = await fakeRpc(t);
  for (const invalid of [
    { finality: "latest" }, { finality: undefined }, { chainId: "91342" },
    { expectedRuntimeCode: "0x" }, { registryAddress: "0x1234" },
    { rpcUrl: "http://remote.example" }, { rpcUrl: "https://user:secret@example.com" },
    { headers: { cookie: "secret" } }, { timeoutMs: 0 }, { timeoutMs: 60_001 },
    { maxStateAgeMs: Number.MAX_SAFE_INTEGER + 1 }, { refreshIntervalMs: 30_000 },
  ]) assert.throws(() => createOnchainPolicySource(options(rpc, invalid)), code("INVALID_CONFIG"));
  assert.equal(rpc.requests.length, 0);
  const input = options(rpc, { headers: { authorization: "Bearer first" } });
  const source = createOnchainPolicySource(input);
  input.headers.authorization = "Bearer changed";
  input.chainId = "eip155:1";
  await source.fetch();
  assert.ok(rpc.requests.every((request) => request.authorization === "Bearer first"));
});

test("one hash-bound tuple supplies active state and unchanged UTF-8/base64 body", async (t) => {
  const rpc = await fakeRpc(t);
  const payload = ' {"sequence":42,"note":"정책 원문", "n":1.00}\n';
  const signature = Buffer.alloc(64, 19).toString("base64");
  rpc.tuple = encodeRead({ payload, signature });
  const source = createOnchainPolicySource(options(rpc));
  assert.equal(source.refreshDue(), true);
  const bundle = await source.fetch();
  assert.equal(bundle.payload, payload);
  assert.equal(bundle.signature, signature);
  assert.deepEqual(bundle.registryState, {
    chainId: "eip155:91342", registryAddress: "0x1111111111111111111111111111111111111111",
    env: "staging", profile: "default", sequence: 42, status: "active",
    blockNumber: "100", blockHash: HASH, blockTimestamp: NOW / 1000, observedAtMs: NOW,
  });
  assert.deepEqual(rpc.requests.map((r) => r.method), [
    "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call", "eth_call",
    "eth_getBlockByNumber", "eth_chainId",
  ]);
  assert.equal(source.refreshDue(), false);
  rpc.now += 5000;
  assert.equal(source.refreshDue(), true);
  assert.equal((await source.fetch()).registryState.observedAtMs, NOW);
  rpc.now = NOW + 20_000;
  await assert.rejects(source.fetch(), code("STATE_EXPIRED"));
});

test("new confirmed blocks refresh state without re-signing; replacement and revocation are explicit", async (t) => {
  const rpc = await fakeRpc(t);
  const source = createOnchainPolicySource(options(rpc));
  const first = await source.fetch();
  rpc.advance();
  const advanced = await source.fetch();
  assert.equal(advanced.payload, first.payload);
  assert.equal(advanced.signature, first.signature);
  assert.ok(advanced.registryState.observedAtMs > first.registryState.observedAtMs);
  rpc.advance();
  rpc.tuple = encodeRead({ sequence: 43, payload: '{"sequence":43}' });
  assert.equal((await source.fetch()).registryState.sequence, 43);
  rpc.advance();
  rpc.tuple = encodeRead({ sequence: 43, status: 3, payload: '{"sequence":43}' });
  assert.equal((await source.fetch()).registryState.status, "revoked");
  rpc.mode = "outage";
  await assert.rejects(source.fetch(), code("HTTP_ERROR"));
});

test("chain/code mismatches and unsupported hash selectors never hide behind cache or latest", async (t) => {
  const rpc = await fakeRpc(t);
  const source = createOnchainPolicySource(options(rpc));
  await source.fetch();
  rpc.chainId = "0x1";
  await assert.rejects(source.fetch(), code("CHAIN_MISMATCH"));
  rpc.chainId = "0x164ce";
  rpc.code = "0x6001";
  await assert.rejects(source.fetch(), code("REGISTRY_MISMATCH"));
  rpc.code = options(rpc).expectedRuntimeCode;
  rpc.mode = "unsupported";
  await assert.rejects(source.fetch(), code("RPC_UNSUPPORTED"));
  assert.ok(rpc.requests.every((request) => !request.params.includes("latest")));
});

test("reorg, same-block mutation, unsafe versions and malformed ABI are not installed", async (t) => {
  const rpc = await fakeRpc(t);
  const source = createOnchainPolicySource(options(rpc));
  await source.fetch();
  rpc.recheckHash = `0x${"99".repeat(32)}`;
  await assert.rejects(source.fetch(), code("REORG"));
  rpc.recheckHash = undefined;
  rpc.tuple = encodeRead({ sequence: 43 });
  await assert.rejects(source.fetch(), code("REORG"));
  rpc.advance();
  for (const tuple of [
    encodeRead({ sequence: 9007199254740992n }),
    encodeRead({ status: 2 }), encodeRead({ status: 4 }),
    encodeRead().slice(0, -2), `${encodeRead()}${"0".repeat(64)}`,
    encodeRead({ signature: Buffer.alloc(63).toString("base64") }),
  ]) {
    rpc.tuple = tuple;
    await assert.rejects(source.fetch(), code("INVALID_RESPONSE"));
  }
  rpc.tuple = encodeRead({ sequence: 0, status: 0 });
  await assert.rejects(source.fetch(), code("POLICY_MISSING"));
  rpc.tuple = encodeRead({ sequence: 43 });
  assert.equal((await source.fetch()).registryState.sequence, 43);
});

test("outages do not return cached state; restart and endpoint/auth replacement revalidate", async (t) => {
  const first = await fakeRpc(t);
  const second = await fakeRpc(t);
  const source = createOnchainPolicySource(options(first));
  await source.fetch();
  first.mode = "outage";
  await assert.rejects(source.fetch(), code("HTTP_ERROR"));
  await assert.rejects(createOnchainPolicySource(options(first)).fetch(), code("HTTP_ERROR"));
  const replacement = createOnchainPolicySource(options(second, { headers: { authorization: "Bearer second" } }));
  assert.equal(replacement.refreshDue(), true);
  assert.equal((await replacement.fetch()).registryState.blockHash, HASH);
  assert.ok(second.requests.every((request) => request.authorization === "Bearer second"));
  second.chainId = "0x1";
  await assert.rejects(replacement.fetch(), code("CHAIN_MISMATCH"));
  first.mode = "ok";
  first.now = NOW + 30_000;
  await assert.rejects(createOnchainPolicySource(options(first)).fetch(), code("STATE_EXPIRED"));
});

test("abort and whole-refresh timeout discard noncooperative late responses", { timeout: 5000 }, async (t) => {
  const rpc = await fakeRpc(t);
  for (const reason of ["ABORTED", "TIMEOUT"]) {
    const entered = deferred();
    const response = deferred();
    const discarded = deferred();
    let held = true;
    const source = createOnchainPolicySource(options(rpc, {
      timeoutMs: reason === "TIMEOUT" ? 25 : 1000,
      fetch: (url, init) => {
        if (!held) return fetch(url, init);
        held = false;
        entered.resolve(init);
        return response.promise;
      },
    }));
    const controller = new AbortController();
    const rejected = assert.rejects(source.fetch({ signal: controller.signal }), code(reason));
    const init = await entered.promise;
    if (reason === "ABORTED") controller.abort();
    await rejected;
    assert.equal(init.signal.aborted, true);
    response.resolve(new Response(new ReadableStream({ cancel() { discarded.resolve(); } })));
    await discarded.promise;
    assert.equal(source.refreshDue(), true);
    assert.equal((await source.fetch()).registryState.status, "active");
  }
});

test("a newer cancelled refresh prevents an older response from publishing cache", { timeout: 5000 }, async (t) => {
  const rpc = await fakeRpc(t);
  const entered = deferred();
  const release = deferred();
  let held = true;
  const source = createOnchainPolicySource(options(rpc, {
    fetch: async (url, init) => {
      if (held) { held = false; entered.resolve(); await release.promise; }
      return fetch(url, init);
    },
  }));
  const older = source.fetch();
  await entered.promise;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.fetch({ signal: controller.signal }), code("ABORTED"));
  release.resolve();
  assert.equal((await older).registryState.status, "active");
  assert.equal(source.refreshDue(), true, "older success must not publish through the cancelled newer generation");
  await source.fetch();
  assert.equal(source.refreshDue(), false);
});
