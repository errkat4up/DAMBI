//! Preserve number tokens until their lossless conversion has been checked.
//! RawValue performs JSON syntax scanning without first rounding numbers to f64.

use std::collections::HashSet;
use std::fmt;

use serde::de::{MapAccess, Visitor};
use serde::{Deserialize, Deserializer};
use serde_json::{value::RawValue, Map, Number, Value};

use super::{PolicyParseError, PolicyParseErrorKind};

const MAX_DEPTH: usize = 128;
const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

fn invalid_json(path: &str, error: serde_json::Error) -> PolicyParseError {
    PolicyParseError::new(PolicyParseErrorKind::InvalidJson, path, error.to_string())
}

pub(super) fn child_path(parent: &str, key: &str) -> String {
    format!("{parent}/{}", key.replace('~', "~0").replace('/', "~1"))
}

struct Members<'a>(Vec<(String, &'a RawValue)>);

impl<'de> Deserialize<'de> for Members<'de> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MembersVisitor;
        impl<'de> Visitor<'de> for MembersVisitor {
            type Value = Members<'de>;

            fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str("a JSON object")
            }

            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut entries = Vec::new();
                while let Some(entry) = map.next_entry::<String, &'de RawValue>()? {
                    entries.push(entry);
                }
                Ok(Members(entries))
            }
        }
        deserializer.deserialize_map(MembersVisitor)
    }
}

pub(super) fn object_members<'a>(
    input: &'a str,
    path: &str,
) -> Result<Vec<(String, &'a RawValue)>, PolicyParseError> {
    let Members(entries) = serde_json::from_str(input).map_err(|e| invalid_json(path, e))?;
    let mut keys = HashSet::new();
    for (key, _) in &entries {
        if !keys.insert(key.as_str()) {
            return Err(PolicyParseError::new(
                PolicyParseErrorKind::DuplicateKey,
                child_path(path, key),
                "duplicate JSON member",
            ));
        }
    }
    Ok(entries)
}

pub(super) fn string(raw: &RawValue, path: &str) -> Result<String, PolicyParseError> {
    if !raw.get().starts_with('"') {
        return Err(PolicyParseError::new(
            PolicyParseErrorKind::InvalidStructure,
            path,
            "expected string",
        ));
    }
    // This decoder rejects lone surrogates; RawValue alone only scans syntax.
    serde_json::from_str(raw.get()).map_err(|e| invalid_json(path, e))
}

pub(crate) fn parse(input: &str) -> Result<Value, PolicyParseError> {
    let raw = serde_json::from_str::<&RawValue>(input).map_err(|e| invalid_json("$", e))?;
    value(raw, &mut "$".to_owned(), 0)
}

// Reuse one path buffer. Copying every ancestor path at each level would let a
// long key amplify memory usage up to the nesting limit before structure checks.
fn child_value(
    raw: &RawValue,
    path: &mut String,
    key: &str,
    depth: usize,
) -> Result<Value, PolicyParseError> {
    let parent_len = path.len();
    path.push('/');
    for character in key.chars() {
        match character {
            '~' => path.push_str("~0"),
            '/' => path.push_str("~1"),
            other => path.push(other),
        }
    }
    let result = value(raw, path, depth);
    path.truncate(parent_len);
    result
}

fn value(raw: &RawValue, path: &mut String, depth: usize) -> Result<Value, PolicyParseError> {
    let token = raw.get();
    if matches!(token.as_bytes()[0], b'{' | b'[') && depth >= MAX_DEPTH {
        return Err(PolicyParseError::new(
            PolicyParseErrorKind::DepthLimit,
            path.as_str(),
            "JSON nesting exceeds 128 containers",
        ));
    }
    match token.as_bytes()[0] {
        b'{' => {
            let mut object = Map::new();
            for (key, raw) in object_members(token, path)? {
                let child = child_value(raw, path, &key, depth + 1)?;
                object.insert(key, child);
            }
            Ok(Value::Object(object))
        }
        b'[' => {
            let raw_items: Vec<&RawValue> =
                serde_json::from_str(token).map_err(|e| invalid_json(path, e))?;
            raw_items
                .iter()
                .enumerate()
                .map(|(i, raw)| child_value(raw, path, &i.to_string(), depth + 1))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::Array)
        }
        b'"' => string(raw, path).map(Value::String),
        b'n' => Ok(Value::Null),
        b't' => Ok(Value::Bool(true)),
        b'f' => Ok(Value::Bool(false)),
        _ => number(token, path).map(Value::Number),
    }
}

fn number(token: &str, path: &str) -> Result<Number, PolicyParseError> {
    let error = || {
        PolicyParseError::new(
            PolicyParseErrorKind::InvalidNumber,
            path,
            "number must be finite, preserve its decimal value and use safe integers",
        )
    };
    let number = token.parse::<f64>().map_err(|_| error())?;
    if !number.is_finite() {
        return Err(error());
    }
    // Compare decimal values, not spelling: 42.0 / 4.2e1 equal 42, but
    // 1.0000000000000001 must not silently become 1. Same check catches underflow.
    match (decimal(token), decimal(&number.to_string())) {
        (Some(before), Some(after)) if before == after => {}
        _ => return Err(error()),
    }
    if number.fract() == 0.0 {
        if number.abs() > MAX_SAFE_INTEGER {
            return Err(error());
        }
        return Ok(if number < 0.0 {
            Number::from(number as i64)
        } else {
            Number::from(number as u64)
        });
    }
    Number::from_f64(number).ok_or_else(error)
}

/// Normalize an already syntax-checked decimal as sign, coefficient, exponent.
/// No floating-point arithmetic is used to decide whether conversion lost value.
fn decimal(token: &str) -> Option<(bool, String, i64)> {
    let negative = token.starts_with('-');
    let unsigned = token.strip_prefix('-').unwrap_or(token);
    let (mantissa, exponent) = unsigned.split_once(['e', 'E']).unwrap_or((unsigned, "0"));
    let fraction_len = mantissa
        .split_once('.')
        .map_or(0, |(_, fraction)| fraction.len());
    let digits: String = mantissa.chars().filter(|&c| c != '.').collect();
    let digits = digits.trim_start_matches('0');
    if digits.is_empty() {
        return Some((false, "0".into(), 0));
    }
    let coefficient = digits.trim_end_matches('0');
    let trailing = digits.len() - coefficient.len();
    let scale = exponent
        .parse::<i64>()
        .ok()?
        .checked_sub(i64::try_from(fraction_len).ok()?)?
        .checked_add(i64::try_from(trailing).ok()?)?;
    Some((negative, coefficient.into(), scale))
}
