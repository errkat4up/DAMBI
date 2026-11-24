import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createScamRpcSource } from "../../dist/adapters/scam-rpc.js";
import { buildTokenProfile } from "../../dist/adapters/scam-token-profile.js";
import { SCAM_DATA_BUILDER_VERSION } from "../../dist/adapters/scam-pool-history.js";
import { ADMIN_EVENT_TOPICS, PAIR_CREATED_TOPIC } from "../../dist/adapters/scam-profile-codec.js";

// All HTTP responses are local fixtures. No live RPC or deployed capabilities
// are inferred from the synthetic support declarations in these tests.
const POOL = `0x${"11".repeat(20)}`;
const FACTORY = `0x${"22".repeat(20)}`;
const TOKEN = `0x${"33".repeat(20)}`;
const QUOTE = `0x${"44".repeat(20)}`;
const OTHER = `0x${"55".repeat(20)}`;
const NOW = 10_000_000_000_000;
const q = (n) => `0x${BigInt(n).toString(16)}`;
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const blockHash = (n) => `0x${word(BigInt(n) + 100n)}`;
const addressWord = (value) => `0x${value.slice(2).padStart(64, "0")}`;
const time = (n) => (1_000 + n) * 1_000;
const header = (n) => ({ number: q(n), hash: blockHash(n), parentHash: blockHash(BigInt(n) - 1n), timestamp: q(BigInt(n) + 1_000n) });
const ok = (rpc, result) => new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
const failure = (reason) => ({ name: "ScamRpcError", reason });
const kinds = Object.keys(ADMIN_EVENT_TOPICS);
const subject = () => ({ chainId: 91342, venue: "uniswap_v2", pool: POOL, factory: FACTORY,
  token: TOKEN, quoteToken: QUOTE, actionPaths: ["actions[0]"] });
const params = (target, overrides = {}) => ({ subject: target, referenceGroupId: "profile:test", confirmDepth: 0,
  dataSchema: "scam.token_profile/1", builderVersion: SCAM_DATA_BUILDER_VERSION,
  ageThresholdSec: 10, ageSearchMaxLookbackSec: 10, maxAgeSearchCalls: 30,
  eventLookbackSec: 0, eventKinds: [], ...overrides });
const support = (target = subject()) => ({ id: "fixture:standard-v2", chainId: target.chainId, factory: target.factory,
  abi: "uniswap_v2", nonRecreationSupportId: "fixture:non-recreating-v2" });
const adminSupport = (target = subject()) => ({ id: "fixture:admin-abi", chainId: target.chainId, token: target.token,
  abi: "openzeppelin_standard", kinds, validFromBlock: "0", validThroughBlock: "100000000" });
const options = { maxEvents: 100, maxLogs: 100, maxBlockLookups: 100, blockTimeHintMs: 1_000 };
const rawLog = (address, n, index, topics, data = "0x") => ({ address, blockNumber: q(n), blockHash: blockHash(n),
  transactionHash: `0x${word(BigInt(n) + 1_000_000n)}`, transactionIndex: "0x0", logIndex: q(index), topics, data, removed: false });
const created = (n, index = 0, pair = POOL) => rawLog(FACTORY, n, index,
  [PAIR_CREATED_TOPIC, addressWord(TOKEN), addressWord(QUOTE)], `0x${word(pair)}${word(1)}`);
function adminEvent(kind, n, index = 0) {
  const topic = ADMIN_EVENT_TOPICS[kind];
  if (kind === "owner_changed") return rawLog(TOKEN, n, index, [topic, addressWord(TOKEN), addressWord(OTHER)]);
  if (kind === "proxy_upgraded") return rawLog(TOKEN, n, index, [topic, addressWord(OTHER)]);
  if (kind === "admin_changed") return rawLog(TOKEN, n, index, [topic], `0x${word(TOKEN)}${word(OTHER)}`);
  return rawLog(TOKEN, n, index, [topic], addressWord(TOKEN));
}

