//! Fixed P-256/SHA-256 verification using locally configured, role-scoped keys.

use base64::{engine::general_purpose::STANDARD, Engine};
use p256::{
    ecdsa::{signature::Verifier, Signature, VerifyingKey},
    pkcs8::DecodePublicKey,
};

use super::ParsedPolicyBundle;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyRole {
    Policy,
    Decoder,
}

/// Local configuration only. A response cannot add a key or assign its role.
#[derive(Debug, Clone)]
pub struct VerificationKey {
    pub key_id: String,
    pub role: KeyRole,
    pub public_key_spki_base64: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignatureErrorKind {
    InvalidConfig,
    InvalidSignature,
    InvalidDecoderSnapshot,
    LimitExceeded,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SignatureError {
    pub kind: SignatureErrorKind,
    pub message: String,
}

impl SignatureError {
    pub(super) fn new(kind: SignatureErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self.kind {
            SignatureErrorKind::InvalidConfig => "INVALID_CONFIG",
            SignatureErrorKind::InvalidSignature => "INVALID_SIGNATURE",
            SignatureErrorKind::InvalidDecoderSnapshot => "INVALID_DECODER_SNAPSHOT",
            SignatureErrorKind::LimitExceeded => "LIMIT_EXCEEDED",
        }
    }
}

impl std::fmt::Display for SignatureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for SignatureError {}

#[derive(Debug)]
struct TrustedKey {
    key_id: String,
    role: KeyRole,
    public_key: VerifyingKey,
}

/// Immutable local trust. Policy keys are required; Decoder keys are optional
/// until a signed external Decoder is used. No key material is fetched at runtime.
#[derive(Debug)]
pub struct TrustedKeys {
    keys: Vec<TrustedKey>,
}

impl TrustedKeys {
    /// Parse Base64 DER SubjectPublicKeyInfo and validate the P-256 curve/point.
    /// Invalid keys fail the whole configuration instead of being silently skipped.
    pub fn new(config: &[VerificationKey]) -> Result<Self, SignatureError> {
        let invalid = |message| SignatureError::new(SignatureErrorKind::InvalidConfig, message);
        let mut keys: Vec<TrustedKey> = Vec::with_capacity(config.len());
        for entry in config {
            if entry.key_id.is_empty() || keys.iter().any(|key| key.key_id == entry.key_id) {
                return Err(invalid("local key IDs must be non-empty and unique"));
            }
            let der = STANDARD
                .decode(&entry.public_key_spki_base64)
                .map_err(|_| invalid("public key must be canonical standard Base64 DER SPKI"))?;
            let public_key = VerifyingKey::from_public_key_der(&der)
                .map_err(|_| invalid("public key must be a valid P-256 SPKI"))?;
            if keys
                .iter()
                .any(|key| key.role != entry.role && key.public_key == public_key)
            {
                return Err(invalid(
                    "policy and Decoder roles must use distinct public keys",
                ));
            }
            keys.push(TrustedKey {
                key_id: entry.key_id.clone(),
                role: entry.role,
                public_key,
            });
        }
        if !keys.iter().any(|key| key.role == KeyRole::Policy) {
            return Err(invalid(
                "at least one locally trusted policy key is required",
            ));
        }
        Ok(Self { keys })
    }

    /// Verify the original B bytes. Whitespace, ordering and escapes remain part
    /// of the signed message; canonicalizing the parsed Value here would be wrong.
    pub fn verify_policy_bundle(
        &self,
        parsed: ParsedPolicyBundle,
    ) -> Result<SignatureVerifiedPolicyBundle, SignatureError> {
        let signer_key_id = self
            .verify_bytes(KeyRole::Policy, parsed.payload_bytes(), parsed.signature())?
            .to_owned();
        Ok(SignatureVerifiedPolicyBundle {
            parsed,
            signer_key_id,
        })
    }

    pub(super) fn verify_bytes(
        &self,
        role: KeyRole,
        message: &[u8],
        signature_bytes: &[u8; 64],
    ) -> Result<&str, SignatureError> {
        // from_slice enforces P1363 scalar bounds; it never interprets input as DER.
        let signature = Signature::from_slice(signature_bytes).map_err(|_| invalid_signature())?;
        for key in self.keys.iter().filter(|key| key.role == role) {
            // P-256's Verifier uses SHA-256 once over the message (not a digest).
            // Both high-S and low-S valid ECDSA signatures retain WebCrypto/KMS
            // compatibility; the wire contract does not mandate low-S.
            if key.public_key.verify(message, &signature).is_ok() {
                return Ok(&key.key_id);
            }
        }
        Err(invalid_signature())
    }
}

fn invalid_signature() -> SignatureError {
    SignatureError::new(
        SignatureErrorKind::InvalidSignature,
        "signature does not verify with a locally trusted key of the required role",
    )
}

/// Signature authentication only. Scope, freshness, rollback and full policy
/// validity are deliberately not claimed until semantic validation completes.
#[derive(Debug)]
pub struct SignatureVerifiedPolicyBundle {
    parsed: ParsedPolicyBundle,
    signer_key_id: String,
}

impl SignatureVerifiedPolicyBundle {
    pub fn parsed(&self) -> &ParsedPolicyBundle {
        &self.parsed
    }
    /// Local identity of the key that actually verified, never response telemetry.
    pub fn signer_key_id(&self) -> &str {
        &self.signer_key_id
    }
}
