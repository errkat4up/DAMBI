//! Authenticate a complete, resolved decoder artifact before publishing a registry.
//!
//! This gate validates installation controls, not every possible decoded Action.
//! ABI data, template placeholders, live inputs and ActionBody construction still
//! undergo the existing request-time checks. No dependency is fetched here.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::bundle::{strict_json, PolicyParseErrorKind, TrustedKeys};
use crate::decode::DecoderRegistry;

use super::{DecoderInput, SnapshotError, SnapshotErrorKind};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
// Bound expansion work as well as input bytes: legacy chain_ids × to is a
// Cartesian product, and typed installation repeats one insertion per address.
const MAX_ROUTING_ENTRIES: usize = 65_536;
const MAX_ROUTING_STRING_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DecoderTrust {
    PinnedArtifact,
    SignedBundle { signer_key_id: String },
}

/// A complete registry whose original artifact has passed its trust boundary.
/// There is deliberately no public constructor or mutable registry accessor.
pub struct VerifiedDecoderSnapshot {
    registry: DecoderRegistry,
    digest: String,
    bundle_ids: Vec<String>,
    bundle_digests: Vec<String>,
    trust: DecoderTrust,
}

impl fmt::Debug for VerifiedDecoderSnapshot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("VerifiedDecoderSnapshot")
            .field("digest", &self.digest)
            .field("bundle_ids", &self.bundle_ids)
            .field("bundle_digests", &self.bundle_digests)
            .field("trust", &self.trust)
            .finish_non_exhaustive()
    }
}

impl VerifiedDecoderSnapshot {
    pub fn registry(&self) -> &DecoderRegistry {
        &self.registry
    }

    /// Exact artifact-byte digest for pinned containers; JCS bundle digest for
    /// signed bundles. Neither is calculated from a projected or normalized DTO.
    pub fn digest(&self) -> &str {
        &self.digest
    }

    pub fn bundle_ids(&self) -> &[String] {
        &self.bundle_ids
    }

    pub fn bundle_digests(&self) -> &[String] {
        &self.bundle_digests
    }

    pub fn trust(&self) -> &DecoderTrust {
        &self.trust
    }
}

pub(super) fn prepare_decoder(
    input: DecoderInput<'_>,
    keys: &TrustedKeys,
    max_bytes: usize,
) -> Result<VerifiedDecoderSnapshot, SnapshotError> {
    if max_bytes == 0 {
        return Err(SnapshotError::new(
            SnapshotErrorKind::InvalidConfig,
            "maxDecoderBytes must be positive",
        ));
    }
    let (bundles, digest, trust) = match input {
        DecoderInput::Pinned {
            artifact,
            expected_digest,
        } => {
            validate_digest(expected_digest)?;
            if artifact.len() > max_bytes {
                return Err(SnapshotError::new(
                    SnapshotErrorKind::LimitExceeded,
                    "decoder artifact exceeds maxDecoderBytes",
                ));
            }
            let digest = sha256(artifact);
            require_digest(&digest, expected_digest)?;
            let input = std::str::from_utf8(artifact)
                .map_err(|_| invalid("$", "decoder artifact is not valid UTF-8"))?;
            let container = strict_json::parse(input).map_err(|error| {
                let kind = match error.kind {
                    PolicyParseErrorKind::InputTooLarge | PolicyParseErrorKind::DepthLimit => {
                        SnapshotErrorKind::LimitExceeded
                    }
                    _ => SnapshotErrorKind::InvalidDecoderSnapshot,
                };
                SnapshotError::new(kind, format!("{}: {}", error.path, error.message))
            })?;
            let container = object(&container, "$", &["schema_version", "bundles"])?;
            if container.get("schema_version").and_then(Value::as_u64) != Some(1) {
                return Err(invalid("$/schema_version", "must be integer 1"));
            }
            let bundles = array(required(container, "bundles", "$")?, "$/bundles")?;
            if bundles.is_empty() {
                return Err(invalid(
                    "$/bundles",
                    "must contain at least one full V3 bundle",
                ));
            }
            (bundles.to_vec(), digest, DecoderTrust::PinnedArtifact)
        }
        DecoderInput::SignedBundle {
            bundle,
            signature,
            key_id,
            expected_bundle_digest,
        } => {
            validate_digest(expected_bundle_digest)?;
            let verified = keys.verify_decoder_bundle(bundle, signature, key_id, max_bytes)?;
            let digest = sha256(verified.canonical_bytes());
            require_digest(&digest, expected_bundle_digest)?;
            (
                vec![verified.bundle().clone()],
                digest,
                DecoderTrust::SignedBundle {
                    signer_key_id: verified.signer_key_id().to_owned(),
                },
            )
        }
    };

    // The legacy registry intentionally supports replacement installs. A new
    // snapshot instead owns fresh state, rejects competing route owners, and
    // never exposes a partially installed registry on any error.
    let mut registry = DecoderRegistry::default();
    let mut seen_ids = HashSet::new();
    let mut routes = Routes::default();
    let mut bundle_ids = Vec::with_capacity(bundles.len());
    let mut bundle_digests = Vec::with_capacity(bundles.len());
    for (index, bundle) in bundles.iter().enumerate() {
        let path = format!("$/bundles/{index}");
        let id = validate_bundle(bundle, &path, &mut routes)?;
        if !seen_ids.insert(id.to_owned()) {
            return Err(invalid(&path, "duplicate bundle id"));
        }
        let canonical = serde_json_canonicalizer::to_vec(bundle)
            .map_err(|error| invalid(&path, format!("JCS serialization failed: {error}")))?;
        let serialized = serde_json::to_string(bundle)
            .map_err(|error| invalid(&path, format!("JSON serialization failed: {error}")))?;
        registry.install(&serialized).map_err(|error| {
            let kind = if error.kind == "input_too_large" {
                SnapshotErrorKind::LimitExceeded
            } else {
                SnapshotErrorKind::InvalidDecoderSnapshot
            };
            SnapshotError::new(kind, format!("{path}: {}", error.message))
        })?;
        bundle_ids.push(id.to_owned());
        bundle_digests.push(sha256(&canonical));
    }
    Ok(VerifiedDecoderSnapshot {
        registry,
        digest,
        bundle_ids,
        bundle_digests,
        trust,
    })
}

