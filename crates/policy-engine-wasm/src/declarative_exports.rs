//! Compatibility JSON/WASM exports backed by the native Core decoder.
//!
//! The legacy module retains one registry per thread/WASM module. New Core
//! callers own independent `DecoderRegistry` instances directly.

use std::cell::RefCell;

use dambi_core::decode::DecoderRegistry;
use dambi_core::json::{EngineErrorDto, Envelope};
use wasm_bindgen::prelude::*;

thread_local! {
    static LEGACY_DECODER: RefCell<DecoderRegistry> = RefCell::new(DecoderRegistry::default());
}

fn envelope<T: serde::Serialize>(result: Result<T, EngineErrorDto>) -> String {
    match result {
        Ok(dto) => Envelope::ok(dto).to_json(),
        Err(error) => Envelope::<()>::err(error.kind, error.message).to_json(),
    }
}

#[wasm_bindgen]
pub fn declarative_install_v3_json(bundle_json: String) -> String {
    LEGACY_DECODER.with(|registry| envelope(registry.borrow_mut().install(&bundle_json)))
}

#[wasm_bindgen]
pub fn declarative_route_request_v3_json(input_json: String) -> String {
    LEGACY_DECODER.with(|registry| envelope(registry.borrow().route_request(&input_json)))
}

#[wasm_bindgen]
pub fn declarative_route_typed_data_v3_json(input_json: String) -> String {
    LEGACY_DECODER.with(|registry| envelope(registry.borrow().route_typed_data_v3(&input_json)))
}

#[wasm_bindgen]
pub fn declarative_route_typed_data_v4_json(input_json: String) -> String {
    let result = LEGACY_DECODER.with(|registry| registry.borrow().route_typed_data_v4(&input_json));
    match result {
        Ok(dto) => Envelope::ok(dto).to_json(),
        Err(error) => {
            let mut detail = serde_json::json!({"kind": error.kind, "message": error.message});
            if let Some(path) = error.path {
                detail["path"] = serde_json::Value::String(path);
            }
            serde_json::json!({"ok": false, "data": null, "error": detail}).to_string()
        }
    }
}
