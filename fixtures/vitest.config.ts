import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** A deliberately standalone Node-only suite; it inherits no extension setup. */
export default {
  root,
  test: {
    environment: "node",
    include: ["fixtures/baseline-verdicts.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
  },
};