fn sha256(bytes: &[u8]) -> String {
    format!("0x{}", hex::encode(Sha256::digest(bytes)))
}

fn validate_digest(digest: &str) -> Result<(), SnapshotError> {
    if digest.len() != 66
        || !digest.starts_with("0x")
        || !digest.as_bytes()[2..]
            .iter()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
    {
        return Err(SnapshotError::new(
            SnapshotErrorKind::InvalidConfig,
            "expected decoder digest must be 0x followed by 64 lowercase hex characters",
        ));
    }
    Ok(())
}

fn require_digest(actual: &str, expected: &str) -> Result<(), SnapshotError> {
    if actual != expected {
        return Err(SnapshotError::new(
            SnapshotErrorKind::DecoderIntegrityMismatch,
            "decoder digest does not match the locally supplied pin",
        ));
    }
    Ok(())
}

fn invalid(path: &str, message: impl fmt::Display) -> SnapshotError {
    SnapshotError::new(
        SnapshotErrorKind::InvalidDecoderSnapshot,
        format!("{path}: {message}"),
    )
}

fn object<'a>(
    value: &'a Value,
    path: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, SnapshotError> {
    let map = value
        .as_object()
        .ok_or_else(|| invalid(path, "must be an object"))?;
    if let Some(key) = map.keys().find(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid(path, format!("unsupported field {key:?}")));
    }
    Ok(map)
}

fn required<'a>(
    map: &'a Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<&'a Value, SnapshotError> {
    map.get(key)
        .ok_or_else(|| invalid(path, format!("missing {key}")))
}

fn string<'a>(value: &'a Value, path: &str) -> Result<&'a str, SnapshotError> {
    value
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or_else(|| invalid(path, "must be a nonempty string"))
}

fn field<'a>(map: &'a Map<String, Value>, key: &str, path: &str) -> Result<&'a str, SnapshotError> {
    string(required(map, key, path)?, &format!("{path}/{key}"))
}

fn array<'a>(value: &'a Value, path: &str) -> Result<&'a Vec<Value>, SnapshotError> {
    value
        .as_array()
        .ok_or_else(|| invalid(path, "must be an array"))
}

