// Development fixtures only. The keys under examples/ are public test material,
// never SDK defaults or production trust anchors.
import { readFileSync } from "node:fs";
import { sign } from "node:crypto";

const read = name => JSON.parse(readFileSync(new URL(`./examples/${name}`, import.meta.url), "utf8"));
export const example = read("day1.envelope.json");
export const testKeys = read("test-only-keys.json");
export const validationContext = {
  now: 1800000000,
  env: "staging",
  profile: "default",
  accepted_sequence: 41,
  maxBundleAgeSec: 259200,
};

const clone = value => structuredClone(value);
const base = () => JSON.parse(example.payload);

function signed(payload, role = "policy") {
  const key = testKeys[role];
  // Object mutations below preserve the member order of the canonical example.
  // This helper signs literal test bytes; it is not the publisher's JCS encoder.
  const bytes = typeof payload === "string" ? payload : JSON.stringify(payload);
  return {
    payload: bytes,
    signature: sign("sha256", Buffer.from(bytes, "utf8"), {
      key: key.private_key_pkcs8_pem,
      dsaEncoding: "ieee-p1363",
    }).toString("base64"),
    key_id: key.key_id,
  };
}

// Each case keeps a complete reviewable envelope in memory. Semantically invalid
// payloads are signed correctly so C3 can eventually isolate the intended error.
export function contractCases() {
  const cases = [{ id: "day1", layer: "valid", envelope: clone(example), signature: true }];
  const numericExpiry = base();
  numericExpiry.expires_at = validationContext.now + 3600;
  cases.push({ id: "numeric-expiry", layer: "valid", envelope: signed(numericExpiry), signature: true });
  const maxSequence = base();
  maxSequence.sequence = Number.MAX_SAFE_INTEGER;
  cases.push({ id: "sequence-max-safe-integer", layer: "valid", envelope: signed(maxSequence), signature: true });
  const addStructure = (id, edit) => {
    const envelope = clone(example);
    edit(envelope);
    cases.push({ id, layer: "structure", envelope });
  };
  const editPayload = edit => envelope => {
    const payload = JSON.parse(envelope.payload);
    edit(payload);
    envelope.payload = JSON.stringify(payload);
  };

  addStructure("payload-object", envelope => { envelope.payload = base(); });
  addStructure("invalid-payload-json", envelope => { envelope.payload = "{"; });
  addStructure("payload-null", envelope => { envelope.payload = "null"; });
  addStructure("missing-signature", envelope => { delete envelope.signature; });
  addStructure("legacy-nested-signature", envelope => {
    envelope.sig = { alg: "ECDSA_P256_SHA256", key_id: envelope.key_id, sig_b64: envelope.signature };
    delete envelope.signature;
    delete envelope.key_id;
  });
  addStructure("signature-trailing-newline", envelope => { envelope.signature += "\n"; });
  addStructure("signature-wrong-length", envelope => { envelope.signature = "AA=="; });
  addStructure("missing-required-field", editPayload(payload => { delete payload.expires_at; }));
  addStructure("empty-policies", editPayload(payload => { payload.policies = []; }));
  addStructure("missing-manifest", editPayload(payload => { delete payload.policies[0].manifest; }));
  addStructure("empty-manifest", editPayload(payload => { payload.policies[0].manifest = {}; }));
  addStructure("manifest-wrong-type", editPayload(payload => { payload.policies[0].manifest = []; }));
  addStructure("manifest-wrong-version", editPayload(payload => { payload.policies[0].manifest.schema_version = 1; }));
  addStructure("legacy-payload-schema-version", editPayload(payload => { payload.schema_version = 1; }));
  addStructure("registry-ref-wrong-type", editPayload(payload => { payload.registry_ref = 1; }));
  addStructure("sequence-string", editPayload(payload => { payload.sequence = "42"; }));
  addStructure("sequence-zero", editPayload(payload => { payload.sequence = 0; }));
  addStructure("sequence-fraction", editPayload(payload => { payload.sequence = 42.5; }));
  addStructure("sequence-unsafe-number", editPayload(payload => { payload.sequence = Number.MAX_SAFE_INTEGER + 1; }));
  addStructure("invalid-environment", editPayload(payload => { payload.env = "fixture"; }));
  addStructure("fractional-time", editPayload(payload => { payload.issued_at = 1799999940.5; }));
  addStructure("unsafe-time", editPayload(payload => { payload.issued_at = 9007199254740992; }));

  const addSemantic = (id, edit, expectedCoreError = id) => {
    const payload = base();
    edit(payload);
    cases.push({ id, layer: "semantic", envelope: signed(payload), signature: true, expected_core_error: expectedCoreError });
  };
  addSemantic("duplicate-policy-id", payload => { payload.policies.push(clone(payload.policies[0])); });
  addSemantic("manifest-id-mismatch", payload => { payload.policies[0].manifest.id = "different-id"; });
  addSemantic("expiry-before-issue", payload => { payload.expires_at = payload.issued_at - 1; });
  addSemantic("expired", payload => { payload.expires_at = validationContext.now - 1; });
  addSemantic("sequence-rollback", payload => { payload.sequence = 40; });
  addSemantic("environment-mismatch", payload => { payload.env = "production"; });
  addSemantic("profile-mismatch", payload => { payload.profile = "different-profile"; });
  addSemantic("non-null-registry-ref", payload => { payload.registry_ref = "remote-root"; }, "UNSUPPORTED_REGISTRY_REF");
  addSemantic("max-age-with-null-expiry", payload => {
    payload.issued_at = validationContext.now - validationContext.maxBundleAgeSec - 1;
    payload.expires_at = null;
  });

  // JSON.parse accepts duplicate members. C3 must reject before trusting the parsed object.
  const duplicateMember = example.payload.replace('"sequence":42', '"sequence":41,"sequence":42');
  cases.push({ id: "duplicate-json-member", layer: "parser", envelope: signed(duplicateMember), signature: true,
    expected_core_error: "duplicate-json-member" });

  const tampered = clone(example);
  tampered.payload += "\n"; // Equivalent parsed object, different signed B bytes.
  cases.push({ id: "payload-byte-tamper", layer: "crypto", envelope: tampered, signature: false,
    expected_core_error: "invalid-signature" });
  const badSignature = clone(example);
  const signatureBytes = Buffer.from(badSignature.signature, "base64");
  signatureBytes[0] ^= 1;
  badSignature.signature = signatureBytes.toString("base64");
  cases.push({ id: "signature-tamper", layer: "crypto", envelope: badSignature, signature: false,
    expected_core_error: "invalid-signature" });
  const wrongRole = signed(example.payload, "decoder");
  wrongRole.key_id = testKeys.policy.key_id; // A claimed policy ID cannot grant trust to the decoder key.
  cases.push({ id: "decoder-key-on-policy", layer: "key-role", envelope: wrongRole,
    signing_role: "decoder", signature: true, expected_core_error: "wrong-key-role" });
  return cases;
}
