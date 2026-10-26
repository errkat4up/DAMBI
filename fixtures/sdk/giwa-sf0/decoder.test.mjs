import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { before, test } from "node:test";
import { assertFixtureBackend, fixtureBackend, runNativeFixture } from "../helpers/native-backend.mjs";

// A narrow SF0/SF4-1 proof, not a packaged snapshot or a live Scam Filter.
// No network, automatic build, policy mock or invented receipt is used.
const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const evidence = readJson("./rpc-evidence.json");
const swapHash = "0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9";
const liquidityHash = "0x55f28ca8295e4526361edfc735b3eedb69052051591c52d98fac06b278ef3578";
const txFor = (hash) => evidence.queries.find(({ request }) =>
  request.method === "eth_getTransactionByHash" && request.params[0] === hash).response.result;
const swapTx = txFor(swapHash);
const liquidityTx = txFor(liquidityHash);
const CHAIN = 91342;
const ROUTER = "0x50d356c7793d41c8b1d2a668f880d3a87aace649";
const FACTORY = "0xd51d7c2a3b9b0f6876336c165adda94468500c47";
const POOL = "0xcaafb95fc292c10a526f03fa480407bb438dac67";
const TOKEN = "0x0274c57358c3a6b8a08b7297ba51665c303a471f";
const WETH = "0x4200000000000000000000000000000000000006";
const OTHER = "0x0000000000000000000000000000000000000001";
const bundles = [
  readJson("./decoders/swap-exact-eth-for-tokens.json"),
  readJson("./decoders/add-liquidity-eth.json"),
];

function request(tx) {
  return {
    chain_id: Number(BigInt(tx.chainId)), to: tx.to, submitter: tx.from,
    calldata: tx.input, selector: tx.input.slice(0, 10), value: BigInt(tx.value).toString(),
    submitted_at: Number(BigInt(tx.blockTimestamp)),
  };
}
const swap = request(swapTx);
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const addressWord = (address) => address.slice(2).padStart(64, "0");
function swapCalldata(path) {
  return "0x7ff36ab5" + word(0) + word(128) + addressWord(swap.submitter) +
    word(1800000000) + word(path.length) + path.map(addressWord).join("");
}

// Synthetic unsigned standard-router request. The observed Mint transaction
// is a different launchpad call and MUST NOT be relabeled as this request.
const syntheticLp = {
  ...swap, selector: "0xf305d719", value: "1000000000000000",
  calldata: "0xf305d719" + addressWord(TOKEN) + word(2500000000000000000n) +
    word(2400000000000000000n) + word(900000000000000n) +
    addressWord(swap.submitter) + word(1800000000),
};
const pathCases = [
  ["different-token", [WETH, OTHER]], ["different-input", [OTHER, TOKEN]],
  ["reverse-path", [TOKEN, WETH]], ["multi-hop", [WETH, OTHER, TOKEN]],
  ["empty-path", []], ["one-token-path", [WETH]],
];
const requests = [
  { id: "observed-swap", input: swap },
  { id: "synthetic-standard-lp", input: syntheticLp },
  ...pathCases.map(([id, path]) => ({ id, input: { ...swap, calldata: swapCalldata(path) } })),
  { id: "different-lp-token", input: { ...syntheticLp,
    calldata: syntheticLp.selector + addressWord(OTHER) + syntheticLp.calldata.slice(74) } },
  { id: "different-chain", input: { ...swap, chain_id: 1 } },
  { id: "different-router", input: { ...swap, to: OTHER } },
  { id: "observed-launchpad-lp", input: request(liquidityTx) },
];
let baseline;
let outputs;

before(async () => {
  assert.equal(fixtureBackend, "native", "Set DAMBI_FIXTURE_BACKEND=native; build fixture_runner explicitly first");
  await assertFixtureBackend();
  const original = [
    readJson("../../../registryV2/manifests/uniswap/v2-router-02/swapExactETHForTokens@1.0.0.json"),
    readJson("../../../registryV2/manifests/uniswap/v2-router-02/addLiquidityETH@1.0.0.json"),
  ];
  baseline = runNativeFixture("decoder", { bundles: original, requests: requests.slice(0, 2) });
  const installed = runNativeFixture("decoder", { bundles, requests });
  assert.equal(installed.installations.length, 2);
  for (let i = 0; i < bundles.length; i++) {
    assert.equal(installed.installations[i].data.decoder_id, bundles[i].id);
  }
  outputs = new Map(installed.results.map(({ id, result }) => [id, result]));
});

function decoded(id) {
  const result = outputs.get(id);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.data.actions.length, 1);
  return result.data.actions[0];
}
function assertMiss(result) {
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.kind, "no_declarative_v3_mapper");
}
function assertVenue(body) {
  assert.equal(body.domain, "amm");
  assert.equal(body.venue.chain, "eip155:91342");
  assert.equal(body.venue.pool, POOL);
  assert.equal(body.venue.factory, FACTORY);
}

test("existing V2 declarations do not falsely claim GIWA support", () => {
  assert.equal(evidence.chainId, CHAIN);
  assert.equal(swap.to, ROUTER);
  assert.equal(swap.selector, "0x7ff36ab5");
  for (const { result } of baseline.results) assertMiss(result);
});

