import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { AdapterError, createPolicyApiSource } from "@dambi/core/adapters";

const payload = ' {"sequence":9007199254740993, "note":"정책\\n원문", "value":1.00}\n';
const envelope = { payload, signature: "opaque-signature", key_id: "telemetry-only" };
const bytes = Buffer.from(JSON.stringify(envelope));
const expected = { payload, signature: envelope.signature, keyId: envelope.key_id };

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function code(expectedCode, status) {
  return (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.code, expectedCode);
    assert.equal(error.status, status);
    return true;
  };
}

async function serverFor(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    const closed = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    server.closeAllConnections();
    await closed;
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function source(options = {}) {
  return createPolicyApiSource({
    baseUrl: "https://policies.example",
    maxResponseBytes: 4_096,
    ...options,
  });
}

function taggedResponse(value = envelope, etag = '"initial"') {
  return new Response(JSON.stringify(value), {
    headers: etag === undefined ? {} : { etag },
  });
}

function responseQueue() {
  const queue = [];
  return {
    fetch: async (_url, init) => {
      const next = queue.shift();
      assert.ok(next, "an injected request must have a scheduled response");
      next.request.resolve(init);
      return next.response.promise;
    },
    schedule() {
      const next = { request: deferred(), response: deferred() };
      queue.push(next);
      return next;
    },
  };
}

test("adapter validates endpoint, limits and fixed request settings before any I/O", () => {
  let requests = 0;
  const fetch = () => { requests++; throw new Error("unexpected request"); };
  for (const baseUrl of [
    "https://policies.example", "https://policies.example/", "http://localhost:3210",
    "http://127.0.0.1:3210", "http://127.17.3.4:3210", "http://[::1]:3210",
  ]) {
    assert.equal(typeof source({ baseUrl, fetch }).fetch, "function");
  }
  for (const options of [
    { baseUrl: "http://policies.example" }, { baseUrl: "http://localhost.example" },
    { baseUrl: "http://128.0.0.1" }, { baseUrl: "ftp://policies.example" },
    { baseUrl: "https://name:secret@policies.example" },
    { baseUrl: "https://@policies.example" },
    { baseUrl: String.raw`https://policies.example\api\..` },
    { baseUrl: "https://policies.example/a/.." },
    { baseUrl: "https://policies.example/api" }, { baseUrl: "https://policies.example?x=1" },
    { baseUrl: "https://policies.example#fragment" }, { baseUrl: "not a URL" },
    { maxResponseBytes: 0 }, { maxResponseBytes: -1 }, { maxResponseBytes: 1.5 },
    { maxResponseBytes: Number.MAX_SAFE_INTEGER + 1 }, { maxResponseBytes: Infinity },
    { version: 0 }, { version: -1 }, { version: 1.5 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { profile: "other" }, { fetch: "not a function" },
    { headers: { "If-None-Match": '"caller-cache"' } },
    { headers: { "if-modified-since": "Mon, 12 Oct 2026 00:00:00 GMT" } },
    { headers: { "bad header": "value" } }, { headers: { authorization: "bad\nvalue" } },
  ]) {
    assert.throws(() => source({ fetch, ...options }), code("INVALID_CONFIG"));
  }
  assert.throws(() => createPolicyApiSource({ baseUrl: "https://policies.example" }), code("INVALID_CONFIG"));
  assert.equal(requests, 0);
});

test("actual HTTP request fixes query and headers while preserving the signed payload string", async (t) => {
  const requests = [];
  const baseUrl = await serverFor(t, (req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(bytes);
  });
  const settings = [];
  const headers = { authorization: "Bearer test-only", "x-client": "original" };
  const options = {
    baseUrl, maxResponseBytes: bytes.length, headers, version: 42,
    fetch: (url, init) => {
      settings.push(init);
      return globalThis.fetch(url, init);
    },
  };
  const policy = createPolicyApiSource(options);
  headers["x-client"] = "mutated";
  options.version = 999;
  options.baseUrl = "https://unrelated.example";
  assert.deepEqual(await policy.fetch(), expected);
  assert.equal(requests[0].method, "GET");
  assert.equal(requests[0].url, "/v1/bundle?profile=default&version=42");
  assert.equal(requests[0].headers.authorization, "Bearer test-only");
  assert.equal(requests[0].headers["x-client"], "original");
  assert.equal(requests[0].headers["if-none-match"], undefined);
  assert.equal(settings[0].cache, "no-store");
  assert.equal(settings[0].credentials, "omit");
  assert.equal(settings[0].redirect, "error");

  assert.deepEqual(await source({ baseUrl }).fetch(), expected);
  assert.equal(requests[1].url, "/v1/bundle?profile=default");
  // Signature validity and the payload's schema are intentionally Core's responsibility.
  const opaque = await source({ fetch: async () => new Response('{"payload":"not JSON","signature":""}') }).fetch();
  assert.deepEqual(opaque, { payload: "not JSON", signature: "" });
});

test("wrapper parsing rejects malformed shape, decoded duplicate keys and invalid UTF-8", async (t) => {
  let body = bytes;
  const baseUrl = await serverFor(t, (_req, res) => res.end(body));
  const policy = source({ baseUrl });
  const invalidBodies = [
    "null", "[]", '"string"', '{"payload":"x"}',
    '{"payload":{},"signature":"s"}', '{"payload":"x","signature":1}',
    '{"payload":"x","signature":"s","key_id":null}',
    '{"payload":"x","signature":"s","extra":true}',
    '{"payload":"x","signature":"s","keyId":"wrong-wire-name"}',
    '{"payload":"x","payload":"y","signature":"s"}',
    '{"payload":"x","\\u0070ayload":"y","signature":"s"}',
    '{"payload":"x","signature":"s","signature":"t"}',
    '{"payload":"x","signature":"s","key_id":"a","key_id":"b"}',
    '{"payload":"x","signature":"s",}', '{"payload":"x","signature":"s"} trailing',
    Buffer.from([0x7b, 0xc3, 0x28, 0x7d]),
  ];
  for (const invalid of invalidBodies) {
    body = invalid;
    await assert.rejects(policy.fetch(), code("INVALID_RESPONSE"));
  }
  body = ' \n{ "\\u0070ayload" : "{\\"payload\\":1,\\"payload\\":2}", "signature":"s", "key_id":"" }\r\n';
  assert.deepEqual(await policy.fetch(), {
    payload: '{"payload":1,"payload":2}', signature: "s", keyId: "",
  });
});

test("response limits count UTF-8 bytes and stop oversized declared or streamed bodies", { timeout: 5_000 }, async (t) => {
  const baseUrl = await serverFor(t, (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    // Multiple writes deliberately avoid a Content-Length header.
    res.write(bytes.subarray(0, 12));
    res.end(bytes.subarray(12));
  });
  assert.deepEqual(await source({ baseUrl, maxResponseBytes: bytes.length }).fetch(), expected);
  await assert.rejects(source({ baseUrl, maxResponseBytes: bytes.length - 1 }).fetch(), code("RESPONSE_TOO_LARGE"));

  const split = bytes.indexOf(Buffer.from("정")) + 1;
  assert.ok(split > 1, "split inside the first three-byte UTF-8 character");
  const splitUtf8 = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, split));
      controller.enqueue(bytes.subarray(split));
      controller.close();
    },
  }));
  assert.deepEqual(await source({
    maxResponseBytes: bytes.length,
    fetch: async () => splitUtf8,
  }).fetch(), expected);

  let cancelled = false;
  const declared = new Response(new ReadableStream({
    cancel() { cancelled = true; },
  }), { headers: { "content-length": String(bytes.length + 1) } });
  await assert.rejects(source({
    maxResponseBytes: bytes.length,
    fetch: async () => declared,
  }).fetch(), code("RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);

  cancelled = false;
  const dishonest = new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { cancelled = true; },
  }), { headers: { "content-length": "1" } });
  await assert.rejects(source({
    maxResponseBytes: bytes.length - 1,
    fetch: async () => dishonest,
  }).fetch(), code("RESPONSE_TOO_LARGE"));
  assert.equal(cancelled, true);
});

