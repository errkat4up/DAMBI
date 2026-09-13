// Development fixtures only. The keys under examples/ are public test material,
// never SDK defaults or production trust anchors.
import { readFileSync } from "node:fs";
import { sign } from "node:crypto";

const read = name => JSON.parse(readFileSync(new URL(`./examples/${name}`, import.meta.url), "utf8"));
export const example = read("day1.envelope.json");
export const testKeys = read("test-only-keys.json");
export const validationContext = {
  now: 1800000000,
  env: "fixture",
  profile: "day1-safety",
  accepted_sequence: "41",
};

const clone = value => structuredClone(value);
const base = () => JSON.parse(example.payload);

function signed(payload, role = "policy") {
  const key = testKeys[role];
  const bytes = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  return {
    payload: bytes,
    sig: {
      alg: "ECDSA_P256_SHA256",
      key_id: key.key_id,
      sig_b64: sign("sha256", Buffer.from(bytes, "utf8"), {
        key: key.private_key_pkcs8_pem,
        dsaEncoding: "ieee-p1363",
      }).toString("base64"),
    },
  };
}

// Each case keeps a complete reviewable envelope in memory. Semantically invalid
// payloads are signed correctly so C3 can eventually isolate the intended error.
export function contractCases() {
  const cases = [{ id: "day1", layer: "valid", envelope: clone(example), signature: true }];
  const noExpiry = base();
  noExpiry.expires_at = null;
  cases.push({ id: "null-expiry", layer: "valid", envelope: signed(noExpiry), signature: true });
  const addStructure = (id, edit) => {
    const envelope = clone(example);
    edit(envelope);
    cases.push({ id, layer: "structure", envelope });
  };
  const editPayload = edit => envelope => {
    const payload = JSON.parse(envelope.payload);
    edit(payload);
    envelope.payload = JSON.stringify(payload, null, 2);
  };

  addStructure("payload-object", envelope => { envelope.payload = base(); });
  addStructure("invalid-payload-json", envelope => { envelope.payload = "{"; });
  addStructure("payload-null", envelope => { envelope.payload = "null"; });
  addStructure("missing-signature", envelope => { delete envelope.sig; });
  addStructure("wrong-algorithm", envelope => { envelope.sig.alg = "none"; });
  addStructure("signature-trailing-newline", envelope => { envelope.sig.sig_b64 += "\n"; });
  addStructure("signature-wrong-length", envelope => { envelope.sig.sig_b64 = "AA=="; });
  addStructure("missing-required-field", editPayload(payload => { delete payload.expires_at; }));
  addStructure("empty-policies", editPayload(payload => { payload.policies = []; }));
  addStructure("missing-manifest", editPayload(payload => { delete payload.policies[0].manifest; }));
  addStructure("empty-manifest", editPayload(payload => { payload.policies[0].manifest = {}; }));
  addStructure("manifest-wrong-type", editPayload(payload => { payload.policies[0].manifest = []; }));
  addStructure("manifest-wrong-version", editPayload(payload => { payload.policies[0].manifest.schema_version = 1; }));
  addStructure("payload-wrong-version", editPayload(payload => { payload.schema_version = 2; }));
  addStructure("non-null-registry-ref", editPayload(payload => { payload.registry_ref = "remote-root"; }));
  addStructure("sequence-number", editPayload(payload => { payload.sequence = 42; }));
  addStructure("sequence-leading-zero", editPayload(payload => { payload.sequence = "042"; }));
  addStructure("sequence-trailing-newline", editPayload(payload => { payload.sequence = "42\n"; }));
  addStructure("fractional-time", editPayload(payload => { payload.issued_at = 1799999940.5; }));
  addStructure("unsafe-time", editPayload(payload => { payload.issued_at = 9007199254740992; }));

  const addSemantic = (id, edit) => {
    const payload = base();
    edit(payload);
    cases.push({ id, layer: "semantic", envelope: signed(payload), signature: true, expected_core_error: id });
  };
  addSemantic("duplicate-policy-id", payload => { payload.policies.push(clone(payload.policies[0])); });
  addSemantic("manifest-id-mismatch", payload => { payload.policies[0].manifest.id = "different-id"; });
  addSemantic("expiry-before-issue", payload => { payload.expires_at = payload.issued_at - 1; });
  addSemantic("expired", payload => { payload.expires_at = validationContext.now - 1; });
  addSemantic("sequence-rollback", payload => { payload.sequence = "40"; });
  addSemantic("environment-mismatch", payload => { payload.env = "different-env"; });

  // JSON.parse accepts duplicate members. C3 must reject before trusting the parsed object.
  const duplicateMember = example.payload.replace('"sequence": "42"', '"sequence": "41",\n  "sequence": "42"');
  cases.push({ id: "duplicate-json-member", layer: "parser", envelope: signed(duplicateMember), signature: true,
    expected_core_error: "duplicate-json-member" });

  const tampered = clone(example);
  tampered.payload += "\n"; // Equivalent parsed object, different signed B bytes.
  cases.push({ id: "payload-byte-tamper", layer: "crypto", envelope: tampered, signature: false,
    expected_core_error: "invalid-signature" });
  const badSignature = clone(example);
  const signatureBytes = Buffer.from(badSignature.sig.sig_b64, "base64");
  signatureBytes[0] ^= 1;
  badSignature.sig.sig_b64 = signatureBytes.toString("base64");
  cases.push({ id: "signature-tamper", layer: "crypto", envelope: badSignature, signature: false,
    expected_core_error: "invalid-signature" });
  cases.push({ id: "decoder-key-on-policy", layer: "key-role", envelope: signed(example.payload, "decoder"),
    signature: true, expected_core_error: "wrong-key-role" });
  return cases;
}