function fixture({ head = 20, target = subject(), logs = [], code = "0x6000", headerFor = header,
  maxBlocksPerQuery = 10_000, rpcLimits = {}, handle } = {}) {
  const calls = [];
  const source = createScamRpcSource({ chainId: 91342, endpoint: { rpcUrl: "https://rpc.invalid/profile" },
    factories: [target.factory], quoteTokens: [target.quoteToken], clock: { now: () => NOW },
    limits: { maxRequests: 300, maxResponseBytes: 65_536, maxTotalResponseBytes: 1_000_000,
      maxLogs: 100, maxBlocksPerQuery, concurrency: 2, maxRetries: 0, retryDelayMs: 0, ...rpcLimits },
    fetch: async (_url, init) => {
      const rpc = JSON.parse(init.body);
      calls.push(rpc);
      const override = await handle?.(rpc, calls);
      if (override !== undefined) return override;
      if (rpc.method === "eth_chainId") return ok(rpc, q(91342));
      if (rpc.method === "eth_getBlockByNumber") return ok(rpc, headerFor(rpc.params[0] === "latest" ? BigInt(head) : BigInt(rpc.params[0])));
      if (rpc.method === "eth_getCode") return ok(rpc, code);
      if (rpc.method === "eth_getLogs") {
        const { address, fromBlock, toBlock, topics } = rpc.params[0];
        return ok(rpc, logs.filter((log) => log.address === address && topics[0].includes(log.topics[0])
          && BigInt(log.blockNumber) >= BigInt(fromBlock) && BigInt(log.blockNumber) <= BigInt(toBlock)));
      }
      if (rpc.method === "eth_call") {
        const selector = rpc.params[0].data.slice(0, 10);
        const result = { "0x0dfe1681": addressWord(target.token), "0xd21220a7": addressWord(target.quoteToken),
          "0xc45a0155": addressWord(target.factory), "0xe6a43905": addressWord(target.pool) }[selector];
        assert.notEqual(result, undefined, `Unexpected fake eth_call selector: ${selector}`);
        return ok(rpc, result);
      }
      throw new Error(`Unexpected fake RPC method: ${rpc.method}`);
    } });
  return { calls, build: async (overrides = {}, config = {}, request = {}) => source.withBatch({ planId: "plan:profile",
    referenceGroupId: "profile:test", confirmDepth: 0, deadlineMs: NOW + 5_000, subjects: [target], ...request }, async (batch) => {
    const pool = await batch.pool(0);
    return buildTokenProfile(batch, pool, params(pool.subject, overrides), { ...options, ...config });
  }) };
}

test("token profile establishes the threshold age only from verified historical code and non-recreation support", async () => {
  const f = fixture();
  const { value } = await f.build({}, { factorySupport: support() });
  assert.deepEqual(value.age, { kind: "lower_bound", ageLowerBoundSec: 10,
    evidence: { kind: "historical_code_presence", checkedAt: { number: "10", hash: blockHash(10), timestampMs: time(10) },
      identityVerified: true, nonRecreationSupportId: "fixture:non-recreating-v2" } });
  assert.equal(value.builderVersion, SCAM_DATA_BUILDER_VERSION);
  assert.equal(value.referenceGroupId, "profile:test");
  assert.deepEqual(value.searchedRanges, [{ fromBlock: "10", fromMs: time(10), toMs: time(10), missing: [], unavailable: [] }]);
  assert.deepEqual(f.calls.filter((rpc) => rpc.method === "eth_getCode").map((rpc) => rpc.params), [[POOL, q(10)]]);
  assert.equal(f.calls.filter((rpc) => rpc.method === "eth_getLogs").length, 0, "An established lower bound needs no creation scan");
});

test("token profile replays a saved GIWA factory PairCreated as exact age after empty historical code", async () => {
  const evidence = JSON.parse(readFileSync(new URL("../../../../fixtures/sdk/giwa-sf0/rpc-evidence.json", import.meta.url), "utf8"));
  const observed = evidence.queries.flatMap((entry) => entry.response.result?.logs ?? [])
    .find((log) => log.topics[0] === PAIR_CREATED_TOPIC);
  assert.ok(observed);
  const n = BigInt(observed.blockNumber), t = BigInt(observed.blockTimestamp);
  const target = { ...subject(), pool: evidence.observations.swap.pool, factory: observed.address,
    token: evidence.observations.swap.path[1], quoteToken: evidence.observations.swap.path[0] };
  // The PairCreated log alone is an unchanged saved observation. Surrounding
  // headers, code absence, identity calls and deployment support are synthetic.
  const f = fixture({ head: n + 2n, target, code: "0x", logs: [observed], headerFor: (height) => ({
    number: q(height), hash: height === n ? observed.blockHash : blockHash(height),
    parentHash: height - 1n === n ? observed.blockHash : blockHash(height - 1n), timestamp: q(t + height - n),
  }) });
  const { value } = await f.build({}, { factorySupport: support(target) });
  assert.deepEqual(value.age, { kind: "exact", ageSec: 2, evidence: { kind: "factory_pair_created",
    factory: target.factory, createdAt: { number: n.toString(), hash: observed.blockHash, timestampMs: Number(t) * 1_000 },
    transactionHash: observed.transactionHash, logIndex: Number(BigInt(observed.logIndex)) } });
  const query = f.calls.find((rpc) => rpc.method === "eth_getLogs").params[0];
  assert.deepEqual(query, { address: target.factory, fromBlock: q(n - 7n), toBlock: q(n + 2n), topics: [[PAIR_CREATED_TOPIC]] });
  assert.equal(value.events.length, 0);
});

