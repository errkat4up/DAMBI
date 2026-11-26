/**
 * F4 fixed publisher: Foundry ABI codec + JSON-RPC + the existing P-256 signer.
 * No HTTP/GCS counter is read or written. Persist the prepared intent and reuse
 * it on retries; never prepare a new sequence merely because submission timed out.
 *
 * Registry ABI: PolicyRegistry.sol. Scope = SHA256(abi.encode(chainId, registry,
 * env, profile)). Signed registry_ref = dambi:policy-registry:<decimal chainId>:
 * <lowercase address> (without the line break); env/profile remain signed fields.
 * This is a publisher/adapter handoff, not an SDK enablement switch: the supplied
 * Core baseline intentionally rejects non-null registry_ref. F1/F5 must consume
 * this binding and the distinct active/superseded/revoked/unavailable states.
 * HTTP publication and its 72-hour consumer default are unchanged.
 *
 * Requires the pinned Foundry installation used by contracts/policy-registry.
 * cast is used ONLY for local ABI encoding/decoding, never RPC or signing.
 *
 * CLI (via the repository's TS runner):
 *   publish-onchain-policy.ts prepare config.json intent.json <expiresUnixSec>
 *   publish-onchain-policy.ts publish config.json intent.json wallet-module.mjs
 * The wallet module exports submit(tx): Promise<transactionHash>. It is a trusted
 * operator-supplied source interface, not a key selected by a policy response.
 * A hash sidecar is written before waiting for a receipt. Unknown submission
 * outcomes are surfaced; rerun the SAME intent to reconcile or retry safely.
 *
 * Implementation candidate only: execution, QA, independent review, GIWA gas and
 * finality support/delay acceptance remain pending. No measured results included.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import canonicalize from "canonicalize";
import { p256 } from "@noble/curves/nist.js";
import {
  loadPolicies, signPayload, MAX_SEQUENCE,
  type BundlePayload, type PublishOptions, type SignedPolicyBundle,
} from "./publish-policy-bundle.js";

export interface RegistryConfig {
  rpcUrl: string;
  network: "local" | "giwa";
  registry: string;
  sender: string;
  env: "staging" | "production";
  profile: string;
  finality: "safe" | "finalized";
  /** Locally pinned SEC1 P-256 point. key_id does not select this key. */
  trustedPublicKeyHex: string;
}
export interface Intent { expectedCurrent: number; signed: SignedPolicyBundle }
export interface Transaction {
  chainId: number;
  from: string;
  to: string;
  data: string;
  value: "0x0";
  gas: string;
}
export interface RecordValue {
  head: number;
  status: 0 | 1 | 2 | 3;
  digest: string;
  payload: string;
  signature: string;
  keyId: string;
}
export interface Receipt {
  transactionHash: string;
  blockHash: string;
  blockNumber: string;
  status: string;
  to: string;
  gasUsed: string;
}
export type Submit = (tx: Transaction) => Promise<string>;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const HEX = /^0x(?:[0-9a-fA-F]{2})*$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const ZERO = "0x" + "0".repeat(40);
const PUBLISH = "publish(bytes32,uint256,uint256,bytes32,bytes,bytes,string)";
const READ = "read(bytes32,uint256)(uint256,uint8,bytes32,bytes,bytes,string)";
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export function abi(command: "calldata" | "abi-encode", signature: string, args: string[]): string {
  const out = execFileSync("cast", [command, signature, ...args], {
    encoding: "utf8", maxBuffer: 2_000_000, timeout: 10_000,
  }).trim();
  if (!HEX.test(out)) throw new Error("invalid ABI encoder output");
  return out;
}
function decode(signature: string, encoded: string): unknown[] {
  if (!HEX.test(encoded) || encoded.length > 200_000) throw new Error("invalid ABI response");
  const out: unknown = JSON.parse(execFileSync("cast", ["abi-decode", signature, encoded, "--json"], {
    encoding: "utf8", maxBuffer: 2_000_000, timeout: 10_000,
  }));
  if (!Array.isArray(out)) throw new Error("invalid ABI decoder output");
  return out;
}
export function sha256(bytes: Uint8Array): string {
  return "0x" + createHash("sha256").update(bytes).digest("hex");
}
export function safeSequence(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("unsafe sequence");
  if (typeof value === "string" && !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("unsafe sequence");
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_SEQUENCE) throw new Error("unsafe sequence");
  return n;
}
function quantity(value: unknown): bigint {
  if (typeof value !== "string" || !QUANTITY.test(value)) throw new Error("invalid RPC quantity");
  return BigInt(value);
}
function bytes(value: unknown): Buffer {
  if (typeof value !== "string" || !HEX.test(value)) throw new Error("invalid RPC bytes");
  return Buffer.from(value.slice(2), "hex");
}
function text(value: unknown): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes(value));
}
function hex(value: string): string { return "0x" + Buffer.from(value, "utf8").toString("hex"); }
function address(value: string): string {
  if (!ADDRESS.test(value) || value.toLowerCase() === ZERO) throw new Error("invalid address");
  return value.toLowerCase();
}
export function registryReference(config: RegistryConfig): string {
  return `dambi:policy-registry:${config.network === "local" ? 31337 : 91342}:${address(config.registry)}`;
}
export function scopeId(config: RegistryConfig): string {
  return sha256(bytes(abi("abi-encode", "scope(uint256,address,string,string)", [
    String(config.network === "local" ? 31337 : 91342), address(config.registry), config.env, config.profile,
  ])));
}

