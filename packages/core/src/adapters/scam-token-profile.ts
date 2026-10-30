/** Internal profile builder. ABI recognition is not proof that a deployment
 * supports that ABI; capabilities below must come from trusted configuration.
 * Publish only through ScamRpcSource.withBatch's final canonical-hash checks.
 */
import type { Address, AdminEvent, AdminEventKind, BlockReference, DataCoverage, MissingInterval,
  PoolAge, Subject, TokenProfileParams, TokenProfileValue } from "../types/scam.js";
import { AdapterError } from "./errors.js";
import { createBlockTimeIndex } from "./scam-block-time.js";
import { SCAM_DATA_BUILDER_VERSION } from "./scam-pool-history.js";
import { ADMIN_EVENT_TOPICS, PAIR_CREATED_TOPIC, decodeAdminEvent, decodePairCreated } from "./scam-profile-codec.js";
import { address, type RpcBlock, type RpcLog } from "./scam-rpc-codec.js";
import { ScamRpcError, type ScamRpcBatch, type VerifiedPool } from "./scam-rpc.js";

export interface FactoryHistorySupport {
  readonly id: string;
  readonly chainId: number;
  readonly factory: Address;
  /** Verified deployment uses the standard V2 PairCreated ABI. */
  readonly abi: "uniswap_v2";
  /** Absent means historical code alone cannot establish this pool's age. */
  readonly nonRecreationSupportId?: string;
}
export interface TokenAdminSupport {
  readonly id: string;
  readonly chainId: number;
  readonly token: Address;
  readonly abi: "openzeppelin_standard";
  readonly kinds: readonly AdminEventKind[];
  readonly validFromBlock: string;
  readonly validThroughBlock: string;
}
export interface TokenProfileBuildOptions {
  readonly maxEvents: number;
  readonly maxLogs: number;
  /** Per age/admin timestamp index; both share the batch's raw request cap. */
  readonly maxBlockLookups: number;
  readonly blockTimeHintMs: number;
  readonly factorySupport?: FactoryHistorySupport;
  readonly adminSupport?: TokenAdminSupport;
}
const SCHEMA = "scam.token_profile/1";
const kinds = Object.keys(ADMIN_EVENT_TOPICS) as AdminEventKind[];
const integer = (v: unknown, min = 0): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min;
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 512;
const height = (v: unknown): v is string => typeof v === "string" && /^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(v);
const fail = (reason: "invalid_request" | "invalid_config" | "resource_limit" | "reorg"): never => { throw new ScamRpcError(reason); };
function sameSubject(a: Subject, b: Subject): boolean {
  return a && a.chainId === b.chainId && a.venue === b.venue
    && (["pool", "factory", "token", "quoteToken"] as const).every((key) => address(a[key]) && a[key].toLowerCase() === b[key])
    && Array.isArray(a.actionPaths) && a.actionPaths.length === b.actionPaths.length
    && a.actionPaths.every((path, i) => path === b.actionPaths[i]);
}
function recoverable(error: unknown): string {
  if (error instanceof ScamRpcError && ["rpc_error", "invalid_response"].includes(error.reason)) return error.reason;
  if (error instanceof AdapterError && error.code === "INVALID_RESPONSE") return "invalid_response";
  throw error; // Global resource exhaustion, reorg, cancellation and timeout stay fatal.
}
const reference = ({ number, hash, timestampMs }: RpcBlock): BlockReference => ({ number, hash, timestampMs });
const unknownAge = (reasons: readonly string[]): PoolAge => ({ kind: "unknown", reasons: [...new Set(reasons)] });
class AgeSearchLimit extends Error {}

