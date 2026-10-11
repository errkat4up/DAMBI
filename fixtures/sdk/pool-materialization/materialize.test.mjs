import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { materializeSelectedDecoder } from "../../../scripts/sdk/materialize-decoder.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
const selection = readJson("./selection.json");
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const RLUSD = "0x8292bb45bf1ee4d140127049757c2e0ff06317ed";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const BALANCER_POOL = "0xda66e8ddf9959e4db759bfd06256730d8a8b2d13";

function fixtures(name) {
  return {
    template: readJson(`./templates/${name}.json`),
    context: readJson(`./contexts/${name}.json`),
  };
}

function freezeJson(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeJson);
    Object.freeze(value);
  }
  return value;
}

function assertNoSourcePlaceholders(value) {
  if (typeof value === "string") {
    assert.ok(!value.startsWith("$source."), `unresolved source value: ${value}`);
  } else if (Array.isArray(value)) {
    value.forEach(assertNoSourcePlaceholders);
  } else if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      assert.ok(!key.startsWith("$source."), `unresolved source key: ${key}`);
      assertNoSourcePlaceholders(nested);
    }
  }
}

test("selected pool contexts preserve identity, token order and immutable inputs", () => {
  assert.equal(selection.schema_version, 1);
  assert.equal(selection.purpose, "regression-only");
  assert.deepEqual(selection.entries.map((entry) => entry.template), [
    "templates/curve.json", "templates/balancer.json", "templates/uniswap.json",
  ]);
  const expected = [
    ["curve/stableswap-ng/source/factory-stable-ng-2coin-mainnet/exchange/1-factory-stable-ng-327-d001ae43@1.0.0", "0x3df02124", "0xd001ae433f254283fece51d4acce8c53263aa186"],
    ["balancer/v3/router-add-liquidity-proportional/v2-mainnet@1.0.0", "0x724dba33", "0xae563e3f8219521950555f5962419c8919758ea2"],
    ["uniswap/v3-pool/swap/1-v3-pool-2c40c7b9@1.0.0", "0x128acb08", "0x2c40c7b9f106f39a6e2aab6d9f1f29364e7250bc"],
  ];
  const bundles = selection.entries.map((entry, index) => {
    const template = freezeJson(readJson(`./${entry.template}`));
    const context = freezeJson(readJson(`./${entry.context}`));
    const before = JSON.stringify([template, context]);
    const bundle = materializeSelectedDecoder(template, context);
    const [id, selector, address] = expected[index];
    assert.equal(bundle.id, id);
    assert.deepEqual(bundle.match, { selector, chain_to_addresses: { "1": [address] } });
    assert.ok(!Object.hasOwn(bundle, "source_materialize"));
    assertNoSourcePlaceholders(bundle);
    assert.equal(JSON.stringify([template, context]), before);
    return bundle;
  });

  const curve = bundles[0].emit.body.amm.swap;
  assert.deepEqual(curve.params.token_in.key.address.$cases, { "0": USDC, "1": RLUSD });
  assert.deepEqual(curve.params.token_out.key.address.$cases, { "0": USDC, "1": RLUSD });
  assert.equal(curve.venue.n_coins, 2);
  assert.equal(curve.params.slippage_bp, 0);

  // This selected map proves static substitution, not the pool's math type or
  // parity with the resolver's full pool universe.
  const balancer = bundles[1].emit.body;
  const selectedMap = { [BALANCER_POOL]: [USDC, WETH] };
  assert.deepEqual(balancer.$match.$args[3], selectedMap);
  assert.deepEqual(balancer.$cases.matched_nonempty.amm.add_liquidity.params.tokens.$args[3], selectedMap);
  assert.equal(balancer.$cases.matched_nonempty.amm.add_liquidity.params.min_lp_out, "$args.exactBptAmountOut");

  const uniswap = bundles[2].emit.body.amm.swap;
  assert.equal(uniswap.venue.pool, expected[2][2]);
  assert.equal(uniswap.venue.fee_tier_bp, 100);
  assert.deepEqual(uniswap.params.token_in.key.address.$args.slice(2, 4), [
    "0x87c9053c819bb28e0d73d33059e1b3da80afb0cf", USDC,
  ]);
  assert.deepEqual(uniswap.params.token_out.key.address.$args.slice(2, 4), [
    "0x87c9053c819bb28e0d73d33059e1b3da80afb0cf", USDC,
  ]);
  // Runtime expressions are intentionally preserved; these are not observed
  // prices or a proof of raw calldata/policy behavior.
  assert.equal(uniswap.params.slippage_bp, "$derived.slippage_bp");
  assert.equal(uniswap.params.direction.$match.$args[0], "$args.amountSpecified");
});

test("materialization rejects source, chain and address mismatches", () => {
  const mutations = [
    ["missing source", (_template, context) => { delete context.source; }],
    ["different resolver source", (_template, context) => { context.source = "uniswap:v3_pool_candidates"; }],
    ["conflicting template source", (template) => { template.source_materialize.source = "uniswap:v3_pool_candidates"; }],
    ["chain outside selected manifest", (_template, context) => { context.chain_id = 8453; context.context.chainId = 8453; }],
    ["conflicting context chain", (_template, context) => { context.context.chainId = 8453; }],
    ["conflicting context address", (_template, context) => { context.context.address = USDC; }],
    ["invalid route address", (_template, context) => { context.address = "not-an-address"; context.context.address = context.address; }],
  ];
  for (const [label, mutate] of mutations) {
    const { template, context } = fixtures("curve");
    mutate(template, context);
    assert.throws(() => materializeSelectedDecoder(template, context), Error, label);
  }
});

test("materialization rejects missing and unresolved build-time context", () => {
  const mutations = [
    ["missing context", (_template, context) => { delete context.context; }],
    ["missing id suffix", (_template, context) => { delete context.context.id_suffix; }],
    ["missing coin list", (_template, context) => { delete context.context.coins; }],
    ["missing second coin", (_template, context) => { context.context.coins.pop(); }],
    ["null coin addresses", (_template, context) => { context.context.coins = [null, null]; }],
    ["duplicate coin addresses", (_template, context) => { context.context.coins[1] = context.context.coins[0]; }],
    ["unknown source placeholder", (template) => { template.emit.body.amm.swap.venue.pool = "$source.no_such_pool"; }],
    ["nested unresolved source", (_template, context) => { context.context.coins[0] = "$source.no_such_coin"; }],
    ["source placeholder key", (template) => { template.emit.body["$source.field"] = "value"; }],
  ];
  for (const [label, mutate] of mutations) {
    const { template, context } = fixtures("curve");
    mutate(template, context);
    assert.throws(() => materializeSelectedDecoder(template, context), Error, label);
  }
  const balancer = fixtures("balancer");
  balancer.context.context.pool_tokens = "not-a-pool-map";
  assert.throws(() => materializeSelectedDecoder(balancer.template, balancer.context), /pool-to-token-address map/);
  balancer.context.context.pool_tokens = { [BALANCER_POOL]: [USDC, null] };
  assert.throws(() => materializeSelectedDecoder(balancer.template, balancer.context), /pool-to-token-address map/);
  const uniswap = fixtures("uniswap");
  uniswap.context.context.token0 = "invalid";
  assert.throws(() => materializeSelectedDecoder(uniswap.template, uniswap.context), /token addresses/);
  uniswap.context.context.token0 = WETH;
  uniswap.context.context.fee_tier_bp = 0x100000000;
  assert.throws(() => materializeSelectedDecoder(uniswap.template, uniswap.context), /u32 fee_tier_bp/);
});
