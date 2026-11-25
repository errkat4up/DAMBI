// blocks: buying a token the feed reports as unsellable (honeypot) or whose sell tax is at or above the blank.
// why:    honeypot / prohibitive sell tax is the dominant code-level trap (most scam tokens by count); the buyer cannot exit.
// name_ko: 스왑으로 받을 토큰을 팔 수 없거나 매도세가 [100]% 이상일 경우 경고
// bucket: action/swap
// tags: bucket:action cat:swap enrichment method:token.security_flags action-family:swap
// methods: token.security_flags (policy-server, GoPlus token_security)
// blank: `_template` in manifest.json — the literal in the `when` clause is the default.
@id("swap-buy-unsellable-token")
@severity("warn")
@reason("사려는 토큰을 팔 수 없거나 매도세가 설정 한도 이상입니다 — 진행 전에 확인하세요")
forbid(principal, action == Amm::Action::"Swap", resource)
when {
  context has custom
  && ((context.custom has tokenIsHoneypot && context.custom.tokenIsHoneypot == true)
      || (context.custom has tokenSellTaxBps && context.custom.tokenSellTaxBps >= 10000))
};
