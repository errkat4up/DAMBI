// blocks: buying a token whose owner/admin holds any of the listed controls.
// why:    owner balance-change / ownership-takeback / mint backdoors let the deployer drain or dilute holders; reported even when ownership looks renounced.
// name_ko: 스왑으로 받을 토큰이 알려진 주요 토큰이 아니고, 소유자가 [잔고 변경, 소유권 회수] 권한을 가졌을 경우 경고
// bucket: action/swap
// tags: bucket:action cat:swap enrichment method:token.security_flags action-family:swap
// methods: token.security_flags (policy-server, GoPlus token_security)
// blank: `_template` in manifest.json — the literal in the `when` clause is the default.
@id("swap-buy-owner-privileged-token")
@severity("warn")
@reason("사려는 토큰의 소유자가 잔고 변경 같은 위험한 권한을 가지고 있습니다 — 진행 전에 확인하세요")
forbid(principal, action == Amm::Action::"Swap", resource)
when {
  context has custom
  && context.custom has tokenOwnerPrivileges
  && context.custom.tokenOwnerPrivileges.containsAny(["balance_change", "take_back_ownership"])
};
