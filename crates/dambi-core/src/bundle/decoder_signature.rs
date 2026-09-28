//! Verify detached Decoder signatures over JCS-canonicalized JSON.

use serde_json::Value;

use super::signature::{KeyRole, SignatureError, SignatureErrorKind, TrustedKeys};
use super::{strict_json, structure, PolicyParseErrorKind};

/// An object whose JCS bytes were signed by a configured Decoder-role key.
///
/// This establishes signature authenticity only. It does not validate the full
/// Decoder bundle schema, dependencies, supported routes, or snapshot readiness.
/// A later installation boundary must perform those checks before activation.
#[derive(Debug)]
pub struct SignatureVerifiedDecoderBundle {
    bundle: Value,
    canonical_bytes: Vec<u8>,
    signer_key_id: String,
    key_id: Option<String>,
}

impl SignatureVerifiedDecoderBundle {
    pub fn bundle(&self) -> &Value {
        &self.bundle
    }

    pub fn canonical_bytes(&self) -> &[u8] {
        &self.canonical_bytes
    }

    /// The local Decoder-role key that successfully verified the signature.
    pub fn signer_key_id(&self) -> &str {
        &self.signer_key_id
    }

    /// Untrusted detached-signature metadata; never a selector for trusted keys.
    pub fn key_id(&self) -> Option<&str> {
        self.key_id.as_deref()
    }
}

impl TrustedKeys {
    /// Verify a detached Decoder signature over the parsed object's JCS bytes.
    ///
    /// `max_decoder_bytes` bounds the supplied JSON before parsing. Strict JSON
    /// checks reject duplicate keys, malformed Unicode, excessive nesting, and
    /// lossy or unsafe numbers. The signature uses the locally fixed algorithm
    /// and only Decoder-role keys; `key_id` is retained solely as metadata.
    pub fn verify_decoder_bundle(
        &self,
        bundle_json: &[u8],
        signature_b64: &str,
        key_id: Option<&str>,
        max_decoder_bytes: usize,
    ) -> Result<SignatureVerifiedDecoderBundle, SignatureError> {
        if max_decoder_bytes == 0 {
            return Err(SignatureError::new(
                SignatureErrorKind::InvalidConfig,
                "maxDecoderBytes must be positive",
            ));
        }
        if bundle_json.len() > max_decoder_bytes {
            return Err(SignatureError::new(
                SignatureErrorKind::LimitExceeded,
                "decoder JSON exceeds maxDecoderBytes",
            ));
        }
        let input = std::str::from_utf8(bundle_json).map_err(|_| {
            SignatureError::new(
                SignatureErrorKind::InvalidDecoderSnapshot,
                "decoder JSON is not valid UTF-8",
            )
        })?;
        let bundle = strict_json::parse(input).map_err(|error| {
            let kind = match error.kind {
                PolicyParseErrorKind::InputTooLarge | PolicyParseErrorKind::DepthLimit => {
                    SignatureErrorKind::LimitExceeded
                }
                _ => SignatureErrorKind::InvalidDecoderSnapshot,
            };
            SignatureError::new(
                kind,
                format!("invalid decoder JSON at {}: {}", error.path, error.message),
            )
        })?;
        if !bundle.is_object() {
            return Err(SignatureError::new(
                SignatureErrorKind::InvalidDecoderSnapshot,
                "decoder JSON must be an object",
            ));
        }
        let signature = structure::decode_signature(signature_b64).map_err(|error| {
            SignatureError::new(SignatureErrorKind::InvalidSignature, error.message)
        })?;
        let canonical_bytes = serde_json_canonicalizer::to_vec(&bundle).map_err(|error| {
            SignatureError::new(
                SignatureErrorKind::InvalidDecoderSnapshot,
                format!("decoder JSON canonicalization failed: {error}"),
            )
        })?;
        let signer_key_id = self
            .verify_bytes(KeyRole::Decoder, &canonical_bytes, &signature)?
            .to_owned();
        Ok(SignatureVerifiedDecoderBundle {
            bundle,
            canonical_bytes,
            signer_key_id,
            key_id: key_id.map(str::to_owned),
        })
    }
}
