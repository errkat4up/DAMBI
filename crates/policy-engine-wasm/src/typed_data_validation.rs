//! Pure validation for the opt-in, full-input typed-data route.
//!
//! `prepare` deliberately stops before inspecting Permit message fields: a
//! lookup miss means unsupported, even when those fields are malformed.
//! `validate_manifest` runs only after the caller has found a supported bundle.
//! Neither phase performs signature recovery, nonce lookup, or policy checks.

use std::collections::{BTreeMap, BTreeSet};

use policy_state::primitives::U256;
use serde_json::{Map, Value};

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const PERMIT_FIELDS: [(&str, &str); 5] = [
    ("owner", "address"),
    ("spender", "address"),
    ("value", "uint256"),
    ("nonce", "uint256"),
    ("deadline", "uint256"),
];

#[derive(Debug)]
pub(crate) struct TypedDataError {
    pub kind: String,
    pub message: String,
    pub path: Option<String>,
}

impl TypedDataError {
    pub(crate) fn new(
        kind: impl Into<String>,
        message: impl Into<String>,
        path: Option<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            message: message.into(),
            path,
        }
    }
}

pub(crate) struct PreparedTypedData {
    /// Original envelope, including field omission and raw routing values.
    /// JSON-string input also retains `typed_data_json`; `typed_data` is parsed.
    pub original: Value,
    pub typed_data: Value,
    pub chain_id: u64,
    pub verifying_contract: String,
    pub primary_type: String,
    pub witness_type: Option<String>,
    pub requested_signer: String,
    pub submitter: String,
    pub submitted_at: u64,
}

pub(crate) struct ValidatedPermit {
    pub owner: String,
    /// Signed request nonce, never the external nonce lookup's initial value.
    pub signed_nonce: String,
    pub deadline_seconds: u64,
    /// Normalized flat emit arguments; the original message is kept separately.
    pub message: Value,
}

fn invalid(path: &str, message: impl Into<String>) -> TypedDataError {
    TypedDataError::new("invalid_typed_data", message, Some(path.to_owned()))
}

fn bundle_error(mut error: TypedDataError) -> TypedDataError {
    error.kind = "invalid_bundle".to_owned();
    error
}

fn object<'a>(value: &'a Value, path: &str) -> Result<&'a Map<String, Value>, TypedDataError> {
    value
        .as_object()
        .ok_or_else(|| invalid(path, "must be an object"))
}

fn required<'a>(
    values: &'a Map<String, Value>,
    key: &str,
    path: &str,
) -> Result<&'a Value, TypedDataError> {
    values
        .get(key)
        .ok_or_else(|| invalid(path, "required field is missing"))
}

fn string<'a>(value: &'a Value, path: &str) -> Result<&'a str, TypedDataError> {
    value
        .as_str()
        .ok_or_else(|| invalid(path, "must be a string"))
}

fn address(value: &Value, path: &str) -> Result<String, TypedDataError> {
    let raw = string(value, path)?;
    if raw.len() != 42
        || !raw.starts_with("0x")
        || !raw.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err(invalid(
            path,
            "must be 0x followed by 40 hexadecimal digits",
        ));
    }
    Ok(raw.to_ascii_lowercase())
}

fn route_name(value: &Value, path: &str) -> Result<String, TypedDataError> {
    let raw = string(value, path)?;
    if !valid_route_name(raw) {
        return Err(invalid(
            path,
            "must contain 1 to 128 ASCII letters, digits, underscores, or colons",
        ));
    }
    Ok(raw.to_owned())
}

fn valid_route_name(raw: &str) -> bool {
    !raw.is_empty()
        && raw.len() <= 128
        && raw
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b':')
}

/// Numeric JSON values must already be safe for JS. Larger exact integers are
/// accepted only as decimal/hex strings and remain strings in the raw context.
fn safe_number(value: &Value, path: &str) -> Result<u64, TypedDataError> {
    if let Some(integer) = value.as_u64() {
        if integer <= MAX_SAFE_INTEGER {
            return Ok(integer);
        }
    }
    // Do not coerce f64 to an integer: JSON 1.0000000000000001 can already
    // have rounded to 1.0 during parsing. JSON-string callers must therefore
    // use integer lexical numbers (or uint256 strings), not 1.0 / 1e0.
    Err(invalid(
        path,
        "must be a nonnegative JS-safe integer JSON number",
    ))
}