export class RegistryClient {
  readonly config: RegistryConfig;
  readonly chainId: number;
  private id = 0;
  constructor(config: RegistryConfig, private readonly fetchImpl: typeof fetch = fetch) {
    const url = new URL(config.rpcUrl);
    const local = ["127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.hash) throw new Error("invalid RPC URL");
    if (config.network === "local") {
      if (!local || url.protocol !== "http:") throw new Error("local RPC must be literal loopback HTTP");
    } else if (config.network !== "giwa" || url.protocol !== "https:") {
      throw new Error("external RPC must use explicit GIWA HTTPS configuration");
    }
    if (!["staging", "production"].includes(config.env) || !/^[a-z0-9-]+$/.test(config.profile)
        || !["safe", "finalized"].includes(config.finality)) throw new Error("invalid scope/finality");
    if (!/^(?:02|03)[0-9a-fA-F]{64}$|^04[0-9a-fA-F]{128}$/.test(config.trustedPublicKeyHex)) {
      throw new Error("explicit P-256 trust point required");
    }
    this.config = Object.freeze({ ...config, registry: address(config.registry), sender: address(config.sender) });
    this.chainId = config.network === "local" ? 31337 : 91342;
  }

  async rpc<T>(method: string, params: unknown[]): Promise<T> {
    const id = ++this.id;
    const response = await this.fetchImpl(this.config.rpcUrl, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
    const body = await response.text();
    if (Buffer.byteLength(body) > 2_000_000) throw new Error("RPC response too large");
    const reply = JSON.parse(body) as { jsonrpc?: string; id?: number; error?: unknown; result?: T };
    if (reply.jsonrpc !== "2.0" || reply.id !== id || reply.error !== undefined || !("result" in reply)) {
      throw new Error(`RPC ${method} unavailable/rejected`);
    }
    return reply.result as T;
  }

  async guard(): Promise<void> {
    if (quantity(await this.rpc("eth_chainId", [])) !== BigInt(this.chainId)) {
      throw new Error("RPC chain ID mismatch: refused before signing/submission");
    }
    const code = bytes(await this.rpc("eth_getCode", [this.config.registry, "latest"]));
    if (code.length === 0) throw new Error("registry has no code");
    const encoded = await this.rpc<string>("eth_call", [{
      to: this.config.registry, data: abi("calldata", "publisher()", []),
    }, "latest"]);
    const [owner] = decode("publisher()(address)", encoded);
    if (typeof owner !== "string" || owner.toLowerCase() !== this.config.sender) {
      throw new Error("sender is not current publisher");
    }
  }

  async read(sequence = 0, block = "latest"): Promise<RecordValue> {
    const encoded = await this.rpc<string>("eth_call", [{
      to: this.config.registry,
      data: abi("calldata", "read(bytes32,uint256)", [scopeId(this.config), String(safeSequence(sequence))]),
    }, block]);
    const [head, status, digest, payload, signature, keyId] = decode(READ, encoded);
    const s = safeSequence(status);
    if (s > 3 || typeof digest !== "string" || !HASH.test(digest) || typeof keyId !== "string") {
      throw new Error("invalid registry record");
    }
    const result: RecordValue = {
      head: safeSequence(head), status: s as RecordValue["status"], digest: digest.toLowerCase(),
      payload: text(payload), signature: bytes(signature).toString("base64"), keyId,
    };
    if (s !== 0 && sha256(Buffer.from(result.payload)) !== result.digest) throw new Error("registry digest mismatch");
    return result;
  }
}

export function validateIntent(client: RegistryClient, intent: Intent, now = Math.floor(Date.now() / 1000)): BundlePayload {
  const { signed } = intent;
  const payload = JSON.parse(signed.payload) as BundlePayload;
  // The tool accepts its own JCS output only. This also rejects duplicate-member
  // input on resume instead of signing/verifying a lossy JSON.parse projection.
  if (canonicalize(payload) !== signed.payload
      || Object.keys(payload).sort().join(",") !== "env,expires_at,issued_at,policies,profile,registry_ref,sequence") {
    throw new Error("intent must contain the original canonical payload");
  }
  const sequence = safeSequence(payload.sequence);
  if (sequence === 0 || safeSequence(intent.expectedCurrent) !== sequence - 1) throw new Error("sequence mismatch");
  if (payload.registry_ref !== registryReference(client.config) || payload.env !== client.config.env
      || payload.profile !== client.config.profile) throw new Error("signed scope mismatch");
  if (!Number.isSafeInteger(payload.issued_at) || payload.issued_at < 0 || payload.issued_at > now
      || !Number.isSafeInteger(payload.expires_at) || payload.expires_at === null
      || payload.expires_at <= payload.issued_at || payload.expires_at <= now) throw new Error("invalid/expired lifetime");
  if (!Array.isArray(payload.policies) || payload.policies.length === 0) throw new Error("empty policies");
  const ids = new Set<string>();
  for (const entry of payload.policies) {
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id)
        || typeof entry.policy !== "string" || !entry.policy.trim()
        || !entry.manifest || entry.manifest.id !== entry.id || entry.manifest.schema_version !== 2) {
      throw new Error("invalid policy entry");
    }
    ids.add(entry.id);
  }
  const raw = Buffer.from(signed.payload, "utf8");
  const sig = Buffer.from(signed.signature, "base64");
  if (raw.length > 32_768 || sig.length !== 64 || sig.toString("base64") !== signed.signature
      || typeof signed.key_id !== "string" || Buffer.byteLength(signed.key_id) > 256) throw new Error("invalid bundle encoding/size");
  if (!p256.verify(sig, bytes(sha256(raw)), Buffer.from(client.config.trustedPublicKeyHex, "hex"), {
    prehash: false, lowS: false,
  })) throw new Error("invalid policy signature");
  return payload;
}

