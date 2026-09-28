//! Legacy JSON/WASM entry points for the native Core policy runtime.

use dambi_core::json::{EngineErrorDto, Envelope};
use dambi_core::runtime::json as runtime_json;
use wasm_bindgen::prelude::wasm_bindgen;

// Diagnosis shares the same lowering/materialization and transaction types.
pub(crate) use dambi_core::runtime::dto::{BundleInput, TxInput};
pub(crate) use dambi_core::runtime::{entities_for_tx, materialized_context};

fn envelope<T: serde::Serialize>(result: Result<T, EngineErrorDto>) -> String {
    match result {
        Ok(data) => Envelope::ok(data).to_json(),
        Err(error) => Envelope::<()>::err(error.kind, error.message).to_json(),
    }
}

#[wasm_bindgen]
#[must_use]
pub fn plan_action_rpc_v2_json(input_json: String) -> String {
    envelope(runtime_json::plan_action_rpc_v2(&input_json))
}

#[wasm_bindgen]
#[must_use]
pub fn evaluate_action_v2_json(input_json: String) -> String {
    Envelope::ok(runtime_json::evaluate_action_v2(&input_json)).to_json()
}

#[wasm_bindgen]
#[must_use]
pub fn debug_lowered_context_v2_json(input_json: String) -> String {
    envelope(runtime_json::debug_lowered_context_v2(&input_json))
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::too_many_lines)]
pub(crate) mod tests;