fn uint256(value: &Value, path: &str) -> Result<U256, TypedDataError> {
    if value.is_number() {
        return safe_number(value, path).map(U256::from);
    }
    let raw = string(value, path)?;
    let (digits, radix) = match raw.strip_prefix("0x") {
        Some(hex) => (hex, 16),
        None => (raw, 10),
    };
    let valid_digits = !digits.is_empty()
        && digits.bytes().all(|c| {
            if radix == 16 {
                c.is_ascii_hexdigit()
            } else {
                c.is_ascii_digit()
            }
        });
    if !valid_digits {
        return Err(invalid(
            path,
            "must be whole decimal digits or 0x-prefixed hexadecimal digits",
        ));
    }
    U256::from_str_radix(digits, radix)
        .map_err(|_| invalid(path, "integer is outside the uint256 range"))
}

fn chain(value: &Value, path: &str) -> Result<u64, TypedDataError> {
    let parsed = uint256(value, path)?;
    if parsed == U256::ZERO || parsed > U256::from(MAX_SAFE_INTEGER) {
        return Err(invalid(path, "chain ID must be a positive JS-safe integer"));
    }
    Ok(parsed.to::<u64>())
}

/// Parse only what is necessary to perform a trustworthy lookup. In
/// particular, do not validate message.owner here or fall back to the v3 DTO.
pub(crate) fn prepare(input: Value) -> Result<PreparedTypedData, TypedDataError> {
    let envelope = object(&input, "input")?;
    if envelope.contains_key("typed_data_json") {
        return Err(invalid(
            "typed_data_json",
            "reserved for preserving the original typed_data JSON string",
        ));
    }
    let requested_signer = address(
        required(envelope, "requested_signer", "requested_signer")?,
        "requested_signer",
    )?;
    let submitter = match envelope.get("submitter") {
        Some(value) => address(value, "submitter")?,
        None => requested_signer.clone(),
    };
    let submitted_at = safe_number(
        required(envelope, "submitted_at", "submitted_at")?,
        "submitted_at",
    )?;
    let raw_typed_data = required(envelope, "typed_data", "typed_data")?;
    let typed_data = match raw_typed_data {
        Value::String(raw) => serde_json::from_str::<Value>(raw)
            .map_err(|error| invalid("typed_data", format!("invalid typed-data JSON: {error}")))?,
        value => value.clone(),
    };
    let typed = object(&typed_data, "typed_data")?;
    let domain = object(
        required(typed, "domain", "typed_data.domain")?,
        "typed_data.domain",
    )?;
    let types = object(
        required(typed, "types", "typed_data.types")?,
        "typed_data.types",
    )?;
    object(
        required(typed, "message", "typed_data.message")?,
        "typed_data.message",
    )?;
    let primary_type = route_name(
        required(typed, "primaryType", "typed_data.primaryType")?,
        "typed_data.primaryType",
    )?;
    let chain_id = chain(
        required(domain, "chainId", "typed_data.domain.chainId")?,
        "typed_data.domain.chainId",
    )?;
    let verifying_contract = address(
        required(
            domain,
            "verifyingContract",
            "typed_data.domain.verifyingContract",
        )?,
        "typed_data.domain.verifyingContract",
    )?;

    // Only extract the optional fourth routing component at this stage.
    // Full declarations, missing references, and cycles are checked post-lookup.
    let mut witness_type = None;
    if let Some(fields) = types.get(&primary_type).and_then(Value::as_array) {
        for (index, field) in fields.iter().enumerate() {
            if field.get("name").and_then(Value::as_str) == Some("witness") {
                let path = format!("typed_data.types.{primary_type}.{index}.type");
                let witness = route_name(field.get("type").unwrap_or(&Value::Null), &path)?;
                if witness_type.replace(witness).is_some() {
                    return Err(invalid(&path, "duplicate witness routing field"));
                }
            }
        }
    }

    if let Some(value) = envelope.get("routing") {
        let routing = object(value, "routing")?;
        let mut mismatch = None;
        if let Some(value) = routing.get("chain_id") {
            if chain(value, "routing.chain_id")? != chain_id {
                mismatch = Some("routing.chain_id");
            }
        }
        if let Some(value) = routing.get("verifying_contract") {
            if address(value, "routing.verifying_contract")? != verifying_contract {
                mismatch = mismatch.or(Some("routing.verifying_contract"));
            }
        }
        if let Some(value) = routing.get("primary_type") {
            if route_name(value, "routing.primary_type")? != primary_type {
                mismatch = mismatch.or(Some("routing.primary_type"));
            }
        }
        if let Some(value) = routing.get("witness_type") {
            if Some(route_name(value, "routing.witness_type")?) != witness_type {
                mismatch = mismatch.or(Some("routing.witness_type"));
            }
        }
        if let Some(path) = mismatch {
            return Err(TypedDataError::new(
                "typed_routing_mismatch",
                "external routing value conflicts with the typed-data request",
                Some(path.to_owned()),
            ));
        }
    }

    let mut original = envelope.clone();
    if let Value::String(raw) = raw_typed_data {
        original.insert("typed_data_json".to_owned(), Value::String(raw.clone()));
    }
    original.insert("typed_data".to_owned(), typed_data.clone());
    Ok(PreparedTypedData {
        original: Value::Object(original),
        typed_data,
        chain_id,
        verifying_contract,
        primary_type,
        witness_type,
        requested_signer,
        submitter,
        submitted_at,
    })
}