function ownOptions(input: TokenProfileBuildOptions): TokenProfileBuildOptions {
  if (!input || ![input.maxEvents, input.maxLogs, input.maxBlockLookups, input.blockTimeHintMs].every((v) => integer(v, 1))) return fail("invalid_config");
  const factory = input.factorySupport, admin = input.adminSupport;
  if (factory && (!text(factory.id) || !integer(factory.chainId, 1) || !address(factory.factory) || factory.abi !== "uniswap_v2"
      || factory.nonRecreationSupportId !== undefined && !text(factory.nonRecreationSupportId))) return fail("invalid_config");
  if (admin && (!text(admin.id) || !integer(admin.chainId, 1) || !address(admin.token) || admin.abi !== "openzeppelin_standard"
      || !height(admin.validFromBlock) || !height(admin.validThroughBlock) || BigInt(admin.validFromBlock) > BigInt(admin.validThroughBlock)
      || !Array.isArray(admin.kinds) || !admin.kinds.length || admin.kinds.length > kinds.length
      || !admin.kinds.every((kind) => kinds.includes(kind)) || new Set(admin.kinds).size !== admin.kinds.length)) return fail("invalid_config");
  return { maxEvents: input.maxEvents, maxLogs: input.maxLogs, maxBlockLookups: input.maxBlockLookups, blockTimeHintMs: input.blockTimeHintMs,
    ...(factory && { factorySupport: { ...factory, factory: factory.factory.toLowerCase() as Address } }),
    ...(admin && { adminSupport: { ...admin, token: admin.token.toLowerCase() as Address, kinds: [...admin.kinds] } }) };
}

/** maxAgeSearchCalls bounds logical header/code/log-scan operations. Raw log
 * chunks and retry attempts are separately bounded by SF4-2 maxRequests.
 */
