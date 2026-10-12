# Installed adapter consumer

`client.mjs` combines the public `@dambi/core`, `@dambi/core/decoders` and
`@dambi/core/adapters` exports. Node and the browser use the same function:
`await createAdapterCore(settings, { signal })`; the caller disposes the returned
Core. Requests are evaluated only; no wallet transaction is signed or submitted.

Copy this directory **outside the repository**, install an actual Core tarball
there, then run the Node entry with files you prepared locally:

```sh
npm install --ignore-scripts --no-audit --no-fund /absolute/path/dambi-core-0.1.0.tgz
node node.mjs --config /private/path/consumer.json --request /private/path/request.json
```

Settings have exactly these sections: `policy: { baseUrl, maxResponseBytes,
headers? }`, `fact: { chains: { "eip155:1": { rpcUrl, headers? } },
maxResponseBytes }`, `trust`, `limits`, and `enforcement`. The last three follow
the public `CoreConfig` types. Pin policy-role **public** keys from a trusted
publisher; they are never selected from a server response. Use explicit limits,
including `maxDecoderBytes >= decoderSnapshotInfo.bytes`. Requests follow
`CheckRequest` (for example a raw `transaction` with `chainId`, `from`, `to`,
`data`, and `value`). `consumer-types.ts` checks these installed public types.

For the browser, serve the copied directory over loopback HTTP or HTTPS, open
`index.html`, and fill its settings and request before selecting **Check**.
For example, Python's standard server can serve a local copy:

```sh
python3 -m http.server 8080 --bind 127.0.0.1
```

The import map points only to the installed package under `node_modules`; keep
its `dist` layout and WASM assets intact. The browser form starts without endpoint
URLs or trust keys and sends no policy/RPC request until Check. Cancel aborts the
operation; all paths dispose Core. No settings are persisted by the example.

Use endpoints approved for public browser access or a host proxy. The example
rejects custom headers, URL userinfo and query strings; this conservative sample
guard cannot detect every credential embedded in a URL path. Verify that paths
contain no secrets. These are example restrictions, not adapter API restrictions.
Keep credentials on a host proxy and configure its CORS for the consumer origin.
Allow RPC `Content-Type` preflight; expose policy `ETag` and allow
`If-None-Match` when enabling revalidation. Without an exposed ETag, regular 200
policy responses still work. A Node credential file must never be copied into the
served directory or pasted into the browser. The example limits are demonstration
values, not operational recommendations.

Automated consumption checks use local policy/RPC servers and a temporary
tarball installation. Test signing keys stay in the Node fixture process; the
browser receives only the signed envelope and public verification key. They do
not validate a production deployment's CORS or RPC authenticity. A verdict with
`source: "fail_closed"` represents a failed evaluation even if the command/UI
returned successfully; inspect `decision`, `source`, and `diagnostics` together.
For the repository's verification command and tool setup, see
[Standalone Node and browser consumers](../../packages/core/README.md#standalone-node-and-browser-consumers).
