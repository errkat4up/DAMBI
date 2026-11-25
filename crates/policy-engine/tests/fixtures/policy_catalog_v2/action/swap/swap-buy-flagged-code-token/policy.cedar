// blocks: buying a token whose contract has any of the listed code traits.
// why:    unverified source hides trap logic from every scanner; an upgradeable proxy can swap in such logic later.
// name_ko: 스왑으로 받을 토큰의 컨트랙트가 [소스 비공개] 상태일 경우 경고
// bucket: action/swap
// tags: bucket:action cat:swap enrichment method:token.security_flags action-family:swap
// methods: token.security_flags (policy-server, GoPlus token_security)
// blank: `_template` in manifest.json — the literal in the `when` clause is the default.
@id("swap-buy-flagged-code-token")
@severity("warn")
@reason("사려는 토큰의 컨트랙트가 설정한 위험 특성(소스 비공개 등)을 가지고 있습니다 — 진행 전에 확인하세요")
forbid(principal, action == Amm::Action::"Swap", resource)
when {
  context has custom
  && context.custom has tokenCodeTraits
  && context.custom.tokenCodeTraits.containsAny(["closed_source"])
};
