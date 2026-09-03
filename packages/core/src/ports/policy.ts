/**
 * `PolicySource` 포트 + `SignedPolicyBundle`.
 *
 * R5: `fetch()`는 `Policy[]`가 아니라 **서명 포함 원본**을 반환한다. 서명 검증은
 * 코어 안에서만 한다 — 호스트가 "검증했다"고 주장하게 두면 신뢰 경계가 무너진다.
 */

/**
 * 서명 포함 원본 정책 번들.
 *
 * 근거: `bundle-verify.ts` 전체 — `verifyBundleSignature`가 detached ECDSA
 * P-256 서명을 **하드코딩된 알고리즘 + build-time 핀 키**로 검증한다. 번들의
 * `.sig`에 실린 `alg` / `key_id`는 "telemetry ONLY"이며 적대적 레지스트리가
 * 이걸로 알고리즘을 다운그레이드할 수 없다 (bundle-verify.ts:15-18, :189 — N2).
 */
export interface SignedPolicyBundle {
  /**
   * 서명 대상 payload (opaque). RFC 8785 JCS로 canonicalize되어 서명된다
   * (bundle-verify.ts:9-12). 구조를 공개하지 않는 이유: 통합사가 재직렬화하면
   * canonical form이 어긋나 서명 검증이 깨질 수 있다.
   */
  payload: unknown;
  /** detached 서명 (base64). */
  signature: string;
  /** 서명 키 식별자 — **telemetry 전용** (N2). 검증 경로에 영향을 주지 않는다. */
  keyId?: string;
}

/**
 * 서명 포함 원본을 가져오는 포트 (R5). `Policy[]`를 반환하지 않는다.
 */
export interface PolicySource {
  fetch(): Promise<SignedPolicyBundle>;
}
