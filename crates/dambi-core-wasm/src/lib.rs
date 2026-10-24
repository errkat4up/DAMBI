//! Package-private WebAssembly bridge to one native CoreSession.
//! Trust, snapshots, plans and evaluation remain in dambi-core.

use dambi_core::session::{CoreSession, SessionError};
use serde_json::{json, Value};
use wasm_bindgen::prelude::*;

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

fn integer(value: f64, field: &str) -> Result<u64, SessionError> {
    if !value.is_finite() || value < 0.0 || value > MAX_SAFE_INTEGER as f64 || value.fract() != 0.0
    {
        return Err(SessionError {
            code: "INVALID_CONFIG".into(),
            message: format!("{field} must be a nonnegative JavaScript-safe integer"),
        });
    }
    Ok(value as u64)
}

fn envelope(result: Result<Value, SessionError>) -> String {
    match result {
        Ok(data) => json!({ "ok": true, "data": data }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
    .to_string()
}

// Use the instance's captured SDK clock, not Date.now or a frozen now_ms.
// A failed/invalid callback is an invalid time sentinel, never a stale success.
fn read_clock(clock: &js_sys::Function) -> u64 {
    clock
        .call0(&JsValue::UNDEFINED)
        .ok()
        .and_then(|value| value.as_f64())
        .and_then(|value| integer(value, "clock").ok())
        .unwrap_or(MAX_SAFE_INTEGER + 1)
}

#[wasm_bindgen]
pub struct WasmCore {
    session: CoreSession,
}

#[wasm_bindgen]
impl WasmCore {
    #[wasm_bindgen(constructor)]
    pub fn new(config_json: &str, policy_json: &str, now_ms: f64) -> Result<WasmCore, JsValue> {
        let result = integer(now_ms, "nowMs")
            .and_then(|now| CoreSession::new(config_json, policy_json, now));
        result
            .map(|session| Self { session })
            .map_err(|error| JsValue::from_str(&json!(error).to_string()))
    }

    pub fn plan(&mut self, request_json: &str, now_ms: f64) -> String {
        envelope(integer(now_ms, "nowMs").and_then(|now| self.session.plan(request_json, now)))
    }

    pub fn evaluate(&mut self, plan_id: &str, facts_json: &str, now_ms: f64) -> String {
        envelope(
            integer(now_ms, "nowMs")
                .and_then(|now| self.session.evaluate(plan_id, facts_json, now)),
        )
    }

    pub fn evaluate_check(
        &mut self,
        plan_id: &str,
        facts_json: &str,
        now_ms: f64,
        failure: &str,
    ) -> String {
        envelope(integer(now_ms, "nowMs").and_then(|now| {
            self.session
                .evaluate_check(plan_id, facts_json, now, failure)
        }))
    }

    /// Additive scam channel; original evaluation entry points remain intact.
    pub fn evaluate_scam(
        &mut self,
        plan_id: &str,
        facts_json: &str,
        scam_input_json: &str,
        now_ms: f64,
        clock: &js_sys::Function,
    ) -> String {
        envelope(integer(now_ms, "nowMs").and_then(|now| {
            self.session.evaluate_scam(
                plan_id, facts_json, scam_input_json, now, &mut || read_clock(clock),
            )
        }))
    }

    pub fn evaluate_check_scam(
        &mut self,
        plan_id: &str,
        facts_json: &str,
        scam_input_json: &str,
        now_ms: f64,
        failure: &str,
        clock: &js_sys::Function,
    ) -> String {
        envelope(integer(now_ms, "nowMs").and_then(|now| {
            self.session.evaluate_check_scam(
                plan_id, facts_json, scam_input_json, now, failure, &mut || read_clock(clock),
            )
        }))
    }

    pub fn set_scam_settings(&mut self, settings_json: &str) -> String {
        envelope(self.session.set_scam_settings(settings_json).map(|()| Value::Null))
    }

    /// Deliberately absent from default production WASM builds.
    #[cfg(feature = "scam-test-fixtures")]
    pub fn install_scam_fixture(&mut self, fixture_json: &str, now_ms: f64) -> String {
        envelope(integer(now_ms, "nowMs").and_then(|now| {
            self.session.install_scam_fixture(fixture_json, now)?;
            Ok(Value::Null)
        }))
    }

    pub fn begin_refresh(&mut self) -> String {
        envelope(self.session.begin_refresh().and_then(|ticket| {
            if ticket > MAX_SAFE_INTEGER {
                return Err(SessionError {
                    code: "LIMIT_EXCEEDED".into(),
                    message: "refresh ticket exceeds the JavaScript-safe integer range".into(),
                });
            }
            Ok(json!(ticket))
        }))
    }

    pub fn commit_refresh(&mut self, ticket: f64, policy_json: &str, now_ms: f64) -> String {
        envelope(integer(ticket, "ticket").and_then(|ticket| {
            let now = integer(now_ms, "nowMs")?;
            self.session.commit_refresh(ticket, policy_json, now)?;
            Ok(Value::Null)
        }))
    }

    pub fn cancel_refresh(&mut self, ticket: f64) -> String {
        envelope(integer(ticket, "ticket").and_then(|ticket| {
            self.session.cancel_refresh(ticket)?;
            Ok(Value::Null)
        }))
    }

    pub fn dispose(&mut self) {
        self.session.dispose();
    }
}