test("token profile never turns unknown deployment semantics or failed code history into a false old-pool claim", async () => {
  const f = fixture({ logs: [created(15)] });
  const withoutCodeTrust = { ...support(), nonRecreationSupportId: undefined };
  assert.equal((await f.build({}, { factorySupport: withoutCodeTrust })).value.age.kind, "exact");
  assert.equal(f.calls.some((rpc) => rpc.method === "eth_getCode"), false);
  const failCode = (rpc) => rpc.method === "eth_getCode" ? new Response("archive unavailable", { status: 500 }) : undefined;
  const recovered = await fixture({ logs: [created(15)], handle: failCode }).build({}, { factorySupport: support() });
  assert.equal(recovered.value.age.kind, "exact");
  assert.equal(recovered.value.age.ageSec, 5);
  assert.deepEqual(recovered.value.searchedRanges[0].unavailable, [{ field: "pool.code", reason: "rpc_error" }]);
  const absent = await fixture({ handle: failCode }).build({}, { factorySupport: support() });
  assert.equal(absent.value.age.kind, "unknown");
  assert.ok(absent.value.age.reasons.includes("creation_not_found"));
  for (const factorySupport of [undefined, { ...support(), factory: OTHER }, { ...support(), chainId: 1 }]) {
    const unsupported = fixture();
    const value = (await unsupported.build({}, { factorySupport })).value;
    assert.deepEqual(value.age, { kind: "unknown", reasons: ["factory_history_unsupported"] });
    assert.equal(unsupported.calls.some((rpc) => ["eth_getCode", "eth_getLogs"].includes(rpc.method)), false);
  }
});

test("token profile leaves creation age unknown for partial, ambiguous, malformed or mismatched factory evidence", async () => {
  const scenarios = [
    { logs: [created(15, 0), created(16, 0)], reason: "creation_ambiguous" },
    { logs: [created(15, 0, OTHER)], reason: "creation_identity_mismatch" },
    { logs: [{ ...created(15), topics: [PAIR_CREATED_TOPIC, addressWord(OTHER), addressWord(QUOTE)] }], reason: "creation_identity_mismatch" },
    { logs: [{ ...created(15), data: "0x" }], reason: "invalid_pair_created" },
    { maxBlocksPerQuery: 4, handle: (rpc) => rpc.method === "eth_getLogs" && rpc.params[0].fromBlock === q(15)
      ? new Response("unavailable", { status: 500 }) : undefined, logs: [created(12)], reason: "creation_search_incomplete" },
  ];
  for (const scenario of scenarios) {
    const { value } = await fixture({ code: "0x", ...scenario }).build({}, { factorySupport: support() });
    assert.equal(value.age.kind, "unknown");
    assert.ok(value.age.reasons.includes(scenario.reason), scenario.reason);
    assert.ok(value.searchedRanges.at(-1).unavailable.length > 0);
  }
  const f = fixture({ code: "0x", logs: [created(10)] });
  assert.ok((await f.build({}, { factorySupport: support() })).value.age.reasons.includes("creation_not_found"),
    "The exact lower boundary is excluded rather than inferred from the first Mint or a missing event");
});

test("token profile treats the age search cap as local unknown while supported administrator history still completes", async () => {
  const f = fixture({ logs: [adminEvent("paused", 15)] });
  const { value } = await f.build({ maxAgeSearchCalls: 1, eventLookbackSec: 10, eventKinds: ["paused"] },
    { factorySupport: support(), adminSupport: adminSupport() });
  assert.deepEqual(value.age, { kind: "unknown", reasons: ["age_search_limit"] });
  assert.equal(f.calls.some((rpc) => rpc.method === "eth_getCode"), false);
  assert.deepEqual(value.events, [{ tMs: time(15), kind: "paused" }]);
  assert.deepEqual(value.coverage.missing, []);
  const bounded = await fixture().build({}, { factorySupport: support(), maxBlockLookups: 1 });
  assert.ok(bounded.value.age.reasons.includes("age_search_limit"));
});