fn is_hex(value: &str, bytes: usize) -> bool {
    value.len() == 2 + bytes * 2
        && value.starts_with("0x")
        && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

#[derive(Default)]
struct Routes {
    exact: HashSet<(u64, String, String)>,
    typed: HashSet<(u64, String, String, Option<String>)>,
    agnostic: HashSet<(u64, String)>,
    installation_entries: usize,
    installation_string_bytes: usize,
}

impl Routes {
    fn reserve(
        &mut self,
        entries: usize,
        typed: bool,
        string_bytes_per_entry: usize,
        path: &str,
    ) -> Result<(), SnapshotError> {
        let total_entries = entries
            .checked_mul(if typed { 2 } else { 1 })
            .and_then(|entries| self.installation_entries.checked_add(entries))
            .filter(|entries| *entries <= MAX_ROUTING_ENTRIES)
            .ok_or_else(|| routing_limit(path))?;
        let total_string_bytes = entries
            .checked_mul(string_bytes_per_entry)
            .and_then(|bytes| self.installation_string_bytes.checked_add(bytes))
            .filter(|bytes| *bytes <= MAX_ROUTING_STRING_BYTES)
            .ok_or_else(|| routing_limit(path))?;
        self.installation_entries = total_entries;
        self.installation_string_bytes = total_string_bytes;
        Ok(())
    }
}

fn routing_limit(path: &str) -> SnapshotError {
    SnapshotError::new(
        SnapshotErrorKind::LimitExceeded,
        format!(
            "{path}: decoder snapshot exceeds {MAX_ROUTING_ENTRIES} routing installation entries or {MAX_ROUTING_STRING_BYTES} routing string bytes"
        ),
    )
}

fn validate_bundle<'a>(
    value: &'a Value,
    path: &str,
    routes: &mut Routes,
) -> Result<&'a str, SnapshotError> {
    let bundle = object(
        value,
        path,
        &[
            "type",
            "id",
            "schema_version",
            "publisher",
            "match",
            "abi_fragment",
            "emit",
            "requires",
            "recurse",
            "note",
            "_note",
            "_note_addresses",
            "_note_mapping",
        ],
    )?;
    if field(bundle, "type", path)? != "adapter_action"
        || field(bundle, "schema_version", path)? != "3"
    {
        return Err(invalid(
            path,
            "only full resolved adapter_action V3 bundles are supported",
        ));
    }
    let id = field(bundle, "id", path)?;
    for key in [
        "publisher",
        "note",
        "_note",
        "_note_addresses",
        "_note_mapping",
    ] {
        if let Some(value) = bundle.get(key) {
            if !value.is_string() {
                return Err(invalid(path, format!("{key} must be a string")));
            }
        }
    }
    let matcher = object(
        required(bundle, "match", path)?,
        &format!("{path}/match"),
        &[
            "selector",
            "chain_to_addresses",
            "chain_ids",
            "to",
            "address_agnostic",
            "typed_data",
        ],
    )?;
    let selector = field(matcher, "selector", path)?;
    if !is_hex(selector, 4) {
        return Err(invalid(
            path,
            "match.selector must be a four-byte hex string",
        ));
    }
    let typed = matcher.contains_key("typed_data");
    validate_routes(matcher, id, &selector.to_ascii_lowercase(), path, routes)?;
    validate_abi(
        required(bundle, "abi_fragment", path)?,
        selector,
        typed,
        path,
    )?;
    let emit = required(bundle, "emit", path)?;
    validate_emit(emit, &format!("{path}/emit"), false)?;
    if typed
        && !matches!(
            emit.get("strategy").and_then(Value::as_str),
            Some("single_emit" | "array_emit")
        )
    {
        return Err(invalid(
            path,
            "typed-data routes support only single_emit or array_emit",
        ));
    }
    validate_templates(emit, path)?;
    if let Some(requires) = bundle.get("requires") {
        validate_requires(
            requires,
            emit["strategy"].as_str().unwrap_or_default(),
            path,
        )?;
    }
    if let Some(recurse) = bundle.get("recurse") {
        let recurse = object(
            recurse,
            path,
            &["strategy", "commands_path", "inputs_path", "max_depth"],
        )?;
        if field(recurse, "strategy", path)? != "commands_and_inputs_paired" {
            return Err(invalid(path, "unsupported recurse descriptor"));
        }
        field(recurse, "commands_path", path)?;
        field(recurse, "inputs_path", path)?;
        optional_integer(recurse, "max_depth", u32::MAX as u64, path)?;
    }
    Ok(id)
}