test("HTTP and network failures expose stable errors without returning an earlier envelope", async (t) => {
  let status = 200;
  const secret = "fixture-credential-must-not-appear";
  const baseUrl = await serverFor(t, (_req, res) => {
    res.writeHead(status);
    res.end(status === 200 ? bytes : secret);
  });
  const policy = source({ baseUrl, headers: { authorization: secret } });
  assert.deepEqual(await policy.fetch(), expected);
  for (status of [304, 404, 429, 503]) {
    await assert.rejects(policy.fetch(), (error) => {
      code("HTTP_ERROR", status)(error);
      assert.equal(String(error).includes(secret), false);
      return true;
    });
  }
  await assert.rejects(source({
    fetch: async () => { throw new Error(secret); },
  }).fetch(), (error) => {
    code("NETWORK_ERROR")(error);
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});

test("cancellation reaches pending HTTP headers and body without cancelling a sibling request", { timeout: 5_000 }, async (t) => {
  const waitingForHeaders = deferred();
  const responseStarted = deferred();
  let mode = "headers";
  const baseUrl = await serverFor(t, (_req, res) => {
    if (mode === "headers") {
      waitingForHeaders.resolve();
    } else if (mode === "body") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"payload":');
    } else {
      res.end(bytes);
    }
  });
  let fetches = 0;
  const policy = source({
    baseUrl,
    fetch: async (url, init) => {
      fetches++;
      const response = await globalThis.fetch(url, init);
      if (mode === "body") responseStarted.resolve();
      return response;
    },
  });
  const already = new AbortController();
  already.abort();
  await assert.rejects(policy.fetch({ signal: already.signal }), code("ABORTED"));
  assert.equal(fetches, 0);

  const headers = new AbortController();
  const pendingHeaders = policy.fetch({ signal: headers.signal });
  const headersRejected = assert.rejects(pendingHeaders, code("ABORTED"));
  await waitingForHeaders.promise;
  headers.abort();
  await headersRejected;

  mode = "body";
  const body = new AbortController();
  const pendingBody = policy.fetch({ signal: body.signal });
  const bodyRejected = assert.rejects(pendingBody, code("ABORTED"));
  await responseStarted.promise;
  mode = "complete";
  const sibling = policy.fetch();
  body.abort();
  await bodyRejected;
  assert.deepEqual(await sibling, expected);
});

test("HTTP redirects are rejected without sending authentication to their target", async (t) => {
  let redirectedRequests = 0;
  const target = await serverFor(t, (_req, res) => {
    redirectedRequests++;
    res.end(bytes);
  });
  const baseUrl = await serverFor(t, (_req, res) => {
    res.writeHead(302, { location: `${target}/redirect-target` });
    res.end();
  });
  await assert.rejects(source({
    baseUrl, headers: { authorization: "Bearer test-only" },
  }).fetch(), code("NETWORK_ERROR"));
  assert.equal(redirectedRequests, 0);
});

test("a body stream failure rejects instead of exposing partial or sensitive response data", async () => {
  const secret = "fixture-sensitive-body-detail";
  const response = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.subarray(0, 10));
      controller.error(new Error(secret));
    },
  }));
  await assert.rejects(source({ fetch: async () => response }).fetch(), (error) => {
    code("NETWORK_ERROR")(error);
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});

