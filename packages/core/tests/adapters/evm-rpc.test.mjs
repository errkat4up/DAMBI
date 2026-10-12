import assert from "node:assert/strict";
import test from "node:test";
import { AdapterError } from "../../dist/adapters/errors.js";
import {
  RpcResponseError,
  balanceOfRequest,
  blockNumberRequest,
  chainIdRequest,
  decodeBalance,
  decodeQuantity,
  parseEip155ChainId,
  readRpcResult,
  resolveBalanceCall,
} from "../../dist/adapters/evm-rpc.js";

const supportedChains = new Set(["eip155:1", "eip155:9007199254740993"]);
const owner = "0x1111111111111111111111111111111111111111";
const token = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

function params() {
  return {
    chain_id: "eip155:1",
    owner,
    asset: { key: { standard: "erc20", chain: "eip155:1", address: token } },
  };
}

function invalidResponse(error) {
  assert.ok(error instanceof AdapterError);
  assert.equal(error.code, "INVALID_RESPONSE");
  return true;
}

test("EIP-155 chain IDs preserve integer precision and reject noncanonical references", () => {
  assert.equal(parseEip155ChainId("eip155:1"), 1n);
  assert.equal(parseEip155ChainId("eip155:9007199254740993"), 9007199254740993n);
  assert.equal(parseEip155ChainId(`eip155:${"9".repeat(32)}`), 10n ** 32n - 1n);
  for (const value of [
    1, 1n, null, "1", "eip155:0", "eip155:01", "eip155:-1", "eip155:+1",
    "eip155:1.0", "eip155:0x1", "eip155:1e3", "eip155:1\n", "EIP155:1",
    "cosmos:1", `eip155:${"9".repeat(33)}`,
  ]) {
    assert.equal(parseEip155ChainId(value), undefined);
  }
});

test("balance call resolution copies and freezes only the validated chain and addresses", () => {
  const input = params();
  input.owner = "0xaBcDeF0123456789aBCdef0123456789AbCDef01";
  input.asset.key.address = "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
  const original = structuredClone(input);
  const resolved = resolveBalanceCall("portfolio.balance", input, supportedChains);
  assert.deepEqual(resolved, {
    chainId: "eip155:1",
    owner: "0xabcdef0123456789abcdef0123456789abcdef01",
    token,
  });
  assert.ok(Object.isFrozen(resolved));
  assert.deepEqual(input, original);
  input.owner = token;
  input.asset.key.address = owner;
  input.chain_id = "eip155:10";
  assert.equal(resolved.owner, original.owner.toLowerCase());
  assert.equal(resolved.token, token);
  assert.equal(resolved.chainId, "eip155:1");

  const largeChain = params();
  largeChain.chain_id = largeChain.asset.key.chain = "eip155:9007199254740993";
  assert.equal(
    resolveBalanceCall("portfolio.balance", largeChain, supportedChains).chainId,
    "eip155:9007199254740993",
  );
});

test("unsupported methods, chains, assets and block selectors cannot become balance requests", () => {
  for (const method of ["eth_getBalance", "portfolio.Balance", "portfolio.balance ", null]) {
    assert.equal(resolveBalanceCall(method, params(), supportedChains), undefined);
  }
  const invalidParams = [null, [], {}, Object.create(params())];
  const changes = [
    (value) => { value.chain_id = 1; },
    (value) => { value.chain_id = value.asset.key.chain = "eip155:10"; },
    (value) => { value.asset.key.chain = "eip155:10"; },
    (value) => { value.asset.key.standard = "native"; },
    (value) => { value.asset.key.standard = "erc721"; },
    (value) => { value.asset = token; },
    (value) => { value.asset = { address: token }; },
    (value) => { value.asset.key = null; },
    (value) => { value.asset.extra = true; },
    (value) => { value.asset.key.token_id = "1"; },
    (value) => { delete value.owner; },
    (value) => { value.blockNumber = "20000000"; },
    (value) => { value.blockTag = "latest"; },
  ];
  for (const change of changes) {
    const value = params();
    change(value);
    invalidParams.push(value);
  }
  for (const address of [owner.slice(2), "0x1234", `0x${"1".repeat(41)}`, `0x${"g".repeat(40)}`, `0X${"1".repeat(40)}`, `${owner}\n`, 0]) {
    const badOwner = params();
    badOwner.owner = address;
    invalidParams.push(badOwner);
    const badToken = params();
    badToken.asset.key.address = address;
    invalidParams.push(badToken);
  }
  for (const value of invalidParams) {
    assert.equal(resolveBalanceCall("portfolio.balance", value, supportedChains), undefined);
  }
});