fn validate_routes(
    matcher: &Map<String, Value>,
    id: &str,
    selector: &str,
    path: &str,
    routes: &mut Routes,
) -> Result<(), SnapshotError> {
    let agnostic = match matcher.get("address_agnostic") {
        Some(Value::Bool(value)) => *value,
        None => false,
        _ => return Err(invalid(path, "address_agnostic must be a boolean")),
    };
    let mut entries: BTreeMap<u64, Vec<String>> = BTreeMap::new();
    if agnostic {
        if selector != "0xa22cb465"
            || ["chain_to_addresses", "to", "typed_data"]
                .iter()
                .any(|key| matcher.contains_key(*key))
        {
            return Err(invalid(path, "address-agnostic routing is restricted to setApprovalForAll without exact or typed routing"));
        }
        let chains = required(matcher, "chain_ids", path)?;
        let string_bytes = routing_string_bytes(matcher, id, selector, true, path)?;
        routes.reserve(array(chains, path)?.len(), false, string_bytes, path)?;
        for chain in chain_ids(chains, path)? {
            if !routes.agnostic.insert((chain, selector.to_owned())) {
                return Err(invalid(path, "duplicate address-agnostic route"));
            }
        }
        return Ok(());
    }
    let string_bytes = routing_string_bytes(matcher, id, selector, false, path)?;
    if let Some(map) = matcher.get("chain_to_addresses") {
        if matcher.contains_key("chain_ids") || matcher.contains_key("to") {
            return Err(invalid(
                path,
                "exact routing must use one resolved address form",
            ));
        }
        let map = map
            .as_object()
            .filter(|map| !map.is_empty())
            .ok_or_else(|| invalid(path, "chain_to_addresses must be a nonempty object"))?;
        let route_count = map.values().try_fold(0usize, |total, addresses| {
            total
                .checked_add(array(addresses, path)?.len())
                .ok_or_else(|| routing_limit(path))
        })?;
        routes.reserve(
            route_count,
            matcher.contains_key("typed_data"),
            string_bytes,
            path,
        )?;
        for (chain, addresses) in map {
            let number = chain
                .parse::<u64>()
                .ok()
                .filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER && n.to_string() == *chain)
                .ok_or_else(|| {
                    invalid(
                        path,
                        "chain keys must be canonical positive JS-safe integers",
                    )
                })?;
            entries.insert(number, address_list(addresses, path)?);
        }
    } else {
        let chains = required(matcher, "chain_ids", path)?;
        let addresses = required(matcher, "to", path)?;
        let route_count = array(chains, path)?
            .len()
            .checked_mul(array(addresses, path)?.len())
            .ok_or_else(|| routing_limit(path))?;
        routes.reserve(
            route_count,
            matcher.contains_key("typed_data"),
            string_bytes,
            path,
        )?;
        let chains = chain_ids(chains, path)?;
        let addresses = address_list(addresses, path)?;
        for chain in chains {
            entries.insert(chain, addresses.clone());
        }
    }
    for (chain, addresses) in &entries {
        for address in addresses {
            if !routes
                .exact
                .insert((*chain, address.clone(), selector.to_owned()))
            {
                return Err(invalid(path, "duplicate exact calldata route"));
            }
        }
    }
    if let Some(value) = matcher.get("typed_data") {
        let typed = object(
            value,
            path,
            &[
                "domain_name",
                "verifying_contract",
                "primary_type",
                "witness_type",
                "types",
            ],
        )?;
        let contract = field(typed, "verifying_contract", path)?.to_ascii_lowercase();
        if !is_hex(&contract, 20) {
            return Err(invalid(path, "typed verifying_contract must be an address"));
        }
        let primary = field(typed, "primary_type", path)?;
        let witness = typed
            .get("witness_type")
            .map(|v| string(v, path).map(str::to_owned))
            .transpose()?;
        if primary == "PermitWitnessTransferFrom" && witness.is_none() {
            return Err(invalid(
                path,
                "PermitWitnessTransferFrom requires witness_type",
            ));
        }
        if let Some(name) = typed.get("domain_name") {
            string(name, path)?;
        }
        let types = required(typed, "types", path)?
            .as_object()
            .ok_or_else(|| invalid(path, "typed_data.types must be an object"))?;
        if !types.contains_key(primary) {
            return Err(invalid(path, "typed_data.types must declare primary_type"));
        }
        for (name, fields) in types {
            if name.is_empty() {
                return Err(invalid(path, "typed-data type names must be nonempty"));
            }
            let mut names = HashSet::new();
            for item in array(fields, path)? {
                let item = object(item, path, &["name", "type"])?;
                if !names.insert(field(item, "name", path)?) {
                    return Err(invalid(path, "duplicate typed-data field"));
                }
                field(item, "type", path)?;
            }
        }
        // Repeated addresses in one chain produce a single typed routing key.
        for (chain, addresses) in &entries {
            if !addresses.contains(&contract) {
                return Err(invalid(
                    path,
                    "typed verifying_contract must belong to each declared chain",
                ));
            }
            if !routes.typed.insert((
                *chain,
                contract.clone(),
                primary.to_owned(),
                witness.clone(),
            )) {
                return Err(invalid(path, "duplicate typed-data route"));
            }
        }
    }
    Ok(())
}

