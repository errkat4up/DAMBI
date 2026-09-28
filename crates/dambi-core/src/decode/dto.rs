//! Decoder input and output DTOs, preserving the existing JSON wire format.

use serde::{Deserialize, Serialize};

// ───────────────────────────────────────────────────────────────────────────
// Declarative mapper boundary — install result (shared v3 / v1)
// ───────────────────────────────────────────────────────────────────────────

/// Result returned by `declarative_install_v3_json` on success.
#[derive(Debug, Clone, Serialize)]
pub struct DeclarativeInstallResultDto {
    /// Decoder id derived from the bundle. For v3 this equals `bundle_id`
    /// (the canonical registry path).
    pub decoder_id: String,
    /// Echoes back the bundle's full id (including `@version`) for client
    /// indexing.
    pub bundle_id: String,
}

// ───────────────────────────────────────────────────────────────────────────
// v3 route entry (raw tx / sig -> `Vec<Action>`)
// ───────────────────────────────────────────────────────────────────────────

/// Input for `declarative_route_request_v3_json`.
///
/// This is the v3 (PDF FSM spec) route entry that emits the new hierarchical
/// `policy_transition::action::Action` tree (the legacy flat
/// `ActionEnvelope` route was removed when the hierarchical action model
/// became the canonical route output).
///
/// The wire shape mirrors the SW orchestrator's `decideMessage` output:
///   * `chain_id`/`to`/`selector`/`calldata` — registry-v2 callkey + raw
///     calldata. (Mirrors the legacy v1 entry.)
///   * `value` — `msg.value` as a decimal string (`"0"` default).
///   * `gas_limit` — declared gas limit as a decimal string. The orchestrator
///     forwards the dApp's value verbatim; defaults to `"0"` when missing.
///   * `gas_price` — current gas price as a decimal string. The WASM route wraps
///     this in a [`LiveField`](policy_state::live_field::LiveField) with a Pyth `gas/<chain_id>` source — the
///     actual sync orchestrator wiring is deferred.
///   * `submitter` — `tx.from`. Echoed into `ActionMeta.submitter`.
///   * `submitted_at` — Unix epoch seconds. Echoed into `ActionMeta.submitted_at`.
///   * `nonce` — declared sequential nonce. `0` when missing.
///
/// `block_timestamp` (optional) — block.timestamp at which the Action would
/// land, distinct from `submitted_at`. Mappers may use this for deadlines.
///
/// `selector` and `block_timestamp` are part of the stable wire shape but are
/// not consumed by this route yet. They will be threaded into the registry-v2
/// callkey lookup and emit-rule decode once that path is fully wired. The
/// `#[allow(dead_code)]` reflects that intentional staging; do not remove
/// either field as that would break the SW wire layer.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize)]
pub struct DeclarativeRouteRequestV3InputDto {
    pub chain_id: u64,
    /// "0x" + 40 hex. Case-insensitive.
    pub to: String,
    /// "0x" + 8 hex. Case-insensitive.
    pub selector: String,
    /// Raw "0x"-prefixed calldata.
    pub calldata: String,
    /// `msg.value` as a base-10 decimal string. Defaults to `"0"`.
    #[serde(default = "default_zero_decimal")]
    pub value: String,
    /// Declared gas limit as a base-10 decimal string. Defaults to `"0"`.
    #[serde(default = "default_zero_decimal")]
    pub gas_limit: String,
    /// Current gas price as a base-10 decimal string. Defaults to `"0"`.
    /// Wrapped in a [`LiveField`](policy_state::live_field::LiveField) by the WASM entry with a Pyth
    /// `gas/<chain_id>` source.
    #[serde(default = "default_zero_decimal")]
    pub gas_price: String,
    /// `tx.from` — "0x" + 40 hex.
    pub submitter: String,
    /// Unix epoch seconds at which the Action was submitted.
    pub submitted_at: u64,
    /// Sequential transaction nonce of `submitter`. Defaults to `0`.
    #[serde(default)]
    pub nonce: u64,
    /// Optional block timestamp.
    #[serde(default)]
    pub block_timestamp: Option<u64>,
}

fn default_zero_decimal() -> String {
    "0".to_string()
}