test("RPC request builders reproduce the first-Fact balanceOf ABI and explicit block contract", () => {
  assert.deepEqual(chainIdRequest("chain-read"), {
    jsonrpc: "2.0", id: "chain-read", method: "eth_chainId", params: [],
  });
  assert.deepEqual(blockNumberRequest("block-read"), {
    jsonrpc: "2.0", id: "block-read", method: "eth_blockNumber", params: [],
  });
  const resolved = resolveBalanceCall("portfolio.balance", params(), supportedChains);
  // Independent golden vector from fixtures/sdk/first-fact-contract.json.
  assert.deepEqual(balanceOfRequest("first-fact-example", resolved, 20000000n), {
    jsonrpc: "2.0",
    id: "first-fact-example",
    method: "eth_call",
    params: [
      {
        to: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        data: "0x70a082310000000000000000000000001111111111111111111111111111111111111111",
      },
      "0x1312d00",
    ],
  });
  assert.equal(balanceOfRequest("genesis", resolved, 0n).params[1], "0x0");
  assert.equal(balanceOfRequest("large-block", resolved, 9007199254740993n).params[1], "0x20000000000001");
});

test("request builders reject invalid correlation IDs and block arguments before transport", () => {
  const resolved = resolveBalanceCall("portfolio.balance", params(), supportedChains);
  for (const id of ["", 1, null, undefined]) {
    assert.throws(() => chainIdRequest(id), TypeError);
    assert.throws(() => blockNumberRequest(id), TypeError);
    assert.throws(() => balanceOfRequest(id, resolved, 1n), TypeError);
  }
  for (const block of [-1n, 1, "0x1", "latest", null]) {
    assert.throws(() => balanceOfRequest("balance", resolved, block), TypeError);
  }
});

test("RPC quantities remain BigInt and reject padded, empty or nonhex encodings", () => {
  assert.equal(decodeQuantity("0x0"), 0n);
  assert.equal(decodeQuantity("0x1312d00"), 20000000n);
  assert.equal(decodeQuantity("0x20000000000001"), 9007199254740993n);
  assert.equal(decodeQuantity("0xABCDEF"), 11259375n);
  for (const value of ["0x", "0x00", "0x01", "0X1", "0x-1", "0x1.0", "0xgg", "0x1\n", "1", 1, null]) {
    assert.throws(() => decodeQuantity(value), invalidResponse);
  }
});

test("exact ABI words become canonical U256 balances without losing precision or inventing zero", () => {
  assert.deepEqual(decodeBalance(`0x${"0".repeat(64)}`), { balance: "0x0" });
  assert.deepEqual(decodeBalance("0x0000000000000000000000000000000000000000000000000000000000000064"), { balance: "0x64" });
  assert.deepEqual(decodeBalance(`0x${"0".repeat(50)}20000000000001`), { balance: "0x20000000000001" });
  assert.deepEqual(decodeBalance(`0x${"F".repeat(64)}`), { balance: `0x${"f".repeat(64)}` });
  for (const value of [
    "0x", "0x0", "0x64", `0x${"0".repeat(63)}`, `0x${"0".repeat(65)}`,
    `0x${"0".repeat(63)}g`, `0X${"0".repeat(64)}`, `0x${"0".repeat(64)}\n`,
    0, null, { balance: "0x0" }, { result: `0x${"0".repeat(64)}` },
  ]) {
    assert.throws(() => decodeBalance(value), invalidResponse);
  }
});

test("RPC envelopes bind results to their IDs and distinguish sanitized errors from malformed responses", () => {
  const id = "balance:opaque-call";
  const result = `0x${"0".repeat(64)}`;
  assert.equal(readRpcResult(JSON.stringify({ jsonrpc: "2.0", id, result }), id), result);
  assert.equal(readRpcResult(JSON.stringify({ jsonrpc: "2.0", id, result: null }), id), null);

  const malformed = [
    null, [], {}, { jsonrpc: "1.0", id, result }, { jsonrpc: "2.0", result },
    { jsonrpc: "2.0", id: "other", result }, { jsonrpc: "2.0", id: 1, result },
    { jsonrpc: "2.0", id }, { jsonrpc: "2.0", id, error: null },
    { jsonrpc: "2.0", id, result, error: { code: -32000, message: "revert" } },
    { jsonrpc: "2.0", id, error: { code: -1.5, message: "revert" } },
    { jsonrpc: "2.0", id, error: { code: Number.MAX_SAFE_INTEGER + 1, message: "revert" } },
    { jsonrpc: "2.0", id, error: { code: "-32000", message: "revert" } },
    { jsonrpc: "2.0", id, error: { code: -32000, message: null } },
  ];
  for (const body of malformed) {
    assert.throws(() => readRpcResult(JSON.stringify(body), id), invalidResponse);
  }
  assert.throws(() => readRpcResult('{"jsonrpc":"2.0",', id), invalidResponse);
  assert.throws(() => readRpcResult(JSON.stringify({ jsonrpc: "2.0", id, result }) + " trailing", id), invalidResponse);

  const secret = "private-provider-token-and-revert-data";
  assert.throws(() => readRpcResult(JSON.stringify({
    jsonrpc: "2.0", id, error: { code: -32000, message: secret, data: { secret } },
  }), id), (error) => {
    assert.ok(error instanceof RpcResponseError);
    assert.equal(error.rpcCode, -32000);
    assert.equal(error.cause, undefined);
    assert.equal(error.data, undefined);
    assert.ok(!String(error).includes(secret));
    assert.ok(!JSON.stringify(error).includes(secret));
    return true;
  });
});