test("HTTP ETags reuse the exact envelope on 304 and remain local to each source", async (t) => {
  const changed = { payload: " {\"sequence\":2}\n", signature: "second-signature" };
  const seen = [];
  const baseUrl = await serverFor(t, (req, res) => {
    seen.push(req.headers["if-none-match"]);
    const step = seen.length;
    if (step === 2 || step === 4) {
      // A 304's own ETag cannot relabel the signed envelope or change the next request.
      res.writeHead(304, { etag: '"unrelated-304-tag"' });
      res.end();
    } else {
      res.writeHead(200, { etag: step === 3 ? 'W/"second"' : '"first"' });
      res.end(JSON.stringify(step === 3 ? changed : envelope));
    }
  });
  const policy = source({ baseUrl });
  assert.deepEqual(await policy.fetch(), expected);
  assert.deepEqual(await policy.fetch(), expected);
  assert.deepEqual(await policy.fetch(), changed);
  assert.deepEqual(await policy.fetch(), changed);
  assert.deepEqual(await source({ baseUrl }).fetch(), expected);
  assert.deepEqual(seen, [undefined, '"first"', '"first"', 'W/"second"', undefined]);
});

test("only one valid opaque ETag enables revalidation and an untagged 200 clears conditional state", async () => {
  for (const etag of ['"strong"', 'W/"weak"', '""', '"comma,backslash\\ok"', '"\x80"']) {
    const seen = [];
    const policy = source({ fetch: async (_url, init) => {
      seen.push(init.headers.get("if-none-match"));
      return seen.length === 1 ? taggedResponse(envelope, etag) : new Response(null, {
        status: 304,
        // A 304's length describes a representation; there is no body to read.
        headers: { "content-length": "99999999" },
      });
    } });
    assert.deepEqual(await policy.fetch(), expected);
    assert.deepEqual(await policy.fetch(), expected);
    assert.deepEqual(seen, [null, etag]);
  }

  for (const etag of [null, "unquoted", "*", 'w/"lowercase"', '"one", "two"', '"space here"', 'W/ "space"', '"quote"inside"']) {
    const seen = [];
    const replacement = { payload: "replacement", signature: "replacement-signature" };
    const policy = source({ fetch: async (_url, init) => {
      seen.push(init.headers.get("if-none-match"));
      if (seen.length === 1) return taggedResponse();
      if (seen.length === 2) return new Response(JSON.stringify(replacement), {
        headers: etag === null ? {} : { etag },
      });
      return new Response(null, { status: 304 });
    } });
    await policy.fetch();
    // The new envelope is usable for this call even when its cache validator is unusable.
    assert.deepEqual(await policy.fetch(), replacement);
    await assert.rejects(policy.fetch(), code("HTTP_ERROR", 304));
    assert.deepEqual(seen, [null, '"initial"', null]);
  }
});

