// @vitest-environment node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { realWindowAnalyze, realWindowEvents } from "./helpers/real-wasm";

/**
 * The algorithm's own reference vectors (produced by its Python reference
 * implementation) run through THIS extension's WASM build. They pin that the
 * unmodified `crates/scam-filter` gives bit-for-bit the same events here.
 */
const here = dirname(fileURLToPath(import.meta.url));
interface GeneratorCase { gen: string; bps: number; direction: string; series: [number, number | null][]; expected: number[] }
const cases = (JSON.parse(readFileSync(join(here, "../../../../crates/scam-filter/tests/fixtures/reference_cases.json"), "utf8")) as
  { generator_cases: GeneratorCase[] }).generator_cases.filter((c) => c.gen === "step" || c.gen === "cumulative");

describe("scam-filter reference vectors through the extension WASM", () => {
  it("covers every change_count generator vector in the repository", () => {
    expect(cases.filter((c) => c.gen === "step")).toHaveLength(63);
    expect(cases.filter((c) => c.gen === "cumulative")).toHaveLength(56);
  });

  it.each(["step", "cumulative"])("%s events match the reference bit for bit", (mode) => {
    const different: number[] = [];
    cases.filter((c) => c.gen === mode).forEach((c, index) => {
      const got = realWindowEvents({ mode, bps: c.bps, direction: c.direction, series: c.series });
      if (JSON.stringify(got) !== JSON.stringify(c.expected)) different.push(index);
    });
    expect(different).toEqual([]);
  });

  it("answers invalid input with an error envelope instead of trapping", () => {
    expect(() => realWindowEvents({ mode: "zigzag", bps: 1, direction: "up", series: [] })).toThrow(/invalid_input/);
    expect(() => realWindowAnalyze({})).toThrow(/invalid_input/);
  });
});
