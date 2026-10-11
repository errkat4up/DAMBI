// Regression-only raw calldata for the three pinned B2 source contexts.
// These requests describe decoder inputs, not executable trades or live quotes.
export const poolSender = "0x000000000000000000000000000000000000aaaa";
export const poolOther = "0x000000000000000000000000000000000000bbbb";
export const poolAmount = 9_007_199_254_740_993n;
export const poolTokens = {
  usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
  rlusd: "0x8292bb45bf1ee4d140127049757c2e0ff06317ed",
  weth: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
  token0: "0x87c9053c819bb28e0d73d33059e1b3da80afb0cf",
};
export const balancerPool = "0xda66e8ddf9959e4db759bfd06256730d8a8b2d13";
export const poolRoutes = [
  {
    id: "curve/stableswap-ng/source/factory-stable-ng-2coin-mainnet/exchange/1-factory-stable-ng-327-d001ae43@1.0.0",
    selector: "0x3df02124", to: "0xd001ae433f254283fece51d4acce8c53263aa186",
  },
  {
    id: "balancer/v3/router-add-liquidity-proportional/v2-mainnet@1.0.0",
    selector: "0x724dba33", to: "0xae563e3f8219521950555f5962419c8919758ea2",
  },
  {
    id: "uniswap/v3-pool/swap/1-v3-pool-2c40c7b9@1.0.0",
    selector: "0x128acb08", to: "0x2c40c7b9f106f39a6e2aab6d9f1f29364e7250bc",
  },
];

const word = (value) => BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, "0");
const words = (values) => values.map(word).join("");
function request(route, args) {
  return {
    kind: "transaction", chainId: "eip155:1", from: poolSender, to: route.to,
    data: route.selector + args, value: "0",
  };
}

export function curvePoolRequest(i = 0, j = 1, amount = poolAmount) {
  return request(poolRoutes[0], words([i, j, amount, 900]));
}

export function curvePoolCases() {
  return [
    { name: "USDC to RLUSD", i: 0, j: 1, tokenIn: poolTokens.usdc, tokenOut: poolTokens.rlusd },
    { name: "RLUSD to USDC", i: 1, j: 0, tokenIn: poolTokens.rlusd, tokenOut: poolTokens.usdc },
  ].map(({ i, j, ...scenario }) => ({
    ...scenario,
    request: curvePoolRequest(i, j),
    controlRequest: curvePoolRequest(i, j, poolAmount - 1n),
  }));
}

export function balancerPoolRequest({ pool = balancerPool, amounts = [poolAmount, 7n], wethIsEth = false } = {}) {
  // Five head words; maxAmountsIn[] precedes empty userData bytes. Both offsets
  // are relative to the argument block immediately following the selector.
  const array = words([amounts.length, ...amounts]);
  return request(poolRoutes[1], words([
    pool, 5 * 32, 9, wethIsEth ? 1 : 0, (6 + amounts.length) * 32,
  ]) + array + word(0));
}

export function uniswapPoolRequest({ amount = poolAmount, zeroForOne = true, recipient = poolSender, sqrtPriceLimitX96 = 1n << 96n } = {}) {
  // int256 is encoded as a full two's-complement word. Empty callback bytes
  // start at word five; sqrtPriceLimitX96 is deliberately not a live quote.
  return request(poolRoutes[2], words([
    recipient, zeroForOne ? 1 : 0, amount, sqrtPriceLimitX96, 5 * 32, 0,
  ]));
}

export function uniswapPoolCases() {
  return [
    { name: "positive amount / token0 to USDC", amount: poolAmount, zeroForOne: true,
      kind: "exact_input", tokenIn: poolTokens.token0, tokenOut: poolTokens.usdc },
    { name: "negative amount / USDC to token0", amount: -poolAmount, zeroForOne: false,
      kind: "exact_output", tokenIn: poolTokens.usdc, tokenOut: poolTokens.token0 },
  ].map(({ amount, zeroForOne, ...scenario }) => ({
    ...scenario,
    request: uniswapPoolRequest({ amount, zeroForOne }),
    controlRequest: uniswapPoolRequest({ amount: amount > 0n ? amount - 1n : amount + 1n, zeroForOne }),
    otherRecipientRequest: uniswapPoolRequest({ amount, zeroForOne, recipient: poolOther }),
  }));
}
