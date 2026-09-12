import { buildReproducibleHandoff } from "./helpers/handoff.mjs";

// Optional user command: retain one verified temporary Registry for inspection.
// A failed build/comparison throws and cleans up; no success path is printed.
const registry = await buildReproducibleHandoff();
console.log(`Verified unsigned decoder fixture artifacts: ${registry.root}`);
console.log("Index references: fixtures/decoder-policy/handoff-index.json (in the source checkout)");
