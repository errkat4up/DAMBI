// blocks: buying a token whose buy tax is at or above the blank.
// why:    a high buy tax silently takes part of the purchase; common on launch-trap tokens, rare on normal tokens above 10%.
// name_ko: 스왑으로 받을 토큰의 매수세가 [10]% 이상일 경우 경고
// bucket: action/swap
// tags: bucket:action cat:swap enrichment method:token.security_flags action-family:swap
// methods: token.security_flags (policy-server, GoPlus token_security)
// blank: `_template` in manifest.json — the literal in the `when` clause is the default.
@id("swap-buy-high-buy-tax")
@severity("warn")
@reason("사려는 토큰의 매수세가 설정 한도 이상입니다 — 진행 전에 확인하세요")
forbid(principal, action == Amm::Action::"Swap", resource)
when {
  context has custom
  && context.custom has tokenBuyTaxBps
  && context.custom.tokenBuyTaxBps >= 1000
};
