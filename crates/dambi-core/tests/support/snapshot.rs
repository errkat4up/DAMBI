//! Fixed local inputs shared by snapshot integration tests; no generators/I/O.
#![allow(dead_code)]

use base64::{engine::general_purpose::STANDARD, Engine};
use dambi_core::{
    bundle::{KeyRole, PolicyValidationConfig, VerificationKey},
    snapshot::{
        DecoderInput, SignedPolicyInput, Snapshot, SnapshotError, SnapshotStore,
        SnapshotStoreConfig,
    },
};
use p256::{
    ecdsa::{signature::Signer, Signature, SigningKey},
    pkcs8::DecodePrivateKey,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub const NOW: u64 = 1_800_000_000_000;
pub const ISSUED: u64 = 1_799_999_940;
pub const CONTRACT: &str = "0x1111111111111111111111111111111111111111";
pub const SECOND_CONTRACT: &str = "0x2222222222222222222222222222222222222222";
pub const BUNDLE_ID: &str = "standard/erc20/approve@1.0.0";
pub const LIMIT: usize = 1_000_000;
pub const ZERO_DIGEST: &str = "0x0000000000000000000000000000000000000000000000000000000000000000";
const DAY1: &[u8] = include_bytes!("../fixtures/policy-bundle/day1.envelope.json");
const KEYS: &str = include_str!("../fixtures/policy-bundle/test-only-keys.json");

pub struct PolicyWire {
    pub payload: Vec<u8>,
    pub signature: String,
    pub key_id: Option<String>,
}

impl PolicyWire {
    pub fn input(&self) -> SignedPolicyInput<'_> {
        SignedPolicyInput {
            payload: &self.payload,
            signature: &self.signature,
            key_id: self.key_id.as_deref(),
        }
    }
}

pub fn day1() -> PolicyWire {
    let envelope: Value = serde_json::from_slice(DAY1).unwrap();
    PolicyWire {
        payload: envelope["payload"].as_str().unwrap().as_bytes().to_vec(),
        signature: envelope["signature"].as_str().unwrap().into(),
        key_id: envelope["key_id"].as_str().map(str::to_owned),
    }
}

pub fn policy_value(sequence: u64) -> Value {
    let mut value: Value = serde_json::from_slice(&day1().payload).unwrap();
    value["sequence"] = json!(sequence);
    value
}

pub fn sign(name: &str, bytes: &[u8]) -> String {
    let keys: Value = serde_json::from_str(KEYS).unwrap();
    let pem: String = keys[name]["private_key_pkcs8_pem"]
        .as_str()
        .unwrap()
        .lines()
        .filter(|line| !line.starts_with("-----"))
        .collect();
    let key = SigningKey::from_pkcs8_der(&STANDARD.decode(pem).unwrap()).unwrap();
    let signature: Signature = key.sign(bytes);
    STANDARD.encode(signature.to_bytes())
}

pub fn signed_raw(payload: Vec<u8>) -> PolicyWire {
    let signature = sign("policy", &payload);
    PolicyWire {
        payload,
        signature,
        key_id: None,
    }
}

pub fn signed_policy(value: Value) -> PolicyWire {
    signed_raw(serde_json::to_vec(&value).unwrap())
}

pub fn key(name: &str, role: KeyRole) -> VerificationKey {
    let keys: Value = serde_json::from_str(KEYS).unwrap();
    VerificationKey {
        key_id: keys[name]["key_id"].as_str().unwrap().into(),
        role,
        public_key_spki_base64: keys[name]["public_key_spki_b64"].as_str().unwrap().into(),
    }
}

pub fn config() -> SnapshotStoreConfig {
    SnapshotStoreConfig {
        keys: vec![
            key("policy", KeyRole::Policy),
            key("decoder", KeyRole::Decoder),
        ],
        policy: PolicyValidationConfig {
            env: "staging".into(),
            profile: "default".into(),
            max_bundle_age_sec: None,
            allowed_clock_skew_ms: 5_000,
        },
        max_policy_bytes: LIMIT,
        max_decoder_bytes: LIMIT,
    }
}

pub fn approve_bundle() -> Value {
    // Hand-resolved match for one address; ABI, body placeholders, and requires
    // retain the real standard approve manifest shape.
    serde_json::from_str(include_str!("../fixtures/snapshot-approve.json")).unwrap()
}

pub fn canonical(value: &Value) -> Vec<u8> {
    serde_json_canonicalizer::to_vec(value).unwrap()
}

pub fn digest(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(Sha256::digest(bytes)))
}

pub struct Artifact {
    pub bytes: Vec<u8>,
    pub digest: String,
}

impl Artifact {
    pub fn input(&self) -> DecoderInput<'_> {
        DecoderInput::Pinned {
            artifact: &self.bytes,
            expected_digest: &self.digest,
        }
    }
}

pub fn artifact(bundles: Vec<Value>) -> Artifact {
    artifact_bytes(serde_json::to_vec(&json!({ "schema_version": 1, "bundles": bundles })).unwrap())
}

pub fn artifact_bytes(bytes: Vec<u8>) -> Artifact {
    let digest = digest(&bytes);
    Artifact { bytes, digest }
}

pub fn store() -> SnapshotStore {
    SnapshotStore::new(
        config(),
        artifact(vec![approve_bundle()]).input(),
        day1().input(),
        NOW,
    )
    .unwrap()
}

pub fn expect_code<T>(result: Result<T, SnapshotError>, code: &str) {
    match result {
        Ok(_) => panic!("expected {code}, got success"),
        Err(error) => {
            assert_eq!(error.code(), code, "{error:?}");
            assert!(!error.message.is_empty());
        }
    }
}

pub fn approve_request(target: &str) -> String {
    let spender = "000000000000000000000000000000000000aaaa";
    json!({
        "chain_id": 1,
        "to": target,
        "selector": "0x095ea7b3",
        "calldata": format!("0x095ea7b3{spender:0>64}{:064x}", 7_u64),
        "submitter": format!("0x{spender}"),
        "submitted_at": NOW / 1000
    })
    .to_string()
}

pub fn assert_approve(snapshot: &Snapshot, target: &str, id: &str) {
    let result = snapshot
        .decoder()
        .registry()
        .route_request(&approve_request(target))
        .unwrap();
    let value = serde_json::to_value(result).unwrap();
    assert_eq!(value["decoder_id"], id);
    assert_eq!(value["actions"].as_array().unwrap().len(), 1);
    assert_eq!(value["actions"][0]["body"]["action"], "erc20_approve");
    assert_eq!(
        value["actions"][0]["body"]["token"]["key"]["address"],
        target
    );
    assert_eq!(value["actions"][0]["body"]["amount"], "0x7");
}
