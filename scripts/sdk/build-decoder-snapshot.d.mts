type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Bundle = { id: string; match: Record<string, Json> } & Record<string, Json>;

export interface SnapshotMeta {
  name: string;
  schema_version: 1;
  digest: string;
  bytes: number;
  bundle_count: number;
  excluded_count: number;
  /** excluded index bundle ids per reason; ids alone run to tens of thousands */
  excluded: Record<string, number>;
  /** bundles Core refused to install, by id; null when the gate was skipped */
  rejected_by_core: { id: string; error: string }[] | null;
  /** Present only for the separate, non-product materialization regression. */
  selection?: {
    purpose: "regression-only";
    route_count: number;
    inputs: { id: string; template: string; context: string; bundle_sha256: string }[];
  };
}

export interface BuildOptions {
  name?: string;
  /** Registry root holding index/ and bundles/ — defaults to registryV2/ */
  registryRoot?: string;
  /** directory holding <name>/ — defaults to packages/core/decoder-snapshots */
  outRoot?: string;
  dryRun?: boolean;
  /** Verify in @dambi/core (default true); only index collection may drop rejected bundles. */
  verify?: boolean;
  /** Extend the saved snapshot with these Registry-relative manifests; always verify, never drop. */
  addManifests?: string[];
  /** Pinned template/context selection; output defaults beside it in generated/. */
  selectionFile?: string;
  log?: (msg: string) => void;
}

export interface BuildResult {
  artifact: string;
  meta: SnapshotMeta;
  written: string[];
}

export interface SnapshotBuilder {
  buildDecoderSnapshot(opts?: BuildOptions): Promise<BuildResult>;
  collectSelectedBundles(selectionFile: string): Promise<{
    bundles: Bundle[];
    selection: NonNullable<SnapshotMeta["selection"]>;
  }>;
  collectBundles(root: string): Promise<{ bundles: Bundle[]; excluded: Record<string, number> }>;
}

export interface BuilderOptions {
  canonicalize?: (value: unknown) => string | undefined | Promise<string | undefined>;
  repoRoot?: string;
}

export function createDecoderSnapshotBuilder(options?: BuilderOptions): SnapshotBuilder;
export const buildDecoderSnapshot: SnapshotBuilder["buildDecoderSnapshot"];
export const collectSelectedBundles: SnapshotBuilder["collectSelectedBundles"];
export const collectBundles: SnapshotBuilder["collectBundles"];
export function parseDecoderSnapshotArgs(argv: string[]): BuildOptions;
export function runDecoderSnapshotCli(builder: Pick<SnapshotBuilder, "buildDecoderSnapshot">, argv?: string[]): Promise<BuildResult>;