fn routing_string_bytes(
    matcher: &Map<String, Value>,
    id: &str,
    selector: &str,
    agnostic: bool,
    path: &str,
) -> Result<usize, SnapshotError> {
    // Every accepted exact address has 42 UTF-8 bytes. Malformed addresses
    // are rejected before cloning. Count the registry's bundle-id copy too.
    let mut bytes = id
        .len()
        .checked_add(selector.len())
        .and_then(|bytes| bytes.checked_add(if agnostic { 0 } else { 42 }))
        .ok_or_else(|| routing_limit(path))?;
    if let Some(typed) = matcher.get("typed_data") {
        let typed = typed
            .as_object()
            .ok_or_else(|| invalid(path, "typed_data must be an object"))?;
        let contract = field(typed, "verifying_contract", path)?;
        let primary = field(typed, "primary_type", path)?;
        let witness_len = typed
            .get("witness_type")
            .map(|value| string(value, path).map(str::len))
            .transpose()?
            .unwrap_or_default();
        // Registry installation repeats this typed key/value for every exact
        // address, even when multiple addresses collapse to the same typed key.
        bytes = bytes
            .checked_add(id.len())
            .and_then(|bytes| bytes.checked_add(contract.len()))
            .and_then(|bytes| bytes.checked_add(primary.len()))
            .and_then(|bytes| bytes.checked_add(witness_len))
            .ok_or_else(|| routing_limit(path))?;
    }
    Ok(bytes)
}

fn chain_ids(value: &Value, path: &str) -> Result<Vec<u64>, SnapshotError> {
    let array = array(value, path)?;
    if array.is_empty() {
        return Err(invalid(path, "chain_ids must not be empty"));
    }
    let mut seen = HashSet::new();
    array
        .iter()
        .map(|value| {
            let chain = value
                .as_u64()
                .filter(|n| *n > 0 && *n <= MAX_SAFE_INTEGER)
                .ok_or_else(|| invalid(path, "chain_ids must contain positive JS-safe integers"))?;
            if !seen.insert(chain) {
                return Err(invalid(path, "duplicate chain id"));
            }
            Ok(chain)
        })
        .collect()
}

fn address_list(value: &Value, path: &str) -> Result<Vec<String>, SnapshotError> {
    let array = array(value, path)?;
    if array.is_empty() {
        return Err(invalid(path, "address lists must not be empty"));
    }
    let mut seen = HashSet::new();
    array
        .iter()
        .map(|value| {
            let address = string(value, path)?;
            if !is_hex(address, 20) {
                return Err(invalid(path, "invalid address"));
            }
            let address = address.to_ascii_lowercase();
            if !seen.insert(address.clone()) {
                return Err(invalid(path, "duplicate address"));
            }
            Ok(address)
        })
        .collect()
}

