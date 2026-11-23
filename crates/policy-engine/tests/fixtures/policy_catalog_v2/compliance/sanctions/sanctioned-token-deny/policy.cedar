// blocks: an ERC-20 transfer, an ERC-20 approval, or a swap that involves a token whose transactions are prohibited by sanctions (A7A5 / wA7A5).
// why:    token-level sanction — the EU 19th Russia sanctions package prohibits any transaction involving the ruble-backed A7A5 stablecoin, so the token itself (not the counterparty) is the bind-site. (Council Regulation (EU) No 833/2014 as amended by the 19th package — article and effective date to be confirmed against the Official Journal.)
// name_ko: 제재로 거래가 금지된 토큰을 거래할 시 차단
// bucket: compliance/sanctions
// tags: bucket:compliance cat:sanctions static could-be-compliance:true action-family:transfer action-family:approve action-family:swap
// blank: `_template` in manifest.json — the literal set appears three times in the `when` clause (transferred/approved token, sold token, bought token); keep all copies identical.
//
// Pure-static (no enrichment). The action scope is left open because Cedar cannot
// mix Token:: and Amm:: actions in one `action in [...]`; the manifest trigger limits
// it to transfer / approve / swap, and each branch is guarded with `has`, so only the
// token fields an action actually carries are screened. `tokenOut` is absent for
// pool-read-required swaps, where only the sold token is screened.
@id("sanctioned-token-deny")
@severity("deny")
@reason("EU 제재로 거래가 금지된 토큰(A7A5)이 포함된 거래입니다 - 서명을 차단했습니다")
forbid(principal, action, resource)
when {
  (context has token
   && context.token.key has address
   && ["0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
       "0xf442ff10b8def89514560a66c0ad28777094636a"].contains(context.token.key.address))
  || (context has tokenIn
      && context.tokenIn.key has address
      && ["0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
          "0xf442ff10b8def89514560a66c0ad28777094636a"].contains(context.tokenIn.key.address))
  || (context has tokenOut
      && context.tokenOut.key has address
      && ["0x6fa0be17e4bea2fcfa22ef89bf8ac9aab0ab0fc9",
          "0xf442ff10b8def89514560a66c0ad28777094636a"].contains(context.tokenOut.key.address))
};
