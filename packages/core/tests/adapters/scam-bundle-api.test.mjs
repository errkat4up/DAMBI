import test from "node:test";
import assert from "node:assert/strict";
import { AdapterError, createPolicyApiSource, createScamBundleApiSource } from "@dambi/core/adapters";

const payload = ' {"kind":"scam_bundle", "sequence":"9007199254740993", "notice":"검사\\n범위"}\n';
const envelope = { payload, signature: "opaque-signature", key_id: "telemetry-only" };
const expected = { payload, signature: envelope.signature, keyId: envelope.key_id };
const options = (overrides = {}) => ({ baseUrl: "https://bundles.example", env: "staging", profile: "giwa-demo",
  maxResponseBytes: 4096, ...overrides });
const errorCode = (code, status) => (error) => {
  assert.ok(error instanceof AdapterError);
  assert.equal(error.code, code);
  assert.equal(error.status, status);
  assert.doesNotMatch(String(error), /SECRET/);
  return true;
};

test("scam bundle source validates explicit scope and preserves large sequence and original signed bytes", async () => {
  let requests = 0;
  const fetch = async (url, init) => {
    requests++;
    assert.equal(url, "https://bundles.example/v1/scam-bundle?env=staging&profile=giwa-demo&sequence=9007199254740993");
    assert.equal(init.headers.get("authorization"), "Bearer test-only");
    assert.equal(init.redirect, "error");
    assert.equal(init.credentials, "omit");
    assert.equal(init.cache, "no-store");
    return new Response(JSON.stringify(envelope));
  };
  for (const invalid of [
    { env: undefined }, { env: "test" }, { profile: "" }, { profile: "../SECRET" },
    { profile: "giwa\n" }, { profile: "a".repeat(129) }, { profile: "GIWA" },
    { sequence: 1 }, { sequence: "01" }, { sequence: "-1" }, { sequence: "1e3" },
    { sequence: "1\n" }, { sequence: "1".repeat(79) },
    { baseUrl: "https://name:SECRET@bundles.example" }, { baseUrl: "http://remote.example" },
    { headers: { "if-none-match": '"SECRET"' } },
  ]) assert.throws(() => createScamBundleApiSource(options({ fetch, ...invalid })), errorCode("INVALID_CONFIG"));
  assert.equal(requests, 0);
  const input = options({ fetch, sequence: "9007199254740993", headers: { authorization: "Bearer test-only" } });
  const source = createScamBundleApiSource(input);
  input.env = "production"; input.sequence = "1"; input.headers.authorization = "SECRET";
  assert.deepEqual(await source.fetchScam(), expected);
  assert.equal(requests, 1);
  const zero = createScamBundleApiSource(options({ env: "production", profile: undefined, sequence: "0",
    fetch: async (url) => {
      assert.equal(url, "https://bundles.example/v1/scam-bundle?env=production&profile=default&sequence=0");
      return new Response('{"payload":"not JSON","signature":""}');
    } }));
  assert.deepEqual(await zero.fetchScam(), { payload: "not JSON", signature: "" }, "Core owns semantic and signature validation");
});

test("policy and scam ETags remain independent on the same endpoint and cannot lend each other a 304 cache", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const tag = init.headers.get("if-none-match");
    seen.push({ path, tag });
    if (tag) return new Response(null, { status: 304, headers: { etag: '"ignored"' } });
    return new Response(JSON.stringify(path === "/v1/scam-bundle" ? envelope : { payload: "policy", signature: "policy-signature" }),
      { headers: { etag: path === "/v1/scam-bundle" ? '"scam"' : '"policy"' } });
  };
  const policy = createPolicyApiSource({ baseUrl: "https://bundles.example", maxResponseBytes: 4096, fetch });
  const scam = createScamBundleApiSource(options({ fetch }));
  const composed = { ...policy, ...scam };
  assert.deepEqual(await composed.fetch(), { payload: "policy", signature: "policy-signature" });
  assert.deepEqual(await composed.fetchScam(), expected);
  assert.deepEqual(await composed.fetch(), { payload: "policy", signature: "policy-signature" });
  assert.deepEqual(await composed.fetchScam(), expected);
  assert.deepEqual(seen, [
    { path: "/v1/bundle", tag: null }, { path: "/v1/scam-bundle", tag: null },
    { path: "/v1/bundle", tag: '"policy"' }, { path: "/v1/scam-bundle", tag: '"scam"' },
  ]);
  await assert.rejects(createScamBundleApiSource(options({ fetch: async () => new Response(null, { status: 304 }) }))
    .fetchScam(), errorCode("HTTP_ERROR", 304));
});

test("scam source returns explicit missing, malformed, size and cancellation errors without substituting cache", async () => {
  let response = () => new Response(JSON.stringify(envelope), { headers: { etag: '"seed"' } });
  const source = createScamBundleApiSource(options({ fetch: async () => response() }));
  assert.deepEqual(await source.fetchScam(), expected);
  for (const status of [404, 429, 503]) {
    response = () => new Response("SECRET", { status });
    await assert.rejects(source.fetchScam(), errorCode("HTTP_ERROR", status));
  }
  for (const body of [
    '{"payload":"x","sig":"wrong field"}',
    '{"payload":"x","signature":"s","\\u0070ayload":"SECRET"}',
    '{"payload":"x","signature":"s","trust":{"key":"SECRET"}}',
  ]) {
    response = () => new Response(body);
    await assert.rejects(source.fetchScam(), errorCode("INVALID_RESPONSE"));
  }
  response = () => new Response("SECRET", { headers: { "content-length": "4097" } });
  await assert.rejects(source.fetchScam(), errorCode("RESPONSE_TOO_LARGE"));
  const controller = new AbortController(); controller.abort();
  response = () => { assert.fail("An aborted call must not reach fetch"); };
  await assert.rejects(source.fetchScam({ signal: controller.signal }), errorCode("ABORTED"));
  response = () => new Response(null, { status: 304 });
  assert.deepEqual(await source.fetchScam(), expected, "Only an explicit 304 can reuse the captured valid wrapper");
});
