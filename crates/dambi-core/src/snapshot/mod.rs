//! Immutable policy/Decoder snapshots with store-owned trust and atomic refresh.
//! No network access, persistent storage, JS entry point, or product selection.

mod decoder;
mod store;

use crate::bundle::{PolicyParseError, PolicySemanticError, SignatureError};
use decoder::prepare_decoder;
pub use decoder::{DecoderTrust, VerifiedDecoderSnapshot};
pub use store::{PreparedRefresh, RefreshTicket, Snapshot, SnapshotStore, SnapshotStoreConfig};

/// PolicySource input; the exact B bytes are authenticated by the receiving Store.
#[derive(Debug, Clone, Copy)]
pub struct SignedPolicyInput<'a> {
    pub payload: &'a [u8],
    pub signature: &'a str,
    pub key_id: Option<&'a str>,
}

/// Native installation inputs. The public JS API still supplies a pinned local
/// container. SignedBundle prepares the separate external Registry trust path;
/// it does not enable remote loading or Decoder refresh in the Store.
#[derive(Debug, Clone, Copy)]
pub enum DecoderInput<'a> {
    Pinned {
        artifact: &'a [u8],
        /// Independently trusted SHA-256 of the exact container UTF-8 bytes.
        expected_digest: &'a str,
    },
    SignedBundle {
        bundle: &'a [u8],
        signature: &'a str,
        key_id: Option<&'a str>,
        /// Requested Registry bundle_sha256: SHA-256 of the full bundle's JCS.
        /// This identity check complements the local Decoder-role signature.
        expected_bundle_digest: &'a str,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotErrorKind {
    InvalidConfig,
    InvalidPolicyBundle,
    InvalidSignature,
    UnsupportedRegistryRef,
    PolicyScopeMismatch,
    PolicyExpired,
    PolicySequenceRejected,
    InvalidDecoderSnapshot,
    DecoderIntegrityMismatch,
    LimitExceeded,
    Disposed,
    Aborted,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotError {
    pub kind: SnapshotErrorKind,
    pub message: String,
}

impl SnapshotError {
    pub(crate) fn new(kind: SnapshotErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn code(&self) -> &'static str {
        match self.kind {
            SnapshotErrorKind::InvalidConfig => "INVALID_CONFIG",
            SnapshotErrorKind::InvalidPolicyBundle => "INVALID_POLICY_BUNDLE",
            SnapshotErrorKind::InvalidSignature => "INVALID_SIGNATURE",
            SnapshotErrorKind::UnsupportedRegistryRef => "UNSUPPORTED_REGISTRY_REF",
            SnapshotErrorKind::PolicyScopeMismatch => "POLICY_SCOPE_MISMATCH",
            SnapshotErrorKind::PolicyExpired => "POLICY_EXPIRED",
            SnapshotErrorKind::PolicySequenceRejected => "POLICY_SEQUENCE_REJECTED",
            SnapshotErrorKind::InvalidDecoderSnapshot => "INVALID_DECODER_SNAPSHOT",
            SnapshotErrorKind::DecoderIntegrityMismatch => "DECODER_INTEGRITY_MISMATCH",
            SnapshotErrorKind::LimitExceeded => "LIMIT_EXCEEDED",
            SnapshotErrorKind::Disposed => "DISPOSED",
            SnapshotErrorKind::Aborted => "ABORTED",
        }
    }
}

impl std::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message)
    }
}

impl std::error::Error for SnapshotError {}

impl From<PolicyParseError> for SnapshotError {
    fn from(error: PolicyParseError) -> Self {
        use crate::bundle::PolicyParseErrorKind;
        let kind = match error.kind {
            PolicyParseErrorKind::InvalidConfig => SnapshotErrorKind::InvalidConfig,
            PolicyParseErrorKind::InputTooLarge | PolicyParseErrorKind::DepthLimit => {
                SnapshotErrorKind::LimitExceeded
            }
            _ => SnapshotErrorKind::InvalidPolicyBundle,
        };
        Self::new(kind, format!("{}: {}", error.path, error.message))
    }
}

impl From<SignatureError> for SnapshotError {
    fn from(error: SignatureError) -> Self {
        use crate::bundle::SignatureErrorKind;
        let kind = match error.kind {
            SignatureErrorKind::InvalidConfig => SnapshotErrorKind::InvalidConfig,
            SignatureErrorKind::InvalidSignature => SnapshotErrorKind::InvalidSignature,
            SignatureErrorKind::InvalidDecoderSnapshot => SnapshotErrorKind::InvalidDecoderSnapshot,
            SignatureErrorKind::LimitExceeded => SnapshotErrorKind::LimitExceeded,
        };
        Self::new(kind, error.message)
    }
}

impl From<PolicySemanticError> for SnapshotError {
    fn from(error: PolicySemanticError) -> Self {
        use crate::bundle::PolicySemanticErrorKind;
        let kind = match error.kind {
            PolicySemanticErrorKind::InvalidConfig => SnapshotErrorKind::InvalidConfig,
            PolicySemanticErrorKind::InvalidPolicyBundle => SnapshotErrorKind::InvalidPolicyBundle,
            PolicySemanticErrorKind::UnsupportedRegistryRef => {
                SnapshotErrorKind::UnsupportedRegistryRef
            }
            PolicySemanticErrorKind::PolicyScopeMismatch => SnapshotErrorKind::PolicyScopeMismatch,
            PolicySemanticErrorKind::PolicyExpired => SnapshotErrorKind::PolicyExpired,
            PolicySemanticErrorKind::PolicySequenceRejected => {
                SnapshotErrorKind::PolicySequenceRejected
            }
            PolicySemanticErrorKind::LimitExceeded => SnapshotErrorKind::LimitExceeded,
        };
        Self::new(kind, format!("{}: {}", error.path, error.message))
    }
}
