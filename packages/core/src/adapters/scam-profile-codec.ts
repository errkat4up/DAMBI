import type { Address, AdminEventKind } from "../types/scam.js";
import { hash, type RpcLog } from "./scam-rpc-codec.js";

// Exact standard event encodings only; recognizing a topic does not establish
// that an arbitrary token implements the capability or has complete coverage.
// ABI sources (also mirrored by the local across/1inch surface ABIs):
// https://github.com/Uniswap/v2-core/blob/master/contracts/interfaces/IUniswapV2Factory.sol
// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/access/Ownable.sol
// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/interfaces/IERC1967.sol
// https://github.com/OpenZeppelin/openzeppelin-contracts/blob/v5.0.2/contracts/utils/Pausable.sol
// Topics are Keccak-256 of canonical signatures. PairCreated also matches the
// recorded factory receipt in fixtures/sdk/giwa-sf0/rpc-evidence.json.
export const PAIR_CREATED_TOPIC = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
export const ADMIN_EVENT_TOPICS: Readonly<Record<AdminEventKind, `0x${string}`>> = Object.freeze({
  owner_changed: "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
  proxy_upgraded: "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
  admin_changed: "0x7e644d79422f17c01e4894b5f4f588d331ebfa28653d42ae832dc59e38c9798f",
  paused: "0x62e78cea01bee320cd4e420270b5ea74000d11b0c9f74754ebdbfc544b05a258",
  unpaused: "0x5db9ee0a495bf2e6ff9c91a7834c1ba4fdd244a5e8aa4e537bd38aeae4b073aa",
});

function encoded(log: RpcLog): boolean {
  return log !== null && typeof log === "object"
    && Array.isArray(log.topics) && log.topics.length > 0 && log.topics.every(hash)
    && typeof log.data === "string" && /^0x(?:[0-9a-fA-F]{2})*(?![\s\S])/.test(log.data);
}

function addressWord(value: string, nonzero = false): Address | undefined {
  if (!/^0x0{24}[0-9a-fA-F]{40}(?![\s\S])/.test(value)) return undefined;
  const address = `0x${value.slice(26).toLowerCase()}` as Address;
  return nonzero && BigInt(address) === 0n ? undefined : address;
}

function dataWord(data: string, index: number): `0x${string}` {
  return `0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`;
}

export function decodePairCreated(log: RpcLog): {
  readonly token0: Address;
  readonly token1: Address;
  readonly pair: Address;
  readonly pairCount: string;
} | undefined {
  if (!encoded(log) || log.topics.length !== 3
      || log.topics[0]!.toLowerCase() !== PAIR_CREATED_TOPIC || log.data.length !== 130) return undefined;
  const token0 = addressWord(log.topics[1]!, true);
  const token1 = addressWord(log.topics[2]!, true);
  const pair = addressWord(dataWord(log.data, 0), true);
  if (token0 === undefined || token1 === undefined || pair === undefined) return undefined;
  // The exact two-word data length bounds the final uint256 before BigInt.
  return Object.freeze({ token0, token1, pair, pairCount: BigInt(dataWord(log.data, 1)).toString() });
}

export function decodeAdminEvent(log: RpcLog): AdminEventKind | undefined {
  if (!encoded(log)) return undefined;
  const topic = log.topics[0]!.toLowerCase();
  if (topic === ADMIN_EVENT_TOPICS.owner_changed) {
    return log.topics.length === 3 && log.data === "0x"
      && addressWord(log.topics[1]!) !== undefined && addressWord(log.topics[2]!) !== undefined
      ? "owner_changed" : undefined;
  }
  if (topic === ADMIN_EVENT_TOPICS.proxy_upgraded) {
    return log.topics.length === 2 && log.data === "0x"
      && addressWord(log.topics[1]!) !== undefined ? "proxy_upgraded" : undefined;
  }
  if (topic === ADMIN_EVENT_TOPICS.admin_changed) {
    return log.topics.length === 1 && log.data.length === 130
      && addressWord(dataWord(log.data, 0)) !== undefined && addressWord(dataWord(log.data, 1)) !== undefined
      ? "admin_changed" : undefined;
  }
  if (topic === ADMIN_EVENT_TOPICS.paused || topic === ADMIN_EVENT_TOPICS.unpaused) {
    if (log.topics.length !== 1 || log.data.length !== 66
        || addressWord(dataWord(log.data, 0)) === undefined) return undefined;
    return topic === ADMIN_EVENT_TOPICS.paused ? "paused" : "unpaused";
  }
  return undefined;
}
