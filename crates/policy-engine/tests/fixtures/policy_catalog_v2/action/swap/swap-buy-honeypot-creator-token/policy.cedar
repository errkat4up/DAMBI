// blocks: buying a token whose creator has deployed a honeypot before and still holds at least the blank share of supply.
// why:    repeat deployers are the strongest single predictor of a new scam; a creator still holding supply can dump it.
// name_ko: 스왑으로 받을 토큰의 배포자가 honeypot을 만든 적이 있고 공급의 [0]% 이상을 보유했을 경우 경고
// bucket: action/swap
// tags: bucket:action cat:swap enrichment method:token.security_flags action-family:swap
// methods: token.security_flags (policy-server, GoPlus token_security)
// blank: `_template` in manifest.json — the literal in the `when` clause is the default.
@id("swap-buy-honeypot-creator-token")
@severity("warn")
@reason("사려는 토큰의 배포자가 이전에 팔 수 없는 토큰(honeypot)을 만든 적이 있습니다 — 진행 전에 확인하세요")
forbid(principal, action == Amm::Action::"Swap", resource)
when {
  context has custom
  && context.custom has tokenSameCreatorHoneypot
  && context.custom.tokenSameCreatorHoneypot == true
  && context.custom has tokenCreatorHoldBps
  && context.custom.tokenCreatorHoldBps >= 0
};
