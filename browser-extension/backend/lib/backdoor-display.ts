/**
 * Display payload for the pool-backdoor warning. It is separate from
 * `ScamDisplay`, which is tied to the SDK's `ScamReport`.
 *
 * A payload exists only for a flagged pool: the check never shows anything for
 * a clear or undetermined result.
 */
export interface BackdoorDisplay {
  readonly version: 1;
  readonly kind: "pool_backdoor";
  readonly chainId: number;
  readonly token: string;
  readonly pool: string;
  /** Sender of the pair-creation transaction. */
  readonly deployer: string;
}

export const BACKDOOR_WARNING_TITLE = "풀 백도어 감지";
export const BACKDOOR_WARNING_TEXT =
  "이 풀을 만든 계정이 풀에 든 토큰을 임의로 옮길 수 있습니다.";

/** Delivered to the confirmation page through session storage, never in its URL. */
export const backdoorConfirmKey = (requestId: string): string =>
  `backdoor:confirm:${requestId}`;

export interface StoredBackdoorDisplay {
  readonly requestId: string;
  readonly expiresAtMs: number;
  readonly display: BackdoorDisplay;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;

/** Validate what the confirmation page read back from session storage. */
export function readStoredBackdoorDisplay(
  value: unknown,
  requestId: string,
  nowMs: number,
): BackdoorDisplay | undefined {
  if (!requestId || typeof value !== "object" || value === null) return undefined;
  const stored = value as Partial<StoredBackdoorDisplay>;
  const display = stored.display;
  if (
    stored.requestId !== requestId ||
    typeof stored.expiresAtMs !== "number" ||
    stored.expiresAtMs <= nowMs ||
    typeof display !== "object" ||
    display === null ||
    display.version !== 1 ||
    display.kind !== "pool_backdoor" ||
    !Number.isSafeInteger(display.chainId) ||
    ![display.token, display.pool, display.deployer].every(
      (a) => typeof a === "string" && ADDRESS.test(a),
    )
  ) {
    return undefined;
  }
  return {
    version: 1,
    kind: "pool_backdoor",
    chainId: display.chainId,
    token: display.token,
    pool: display.pool,
    deployer: display.deployer,
  };
}