fn validate_abi(
    value: &Value,
    selector: &str,
    typed: bool,
    path: &str,
) -> Result<(), SnapshotError> {
    let fragment = object(value, path, &["function_name", "abi"])?;
    let name = field(fragment, "function_name", path)?;
    let abi = required(fragment, "abi", path)?;
    let object = object(
        abi,
        path,
        &[
            "type",
            "name",
            "inputs",
            "outputs",
            "stateMutability",
            "constant",
            "payable",
        ],
    )?;
    if field(object, "type", path)? != "function" {
        return Err(invalid(path, "abi_fragment must describe a function"));
    }
    for key in ["inputs", "outputs"] {
        if let Some(params) = object.get(key) {
            validate_abi_params(params, path)?;
        }
    }
    // Match the runtime's compact ABI compatibility defaults. Never mutate the
    // bundle which is hashed, authenticated and installed.
    let mut patched = object.clone();
    patched
        .entry("outputs")
        .or_insert_with(|| Value::Array(vec![]));
    patched
        .entry("stateMutability")
        .or_insert_with(|| Value::String("nonpayable".into()));
    let function: alloy_json_abi::Function = serde_json::from_value(Value::Object(patched))
        .map_err(|error| invalid(path, format!("invalid ABI function: {error}")))?;
    if function.name != name {
        return Err(invalid(
            path,
            "abi function name differs from function_name",
        ));
    }
    // Native transfers deliberately use a sentinel, while off-chain typed-data
    // manifests (e.g. HyperLiquid) may use synthetic calldata selectors.
    if !typed
        && selector != "0x00000000"
        && format!("0x{}", hex::encode(function.selector())) != selector.to_ascii_lowercase()
    {
        return Err(invalid(
            path,
            "match.selector differs from the ABI function selector",
        ));
    }
    Ok(())
}

fn validate_abi_params(value: &Value, path: &str) -> Result<(), SnapshotError> {
    for param in array(value, path)? {
        let param = object(param, path, &["name", "type", "components", "internalType"])?;
        if let Some(components) = param.get("components") {
            validate_abi_params(components, path)?;
        }
    }
    Ok(())
}

fn optional_integer(
    map: &Map<String, Value>,
    key: &str,
    max: u64,
    path: &str,
) -> Result<(), SnapshotError> {
    if let Some(value) = map.get(key) {
        if value.as_u64().filter(|n| *n > 0 && *n <= max).is_none() {
            return Err(invalid(
                path,
                format!("{key} must be an integer in 1..={max}"),
            ));
        }
    }
    Ok(())
}