export async function buildTokenProfile(
  batch: ScamRpcBatch, pool: VerifiedPool, input: TokenProfileParams, suppliedOptions: TokenProfileBuildOptions,
): Promise<TokenProfileValue> {
  const options = ownOptions(suppliedOptions);
  if (!input || input.dataSchema !== SCHEMA || input.builderVersion !== SCAM_DATA_BUILDER_VERSION
      || input.referenceGroupId !== batch.referenceGroupId || input.confirmDepth !== batch.reference.requiredConfirmDepth
      || !sameSubject(input.subject, pool.subject) || !integer(input.ageThresholdSec, 1)
      || input.ageThresholdSec > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
      || !integer(input.ageSearchMaxLookbackSec) || input.ageSearchMaxLookbackSec > 86_400
      || !integer(input.maxAgeSearchCalls, 1) || input.maxAgeSearchCalls > 10_000
      || !integer(input.eventLookbackSec) || input.eventLookbackSec > 86_400
      || !Array.isArray(input.eventKinds) || input.eventKinds.length > kinds.length
      || !input.eventKinds.every((kind) => kinds.includes(kind)) || new Set(input.eventKinds).size !== input.eventKinds.length
      || (input.eventKinds.length === 0) !== (input.eventLookbackSec === 0)) return fail("invalid_request");
  const params: Pick<TokenProfileParams, "ageThresholdSec" | "ageSearchMaxLookbackSec"
    | "maxAgeSearchCalls" | "eventLookbackSec" | "eventKinds"> = {
    ageThresholdSec: input.ageThresholdSec, ageSearchMaxLookbackSec: input.ageSearchMaxLookbackSec,
    maxAgeSearchCalls: input.maxAgeSearchCalls, eventLookbackSec: input.eventLookbackSec, eventKinds: [...input.eventKinds] };
  const end = batch.reference.block.timestampMs;
  const searchedRanges: DataCoverage[] = [];
  const support = options.factorySupport;

  async function age(): Promise<PoolAge> {
    if (!support || support.chainId !== pool.subject.chainId || support.factory !== pool.subject.factory) {
      return unknownAge(["factory_history_unsupported"]);
    }
    let operations = 0, headers = 0;
    const spend = (): void => { if (++operations > params.maxAgeSearchCalls) throw new AgeSearchLimit(); };
    const scoped: ScamRpcBatch = { ...batch, block: (number) => {
      spend();
      if (++headers > options.maxBlockLookups) throw new AgeSearchLimit();
      return batch.block(number);
    } };
    // The local wrapper stops first and returns age_unknown rather than
    // confusing this optional search budget with the batch's global limits.
    const times = createBlockTimeIndex(scoped, { maxBlocks: params.maxAgeSearchCalls + 1, blockTimeHintMs: options.blockTimeHintMs });
    const reasons: string[] = [];
    try {
      let afterEmptyCode: RpcBlock | undefined;
      if (support.nonRecreationSupportId) {
        const cutoff = Math.max(0, end - params.ageThresholdSec * 1000);
        const boundary = await times.atOrBefore(cutoff);
        if (boundary.before) {
          const checked = boundary.before;
          spend();
          try {
            const code = await batch.code(pool, checked.number);
            searchedRanges.push({ fromBlock: checked.number, fromMs: checked.timestampMs, toMs: checked.timestampMs, missing: [], unavailable: [] });
            if (code !== "0x") return { kind: "lower_bound", ageLowerBoundSec: Math.floor((end - checked.timestampMs) / 1000),
              evidence: { kind: "historical_code_presence", checkedAt: reference(checked), identityVerified: true,
                nonRecreationSupportId: support.nonRecreationSupportId } };
            afterEmptyCode = checked;
            reasons.push("code_absent_at_threshold");
          } catch (error) {
            const reason = recoverable(error);
            searchedRanges.push({ fromBlock: checked.number, fromMs: checked.timestampMs, toMs: checked.timestampMs,
              missing: [], unavailable: [{ field: "pool.code", reason }] });
            reasons.push(`historical_code_${reason}`);
          }
        }
      } else reasons.push("non_recreation_unverified");
      if (params.ageSearchMaxLookbackSec === 0) return unknownAge([...reasons, "creation_search_disabled"]);
      const start = Math.max(0, end - params.ageSearchMaxLookbackSec * 1000, afterEmptyCode?.timestampMs ?? 0);
      const boundary = await times.atOrBefore(start);
      const startBlock = boundary.before ?? boundary.after!;
      const fromBlock = BigInt(startBlock.number) + (boundary.before ? 1n : 0n);
      const range: DataCoverage = { fromBlock: startBlock.number, fromMs: start, toMs: end, missing: [], unavailable: [] };
      if (fromBlock > BigInt(batch.reference.block.number)) return unknownAge([...reasons, "creation_not_found"]);
      searchedRanges.push({ ...range,
        missing: start < end ? [{ fromMs: start, toMs: end, reason: "unavailable_history" }] : [],
        unavailable: [{ field: "pool.creation", reason: "search_not_completed" }] });
      spend();
      const scan = await batch.logs(pool, { scope: "factory", fromBlock: fromBlock.toString(), toBlock: batch.reference.block.number, topics: [PAIR_CREATED_TOPIC] });
      if (scan.logs.length > options.maxLogs || scan.missing.length > options.maxLogs) return fail("resource_limit");
      // A complete post-creation range is required here. A partial search or
      // ambiguous identity never becomes an exact age or an old-pool inference.
      if (scan.missing.length) {
        searchedRanges[searchedRanges.length - 1] = { ...range,
          missing: start < end ? [{ fromMs: start, toMs: end,
            reason: scan.missing.some((gap) => gap.reason === "invalid_response") ? "unavailable_history" : "rpc_error" }] : [],
          unavailable: [{ field: "pool.creation", reason: "partial_factory_logs" }] };
        return unknownAge([...reasons, "creation_search_incomplete"]);
      }
      searchedRanges[searchedRanges.length - 1] = range;
      const matches: RpcLog[] = [];
      for (const log of scan.logs) {
        const decoded = decodePairCreated(log);
        if (!decoded) { reasons.push("invalid_pair_created"); continue; }
        const tokensMatch = decoded.token0 === pool.token0 && decoded.token1 === pool.token1;
        if (decoded.pair === pool.subject.pool && tokensMatch) matches.push(log);
        else if (decoded.pair === pool.subject.pool || tokensMatch) reasons.push("creation_identity_mismatch");
      }
      if (reasons.includes("invalid_pair_created") || reasons.includes("creation_identity_mismatch") || matches.length > 1) {
        searchedRanges[searchedRanges.length - 1] = { ...range,
          unavailable: [{ field: "pool.creation", reason: "invalid_or_ambiguous_creation" }] };
        return unknownAge([...reasons, "creation_ambiguous"]);
      }
      if (!matches.length) return unknownAge([...reasons, "creation_not_found"]);
      const log = matches[0], created = await times.block(log.blockNumber);
      if (created.hash !== log.blockHash) return fail("reorg");
      if (created.timestampMs <= start || created.timestampMs > end) return unknownAge([...reasons, "creation_outside_window"]);
      return { kind: "exact", ageSec: Math.floor((end - created.timestampMs) / 1000),
        evidence: { kind: "factory_pair_created", factory: pool.subject.factory, createdAt: reference(created),
          transactionHash: log.transactionHash, logIndex: log.logIndex } };
    } catch (error) {
      if (error instanceof AgeSearchLimit) return unknownAge([...reasons, "age_search_limit"]);
      return unknownAge([...reasons, `age_${recoverable(error)}`]);
    }
  }

  const resolvedAge = await age();
  const from = Math.max(0, end - params.eventLookbackSec * 1000);
  const events: AdminEvent[] = [];
  let missing: MissingInterval[] = [];
  const unavailable: { field: string; reason: string }[] = [];
  const times = createBlockTimeIndex(batch, { maxBlocks: options.maxBlockLookups, blockTimeHintMs: options.blockTimeHintMs });
  const boundary = params.eventKinds.length ? await times.atOrBefore(from) : undefined;
  const startBlock = boundary ? (boundary.before ?? boundary.after!) : batch.reference.block;
  const queryFrom = BigInt(startBlock.number) + (boundary?.before ? 1n : 0n);
  const admin = options.adminSupport;
  if (params.eventKinds.length) {
    const supported = admin && admin.chainId === pool.subject.chainId && admin.token === pool.subject.token
      && BigInt(admin.validFromBlock) <= queryFrom && BigInt(admin.validThroughBlock) >= BigInt(batch.reference.block.number)
      && params.eventKinds.every((kind) => admin.kinds.includes(kind));
    if (!supported) {
      // The wire contract has one shared missing timeline, not kind-specific
      // coverage. Do not mix supported events into a wholly unknown timeline.
      unavailable.push({ field: "adminEvents", reason: "unsupported_target_kind_or_range" });
      if (from < end) missing.push({ fromMs: from, toMs: end, reason: "unavailable_history" });
    } else if (queryFrom <= BigInt(batch.reference.block.number)) {
      const scan = await batch.logs(pool, { scope: "token", fromBlock: queryFrom.toString(), toBlock: batch.reference.block.number,
        topics: params.eventKinds.map((kind) => ADMIN_EVENT_TOPICS[kind]) });
      if (scan.logs.length > options.maxLogs || scan.missing.length > options.maxLogs) return fail("resource_limit");
      const gap = (start: number, stop: number, reason: MissingInterval["reason"]): void => {
        const fromMs = Math.max(from, Math.min(start, end - 1)), toMs = Math.min(end, stop + 1);
        if (fromMs < toMs) missing.push({ fromMs, toMs, reason });
      };
      for (const range of scan.missing) {
        const first = await times.block(range.fromBlock), last = await times.block(range.toBlock);
        gap(first.timestampMs, last.timestampMs, range.reason === "rpc_error" ? "rpc_error" : "unavailable_history");
      }
      for (const log of scan.logs) {
        const block = await times.block(log.blockNumber);
        if (block.hash !== log.blockHash) return fail("reorg");
        const kind = decodeAdminEvent(log);
        if (!kind || !params.eventKinds.includes(kind)) { gap(block.timestampMs, block.timestampMs, "unavailable_history"); continue; }
        if (block.timestampMs > from && block.timestampMs <= end) events.push({ tMs: block.timestampMs, kind });
        if (events.length > options.maxEvents) return fail("resource_limit");
      }
      missing.sort((a, b) => a.fromMs - b.fromMs || a.toMs - b.toMs);
      const merged: MissingInterval[] = [];
      for (const current of missing) {
        const previous = merged[merged.length - 1];
        if (previous && current.fromMs <= previous.toMs) merged[merged.length - 1] = { ...previous, toMs: Math.max(previous.toMs, current.toMs) };
        else merged.push(current);
      }
      missing = merged;
      // Different blocks can share a timestamp. Incomplete timestamps cannot
      // retain partial events under the current algorithm wire contract.
      // Both timelines are sorted; keep this linear in events + missing ranges.
      let gapIndex = 0, kept = 0;
      for (const event of events) {
        while (gapIndex < missing.length && missing[gapIndex].toMs <= event.tMs
          && !(missing[gapIndex].toMs === end && event.tMs === end)) gapIndex++;
        const gap = missing[gapIndex];
        if (!gap || event.tMs < gap.fromMs) events[kept++] = event;
      }
      events.length = kept;
    }
  }
  return { method: "scam.token_profile", schema: SCHEMA, builderVersion: SCAM_DATA_BUILDER_VERSION,
    subject: pool.subject, referenceGroupId: batch.referenceGroupId, reference: batch.reference,
    age: resolvedAge, searchedRanges, events,
    coverage: { fromBlock: startBlock.number, fromMs: from, toMs: end, missing, unavailable } };
}
