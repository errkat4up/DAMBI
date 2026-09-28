//! All-or-nothing content validation for authenticated policy bundles.

use std::collections::HashSet;
use std::str::FromStr;

use cedar_policy::PolicySet;
use policy_engine::policy::PolicyEngine;
use policy_engine::policy_rpc::{
    ManifestV2, ProjectionType, MAX_POLICY_RPC_V2_CALL_SPECS,
    MAX_POLICY_RPC_V2_CUSTOM_CONTEXT_FIELDS, MAX_POLICY_RPC_V2_MANIFESTS,
    MAX_POLICY_RPC_V2_OUTPUTS_PER_CALL,
};
use policy_engine::schema::compose_per_policy;
use serde_json::{Map, Value};

use super::semantics::{PolicySemanticError, PolicySemanticErrorKind};

/// The caller has already checked the payload wire structure and signature.
/// Every policy is checked, including policies that match no current request.
pub(super) fn validate_policies(payload: &Value) -> Result<Vec<ManifestV2>, PolicySemanticError> {
    let entries = payload["policies"]
        .as_array()
        .ok_or_else(|| invalid("$/policies", "policies must be an array"))?;
    if entries.is_empty() {
        return Err(invalid("$/policies", "policies must not be empty"));
    }
    check_count(entries.len(), MAX_POLICY_RPC_V2_MANIFESTS, "$/policies")?;

    let mut ids = HashSet::new();
    let mut call_ids = HashSet::new();
    let mut manifests = Vec::with_capacity(entries.len());
    let mut compilations = Vec::with_capacity(entries.len());
    for (index, entry) in entries.iter().enumerate() {
        let path = format!("$/policies/{index}");
        let id = entry["id"]
            .as_str()
            .ok_or_else(|| invalid(format!("{path}/id"), "policy id must be a string"))?;
        if !ids.insert(id) {
            return Err(invalid(format!("{path}/id"), "duplicate policy id"));
        }
        let manifest_path = format!("{path}/manifest");
        validate_nested_fields(&entry["manifest"], &manifest_path)?;
        let manifest: ManifestV2 = serde_json::from_value(entry["manifest"].clone())
            .map_err(|error| invalid(&manifest_path, format!("invalid ManifestV2: {error}")))?;
        if manifest.id != id {
            return Err(invalid(
                format!("{manifest_path}/id"),
                "manifest id must equal its policy entry id",
            ));
        }
        validate_manifest(&manifest, &manifest_path)?;
        for (index, call) in manifest.policy_rpc.iter().enumerate() {
            // The current planner's delimiter encoding must stay unambiguous
            // until Core plans map these pairs to opaque IDs.
            if !call_ids.insert(format!("{}::{}", manifest.id, call.id)) {
                return Err(invalid(
                    format!("{manifest_path}/policy_rpc/{index}/id"),
                    "policy RPC call id collides with another manifest/spec pair",
                ));
            }
        }

        let policy_path = format!("{path}/policy");
        let source = entry["policy"]
            .as_str()
            .ok_or_else(|| invalid(&policy_path, "policy must be Cedar text"))?;
        let set = PolicySet::from_str(source)
            .map_err(|error| invalid(&policy_path, format!("invalid Cedar policy: {error}")))?;
        if set.templates().next().is_some() {
            return Err(invalid(&policy_path, "policy templates are not supported"));
        }
        let mut policies = set.policies();
        let policy = policies
            .next()
            .ok_or_else(|| invalid(&policy_path, "entry must contain one static Cedar policy"))?;
        if policies.next().is_some() {
            return Err(invalid(
                &policy_path,
                "entry must contain exactly one static Cedar policy",
            ));
        }
        if policy.annotation("id") != Some(id) {
            return Err(invalid(
                &policy_path,
                "Cedar @id must equal its policy entry id",
            ));
        }
        let est = policy.to_json().map_err(|error| {
            invalid(
                &policy_path,
                format!("cannot inspect Cedar policy: {error}"),
            )
        })?;
        validate_custom_refs(&est, &manifest, &policy_path)?;
        let schema = compose_per_policy(&manifest)
            .map_err(|error| invalid(&manifest_path, format!("invalid policy schema: {error}")))?;
        compilations.push((source.to_owned(), schema));
        manifests.push(manifest);
    }

    // The engine validates each source against only its own schema, then checks
    // the complete policy set (including annotation IDs and severities). Unlike
    // runtime quarantine, any error here rejects the whole authenticated bundle.
    PolicyEngine::build_from_per_policy(&compilations)
        .map_err(|error| invalid("$/policies", format!("policy compilation failed: {error}")))?;
    Ok(manifests)
}

