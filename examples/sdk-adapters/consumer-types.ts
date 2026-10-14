import { createCore, type CallOptions, type CheckRequest, type CoreConfig, type DambiCore, type Verdict } from "@dambi/core";
import { decoderSnapshot, decoderSnapshotInfo } from "@dambi/core/decoders";
import { createEvmFactProvider, createPolicyApiSource, type EvmFactProviderOptions, type PolicyApiSourceOptions } from "@dambi/core/adapters";
import { createAdapterCore } from "./client.mjs";

// Compile-only consumer: every declaration is resolved from the installed tarball.
declare const policy: PolicyApiSourceOptions;
declare const fact: EvmFactProviderOptions;
declare const trust: CoreConfig["trust"];
declare const limits: CoreConfig["limits"];
declare const enforcement: CoreConfig["enforcement"];
declare const options: CallOptions;
declare const request: CheckRequest;

const config = {
  decoderSnapshot, trust, limits, enforcement,
  ports: { policy: createPolicyApiSource(policy), fact: createEvmFactProvider(fact) },
} satisfies CoreConfig;
const bytes: number = decoderSnapshotInfo.bytes;
const direct: Promise<DambiCore> = createCore(config, options);
const shared: Promise<DambiCore> = createAdapterCore({ policy, fact, trust, limits, enforcement }, options);
const result: Promise<Verdict> = shared.then((core) => core.check(request, options));
void [bytes, direct, result];