/// Input for `declarative_route_typed_data_v3_json` (Phase A.1).
///
/// The off-chain EIP-712 parallel to [`DeclarativeRouteRequestV3InputDto`].
/// Instead of raw calldata + selector, the wallet's `eth_signTypedData`
/// payload surfaces:
///   * `chain_id` / `verifying_contract` / `primary_type` — the typed-data
///     bridge key populated at install time from the manifest's
///     `match.typed_data` block. `verifying_contract` is case-insensitive.
///   * `domain_name` (optional) — the EIP-712 `domain.name`. Echoed verbatim
///     into the resulting [`Eip712Domain`](policy_transition::action::Eip712Domain).
///     Defaults to an empty string when the wallet payload omits it.
///   * `message` — the EIP-712 `message` object. The route handler reshapes
///     this into `args_json` via the ABI-derived wrap rule (single-tuple wrap
///     vs flat) so the manifest's `$args.<path>` placeholders resolve.
///   * `submitter` — the signer address. Echoed into `ActionMeta.submitter`.
///   * `submitted_at` — Unix epoch seconds. Echoed into `ActionMeta.submitted_at`.
#[derive(Debug, Clone, Deserialize)]
pub struct DeclarativeRouteTypedDataV3InputDto {
    pub chain_id: u64,
    /// EIP-712 `domain.verifyingContract` — "0x" + 40 hex. Case-insensitive.
    pub verifying_contract: String,
    /// EIP-712 `primaryType` (e.g. `"PermitSingle"`).
    pub primary_type: String,
    /// Optional 4th routing-key component (T1). For Permit2
    /// `permitWitnessTransferFrom` witnesses (UniswapX intent orders etc.) the
    /// real order type is the EIP-712 `witness` field's type — every such order
    /// collides on `(chain_id, Permit2, "PermitWitnessTransferFrom")`, so
    /// `witness_type` (the witness struct's EIP-712 type name, kept VERBATIM
    /// like `primary_type`) disambiguates. Absent for non-witness payloads →
    /// the bridge key keeps its 3-tuple shape (backward compatible).
    #[serde(default)]
    pub witness_type: Option<String>,
    /// EIP-712 `domain.name`. Optional — defaults to empty.
    #[serde(default)]
    pub domain_name: Option<String>,
    /// The EIP-712 `message` object (decoded typed-data payload).
    pub message: serde_json::Value,
    /// Signer address — "0x" + 40 hex.
    pub submitter: String,
    /// Unix epoch seconds at which the signature was requested.
    pub submitted_at: u64,
}

/// Full-input v4 boundary. Keep the entire envelope as JSON so the validator
/// can preserve original field spellings, values and optional-field omission.
/// `typed_data` accepts an object or a JSON string; v3 callers are unaffected.
#[derive(Debug, Deserialize)]
#[serde(transparent)]
pub struct DeclarativeRouteTypedDataV4InputDto(pub serde_json::Value);

#[derive(Debug, Serialize)]
pub struct DeclarativeRouteTypedDataV4ResultDto {
    pub actions: Vec<policy_transition::action::Action>,
    pub decoder_id: String,
    pub request: TypedDataRequestV4Dto,
}

#[derive(Debug, Serialize)]
pub struct TypedDataRequestV4Dto {
    pub original: serde_json::Value,
    pub routing: TypedDataRoutingV4Dto,
    pub validated: TypedDataValidatedV4Dto,
    pub validation: TypedDataValidationV4Dto,
}

#[derive(Debug, Serialize)]
pub struct TypedDataRoutingV4Dto {
    pub chain_id: u64,
    pub verifying_contract: String,
    pub primary_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub witness_type: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct TypedDataValidatedV4Dto {
    pub owner: String,
    /// Requested signing wallet, never a recovered signature identity.
    pub requested_signer: String,
    pub submitter: String,
    /// Signed nonce, distinct from the Action's external-lookup nonce stub.
    pub signed_nonce: String,
    pub deadline_seconds: String,
}

#[derive(Debug, Serialize)]
pub struct TypedDataValidationV4Dto {
    /// Request consistency does not establish cryptographic validity.
    pub signature_verification: &'static str,
}

/// A position in the original transaction call tree, independent of emitted
/// Action nesting. Callback bytes have no selector or independent target/value.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum TransactionCallPathDto {
    #[serde(rename = "self")]
    SelfCall {
        index: usize,
    },
    Call {
        index: usize,
    },
    Callback,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionDiagnosticCodeDto {
    DepthLimit,
    ChildLimit,
    NodeLimit,
    UnregisteredCall,
    ShortCalldata,
    RouteNotApplicable,
    UninterpretedAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TransactionDiagnosticDto {
    pub code: TransactionDiagnosticCodeDto,
    pub path: Vec<TransactionCallPathDto>,
    /// None means no decoder was matched/looked up. Callback segments identify
    /// the manifest that supplied the opaque callback, not a guessed child ID.
    pub decoder_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TransactionDecodingStatusDto {
    Complete,
    Partial,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct TransactionDecodingDto {
    pub status: TransactionDecodingStatusDto,
    pub diagnostics: Vec<TransactionDiagnosticDto>,
}

/// Result returned by `declarative_route_request_v3_json` on success.
///
/// `actions` contains the decoded Actions and `decoder_id` identifies the
/// matched root manifest. The legacy v3 typed route also uses this DTO but
/// never adds transaction traversal metadata.
#[derive(Debug, Clone, Serialize)]
pub struct DeclarativeRouteRequestV3ResultDto {
    pub actions: Vec<policy_transition::action::Action>,
    pub decoder_id: String,
    /// When the matched manifest declares `emit.reenter_callback_arg`, the raw
    /// `bytes` value of that arg — an `abi.encode(Call[])` re-entry callback the
    /// transaction traversal expands using the same request context. Kept for
    /// response compatibility; callback decoding is manifest-driven and does
    /// not require a per-protocol selector list.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reenter_callback: Option<String>,
    /// Present only when transaction multicall/callback traversal was active.
    /// Shared typed routes leave this absent; absence does not mean complete.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decoding: Option<TransactionDecodingDto>,
}
