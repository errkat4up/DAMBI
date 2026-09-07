/**
 * `DecoderSource` 포트 — 셀렉터+체인으로 디코드 번들을 조회한다.
 *
 * R7: 코어가 물어보는 협력자. LRU / TTL / 스토리지 스키마 같은 캐시 구현 세부는
 * 이 포트 뒤의 호스트 책임이다 (declarative-v3-cache.ts).
 */

/**
 * 셀렉터+체인으로 디코드 번들을 조회하는 포트.
 *
 * 근거: `declarative-v3-cache.ts:211` `get(callkey)`,
 * `bundle-schema.ts:753-776` `V3BundleMatch` (selector = `"0x"` + 8 hex,
 * chain 키). 반환값은 코어가 opaque하게 소비하는 `V3Bundle` 상당물 — SW 계층도
 * 이 번들 형태를 모델링하지 않고 그대로 WASM에 넘긴다
 * (bundle-schema.ts:789-795 "pass-through at the SW layer").
 */
export interface DecoderSource {
  /**
   * @param selector `"0x"` + 8 hex (case-insensitive).
   * @param chainId  CAIP-2 문자열.
   * @returns 매칭되는 디코드 번들 (opaque), 없으면 `null`.
   *
   * 반환 타입의 `| null`은 `unknown`에 흡수되어 타입상 무의미하다
   * (`unknown | null === unknown`). 반환값이 없을 수 있다는 것은 이 주석이
   * 유일한 계약이다 — 구현자는 매칭 실패 시 반드시 `null`을 돌려줘야 한다.
   */
  load(selector: string, chainId: string): Promise<unknown | null>;
}