fn validate_nested_fields(manifest: &Value, path: &str) -> Result<(), PolicySemanticError> {
    if let Some(trigger) = manifest.get("trigger") {
        closed_object(trigger, &format!("{path}/trigger"), &["scope", "where"])?;
    }
    if let Some(context) = manifest.get("custom_context") {
        closed_object(context, &format!("{path}/custom_context"), &["fields"])?;
    }
    if let Some(calls) = manifest.get("policy_rpc") {
        let path = format!("{path}/policy_rpc");
        let calls = calls
            .as_array()
            .ok_or_else(|| invalid(&path, "policy_rpc must be an array"))?;
        for (index, call) in calls.iter().enumerate() {
            let path = format!("{path}/{index}");
            let call = closed_object(
                call,
                &path,
                &["id", "method", "params", "outputs", "optional"],
            )?;
            if let Some(outputs) = call.get("outputs") {
                let path = format!("{path}/outputs");
                let outputs = outputs
                    .as_array()
                    .ok_or_else(|| invalid(&path, "outputs must be an array"))?;
                for (index, output) in outputs.iter().enumerate() {
                    closed_object(
                        output,
                        &format!("{path}/{index}"),
                        &["kind", "field", "type", "from", "required"],
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn validate_manifest(manifest: &ManifestV2, path: &str) -> Result<(), PolicySemanticError> {
    check_count(
        manifest.policy_rpc.len(),
        MAX_POLICY_RPC_V2_CALL_SPECS,
        &format!("{path}/policy_rpc"),
    )?;
    check_count(
        manifest.custom_context.fields.len(),
        MAX_POLICY_RPC_V2_CUSTOM_CONTEXT_FIELDS,
        &format!("{path}/custom_context/fields"),
    )?;
    for (field, type_name) in &manifest.custom_context.fields {
        let path = child_path(&format!("{path}/custom_context/fields"), field);
        if !is_identifier(field) {
            return Err(invalid(&path, "custom field must be a Cedar identifier"));
        }
        if supported_type(type_name).is_none() {
            return Err(invalid(&path, "unsupported custom field type"));
        }
    }
    for (index, call) in manifest.policy_rpc.iter().enumerate() {
        let path = format!("{path}/policy_rpc/{index}");
        if call.id.is_empty() {
            return Err(invalid(format!("{path}/id"), "call id must not be empty"));
        }
        if call.method.is_empty() {
            return Err(invalid(
                format!("{path}/method"),
                "method must not be empty",
            ));
        }
        for (name, value) in &call.params {
            // The planner substitutes only top-level strings beginning with $.;
            // nested objects/arrays and other strings are literal parameters.
            if let Some(selector) = value.as_str().filter(|value| value.starts_with("$.")) {
                validate_selector(
                    selector,
                    false,
                    &child_path(&format!("{path}/params"), name),
                )?;
            }
        }
        check_count(
            call.outputs.len(),
            MAX_POLICY_RPC_V2_OUTPUTS_PER_CALL,
            &format!("{path}/outputs"),
        )?;
        for (index, output) in call.outputs.iter().enumerate() {
            let path = format!("{path}/outputs/{index}");
            if output.kind != "context" {
                return Err(invalid(
                    format!("{path}/kind"),
                    "projection kind must be context",
                ));
            }
            validate_selector(&output.from, true, &format!("{path}/from"))?;
            let projection_type = match &output.type_name {
                ProjectionType::String => "String",
                ProjectionType::Long => "Long",
                ProjectionType::Bool => "Bool",
                ProjectionType::Decimal => "decimal",
                ProjectionType::SetString => "Set<String>",
                ProjectionType::UsdValuation | ProjectionType::WindowStats => {
                    return Err(invalid(
                        format!("{path}/type"),
                        "legacy record projections are not supported by ManifestV2",
                    ));
                }
            };
            let declared = manifest
                .custom_context
                .fields
                .get(&output.field)
                .and_then(|name| supported_type(name));
            if declared != Some(projection_type) {
                return Err(invalid(
                    format!("{path}/type"),
                    "projection type must match its declared custom field type",
                ));
            }
        }
    }
    manifest
        .validate()
        .map_err(|error| invalid(path, format!("invalid ManifestV2: {error}")))
}

fn validate_selector(selector: &str, output: bool, path: &str) -> Result<(), PolicySemanticError> {
    let Some(selector) = selector.strip_prefix("$.") else {
        return Err(invalid(path, "selector must start with $."));
    };
    if selector
        .chars()
        .any(|ch| matches!(ch, '[' | ']' | '*' | '(' | ')'))
    {
        return Err(invalid(path, "unsupported selector syntax"));
    }
    let parts: Vec<_> = selector.split('.').collect();
    if parts.iter().any(|part| part.is_empty()) {
        return Err(invalid(path, "selector contains an empty segment"));
    }
    if output {
        if parts[0] != "result" {
            return Err(invalid(path, "output selector must use $.result"));
        }
    } else {
        match parts[0] {
            "action" => {}
            "root" => {
                if parts.len() > 2
                    || (parts.len() == 2 && !matches!(parts[1], "chain_id" | "from" | "to"))
                {
                    return Err(invalid(path, "unknown transaction root field"));
                }
            }
            _ => {
                return Err(invalid(
                    path,
                    "parameter selector must use $.root or $.action",
                ));
            }
        }
    }
    Ok(())
}

fn supported_type(name: &str) -> Option<&str> {
    match name {
        "String" | "Long" | "Bool" | "Set<String>" => Some(name),
        "Decimal" | "decimal" => Some("decimal"),
        _ => None,
    }
}

fn is_identifier(name: &str) -> bool {
    let mut bytes = name.bytes();
    matches!(bytes.next(), Some(b'a'..=b'z' | b'A'..=b'Z' | b'_'))
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

/// Inspect parsed EST instead of scanning source text: comments, annotations,
/// and string literals containing context.custom are not field references.
fn validate_custom_refs(
    est: &Value,
    manifest: &ManifestV2,
    path: &str,
) -> Result<(), PolicySemanticError> {
    let mut pending = vec![est];
    while let Some(value) = pending.pop() {
        match value {
            Value::Array(values) => pending.extend(values),
            Value::Object(object) => {
                for operator in [".", "has"] {
                    if let Some(operation) = object.get(operator) {
                        let fields = match &operation["attr"] {
                            Value::String(field) => vec![field.as_str()],
                            Value::Array(attributes) => {
                                attributes.iter().filter_map(Value::as_str).collect()
                            }
                            _ => Vec::new(),
                        };
                        validate_receiver_refs(&operation["left"], fields, manifest, path)?;
                    }
                }
                pending.extend(object.values());
            }
            _ => {}
        }
    }
    Ok(())
}

/// Follow every possible origin of an attribute receiver. A conditional can
/// return context.custom, and a record can give it a different local name; both
/// still refer to the same manifest-declared fields. Do not constant-fold either
/// branch, because Cedar can otherwise accept an undeclared, dead `has` guard.
fn validate_receiver_refs<'a>(
    expression: &'a Value,
    fields: Vec<&'a str>,
    manifest: &ManifestV2,
    path: &str,
) -> Result<(), PolicySemanticError> {
    let mut pending = vec![(expression, fields)];
    while let Some((current, mut fields)) = pending.pop() {
        if current.get("Var").and_then(Value::as_str) == Some("context") {
            if fields.len() >= 2
                && fields[0] == "custom"
                && !manifest.custom_context.fields.contains_key(fields[1])
            {
                return Err(invalid(
                    path,
                    format!("undeclared custom context field {}", fields[1]),
                ));
            }
        } else if let Some(access) = current.get(".") {
            if let Some(field) = access["attr"].as_str() {
                fields.insert(0, field);
                pending.push((&access["left"], fields));
            }
        } else if let Some(branches) = current.get("if-then-else") {
            pending.push((&branches["then"], fields.clone()));
            pending.push((&branches["else"], fields));
        } else if let Some(record) = current.get("Record") {
            if let Some(field) = fields.first() {
                if let Some(value) = record.get(*field) {
                    pending.push((value, fields[1..].to_vec()));
                }
            }
        }
    }
    Ok(())
}

fn closed_object<'a>(
    value: &'a Value,
    path: &str,
    allowed: &[&str],
) -> Result<&'a Map<String, Value>, PolicySemanticError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid(path, "expected an object"))?;
    for key in object.keys() {
        if !allowed.contains(&key.as_str()) {
            return Err(invalid(child_path(path, key), "unsupported manifest field"));
        }
    }
    Ok(object)
}

fn child_path(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn check_count(count: usize, maximum: usize, path: &str) -> Result<(), PolicySemanticError> {
    if count > maximum {
        Err(PolicySemanticError::new(
            PolicySemanticErrorKind::LimitExceeded,
            path,
            format!("item count {count} exceeds {maximum}"),
        ))
    } else {
        Ok(())
    }
}

fn invalid(path: impl Into<String>, message: impl Into<String>) -> PolicySemanticError {
    PolicySemanticError::new(PolicySemanticErrorKind::InvalidPolicyBundle, path, message)
}
