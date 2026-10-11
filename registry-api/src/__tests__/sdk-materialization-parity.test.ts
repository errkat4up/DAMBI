import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import canonicalize from "canonicalize";
import { describe, expect, it } from "vitest";
import { materializeSourceBundle, type SourceContextDocument } from "../server";
import { materializeSelectedDecoder } from "../../../scripts/sdk/materialize-decoder.mjs";

const ROOT = new URL("../../../", import.meta.url);
const FIXTURES = new URL("fixtures/sdk/pool-materialization/", ROOT);
const originals = [
  "registryV2/manifests/curve/stableswap-ng/zz-source-factory-stable-ng-2coin-mainnet/exchange@1.0.0.json",
  "registryV2/manifests/balancer/v3/router-add-liquidity-proportional@1.0.0.json",
  "registryV2/manifests/uniswap/v3-pool/swap@1.0.0.json",
];
const selection = JSON.parse(readFileSync(new URL("selection.json", FIXTURES), "utf8")) as {
  entries: { template: string; context: string }[];
};

function jcs(value: unknown): string {
  const bytes = canonicalize(value);
  if (typeof bytes !== "string") throw new Error("materialized bundle is not JSON");
  return bytes;
}

function digest(bytes: string): string {
  return "0x" + createHash("sha256").update(bytes, "utf8").digest("hex");
}

describe("selected SDK source materialization parity", () => {
  it("pins exact copies of the three selected Registry manifests", () => {
    expect(selection.entries).toHaveLength(originals.length);
    selection.entries.forEach((entry, index) => {
      expect(readFileSync(new URL(entry.template, FIXTURES), "utf8"), originals[index])
        .toBe(readFileSync(new URL(originals[index]!, ROOT), "utf8"));
    });
  });

  it("matches the real API materializer in JCS bytes and digest for identical pinned contexts", () => {
    // The Balancer context intentionally contains one pool. This compares two
    // materializers on that selected input, not the complete resolver corpus.
    for (const entry of selection.entries) {
      const template = JSON.parse(readFileSync(new URL(entry.template, FIXTURES), "utf8"));
      const context = JSON.parse(readFileSync(new URL(entry.context, FIXTURES), "utf8")) as SourceContextDocument;
      const before = JSON.stringify([template, context]);
      const api = jcs(materializeSourceBundle(template, context));
      const sdk = jcs(materializeSelectedDecoder(template, context));
      const label = fileURLToPath(new URL(entry.template, FIXTURES));
      expect(sdk, label).toBe(api);
      expect(digest(sdk), label).toBe(digest(api));
      expect(JSON.stringify([template, context]), label).toBe(before);
    }
  });

  it("pins exact UR and Aave originals for isolated selected-product reconstruction", () => {
    const inputs = new URL("fixtures/sdk/resolved-decoders/", ROOT);
    const selected = JSON.parse(readFileSync(new URL("selection.json", inputs), "utf8")) as {
      schema_version: number; manifests: string[];
    };
    expect(selected.schema_version).toBe(1);
    expect(selected.manifests).toHaveLength(5);
    for (const path of selected.manifests) {
      expect(readFileSync(new URL(path, inputs), "utf8"), path)
        .toBe(readFileSync(new URL(`registryV2/${path}`, ROOT), "utf8"));
    }
  });
});