#[derive(Debug, PartialEq, Eq)]
struct TypeField {
    name: String,
    field_type: String,
    reference: Option<String>,
}

/// Return the referenced struct, or None for an EIP-712 scalar. Arrays are
/// checked syntactically only; supporting their emission is a separate step.
fn type_reference(raw: &str, path: &str) -> Result<Option<String>, TypedDataError> {
    let end = raw.find('[').unwrap_or(raw.len());
    let base = &raw[..end];
    let mut suffix = &raw[end..];
    while !suffix.is_empty() {
        let Some(after_open) = suffix.strip_prefix('[') else {
            return Err(invalid(path, "malformed array type"));
        };
        let Some(close) = after_open.find(']') else {
            return Err(invalid(path, "malformed array type"));
        };
        let size = &after_open[..close];
        if !size.is_empty()
            && (!size.bytes().all(|c| c.is_ascii_digit())
                || size.starts_with('0')
                || size.parse::<u64>().is_err())
        {
            return Err(invalid(path, "array length must be a positive integer"));
        }
        suffix = &after_open[close + 1..];
    }
    if matches!(base, "address" | "bool" | "string" | "bytes") {
        return Ok(None);
    }
    for (prefix, max, step) in [("uint", 256, 8), ("int", 256, 8), ("bytes", 32, 1)] {
        if let Some(width) = base.strip_prefix(prefix) {
            // A genuinely named struct such as "intOrder" remains a reference.
            if width.is_empty() || width.bytes().all(|c| c.is_ascii_digit()) {
                let valid_width = width
                    .parse::<u16>()
                    .ok()
                    .is_some_and(|width| width > 0 && width <= max && width % step == 0);
                if !valid_width || width.starts_with('0') {
                    return Err(invalid(path, "invalid EIP-712 scalar width"));
                }
                return Ok(None);
            }
        }
    }
    if !valid_route_name(base) {
        return Err(invalid(path, "invalid scalar or struct type"));
    }
    Ok(Some(base.to_owned()))
}

