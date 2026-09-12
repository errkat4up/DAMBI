import { test } from "node:test";
import { buildReproducibleHandoff } from "./helpers/handoff.mjs";

test("handoff references match fixtures/selection and two isolated builds have identical indexes and canonical bundles", { timeout: 300_000 }, async () => {
  const registry = await buildReproducibleHandoff();
  // All comparisons and JCS checks run before buildReproducibleHandoff returns.
  // Build/comparison failures clean themselves up; success is also temporary.
  await registry.cleanup();
});