export async function prepareOnchainPolicy(client: RegistryClient, options: {
  repoRoot: string; set?: string; issuedAt?: number; expiresAt: number; signing: PublishOptions;
}): Promise<Intent> {
  await client.guard(); // before loading a signing key or invoking KMS
  const current = await client.read();
  if (current.head === MAX_SEQUENCE) throw new Error("sequence exhausted");
  const payload: BundlePayload = {
    policies: loadPolicies(options.repoRoot, options.set ?? "day1-safety"),
    sequence: current.head + 1,
    issued_at: options.issuedAt ?? Math.floor(Date.now() / 1000),
    expires_at: options.expiresAt,
    env: client.config.env, profile: client.config.profile,
    registry_ref: registryReference(client.config),
  };
  if (!Number.isSafeInteger(payload.expires_at) || payload.expires_at === null
      || payload.expires_at <= payload.issued_at) throw new Error("explicit expiry required");
  const signed = await signPayload(payload, options.signing);
  const intent = { expectedCurrent: current.head, signed };
  validateIntent(client, intent);
  return intent;
}

export function publicationData(client: RegistryClient, intent: Intent): string {
  const payload = validateIntent(client, intent);
  return abi("calldata", PUBLISH, [scopeId(client.config), String(intent.expectedCurrent), String(payload.sequence),
    sha256(Buffer.from(intent.signed.payload)), hex(intent.signed.payload),
    "0x" + Buffer.from(intent.signed.signature, "base64").toString("hex"), intent.signed.key_id]);
}
function matches(record: RecordValue, intent: Intent): boolean {
  return record.payload === intent.signed.payload && record.signature === intent.signed.signature
    && record.keyId === intent.signed.key_id && record.digest === sha256(Buffer.from(intent.signed.payload));
}
function assertActive(record: RecordValue, sequence: number, intent: Intent): void {
  if (record.status === 3) throw new Error("POLICY_REVOKED");
  if (record.status === 2 || record.head > sequence) throw new Error("POLICY_SUPERSEDED");
  if (record.status !== 1 || record.head !== sequence || !matches(record, intent)) throw new Error("publication conflict");
}