fn fields(value: &Value, path: &str) -> Result<Vec<TypeField>, TypedDataError> {
    let definitions = value
        .as_array()
        .ok_or_else(|| invalid(path, "struct declaration must be an array"))?;
    let mut names = BTreeSet::new();
    let mut result = Vec::with_capacity(definitions.len());
    for (index, definition) in definitions.iter().enumerate() {
        let path = format!("{path}.{index}");
        let definition = object(definition, &path)?;
        let name_path = format!("{path}.name");
        let name = string(required(definition, "name", &name_path)?, &name_path)?;
        if !valid_route_name(name) || !names.insert(name.to_owned()) {
            return Err(invalid(
                &name_path,
                "invalid or duplicate struct field name",
            ));
        }
        let type_path = format!("{path}.type");
        let field_type = string(required(definition, "type", &type_path)?, &type_path)?;
        let reference = type_reference(field_type, &type_path)?;
        result.push(TypeField {
            name: name.to_owned(),
            field_type: field_type.to_owned(),
            reference,
        });
    }
    Ok(result)
}

/// Iterative DFS checks only reachable declarations, avoiding recursive walks
/// of adversarial graphs. Unused definitions remain available in the original.
fn type_graph(
    types: &Map<String, Value>,
    primary_type: &str,
    prefix: &str,
) -> Result<BTreeMap<String, Vec<TypeField>>, TypedDataError> {
    let mut graph = BTreeMap::new();
    let mut active = BTreeSet::new();
    let mut complete = BTreeSet::new();
    let mut stack = vec![(primary_type.to_owned(), false)];
    while let Some((name, exiting)) = stack.pop() {
        if exiting {
            active.remove(&name);
            complete.insert(name);
            continue;
        }
        if complete.contains(&name) {
            continue;
        }
        let path = format!("{prefix}.{name}");
        if !active.insert(name.clone()) {
            return Err(invalid(&path, "cyclic type references are not supported"));
        }
        let declaration = required(types, &name, &path)?;
        let fields = fields(declaration, &path)?;
        stack.push((name.clone(), true));
        for (index, field) in fields.iter().enumerate().rev() {
            if let Some(reference) = &field.reference {
                if !types.contains_key(reference) {
                    return Err(invalid(
                        &format!("{path}.{index}.type"),
                        format!("missing referenced struct {reference}"),
                    ));
                }
                stack.push((reference.clone(), false));
            }
        }
        graph.insert(name, fields);
    }
    Ok(graph)
}

fn validate_types(
    input: &PreparedTypedData,
    typed_match: &Map<String, Value>,
) -> Result<(), TypedDataError> {
    let bundle_path = "bundle.match.typed_data.types";
    let expected_types = object(
        required(typed_match, "types", bundle_path).map_err(bundle_error)?,
        bundle_path,
    )
    .map_err(bundle_error)?;
    let expected =
        type_graph(expected_types, &input.primary_type, bundle_path).map_err(bundle_error)?;
    let expected_fields = expected
        .get(&input.primary_type)
        .ok_or_else(|| bundle_error(invalid(bundle_path, "missing primary type declaration")))?;
    if input.primary_type != "Permit"
        || expected_fields.len() != PERMIT_FIELDS.len()
        || expected_fields
            .iter()
            .zip(PERMIT_FIELDS)
            .any(|(actual, (name, field_type))| {
                actual.name != name || actual.field_type != field_type
            })
    {
        return Err(bundle_error(invalid(
            bundle_path,
            "supported ERC-2612 bundle must declare the five canonical Permit fields",
        )));
    }
    let requested_types = object(&input.typed_data["types"], "typed_data.types")?;
    let requested = type_graph(requested_types, &input.primary_type, "typed_data.types")?;
    for (name, expected_fields) in expected {
        let path = format!("typed_data.types.{name}");
        let actual_fields = requested
            .get(&name)
            .ok_or_else(|| invalid(&path, "required manifest struct is missing"))?;
        if actual_fields.len() != expected_fields.len() {
            return Err(invalid(
                &path,
                "field count differs from the manifest declaration",
            ));
        }
        for (index, (actual, expected)) in actual_fields.iter().zip(expected_fields).enumerate() {
            if actual.name != expected.name {
                return Err(invalid(
                    &format!("{path}.{index}.name"),
                    "field name or field declaration order differs from the manifest",
                ));
            }
            if actual.field_type != expected.field_type {
                return Err(invalid(
                    &format!("{path}.{index}.type"),
                    "field type differs from the manifest declaration",
                ));
            }
        }
    }
    Ok(())
}

