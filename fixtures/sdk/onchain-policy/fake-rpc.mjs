import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";

export const NOW = 1_800_000_000_000;
export const REGISTRY = "0x1111111111111111111111111111111111111111";
export const CODE = "0x60006000f3";
export const HASH = `0x${"ab".repeat(32)}`;
export const SCOPE = `0x${"cd".repeat(32)}`;
const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const tail = (bytes) => word(bytes.length) + bytes.toString("hex").padEnd(Math.ceil(bytes.length / 32) * 64, "0");

// Independent request oracle: F4 3fab6d8b, solc 0.8.28 methodIdentifiers.
// Do not derive these selectors with the adapter's Keccak implementation.
// Compare the entire canonical ABI encoding, including offsets and padding.
export const SCOPE_CALLDATA = `0xc8121043${word(64)}${word(128)}${word(7)}${Buffer.from("staging").toString("hex").padEnd(64, "0")}${word(7)}${Buffer.from("default").toString("hex").padEnd(64, "0")}`;
export const READ_CALLDATA = `0x3d301c91${SCOPE.slice(2)}${word(0)}`;

// Independent encoder, not the adapter decoder. Synthetic RPC only: CODE is
// not a deployed F4 registry. Hash the exact UTF-8 payload by default; explicit
// digest overrides support inconsistent-response regressions.
export function encodeRead({ sequence = 42, status = 1, payload = " {\"sequence\":42}\n",
  signature = Buffer.alloc(64, 7).toString("base64"), keyId = "test-only",
  digest = `0x${createHash("sha256").update(payload, "utf8").digest("hex")}` } = {}) {
  const p = tail(Buffer.from(payload));
  const s = tail(Buffer.from(signature, "base64"));
  const k = tail(Buffer.from(keyId));
  return `0x${word(sequence)}${word(status)}${digest.slice(2)}${word(192)}${word(192 + p.length / 2)}${word(192 + p.length / 2 + s.length / 2)}${p}${s}${k}`;
}

export function options(rpc, extra = {}) {
  return {
    rpcUrl: rpc.url, chainId: "eip155:91342", registryAddress: REGISTRY,
    expectedRuntimeCode: CODE, env: "staging", profile: "default", finality: "finalized",
    maxResponseBytes: 2_500_000, timeoutMs: 1000, maxBlockAgeMs: 30_000,
    maxStateAgeMs: 20_000, refreshIntervalMs: 5000, allowedClockSkewMs: 1000,
    clock: { now: () => rpc.now }, ...extra,
  };
}

export async function fakeRpc(t) {
  const state = {
    now: NOW, chainId: "0x164ce", code: CODE,
    block: { number: "0x64", hash: HASH, timestamp: `0x${(NOW / 1000).toString(16)}` },
    tuple: encodeRead(), mode: "ok", requests: [], errors: [], rejectedCalls: [],
    recheckHash: undefined, transform: undefined, hold: undefined,
  };
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST", "No policy HTTP GET or transaction submission is allowed");
      let text = "";
      for await (const chunk of req) {
        text += chunk;
        assert.ok(text.length < 100_000);
      }
      const body = JSON.parse(text);
      state.requests.push({ ...body, authorization: req.headers.authorization });
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
      res.setHeader("content-type", "application/json");
      if (state.mode === "outage") { res.writeHead(503); res.end("fixture outage"); return; }
      if (state.hold) await state.hold(body);
      if (state.mode === "unsupported" && body.method === "eth_getCode") {
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32602, message: "hash selector unsupported" } }));
        return;
      }
      let result;
      switch (body.method) {
        case "eth_chainId": result = state.chainId; break;
        case "eth_getBlockByNumber": {
          assert.equal(body.params[1], false);
          assert.ok(["safe", "finalized", state.block.number].includes(body.params[0]), "latest is forbidden");
          result = { ...state.block };
          if (body.params[0] === state.block.number && state.recheckHash) result.hash = state.recheckHash;
          break;
        }
        case "eth_getCode":
          assert.deepEqual(body.params, [REGISTRY, { blockHash: state.block.hash, requireCanonical: true }]);
          result = state.code;
          break;
        case "eth_call": {
          const [call, selector] = body.params;
          assert.equal(call.to, REGISTRY);
          assert.deepEqual(selector, { blockHash: state.block.hash, requireCanonical: true });
          assert.equal(body.params.length, 2);
          assert.deepEqual(Object.keys(call).sort(), ["data", "to"]);
          if (call.data === READ_CALLDATA) result = state.tuple;
          else if (call.data === SCOPE_CALLDATA) result = SCOPE;
          else {
            // An intentional bad-calldata control is an RPC rejection, not a
            // fixture crash. Unexpected fixture assertions still fail teardown.
            state.rejectedCalls.push(call.data);
            res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id,
              error: { code: -32602, message: "Unexpected F4 calldata" } }));
            return;
          }
          break;
        }
        default: assert.fail(`Unexpected method ${body.method}`);
      }
      reply(state.transform ? state.transform(result, body) : result);
    } catch (error) {
      state.errors.push(error);
      if (!res.headersSent) res.writeHead(500);
      res.end("fixture assertion failed");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  state.url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    server.closeAllConnections();
    await closed;
    assert.deepEqual(state.errors, []);
  });
  state.advance = (seconds = 1) => {
    state.now += seconds * 1000;
    state.block = {
      number: `0x${(BigInt(state.block.number) + 1n).toString(16)}`,
      hash: `0x${BigInt(state.block.number).toString(16).padStart(64, "0")}`,
      timestamp: `0x${Math.floor(state.now / 1000).toString(16)}`,
    };
  };
  return state;
}