test("observed swap raw request resolves the actual token, pool and factory", () => {
  const action = decoded("observed-swap");
  assert.equal(outputs.get("observed-swap").data.decoder_id, bundles[0].id);
  assertVenue(action.body);
  assert.equal(action.body.action, "swap");
  assert.deepEqual(action.body.params.token_in.key, { standard: "native", chain: "eip155:91342" });
  assert.equal(action.body.params.token_out.key.address, TOKEN);
  assert.equal(action.body.params.recipient, swapTx.from);
  assert.equal(BigInt(action.body.params.direction.amount_in), BigInt(swapTx.value));
  assert.equal(BigInt(action.body.params.direction.min_amount_out), 0n);
  const route = action.body.live_inputs.route;
  assert.deepEqual(route.source, { kind: "derived_from", inputs: [], calc_id: "sf0_fixture_calldata_single_hop_route" });
  assert.equal(route.value.paths.length, 1);
  assert.equal(route.value.paths[0].share_bp, 10_000);
  assert.equal(route.value.paths[0].hops.length, 1);
  const hop = route.value.paths[0].hops[0];
  assert.deepEqual(hop.token_in.key, { standard: "erc20", chain: "eip155:91342", address: WETH });
  assert.deepEqual(hop.token_out, action.body.params.token_out);
  assert.deepEqual(hop.venue, action.body.venue);
  // Identity only: these skeletons are not fetched liquidity or a quote.
  assert.equal(BigInt(hop.pool_state.reserve_in), 0n);
  assert.equal(BigInt(hop.pool_state.reserve_out), 0n);
  assert.equal(BigInt(hop.estimated_out), 0n);
});

test("explicit route values stay typed without seeding other live values", () => {
  const selected = structuredClone(bundles[0]);
  const live = selected.emit.live_inputs;
  live.expected_amount_out.value = "123";
  live.price_impact_bp.value = 123;
  live.gas_estimate.value = "123";
  const run = () => {
    const result = runNativeFixture("decoder", { bundles: [selected], requests: [requests[0]] });
    assert.equal(result.installations[0].ok, true);
    return result.results[0].result;
  };
  const valid = run();
  assert.equal(valid.ok, true, JSON.stringify(valid));
  const decodedLive = valid.data.actions[0].body.live_inputs;
  assert.equal(decodedLive.route.value.paths.length, 1);
  assert.equal(BigInt(decodedLive.expected_amount_out.value), 0n);
  assert.equal(decodedLive.price_impact_bp.value, 0);
  assert.equal(BigInt(decodedLive.gas_estimate.value), 0n);

  // A malformed explicit route is rejected, not replaced by an empty route.
  live.route.value = null;
  const invalid = run();
  assert.equal(invalid.ok, false, JSON.stringify(invalid));
  assert.equal(invalid.error.kind, "build_action_body_failed");
});

test("synthetic standard LP request resolves identity without claiming executed deposits", () => {
  const action = decoded("synthetic-standard-lp");
  assert.equal(outputs.get("synthetic-standard-lp").data.decoder_id, bundles[1].id);
  assertVenue(action.body);
  assert.equal(action.body.action, "add_liquidity");
  assert.equal(action.body.params.recipient, swap.submitter);
  const [token, native] = action.body.params.tokens;
  assert.equal(token[0].key.address, TOKEN);
  assert.equal(BigInt(token[1]), 2500000000000000000n);
  assert.deepEqual(native[0].key, { standard: "native", chain: "eip155:91342" });
  assert.equal(BigInt(native[1]), BigInt(syntheticLp.value));
  assert.equal(action.body.live_inputs.pool_state.source.contract, POOL);
});

test("different tokens and non-single-hop paths stay Unknown instead of borrowing the selected pool", () => {
  for (const id of [...pathCases.map(([id]) => id), "different-lp-token"]) {
    const body = decoded(id).body;
    const raw = requests.find((r) => r.id === id).input;
    assert.equal(body.domain, "unknown", id);
    assert.equal(body.target, ROUTER, id);
    assert.equal(body.calldata, raw.calldata, id);
    assert.equal(Object.hasOwn(body, "venue"), false, id);
    assert.equal(Object.hasOwn(body, "live_inputs"), false, id);
  }
});

test("chain and router scoping reject unrelated callkeys", () => {
  for (const id of ["different-chain", "different-router"]) assertMiss(outputs.get(id));
});

test("observed launchpad Mint transaction is not mislabeled as a standard LP call", () => {
  assert.equal(liquidityTx.input.slice(0, 10), "0x08cb1051");
  assert.notEqual(liquidityTx.to, ROUTER);
  assertMiss(outputs.get("observed-launchpad-lp"));
  const receipt = evidence.queries.find(({ request }) =>
    request.method === "eth_getTransactionReceipt" && request.params[0] === liquidityHash).response.result;
  assert.equal(receipt.status, "0x1");
  assert.equal(receipt.blockHash, liquidityTx.blockHash);
  const creation = receipt.logs.find((log) => log.address === FACTORY &&
    log.topics[0] === "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9");
  assert.ok(creation);
  assert.equal("0x" + creation.topics[1].slice(-40), TOKEN);
  assert.equal("0x" + creation.topics[2].slice(-40), WETH);
  assert.equal("0x" + creation.data.slice(26, 66), POOL);
  assert.equal(Number(BigInt(receipt.blockNumber)), 31390683);
});