fn domain_field_type(name: &str) -> Option<&'static str> {
    match name {
        "name" | "version" => Some("string"),
        "chainId" => Some("uint256"),
        "verifyingContract" => Some("address"),
        "salt" => Some("bytes32"),
        _ => None,
    }
}

fn validate_domain(
    input: &PreparedTypedData,
    bundle_match: &Map<String, Value>,
    typed_match: &Map<String, Value>,
) -> Result<(), TypedDataError> {
    let expected_contract = address(
        required(
            typed_match,
            "verifying_contract",
            "bundle.match.typed_data.verifying_contract",
        )
        .map_err(bundle_error)?,
        "bundle.match.typed_data.verifying_contract",
    )
    .map_err(bundle_error)?;
    let expected_primary = route_name(
        required(
            typed_match,
            "primary_type",
            "bundle.match.typed_data.primary_type",
        )
        .map_err(bundle_error)?,
        "bundle.match.typed_data.primary_type",
    )
    .map_err(bundle_error)?;
    let chain_path = "bundle.match.chain_to_addresses";
    let chain_addresses = object(
        required(bundle_match, "chain_to_addresses", chain_path).map_err(bundle_error)?,
        chain_path,
    )
    .map_err(bundle_error)?;
    let addresses = chain_addresses
        .get(&input.chain_id.to_string())
        .and_then(Value::as_array)
        .ok_or_else(|| bundle_error(invalid(chain_path, "matched chain must declare addresses")))?;
    let mut matches_address = false;
    for (index, value) in addresses.iter().enumerate() {
        let value = address(value, &format!("{chain_path}.{}.{index}", input.chain_id))
            .map_err(bundle_error)?;
        matches_address |= value == input.verifying_contract;
    }
    if expected_contract != input.verifying_contract
        || expected_primary != input.primary_type
        || !matches_address
    {
        return Err(bundle_error(invalid(
            "bundle.match",
            "typed bridge conflicts with the bundle's chain, contract, or primary type",
        )));
    }

    let domain = object(&input.typed_data["domain"], "typed_data.domain")?;
    for (name, value) in domain {
        let path = format!("typed_data.domain.{name}");
        match domain_field_type(name) {
            Some("string") => {
                string(value, &path)?;
            }
            Some("bytes32") => {
                let salt = string(value, &path)?;
                if salt.len() != 66
                    || !salt.starts_with("0x")
                    || !salt.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
                {
                    return Err(invalid(&path, "salt must be a 0x-prefixed bytes32 value"));
                }
            }
            Some(_) => {} // chainId/verifyingContract were checked before lookup.
            None => return Err(invalid(&path, "unknown EIP-712 domain field")),
        }
    }
    let expected_name = string(
        required(
            typed_match,
            "domain_name",
            "bundle.match.typed_data.domain_name",
        )
        .map_err(bundle_error)?,
        "bundle.match.typed_data.domain_name",
    )
    .map_err(bundle_error)?;
    let actual_name = string(
        required(domain, "name", "typed_data.domain.name")?,
        "typed_data.domain.name",
    )?;
    if actual_name != expected_name {
        return Err(TypedDataError::new(
            "typed_domain_mismatch",
            "domain name must exactly match the manifest declaration",
            Some("typed_data.domain.name".to_owned()),
        ));
    }

    if let Some(declaration) = input.typed_data["types"].get("EIP712Domain") {
        let path = "typed_data.types.EIP712Domain";
        let declared_fields = fields(declaration, path)?;
        let names: BTreeSet<_> = declared_fields
            .iter()
            .map(|field| field.name.as_str())
            .collect();
        for (index, field) in declared_fields.iter().enumerate() {
            if domain_field_type(&field.name) != Some(field.field_type.as_str()) {
                return Err(invalid(
                    &format!("{path}.{index}.type"),
                    "EIP712Domain field has an invalid type",
                ));
            }
            if !domain.contains_key(&field.name) {
                return Err(invalid(
                    &format!("typed_data.domain.{}", field.name),
                    "field declared by EIP712Domain is missing",
                ));
            }
        }
        for name in domain.keys() {
            if !names.contains(name.as_str()) {
                return Err(invalid(
                    path,
                    format!("domain field {name} is not declared"),
                ));
            }
        }
    }
    Ok(())
}