test("token profile normalizes all five supported admin kinds and preserves separate same-kind events at the same time", async () => {
  const same = adminEvent("owner_changed", 12, 1);
  const logs = [adminEvent("paused", 10), adminEvent("owner_changed", 12, 0), same, { ...same },
    adminEvent("proxy_upgraded", 14), adminEvent("admin_changed", 16), adminEvent("paused", 18), adminEvent("unpaused", 20)];
  const f = fixture({ logs });
  const { value } = await f.build({ eventLookbackSec: 10, eventKinds: kinds }, { adminSupport: adminSupport() });
  assert.deepEqual(value.events, [
    { tMs: time(12), kind: "owner_changed" }, { tMs: time(12), kind: "owner_changed" },
    { tMs: time(14), kind: "proxy_upgraded" }, { tMs: time(16), kind: "admin_changed" },
    { tMs: time(18), kind: "paused" }, { tMs: time(20), kind: "unpaused" },
  ]);
  assert.deepEqual(value.coverage, { fromBlock: "10", fromMs: time(10), toMs: time(20), missing: [], unavailable: [] });
  const queries = f.calls.filter((rpc) => rpc.method === "eth_getLogs");
  assert.equal(queries.length, 1);
  assert.deepEqual(queries[0].params[0], { address: TOKEN, fromBlock: q(11), toBlock: q(20), topics: [kinds.map((kind) => ADMIN_EVENT_TOPICS[kind])] });
});

test("token profile requires explicit admin target, kind and block-range support and distinguishes empty complete history from failure", async () => {
  const configured = adminSupport();
  for (const declared of [undefined, { ...configured, token: OTHER }, { ...configured, chainId: 1 },
    { ...configured, kinds: ["unpaused"] }, { ...configured, validFromBlock: "12" }, { ...configured, validThroughBlock: "19" }]) {
    const f = fixture({ logs: [adminEvent("paused", 15)] });
    const { value } = await f.build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: declared });
    assert.deepEqual(value.events, []);
    assert.deepEqual(value.coverage.missing, [{ fromMs: time(10), toMs: time(20), reason: "unavailable_history" }]);
    assert.deepEqual(value.coverage.unavailable, [{ field: "adminEvents", reason: "unsupported_target_kind_or_range" }]);
    assert.equal(f.calls.some((rpc) => rpc.method === "eth_getLogs"), false);
  }
  const empty = (await fixture().build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: configured })).value;
  assert.deepEqual(empty.events, []);
  assert.deepEqual(empty.coverage.missing, []);
  assert.deepEqual(empty.coverage.unavailable, []);
  const failed = (await fixture({ handle: (rpc) => rpc.method === "eth_getLogs"
    ? new Response("missing archive", { status: 500 }) : undefined })
    .build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: configured })).value;
  assert.deepEqual(failed.events, []);
  assert.deepEqual(failed.coverage.missing, [{ fromMs: time(11), toMs: time(20), reason: "rpc_error" }]);
});

test("token profile carries malformed, wrong-scope and missing admin data as gaps without inventing or joining events", async () => {
  const malformed = { ...adminEvent("paused", 18, 0), data: "0x" };
  const { value } = await fixture({ logs: [adminEvent("paused", 15), malformed, adminEvent("paused", 18, 1), adminEvent("paused", 20)] })
    .build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: adminSupport() });
  assert.deepEqual(value.coverage.missing, [{ fromMs: time(18), toMs: time(18) + 1, reason: "unavailable_history" }]);
  assert.deepEqual(value.events, [{ tMs: time(15), kind: "paused" }, { tMs: time(20), kind: "paused" }]);
  const final = (await fixture({ logs: [{ ...adminEvent("paused", 20), data: "0x" }, adminEvent("paused", 20, 1)] })
    .build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: adminSupport() })).value;
  assert.deepEqual(final.events, [], "A malformed final block poisons its other events too");
  assert.deepEqual(final.coverage.missing,
    [{ fromMs: time(20) - 1, toMs: time(20), reason: "unavailable_history" }]);
  const wrongScope = (await fixture({ handle: (rpc) => rpc.method === "eth_getLogs"
    ? ok(rpc, [{ ...adminEvent("paused", 15), address: OTHER }]) : undefined })
    .build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: adminSupport() })).value;
  assert.deepEqual(wrongScope.events, []);
  assert.deepEqual(wrongScope.coverage.missing, [{ fromMs: time(11), toMs: time(20), reason: "unavailable_history" }]);
  const partial = (await fixture({ maxBlocksPerQuery: 4, logs: [adminEvent("paused", 12), adminEvent("paused", 19)],
    handle: (rpc) => rpc.method === "eth_getLogs" && rpc.params[0].fromBlock === q(15)
      ? new Response("unavailable", { status: 500 }) : undefined })
    .build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: adminSupport() })).value;
  assert.deepEqual(partial.events, [{ tMs: time(12), kind: "paused" }, { tMs: time(19), kind: "paused" }]);
  assert.deepEqual(partial.coverage.missing, [{ fromMs: time(15), toMs: time(18) + 1, reason: "rpc_error" }]);
});