export async function publishOnchainPolicy(client: RegistryClient, intent: Intent, submit: Submit, options: {
  transactionHash?: string;
  onSubmitted?: (hash: string) => Promise<void> | void;
  attempts?: number;
  pollMs?: number;
} = {}): Promise<{ outcome: "confirmed" | "reconciled"; receipt?: Receipt; blockNumber: string; blockHash: string }> {
  await client.guard();
  const payload = validateIntent(client, intent);
  const sequence = payload.sequence;
  const data = publicationData(client, intent);
  const attempts = options.attempts ?? 60;
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 120 || !Number.isInteger(pollMs)
      || pollMs < 0 || pollMs > 10_000) throw new Error("invalid bounded polling configuration");
  let hash = options.transactionHash;
  if (hash !== undefined && !HASH.test(hash)) throw new Error("invalid resume transaction hash");
  const current = await client.read(sequence);
  if (current.status !== 0) assertActive(current, sequence, intent);
  else if (current.head !== intent.expectedCurrent) throw new Error("publication conflict");

  if (!hash && current.status === 0) {
    const tx = { from: client.config.sender, to: client.config.registry, data, value: "0x0" as const };
    // Simulation is not a reservation: Solidity CAS still arbitrates races.
    await client.rpc("eth_call", [tx, "latest"]);
    const estimate = quantity(await client.rpc("eth_estimateGas", [tx]));
    await client.guard();
    hash = await submit({ ...tx, chainId: client.chainId, gas: "0x" + ((estimate * 12n + 9n) / 10n).toString(16) });
    if (!HASH.test(hash)) throw new Error("submission outcome unknown: invalid transaction hash; reuse intent");
    await options.onSubmitted?.(hash);
  }

  let receipt: Receipt | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // RPC errors remain errors, never revocation and never successful retries.
    if (hash && !receipt) {
      const found = await client.rpc<Receipt | null>("eth_getTransactionReceipt", [hash]);
      if (found) {
        if (found.transactionHash.toLowerCase() !== hash.toLowerCase() || found.status !== "0x1"
            || found.to?.toLowerCase() !== client.config.registry || !HASH.test(found.blockHash)) {
          throw new Error("transaction receipt failed/mismatched");
        }
        quantity(found.blockNumber);
        quantity(found.gasUsed);
        const transaction = await client.rpc<{ from: string; to: string; input: string; chainId: string } | null>(
          "eth_getTransactionByHash", [hash],
        );
        if (!transaction || transaction.from.toLowerCase() !== client.config.sender
            || transaction.to.toLowerCase() !== client.config.registry || transaction.input.toLowerCase() !== data.toLowerCase()
            || quantity(transaction.chainId) !== BigInt(client.chainId)) throw new Error("receipt transaction mismatch");
        receipt = found;
      }
    }
    const block = await client.rpc<{ number: string; hash: string } | null>(
      "eth_getBlockByNumber", [client.config.finality, false],
    );
    if (!block || !HASH.test(block.hash)) throw new Error("configured finality unavailable");
    const height = quantity(block.number);
    if ((!hash || receipt) && (!receipt || height >= quantity(receipt.blockNumber))) {
      if (receipt) {
        const inclusion = await client.rpc<{ hash: string } | null>("eth_getBlockByNumber", [receipt.blockNumber, false]);
        if (!inclusion || inclusion.hash.toLowerCase() !== receipt.blockHash.toLowerCase()) throw new Error("receipt reorged");
      }
      const confirmed = await client.read(sequence, block.number);
      if (confirmed.status !== 0) {
        assertActive(confirmed, sequence, intent);
        // Protect the number-pinned read against a reorg during the RPC sequence.
        const again = await client.rpc<{ hash: string } | null>("eth_getBlockByNumber", [block.number, false]);
        if (!again || again.hash !== block.hash) throw new Error("confirmation block changed");
        return { outcome: receipt ? "confirmed" : "reconciled", receipt, blockNumber: block.number, blockHash: block.hash };
      }
    }
    if (attempt + 1 < attempts) await delay(pollMs);
  }
  throw new Error("confirmation pending: retain transaction hash and reuse the same intent");
}