/// Returned JSON must not round otherwise-unused numeric leaves in the raw
/// context. All retained numeric leaves must use signed safe-integer JSON
/// lexemes; other numeric values must be strings. Float coercion cannot prove
/// the original precision. This runs after lookup/message checks, not on misses.
fn validate_preserved_numbers(original: &Value) -> Result<(), TypedDataError> {
    let mut stack = vec![(String::new(), original)];
    while let Some((path, value)) = stack.pop() {
        match value {
            Value::Object(values) => {
                for (name, value) in values {
                    let child = if path.is_empty() {
                        name.clone()
                    } else {
                        format!("{path}.{name}")
                    };
                    stack.push((child, value));
                }
            }
            Value::Array(values) => {
                for (index, value) in values.iter().enumerate() {
                    stack.push((format!("{path}.{index}"), value));
                }
            }
            Value::Number(number) => {
                let unsafe_number = match (number.as_u64(), number.as_i64()) {
                    (Some(value), _) => value > MAX_SAFE_INTEGER,
                    (_, Some(value)) => value < -(MAX_SAFE_INTEGER as i64),
                    _ => true,
                };
                if unsafe_number {
                    return Err(invalid(
                        &path,
                        "raw JSON numbers must be signed JS-safe integer lexemes; use a string",
                    ));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub(crate) fn validate_manifest(
    input: &PreparedTypedData,
    bundle: &Value,
) -> Result<ValidatedPermit, TypedDataError> {
    let bundle_match = object(&bundle["match"], "bundle.match").map_err(bundle_error)?;
    let typed_match = object(
        required(bundle_match, "typed_data", "bundle.match.typed_data").map_err(bundle_error)?,
        "bundle.match.typed_data",
    )
    .map_err(bundle_error)?;
    validate_types(input, typed_match)?;
    validate_domain(input, bundle_match, typed_match)?;

    let message = object(&input.typed_data["message"], "typed_data.message")?;
    let owner = address(
        required(message, "owner", "typed_data.message.owner")?,
        "typed_data.message.owner",
    )?;
    let spender = address(
        required(message, "spender", "typed_data.message.spender")?,
        "typed_data.message.spender",
    )?;
    let value = uint256(
        required(message, "value", "typed_data.message.value")?,
        "typed_data.message.value",
    )?;
    let nonce = uint256(
        required(message, "nonce", "typed_data.message.nonce")?,
        "typed_data.message.nonce",
    )?;
    let deadline = uint256(
        required(message, "deadline", "typed_data.message.deadline")?,
        "typed_data.message.deadline",
    )?;
    for name in message.keys() {
        if !PERMIT_FIELDS
            .iter()
            .any(|(field, _)| name.as_str() == *field)
        {
            return Err(invalid(
                &format!("typed_data.message.{name}"),
                "message field is not declared by the supported Permit type",
            ));
        }
    }
    validate_preserved_numbers(&input.original)?;
    if owner != input.requested_signer {
        return Err(TypedDataError::new(
            "typed_requested_signer_mismatch",
            "owner differs from requested_signer; this is request consistency, not signature recovery",
            Some("typed_data.message.owner".to_owned()),
        ));
    }
    if deadline > U256::from(MAX_SAFE_INTEGER) {
        return Err(TypedDataError::new(
            "typed_deadline_out_of_range",
            "deadline is uint256 but cannot be represented as a JS-safe Action/meta timestamp",
            Some("typed_data.message.deadline".to_owned()),
        ));
    }
    let signed_nonce = nonce.to_string();
    let deadline_seconds = deadline.to::<u64>();
    let message = serde_json::json!({
        "owner": owner,
        "spender": spender,
        "value": value.to_string(),
        "nonce": signed_nonce,
        "deadline": deadline_seconds.to_string(),
    });
    Ok(ValidatedPermit {
        owner,
        signed_nonce,
        deadline_seconds,
        message,
    })
}