fn validate_emit(value: &Value, path: &str, part: bool) -> Result<(), SnapshotError> {
    let emit = value
        .as_object()
        .ok_or_else(|| invalid(path, "emit must be an object"))?;
    let strategy = field(emit, "strategy", path)?;
    let fields: &[&str] = match strategy {
        "single_emit" => &["body", "live_inputs"],
        "array_emit" => &[
            "array_source",
            "parallel_sources",
            "max_elements",
            "body",
            "live_inputs",
            "per_item_body",
        ],
        "opcode_stream_dispatch" if !part => &[
            "dispatcher_id",
            "mask",
            "allow_revert_bit",
            "unknown_opcode_policy",
            "per_opcode_body",
            "max_depth",
            "unlock_data_source",
        ],
        "tagged_dispatch" if !part => &[
            "bytes_source",
            "version_byte",
            "tag_offset",
            "tag_size",
            "per_action_body",
        ],
        "parallel_tagged_dispatch" if !part => &[
            "actions_source",
            "data_source",
            "tag_encoding",
            "max_elements",
            "unknown_tag_policy",
            "resolve_from_inputs",
            "per_tag",
        ],
        "multicall_recurse" if !part => &["recurse_rule_id", "recurse_arg", "max_depth"],
        "multicall_call_array" if !part => &["recurse_arg", "max_depth"],
        "composite_emit" if !part => &["parts"],
        "reenter_only" if !part => &[],
        _ => return Err(invalid(path, "unsupported emit strategy")),
    };
    for key in emit.keys() {
        if !fields.contains(&key.as_str())
            && !["strategy", "_note", "reenter_callback_arg"].contains(&key.as_str())
        {
            return Err(invalid(path, format!("unsupported emit field {key:?}")));
        }
    }
    for key in [
        "dispatcher_id",
        "array_source",
        "bytes_source",
        "actions_source",
        "data_source",
        "unlock_data_source",
        "recurse_arg",
        "reenter_callback_arg",
        "_note",
    ] {
        if let Some(value) = emit.get(key) {
            string(value, path)?;
        }
    }
    for key in ["body", "live_inputs", "per_item_body"] {
        if let Some(value) = emit.get(key) {
            if !value.is_object() {
                return Err(invalid(path, format!("{key} must be an object template")));
            }
        }
    }
    for key in ["parallel_sources", "resolve_from_inputs"] {
        if let Some(value) = emit.get(key) {
            let map = value
                .as_object()
                .ok_or_else(|| invalid(path, format!("{key} must be an object")))?;
            for (name, source) in map {
                if name.is_empty() {
                    return Err(invalid(path, format!("{key} names must be nonempty")));
                }
                string(source, path)?;
                if key == "resolve_from_inputs"
                    && !["compound_v3_base_asset", "compound_v2_underlying"]
                        .contains(&name.as_str())
                {
                    return Err(invalid(path, "unsupported named input resolver"));
                }
            }
        }
    }
    optional_integer(emit, "max_elements", 64, path)?;
    optional_integer(emit, "max_depth", u32::MAX as u64, path)?;
    for key in ["mask", "allow_revert_bit", "version_byte"] {
        if let Some(value) = emit.get(key) {
            if !is_hex(string(value, path)?, 1) {
                return Err(invalid(path, format!("{key} must be one hex byte")));
            }
        }
    }
    if let Some(value) = emit.get("unknown_opcode_policy") {
        if !["deny", "warn", "skip"].contains(&string(value, path)?) {
            return Err(invalid(path, "unknown opcode policy"));
        }
    }
    if let Some(value) = emit.get("unknown_tag_policy") {
        if !["deny", "warn"].contains(&string(value, path)?) {
            return Err(invalid(path, "unknown tag policy"));
        }
    }
    match strategy {
        "single_emit" | "array_emit" => {
            required(emit, "body", path)?;
            if strategy == "array_emit" {
                field(emit, "array_source", path)?;
            }
        }
        "opcode_stream_dispatch" => {
            validate_dispatch(required(emit, "per_opcode_body", path)?, path, true)?
        }
        "tagged_dispatch" => {
            field(emit, "bytes_source", path)?;
            for key in ["tag_offset", "tag_size"] {
                if let Some(value) = emit.get(key) {
                    let range = if key == "tag_size" {
                        1..=8
                    } else {
                        0..=u32::MAX as u64
                    };
                    if value.as_u64().filter(|n| range.contains(n)).is_none() {
                        return Err(invalid(
                            path,
                            "tag_offset must be in 0..=u32::MAX and tag_size in 1..=8",
                        ));
                    }
                }
            }
            validate_dispatch(required(emit, "per_action_body", path)?, path, false)?;
        }
        "parallel_tagged_dispatch" => {
            field(emit, "actions_source", path)?;
            field(emit, "data_source", path)?;
            if !["bytes32_ascii", "bytes32_hex", "uint"].contains(&field(
                emit,
                "tag_encoding",
                path,
            )?) {
                return Err(invalid(path, "unsupported tag encoding"));
            }
            validate_dispatch(required(emit, "per_tag", path)?, path, false)?;
        }
        "multicall_recurse" => {
            if field(emit, "recurse_rule_id", path)? != "self_array_bytes_last_arg" {
                return Err(invalid(path, "unsupported multicall recurse rule"));
            }
        }
        "reenter_only" => {
            field(emit, "reenter_callback_arg", path)?;
        }
        "composite_emit" => {
            let parts = array(required(emit, "parts", path)?, path)?;
            if parts.is_empty() {
                return Err(invalid(
                    path,
                    "composite emit must contain at least one part",
                ));
            }
            for part in parts {
                validate_emit(part, path, true)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn validate_dispatch(value: &Value, path: &str, opcode: bool) -> Result<(), SnapshotError> {
    let entries = value
        .as_object()
        .ok_or_else(|| invalid(path, "dispatch table must be an object"))?;
    for (key, entry) in entries {
        if key.is_empty() || (opcode && (!is_hex(key, 1) || key != &key.to_ascii_lowercase())) {
            return Err(invalid(path, "invalid dispatch table key"));
        }
        let entry = object(
            entry,
            path,
            &[
                "body",
                "live_inputs",
                "inputs_abi",
                "nested",
                "name",
                "_note",
            ],
        )?;
        for key in ["inputs_abi", "name", "_note"] {
            if let Some(value) = entry.get(key) {
                string(value, path)?;
            }
        }
        if let Some(signature) = entry.get("inputs_abi") {
            alloy_json_abi::Function::parse(&format!("step{}", string(signature, path)?))
                .map_err(|error| invalid(path, format!("invalid dispatch inputs_abi: {error}")))?;
        }
        if let Some(nested) = entry.get("nested") {
            if !opcode || entry.contains_key("body") {
                return Err(invalid(path, "nested opcode must not also declare a body"));
            }
            let nested = object(
                nested,
                path,
                &[
                    "mask",
                    "allow_revert_bit",
                    "unknown_opcode_policy",
                    "inner_actions_source",
                    "inner_params_source",
                    "per_opcode_body",
                    "_note",
                ],
            )?;
            for key in ["mask", "allow_revert_bit"] {
                if let Some(value) = nested.get(key) {
                    if !is_hex(string(value, path)?, 1) {
                        return Err(invalid(path, "nested mask must be one hex byte"));
                    }
                }
            }
            for key in ["inner_actions_source", "inner_params_source", "_note"] {
                if let Some(value) = nested.get(key) {
                    string(value, path)?;
                }
            }
            if let Some(value) = nested.get("unknown_opcode_policy") {
                if !["deny", "warn", "skip"].contains(&string(value, path)?) {
                    return Err(invalid(path, "unknown nested opcode policy"));
                }
            }
            validate_dispatch(required(nested, "per_opcode_body", path)?, path, true)?;
        } else if !required(entry, "body", path)?.is_object() {
            return Err(invalid(path, "dispatch body must be an object template"));
        }
        if let Some(live) = entry.get("live_inputs") {
            if !live.is_object() {
                return Err(invalid(path, "live_inputs must be an object template"));
            }
        }
    }
    Ok(())
}

fn validate_templates(value: &Value, path: &str) -> Result<(), SnapshotError> {
    let mut pending = vec![value];
    while let Some(value) = pending.pop() {
        match value {
            Value::Object(map) => {
                if let Some(function) = map.get("$fn") {
                    object(value, path, &["$fn", "$args"])?;
                    if !mappers::declarative::builtin_fn::WHITELIST
                        .contains(&string(function, path)?)
                    {
                        return Err(invalid(path, "unsupported template $fn"));
                    }
                    if let Some(args) = map.get("$args") {
                        pending.extend(array(args, path)?);
                    }
                    continue;
                } else if map.contains_key("$match") {
                    object(value, path, &["$match", "$cases", "$default"])?;
                    let cases = required(map, "$cases", path)?
                        .as_object()
                        .ok_or_else(|| invalid(path, "template $cases must be an object"))?;
                    pending.push(&map["$match"]);
                    pending.extend(cases.values());
                    if let Some(default) = map.get("$default") {
                        pending.push(default);
                    }
                    continue;
                }
                pending.extend(
                    map.iter()
                        .filter(|(key, _)| *key != "_note" && *key != "note")
                        .map(|(_, value)| value),
                );
            }
            Value::Array(array) => pending.extend(array),
            Value::String(string) if string == "$source" || string.starts_with("$source.") => {
                return Err(invalid(
                    path,
                    "unresolved $source template; supply a fully materialized bundle",
                ));
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_requires(value: &Value, strategy: &str, path: &str) -> Result<(), SnapshotError> {
    let requires = object(
        value,
        path,
        &[
            "imperative",
            "adapter_capabilities",
            "host_capabilities",
            "extension",
        ],
    )?;
    for key in ["imperative", "adapter_capabilities", "host_capabilities"] {
        if let Some(value) = requires.get(key) {
            let mut seen = HashSet::new();
            for value in array(value, path)? {
                let dependency = string(value, path)?;
                if !seen.insert(dependency) {
                    return Err(invalid(path, "duplicate dependency declaration"));
                }
                if key == "imperative" {
                    let supported = match dependency {
                        "multicall-recurse@^1.0" => strategy == "multicall_recurse",
                        "universal-router-dispatcher@^1.0"
                        | "universal-router-dispatcher@^2.0"
                        | "uniswap-v4-actions-dispatcher@^1.0" => {
                            strategy == "opcode_stream_dispatch"
                        }
                        "core-writer-dispatcher@^1.0" => strategy == "tagged_dispatch",
                        _ => false,
                    };
                    if !supported {
                        return Err(invalid(
                            path,
                            "unsupported imperative dependency for this strategy",
                        ));
                    }
                }
            }
        }
    }
    if let Some(extension) = requires.get("extension") {
        string(extension, path)?;
    }
    // Adapter/host capabilities describe request-time inputs. Their declared
    // shape is checked here; this type does not promise those inputs exist.
    Ok(())
}
