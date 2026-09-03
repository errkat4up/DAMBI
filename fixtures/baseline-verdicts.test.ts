import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

import init, {
  evaluate_action_v2_json,
} from "../crates/policy-engine-wasm/pkg/policy_engine_wasm.js";
import { stableVerdictJson } from "./normalize";

type BaselineCase = {
  id: string;
  input: { action: unknown; results?: Record<string, unknown> };
  expected: unknown;
};

type Baseline = {
  source: { policy_set: string; sha256: string };
  fixed_meta: unknown;
  fixed_tx: unknown;
  cases: BaselineCase[];
};

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(
  readFileSync(resolve(root, "fixtures/baseline-verdicts.json"), "utf8"),
) as Baseline;
const policySetBytes = readFileSync(resolve(root, baseline.source.policy_set));
const bundles = JSON.parse(policySetBytes.toString()) as unknown;

describe("Phase 0 browser-free verdict baseline", () => {
  beforeAll(async () => {
    expect(createHash("sha256").update(policySetBytes).digest("hex")).toBe(
      baseline.source.sha256,
    );

    await init({
      module_or_path: readFileSync(
        resolve(
          root,
          "crates/policy-engine-wasm/pkg/policy_engine_wasm_bg.wasm",
        ),
      ),
    });
  });

  for (const fixture of baseline.cases) {
    it(fixture.id, () => {
      const actual = JSON.parse(
        evaluate_action_v2_json(
          JSON.stringify({
            action: fixture.input.action,
            meta: baseline.fixed_meta,
            tx: baseline.fixed_tx,
            bundles,
            results: fixture.input.results ?? {},
          }),
        ),
      );

      expect(stableVerdictJson(actual)).toBe(stableVerdictJson(fixture.expected));
    });
  }
});
