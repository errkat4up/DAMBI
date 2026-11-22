import type { BlockReference, PoolAge, Subject, TokenProfile } from "../types/scam.js";
import { decodePairCreated } from "./scam-profile-codec.js";
import { address, hash, type RpcLog } from "./scam-rpc-codec.js";

/** Chain context is supplied separately because an EVM header has no chain ID. */
export interface PoolCreationHeader {
  readonly chainId: Subject["chainId"];
  readonly block: BlockReference;
}

export interface PoolCreationEvidence {
  readonly chainId: Subject["chainId"];
  /**
   * Candidate creation evidence, not an arbitrary factory history scan. Exactly
   * one event is required. Preserve the removal flag at acquisition time: the
   * normalized RpcLog alone does not attest that the event was not removed.
   */
  readonly logs: readonly (RpcLog & { readonly removed: boolean })[];
}

type CreationProof = Extract<PoolAge, { kind: "exact" }>["evidence"];
export type PoolCreationResult =
  | {
      readonly kind: "verified";
      readonly poolCreatedMs: NonNullable<TokenProfile["poolCreatedMs"]>;
      readonly evidence: CreationProof;
    }
  | Extract<PoolAge, { kind: "unknown" }>;

const integer = (value: unknown, min = 0): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min;
const height = (value: unknown): value is string =>
  typeof value === "string" && /^(?:0|[1-9][0-9]{0,77})(?![\s\S])/.test(value);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function unknown(reason: string): Extract<PoolAge, { kind: "unknown" }> {
  return Object.freeze({ kind: "unknown", reasons: Object.freeze(["age_unknown", reason]) });
}

/**
 * Pure offline binding check for standard V2 PairCreated evidence.
 *
 * The expected subject and observed creation header must be supplied independently
 * of the candidate log. The caller is responsible for factory provenance, chain
 * provenance, header authenticity/canonicality and completeness of acquisition.
 * Matching this ABI does not authenticate a factory or establish those facts.
 * No RPC, lookup time, current clock, age inference or first-Mint fallback is used.
 * Missing, malformed, removed or multiple candidates always preserve age_unknown.
 */
export function verifyPoolCreation(
  expected: Subject,
  observed: PoolCreationHeader | null | undefined,
  supplied: PoolCreationEvidence | null | undefined,
): PoolCreationResult {
  if (!record(expected) || !integer(expected.chainId, 1) || expected.venue !== "uniswap_v2"
      || !address(expected.factory) || !address(expected.pool)
      || !address(expected.token) || !address(expected.quoteToken)
      || expected.token.toLowerCase() === expected.quoteToken.toLowerCase()) {
    return unknown("invalid_subject");
  }
  if (observed == null || supplied == null) return unknown("creation_evidence_missing");
  if (!record(observed) || !integer(observed.chainId, 1)
      || !record(observed.block) || !height(observed.block.number)
      || !hash(observed.block.hash) || !integer(observed.block.timestampMs)) {
    return unknown("invalid_creation_header");
  }
  if (!record(supplied) || !integer(supplied.chainId, 1) || !Array.isArray(supplied.logs)) {
    return unknown("invalid_creation_evidence");
  }
  if (expected.chainId !== observed.chainId || expected.chainId !== supplied.chainId) {
    return unknown("creation_chain_mismatch");
  }
  if (supplied.logs.length === 0) return unknown("creation_evidence_missing");
  // Even duplicate copies are ambiguous at this boundary; do not select a winner.
  if (supplied.logs.length !== 1) return unknown("creation_ambiguous");
  const log = supplied.logs[0];
  if (!record(log) || log.removed !== false || !address(log.address)
      || !height(log.blockNumber) || !hash(log.blockHash) || !hash(log.transactionHash)
      || !integer(log.transactionIndex) || !integer(log.logIndex)
      || !Array.isArray(log.topics) || log.topics.length !== 3) {
    return unknown("invalid_creation_event");
  }
  // Unlike Array.every, iteration visits sparse slots, which must not reach the
  // existing decoder as missing topics in an otherwise plausible ABI layout.
  for (const topic of log.topics) {
    if (!hash(topic)) return unknown("invalid_creation_event");
  }
  if (log.address.toLowerCase() !== expected.factory.toLowerCase()) {
    return unknown("creation_factory_mismatch");
  }
  const decoded = decodePairCreated(log);
  if (!decoded) return unknown("invalid_pair_created");
  if (decoded.pair !== expected.pool.toLowerCase()) return unknown("creation_pool_mismatch");
  const token = expected.token.toLowerCase(), quote = expected.quoteToken.toLowerCase();
  if (!((decoded.token0 === token && decoded.token1 === quote)
      || (decoded.token0 === quote && decoded.token1 === token))) {
    return unknown("creation_tokens_mismatch");
  }
  const block = observed.block;
  if (log.blockNumber !== block.number) return unknown("creation_block_number_mismatch");
  if (log.blockHash.toLowerCase() !== block.hash.toLowerCase()) {
    return unknown("creation_block_hash_mismatch");
  }
  // A log time never replaces the header time; a conflicting optional time is
  // inconsistent evidence. A present undefined value is malformed, not absent.
  if ("timestampMs" in log && (!integer(log.timestampMs) || log.timestampMs !== block.timestampMs)) {
    return unknown("creation_timestamp_mismatch");
  }
  const createdAt: BlockReference = Object.freeze({
    number: block.number,
    hash: block.hash.toLowerCase() as BlockReference["hash"],
    timestampMs: block.timestampMs,
  });
  const evidence: CreationProof = Object.freeze({
    kind: "factory_pair_created",
    factory: expected.factory.toLowerCase() as Subject["factory"],
    createdAt,
    transactionHash: log.transactionHash.toLowerCase() as CreationProof["transactionHash"],
    logIndex: log.logIndex,
  });
  return Object.freeze({ kind: "verified", poolCreatedMs: createdAt.timestampMs, evidence });
}
