import type { Address } from "viem";

export function walletAddress(value: unknown): value is Address {
  return typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/** Parse a decimal integer or explicit 0x quantity without rounding through Number. */
export function walletQuantity(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value >= 0n ? value : undefined;
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined;
  }
  if (typeof value !== "string" || !/^(?:[0-9]+|0x[0-9a-f]+)$/i.test(value)) return undefined;
  return BigInt(value);
}

export function walletChainId(value: unknown): number | undefined {
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const id = walletQuantity(value);
  return id !== undefined && id > 0n && id <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(id) : undefined;
}

export function signatureFields(
  method: string,
  params: readonly unknown[],
): { address?: Address; message: unknown } {
  const [first, second] = params;
  // personal_sign is [message, signer]; eth_sign and typed methods are
  // [signer, message]. When both are addresses, the method's order wins.
  if (second === undefined || second === null) {
    return {
      message: method !== "personal_sign" && walletAddress(first)
        ? undefined
        : first,
    };
  }
  const [signer, message] = method === "personal_sign"
    ? [second, first]
    : [first, second];
  if (walletAddress(signer)) return { address: signer, message };
  // Tolerate the reversed two-parameter form only when there is one address
  // and an actual other payload, never promote a lone message to a signer.
  if (signer !== undefined && signer !== null && walletAddress(message)) {
    return { address: message, message: signer };
  }
  return { message: method === "personal_sign" ? first : second };
}
