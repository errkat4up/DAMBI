import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runNativeFixture } from "../helpers/native-backend.mjs";

const readJson = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

test("GIWA product snapshot on Native decodes the recorded swap while leaving market observations absent", () => {
  const evidence = readJson("./rpc-evidence.json");
  const { swap } = evidence.observations;
  const swapHash = "0x212c9856eee05e3dc92710267106842dcd44eb624668998b9079272136185cb9";
  const tx = evidence.queries.find(({ request }) =>
    request.method === "eth_getTransactionByHash" && request.params[0] === swapHash).response.result;
  assert.equal(tx.hash, swapHash);
  assert.equal(tx.to, swap.router);
  assert.equal(tx.input.slice(0, 10), swap.selector);
  const { bundles } = readJson("../../../packages/core/decoder-snapshots/full/snapshot.json");
  const input = {
    chain_id: Number(BigInt(tx.chainId)), to: tx.to, submitter: tx.from,
    calldata: tx.input, selector: tx.input.slice(0, 10), value: BigInt(tx.value).toString(),
    submitted_at: Number(BigInt(tx.blockTimestamp)),
  };
  const { results } = runNativeFixture("decoder", { bundles, requests: [{ id: "recorded", input }] });
  const decoded = results[0].result;
  assert.equal(decoded.ok, true, JSON.stringify(decoded));
  assert.equal(decoded.data.decoder_id, "giwa/v2-router/swap-exact-eth-for-tokens@1.0.0");
  assert.equal(decoded.data.actions.length, 1);
  const { body } = decoded.data.actions[0];
  assert.equal(body.action, "swap");
  assert.equal(body.venue.chain, `eip155:${evidence.chainId}`);
  assert.equal(body.venue.pool, swap.pool);
  assert.equal(body.venue.factory, swap.factory);
  assert.equal(body.params.token_in.key.standard, "native");
  assert.equal(body.params.token_out.key.address, swap.path[1]);
  assert.equal(body.params.recipient, tx.from);
  assert.equal(BigInt(body.params.direction.amount_in), BigInt(tx.value));
  assert.equal(BigInt(body.params.direction.min_amount_out), 0n);
  assert.equal(Object.hasOwn(body.params, "slippage_bp"), false);
  const { declared_route: route, ...marketObservations } = body.live_inputs;
  assert.deepEqual(marketObservations, {});
  assert.equal(route.kind, "direct");
  assert.equal(route.token_in.key.address, swap.path[0]);
  assert.deepEqual(route.token_out, body.params.token_out);
  assert.deepEqual(route.venue, body.venue);
});
