// Test-only calldata matching crates/dambi-core/tests/universal_router.rs.
// These fixed layouts deliberately use no Registry runtime or ABI SDK dependency.
const SENDER = "0x000000000000000000000000000000000000aaaa";
const OTHER = "0x000000000000000000000000000000000000bbbb";
const TOKEN_IN = "0x1111111111111111111111111111111111111111";
const TOKEN_OUT = "0x2222222222222222222222222222222222222222";
const ROUTER = "0x66a9893cc07d91d95644aedd05d03f95e1dba8af";

export const universalRouterRoutes = [
  { id: "uniswap/universal-router/execute-v2@1.0.0", selector: "3593564c", deadline: true },
  { id: "uniswap/universal-router/execute-v2-no-deadline@1.0.0", selector: "24856bc3", deadline: false },
];

const word = (value) => BigInt(value).toString(16).padStart(64, "0");
const byteLength = (hex) => hex.length / 2;
const bytes = (hex) => word(byteLength(hex)) + hex.padEnd(Math.ceil(hex.length / 64) * 64, "0");

function bytesArray(values) {
  const tails = values.map(bytes);
  // Element offsets are relative to the array's tuple head AFTER its length.
  let offset = values.length * 32;
  const heads = tails.map((tail) => {
    const head = word(offset);
    offset += byteLength(tail);
    return head;
  });
  return word(values.length) + heads.join("") + tails.join("");
}

function commandsAndInputs(commands, inputs, deadline) {
  const encodedCommands = bytes(commands);
  const headBytes = deadline === undefined ? 64 : 96;
  return word(headBytes) + word(headBytes + byteLength(encodedCommands))
    + (deadline === undefined ? "" : word(deadline))
    + encodedCommands + bytesArray(inputs);
}

function v3Input(recipient) {
  const path = TOKEN_IN.slice(2) + "0001f4" + TOKEN_OUT.slice(2);
  // (address,uint256,uint256,bytes,bool): bytes path follows five head words.
  return word(recipient) + word(1000) + word(900) + word(160) + word(1) + bytes(path);
}

function v4Input(alternative) {
  // PathKey[] has one dynamic tuple: (address,uint24,int24,address,bytes).
  // Positive int24 tickSpacing=60 uses the same ABI word as uint24.
  const pathKey = word(TOKEN_OUT) + word(500) + word(60) + word(0) + word(160) + bytes("");
  const path = word(1) + word(32) + pathKey;
  const headBytes = alternative ? 128 : 160;
  const prices = word(1) + word(1); // Primary layout's uint256[] price limits.
  const tuple = word(TOKEN_IN) + word(headBytes)
    + (alternative ? "" : word(headBytes + byteLength(path)))
    + word(1000) + word(900) + path + (alternative ? "" : prices);
  // A single dynamic tuple parameter has its own leading offset.
  const swap = word(32) + tuple;
  return commandsAndInputs("07", [swap]);
}

export function universalRouterCases(nowMs) {
  return universalRouterRoutes.flatMap((route) => [
    { name: "V3 self", command: "00", input: v3Input(SENDER), decision: "allow" },
    { name: "V3 other", command: "00", input: v3Input(OTHER), decision: "deny" },
    { name: "V4 primary", command: "10", input: v4Input(false), decision: "allow" },
    { name: "V4 alternative", command: "10", input: v4Input(true), decision: "allow" },
  ].map(({ name, command, input, decision }) => ({
    name: `${route.id}: ${name}`,
    decision,
    request: {
      kind: "transaction", chainId: "eip155:1", from: SENDER, to: ROUTER,
      data: `0x${route.selector}${commandsAndInputs(command, [input], route.deadline ? BigInt(nowMs) / 1000n + 60n : undefined)}`,
    },
  })));
}
