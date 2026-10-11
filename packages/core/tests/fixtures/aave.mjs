// Test-only calldata matching the Native aave_governance.rs / aave_umbrella.rs
// regressions, with no Registry runtime or ABI SDK dependency.
export const aaveSender = "0x000000000000000000000000000000000000aaaa";
export const aaveHelper = "0xce6ced23118edeb23054e06118a702797b13fc2f";
export const aaveStake = "0x3333333333333333333333333333333333333333";
export const aaveRewards = [
  "0x1111111111111111111111111111111111111111",
  "0x2222222222222222222222222222222222222222",
];
const OTHER = "0x000000000000000000000000000000000000bbbb";
const GOVERNANCE = "0x9aee0b04504cef83a65ac3f0e838d0593bcb2bc7";

export const aaveRoutes = [
  {
    id: "aave/governance/core/redeemCancellationFee@1.0.0",
    selector: "0x9043ffc3",
    to: GOVERNANCE,
  },
  {
    id: "aave/governance/core/updateRepresentativesForChain@1.0.0",
    selector: "0x133539ec",
    to: GOVERNANCE,
  },
  {
    id: "aave/umbrella/batch/claimRewardsPermit@1.0.0",
    selector: "0xa5fbb680",
    to: aaveHelper,
  },
];

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const words = (values) => values.map(word).join("");

function request(route, encodedArgs) {
  return {
    kind: "transaction", chainId: "eip155:1", from: aaveSender, to: route.to,
    data: route.selector + encodedArgs,
  };
}

function governanceRequest(route, entries) {
  // A single dynamic array starts at word 1. Each entry is either one uint256
  // or a fully static (address,uint256) tuple, so entries have no own offsets.
  return request(route, word(32) + word(entries.length) + entries.map(words).join(""));
}

function umbrellaRequest(nowMs, rewards, restake) {
  // The single dynamic tuple begins after the outer offset. Its rewards[]
  // starts after seven tuple-head words; its offset is relative to that tuple.
  const tuple = words([
    aaveStake, 7 * 32, BigInt(nowMs) / 1000n + 60n, 27, 0, 0, restake ? 1 : 0,
  ]) + word(rewards.length) + words(rewards);
  return request(aaveRoutes[2], word(32) + tuple);
}

export function aaveGovernanceCases() {
  const entries = [
    [[(1n << 256n) - 1n], [7n]],
    // The second chain ID is a precision probe, not a live deployment claim.
    [[OTHER, 10n], [aaveSender, 9_007_199_254_740_993n]],
  ];
  return aaveRoutes.slice(0, 2).map((route, index) => ({
    name: `${route.id}: ordered array with full-width integers`,
    route,
    request: governanceRequest(route, entries[index]),
    // Omit the precision-sensitive element so the test policy must allow it.
    controlRequest: governanceRequest(route, [entries[index][index === 0 ? 1 : 0]]),
  }));
}

export function aaveUmbrellaCases(nowMs) {
  return [false, true].map((restake) => ({
    name: `${aaveRoutes[2].id}: restake=${restake}`,
    route: aaveRoutes[2],
    request: umbrellaRequest(nowMs, aaveRewards, restake),
    restake,
    // A test-only policy observes the requested preference. This does not
    // assert restaking is unsafe, a valid permit, or successful execution.
    decision: restake ? "deny" : "allow",
  }));
}

export function aaveEmptyCases(nowMs) {
  return aaveRoutes.map((route, index) => ({
    name: `${route.id}: empty array`,
    route,
    request: index === 2
      ? umbrellaRequest(nowMs, [], true)
      : governanceRequest(route, []),
  }));
}