test("concurrent requests pin their own 304 envelope and failed newest work blocks older cache publication", { timeout: 5_000 }, async () => {
  const transport = responseQueue();
  const policy = source({ fetch: transport.fetch });
  const seed = transport.schedule();
  seed.response.resolve(taggedResponse());
  await policy.fetch();

  const older = transport.schedule();
  const olderResult = policy.fetch();
  assert.equal((await older.request.promise).headers.get("if-none-match"), '"initial"');
  const newer = transport.schedule();
  const newerResult = policy.fetch();
  assert.equal((await newer.request.promise).headers.get("if-none-match"), '"initial"');
  const second = { payload: "second", signature: "second-signature" };
  newer.response.resolve(taggedResponse(second, '"second"'));
  assert.deepEqual(await newerResult, second);
  older.response.resolve(new Response(null, { status: 304, headers: { etag: '"ignored"' } }));
  assert.deepEqual(await olderResult, expected);

  const late = transport.schedule();
  const lateResult = policy.fetch();
  assert.equal((await late.request.promise).headers.get("if-none-match"), '"second"');
  const failed = transport.schedule();
  const failedResult = policy.fetch();
  const failure = assert.rejects(failedResult, code("INVALID_RESPONSE"));
  await failed.request.promise;
  failed.response.resolve(new Response('{"payload":"missing-signature"}', { headers: { etag: '"invalid"' } }));
  await failure;
  const third = { payload: "late-third", signature: "third-signature" };
  late.response.resolve(taggedResponse(third, '"third"'));
  assert.deepEqual(await lateResult, third);

  const probe = transport.schedule();
  const probeResult = policy.fetch();
  assert.equal((await probe.request.promise).headers.get("if-none-match"), '"second"');
  probe.response.resolve(new Response(null, { status: 304 }));
  assert.deepEqual(await probeResult, second);
});

test("cancelled header and body work cannot change cached envelopes or cancel an independent refresh", { timeout: 5_000 }, async () => {
  const transport = responseQueue();
  const policy = source({ fetch: transport.fetch });
  const seed = transport.schedule();
  seed.response.resolve(taggedResponse());
  await policy.fetch();

  const older = transport.schedule();
  const olderResult = policy.fetch();
  await older.request.promise;
  const cancelled = transport.schedule();
  const cancellation = new AbortController();
  const cancelledResult = policy.fetch({ signal: cancellation.signal });
  const rejected = assert.rejects(cancelledResult, code("ABORTED"));
  await cancelled.request.promise;
  cancellation.abort();
  await rejected;
  const lateValue = { payload: "older-response", signature: "older-signature" };
  older.response.resolve(taggedResponse(lateValue, '"older"'));
  assert.deepEqual(await olderResult, lateValue);
  const discarded = deferred();
  cancelled.response.resolve(new Response(new ReadableStream({ cancel() { discarded.resolve(); } }), {
    headers: { etag: '"cancelled"' },
  }));
  await discarded.promise;

  const reading = deferred();
  let bodyCancelled = false;
  const pendingBody = transport.schedule();
  pendingBody.response.resolve(new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, 10)); },
    pull() { reading.resolve(); },
    cancel() { bodyCancelled = true; },
  }), { headers: { etag: '"incomplete"' } }));
  const bodyCancellation = new AbortController();
  const bodyResult = policy.fetch({ signal: bodyCancellation.signal });
  const bodyRejected = assert.rejects(bodyResult, code("ABORTED"));
  assert.equal((await pendingBody.request.promise).headers.get("if-none-match"), '"initial"');
  await reading.promise;
  const sibling = transport.schedule();
  const siblingResult = policy.fetch();
  const siblingInit = await sibling.request.promise;
  assert.equal(siblingInit.headers.get("if-none-match"), '"initial"');
  assert.equal(siblingInit.signal, undefined);
  bodyCancellation.abort();
  await bodyRejected;
  assert.equal(bodyCancelled, true);
  const replacement = { payload: "sibling", signature: "sibling-signature" };
  sibling.response.resolve(taggedResponse(replacement, '"sibling"'));
  assert.deepEqual(await siblingResult, replacement);

  const probe = transport.schedule();
  const probeResult = policy.fetch();
  assert.equal((await probe.request.promise).headers.get("if-none-match"), '"sibling"');
  probe.response.resolve(new Response(null, { status: 304 }));
  assert.deepEqual(await probeResult, replacement);
});
