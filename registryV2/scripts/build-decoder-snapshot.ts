/** Registry entry point for the shared SDK snapshot generator. Only the Registry
 * injects its JavaScript JCS dependency; SDK isolation uses Core's Native JCS. */
import canonicalize from "canonicalize";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDecoderSnapshotBuilder, runDecoderSnapshotCli,
} from "../../scripts/sdk/build-decoder-snapshot.mjs";

export type { BuildOptions, BuildResult, SnapshotMeta } from "../../scripts/sdk/build-decoder-snapshot.mjs";
export { createDecoderSnapshotBuilder, parseDecoderSnapshotArgs, runDecoderSnapshotCli } from "../../scripts/sdk/build-decoder-snapshot.mjs";
const builder = createDecoderSnapshotBuilder({ canonicalize });
export const { buildDecoderSnapshot, collectSelectedBundles, collectBundles } = builder;

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runDecoderSnapshotCli(builder).catch((error: unknown) => {
    console.error(`[build-decoder-snapshot] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