async function main(argv: string[]): Promise<void> {
  const [command, configPath, intentPath, extra] = argv;
  if (argv.length !== 4 || !["prepare", "publish"].includes(command ?? "")) {
    throw new Error("usage: prepare config intent expiresUnixSec | publish config intent walletModule");
  }
  const client = new RegistryClient(JSON.parse(readFileSync(configPath!, "utf8")) as RegistryConfig);
  await client.guard();
  if (command === "prepare") {
    const intent = await prepareOnchainPolicy(client, {
      repoRoot: fileURLToPath(new URL("../../", import.meta.url)),
      expiresAt: safeSequence(extra), signing: {},
    });
    writeFileSync(intentPath!, JSON.stringify(intent, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    console.log(JSON.stringify({ outcome: "prepared", sequence: JSON.parse(intent.signed.payload).sequence }));
    return;
  }
  const intent = JSON.parse(readFileSync(intentPath!, "utf8")) as Intent;
  validateIntent(client, intent);
  const hashPath = intentPath + ".txhash";
  const transactionHash = existsSync(hashPath) ? readFileSync(hashPath, "utf8").trim() : undefined;
  // Load the trusted signing integration only after checking the actual chain.
  const wallet = await import(pathToFileURL(resolve(extra!)).href) as { submit: Submit };
  if (typeof wallet.submit !== "function") throw new Error("wallet module must export submit");
  const result = await publishOnchainPolicy(client, intent, wallet.submit, {
    transactionHash,
    onSubmitted(hash) { writeFileSync(hashPath, hash + "\n", { flag: "wx", mode: 0o600 }); },
  });
  console.log(JSON.stringify(result));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "publication failed");
    process.exitCode = 1;
  });
}