test("token profile rejects incompatible requests and invalid support budgets before history work without truncating data", async () => {
  let calls = 0;
  const noData = async () => { calls++; throw new Error("History must not start"); };
  const pool = { subject: subject(), token0: TOKEN, token1: QUOTE };
  const batch = { referenceGroupId: "profile:test", reference: {
    block: { number: "20", hash: blockHash(20), timestampMs: time(20) }, requiredConfirmDepth: 0,
  }, block: noData, code: noData, logs: noData };
  for (const override of [
    { dataSchema: "scam.token_profile/99" }, { builderVersion: "unknown/99" }, { referenceGroupId: "other" },
    { subject: { ...subject(), token: OTHER } }, { confirmDepth: 1 }, { ageThresholdSec: 0 },
    { maxAgeSearchCalls: 0 }, { ageSearchMaxLookbackSec: 86_401 }, { eventLookbackSec: 86_401, eventKinds: ["paused"] },
    { eventLookbackSec: 10, eventKinds: [] }, { eventKinds: ["paused"] },
    { eventLookbackSec: 10, eventKinds: ["paused", "paused"] },
  ]) await assert.rejects(buildTokenProfile(batch, pool, params(pool.subject, override), options), failure("invalid_request"));
  for (const invalid of [{ maxEvents: 0 }, { maxLogs: 0 }, { blockTimeHintMs: 0 },
    { factorySupport: { ...support(), abi: "unknown" } },
    { adminSupport: { ...adminSupport(), validFromBlock: "20", validThroughBlock: "10" } }]) {
    await assert.rejects(buildTokenProfile(batch, pool, params(pool.subject), { ...options, ...invalid }), failure("invalid_config"));
  }
  assert.equal(calls, 0);
  const f = fixture({ logs: [adminEvent("paused", 12), adminEvent("paused", 13)] });
  for (const budget of [{ maxEvents: 1 }, { maxLogs: 1 }]) await assert.rejects(
    f.build({ eventLookbackSec: 10, eventKinds: ["paused"] }, { adminSupport: adminSupport(), ...budget }), failure("resource_limit"));
});

test("token profile never downgrades global resource failures, cancellation or evidence reorg to age unknown or empty events", async () => {
  const overLimit = fixture({ rpcLimits: { maxRequests: 7 } });
  await assert.rejects(overLimit.build({}, { factorySupport: support() }), failure("resource_limit"));
  const controller = new AbortController();
  const aborted = fixture({ handle: (rpc) => {
    if (rpc.method !== "eth_getCode") return undefined;
    controller.abort();
    return ok(rpc, "0x6000");
  } });
  await assert.rejects(aborted.build({}, { factorySupport: support() }, { signal: controller.signal }), failure("aborted"));
  const wrongHash = { ...adminEvent("paused", 15), blockHash: blockHash(16) };
  await assert.rejects(fixture({ logs: [wrongHash] }).build({ eventLookbackSec: 10, eventKinds: ["paused"] },
    { adminSupport: adminSupport() }), failure("reorg"));
  let codeRead = false;
  const changedHistory = fixture({ handle: (rpc) => {
    if (rpc.method === "eth_getCode") codeRead = true;
    if (codeRead && rpc.method === "eth_getBlockByNumber" && rpc.params[0] === q(10)) {
      return ok(rpc, { ...header(10), hash: blockHash(999) });
    }
    return undefined;
  } });
  await assert.rejects(changedHistory.build({}, { factorySupport: support() }), failure("reorg"));
});
