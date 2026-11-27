import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { AdapterError, createOnchainPolicySource } from "@dambi/core/adapters";
import { keccak256 } from "../../dist/adapters/onchain-policy.js";
import { fakeRpc, options, encodeRead, NOW, HASH, REGISTRY, SCOPE, SCOPE_CALLDATA, READ_CALLDATA } from "../../../../fixtures/sdk/onchain-policy/fake-rpc.mjs";

const code = (expected) => (error) => error instanceof AdapterError && error.code === expected;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("Keccak uses Ethereum padding and selectors, not SHA3", () => {
  assert.equal(keccak256(new Uint8Array()), "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
  assert.equal(keccak256(new TextEncoder().encode("transfer(address,uint256)")).slice(0, 10), "0xa9059cbb");
  assert.equal(keccak256(new TextEncoder().encode("scopeId(string,string)")).slice(0, 10), "0xc8121043");
  assert.equal(keccak256(new TextEncoder().encode("read(bytes32,uint256)")).slice(0, 10), "0x3d301c91");
});

test("fake RPC rejects wrong selectors and noncanonical complete F4 calldata", async (t) => {
  const rpc = await fakeRpc(t);
  let id = 0;
  async function call(data) {
    const requestId = ++id;
    const response = await fetch(rpc.url, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method: "eth_call",
        params: [{ to: REGISTRY, data }, { blockHash: HASH, requireCanonical: true }] }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.id, requestId);
    assert.equal(body.jsonrpc, "2.0");
    return body;
  }
  assert.equal((await call(SCOPE_CALLDATA)).result, SCOPE);
  assert.equal((await call(READ_CALLDATA)).result, rpc.tuple);
  const replaceWord = (data, index, value) => data.slice(0, 10 + index * 64)
    + BigInt(value).toString(16).padStart(64, "0") + data.slice(10 + (index + 1) * 64);
  const invalid = [
    `0x00000000${SCOPE_CALLDATA.slice(10)}`,
    `0xdeadbeef${READ_CALLDATA.slice(10)}`,
    `0x3d301c91${SCOPE_CALLDATA.slice(10)}`, // valid selector, wrong arguments
    `0xc8121043${READ_CALLDATA.slice(10)}`,
    replaceWord(SCOPE_CALLDATA, 0, 96), // wrong dynamic offset
    replaceWord(SCOPE_CALLDATA, 1, 64), // aliased strings
    replaceWord(SCOPE_CALLDATA, 2, 8), // wrong UTF-8 byte length
    `${SCOPE_CALLDATA.slice(0, 10 + 3 * 64 + 14)}01${SCOPE_CALLDATA.slice(10 + 3 * 64 + 16)}`,
    `${SCOPE_CALLDATA.slice(0, -2)}01`, // nonzero second string padding
    `${READ_CALLDATA.slice(0, 10)}${"00".repeat(32)}${READ_CALLDATA.slice(74)}`,
    replaceWord(READ_CALLDATA, 1, 1), // fixture requires head selection
    SCOPE_CALLDATA.slice(0, -2), READ_CALLDATA.slice(0, -2),
    `${SCOPE_CALLDATA}${"00".repeat(32)}`, `${READ_CALLDATA}00`,
  ];
  for (const data of invalid) {
    const body = await call(data);
    assert.equal(Object.hasOwn(body, "result"), false);
    assert.deepEqual(body.error, { code: -32602, message: "Unexpected F4 calldata" });
  }
  assert.deepEqual(rpc.rejectedCalls, invalid);
  // The actual adapter must also satisfy this independent full-byte oracle.
  await createOnchainPolicySource(options(rpc)).fetch();
  assert.deepEqual(rpc.requests.slice(-7).filter((r) => r.method === "eth_call")
    .map((r) => r.params[0].data), [SCOPE_CALLDATA, READ_CALLDATA]);
  assert.equal(rpc.rejectedCalls.length, invalid.length);
});

test("configuration is explicit and copied before any request", async (t) => {
  const rpc = await fakeRpc(t);
  for (const invalid of [
    { finality: "latest" }, { finality: undefined }, { chainId: "91342" },
    { chainId: "eip155:0" }, { chainId: "eip155:-1" },
    { chainId: "eip155:9007199254740992" }, { chainId: 91342 },
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
    chainId: 91342, registryAddress: "0x1111111111111111111111111111111111111111",
    env: "staging", profile: "default", version: 42, status: "active",
    payloadDigest: `0x${createHash("sha256").update(payload, "utf8").digest("hex")}`,
    finality: "finalized",
    blockNumber: 100, blockHash: HASH, blockTimestamp: NOW / 1000, observedAtMs: NOW,
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
  assert.equal((await source.fetch()).registryState.version, 43);
  rpc.advance();
  rpc.tuple = encodeRead({ sequence: 43, status: 3, payload: '{"sequence":43}' });
  const revoked = await source.fetch();
  assert.equal(revoked.registryState.status, "revoked");
  assert.equal(revoked.registryState.version, 43);
  assert.equal(revoked.registryState.finality, "finalized");
  assert.equal(revoked.registryState.payloadDigest,
    `0x${createHash("sha256").update(revoked.payload, "utf8").digest("hex")}`);
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

test("RegistryObservation preserves safe numeric boundaries and configured finality", async (t) => {
  const rpc = await fakeRpc(t);
  for (const finality of ["safe", "finalized"]) {
    for (const number of [0, Number.MAX_SAFE_INTEGER]) {
      rpc.block.number = `0x${BigInt(number).toString(16)}`;
      rpc.chainId = "0x1fffffffffffff";
      rpc.tuple = encodeRead({ sequence: Number.MAX_SAFE_INTEGER });
      const source = createOnchainPolicySource(options(rpc, {
        chainId: "eip155:9007199254740991", finality,
      }));
      const bundle = await source.fetch();
      assert.equal(bundle.registryState.chainId, Number.MAX_SAFE_INTEGER);
      assert.equal(bundle.registryState.blockNumber, number);
      assert.equal(bundle.registryState.version, Number.MAX_SAFE_INTEGER);
      assert.equal(bundle.registryState.finality, finality);
      assert.equal(Object.hasOwn(bundle.registryState, "sequence"), false);
      assert.equal(rpc.requests.at(-6).params[0], finality);
    }
  }
});

test("unsafe or negative RPC heights reject before publication, including the final recheck", async (t) => {
  const rpc = await fakeRpc(t);
  const source = createOnchainPolicySource(options(rpc));
  await source.fetch();
  for (const number of ["0x20000000000000", "-0x1"]) {
    for (const recheckOnly of [false, true]) {
      rpc.transform = (result, request) => request.method === "eth_getBlockByNumber"
        && (!recheckOnly || request.params[0] === rpc.block.number)
        ? { ...result, number } : result;
      await assert.rejects(source.fetch(), code("INVALID_RESPONSE"));
    }
  }
  rpc.transform = undefined;
  rpc.chainId = "0x20000000000000";
  await assert.rejects(source.fetch(), code("CHAIN_MISMATCH"));
  rpc.chainId = "0x164ce";
  assert.equal((await source.fetch()).registryState.observedAtMs, NOW);
});

test("the tuple digest is forwarded, not synthesized or replaced from another observation", async (t) => {
  const rpc = await fakeRpc(t);
  const payload = ' {"note":"원문", "n":1.00}\n';
  const digest = `0x${"12".repeat(32)}`;
  // Deliberately inconsistent: the transport must expose the registry claim
  // unchanged so Core can reject its binding, not silently repair the claim.
  rpc.tuple = encodeRead({ payload, digest });
  const source = createOnchainPolicySource(options(rpc, { finality: "safe" }));
  const first = await source.fetch();
  assert.equal(first.payload, payload);
  assert.equal(first.registryState.payloadDigest, digest);
  assert.equal(first.registryState.finality, "safe");
  rpc.tuple = encodeRead({ payload });
  await assert.rejects(source.fetch(), code("REORG"));
  rpc.advance();
  const next = await source.fetch();
  assert.equal(next.payload, payload);
  assert.equal(next.registryState.payloadDigest,
    `0x${createHash("sha256").update(payload, "utf8").digest("hex")}`);
  assert.notEqual(next.registryState.blockHash, first.registryState.blockHash);
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
  assert.equal((await source.fetch()).registryState.version, 43);
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
