//! Native backend for the shared DEC/D3 fixture assertions.
//! Build explicitly, then pass one JSON scenario on stdin. No network or files.

use std::io::{self, Read};

use dambi_core::{
    decode::DecoderRegistry,
    json::{EngineErrorDto, Envelope},
    runtime::json as runtime,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Deserialize)]
struct DecoderScenario {
    bundles: Vec<Value>,
    requests: Vec<Request>,
    #[serde(rename = "policyBundle")]
    policy_bundle: Option<Value>,
}

#[derive(Deserialize)]
struct Request {
    id: String,
    #[serde(default = "transaction_kind")]
    kind: String,
    input: Value,
}

#[derive(Deserialize)]
struct PolicyScenario {
    input: Value,
    bundles: Vec<Value>,
}

fn transaction_kind() -> String {
    "transaction".into()
}

fn envelope<T: Serialize>(result: Result<T, EngineErrorDto>) -> Value {
    match result {
        Ok(data) => serde_json::to_value(Envelope::ok(data)).unwrap(),
        Err(error) => serde_json::to_value(Envelope::<()>::err(error.kind, error.message)).unwrap(),
    }
}

fn policy(input: Value, bundles: Vec<Value>) -> Result<Value, String> {
    let mut input = input
        .as_object()
        .cloned()
        .ok_or("policy input must be an object")?;
    let manifests = bundles
        .iter()
        .map(|bundle| {
            bundle
                .get("manifest")
                .cloned()
                .ok_or("policy bundle is missing its manifest")
        })
        .collect::<Result<Vec<_>, _>>()?;
    input.insert("manifests".into(), json!(manifests));
    let plan = envelope(runtime::plan_action_rpc_v2(
        &Value::Object(input.clone()).to_string(),
    ));
    input.remove("manifests");
    input.insert("bundles".into(), json!(bundles));
    input.insert("results".into(), json!({}));
    let evaluation = Envelope::ok(runtime::evaluate_action_v2(
        &Value::Object(input).to_string(),
    ));
    Ok(json!({ "plan": plan, "evaluation": evaluation }))
}

fn decoder(scenario: DecoderScenario) -> Result<Value, String> {
    // All installs and alternating/repeated requests in a scenario share state.
    let mut registry = DecoderRegistry::default();
    let mut installations = Vec::new();
    for bundle in scenario.bundles {
        let id = bundle["id"]
            .as_str()
            .ok_or("decoder bundle is missing id")?;
        let result = registry
            .install(&bundle.to_string())
            .map_err(|error| format!("install failed for {id}: {error:?}"))?;
        if result.bundle_id != id || result.decoder_id != id {
            return Err(format!("installed decoder id does not match {id}"));
        }
        installations.push(Envelope::ok(result));
    }

    let mut results = Vec::new();
    for Request { id, kind, input } in scenario.requests {
        if scenario.policy_bundle.is_some() && kind != "transaction" {
            return Err("DEC-02 policy evaluation requires a transaction request".into());
        }
        let input_json = input.to_string();
        // Route exactly once. A strict error/miss never retries the v3 path.
        let result = match kind.as_str() {
            "transaction" => envelope(registry.route_request(&input_json)),
            "typed" => envelope(registry.route_typed_data_v3(&input_json)),
            "typed_strict" => match registry.route_typed_data_v4(&input_json) {
                Ok(data) => serde_json::to_value(Envelope::ok(data)).unwrap(),
                Err(error) => {
                    let mut detail = json!({ "kind": error.kind, "message": error.message });
                    if let Some(path) = error.path {
                        detail["path"] = json!(path);
                    }
                    json!({ "ok": false, "data": null, "error": detail })
                }
            },
            _ => return Err(format!("unknown request kind: {kind}")),
        };
        let Some(bundle) = scenario.policy_bundle.as_ref() else {
            results.push(json!({ "id": id, "result": result }));
            continue;
        };
        if result["ok"] != true || !result["error"].is_null() {
            return Err(format!(
                "decode before policy evaluation failed: {id}: {result}"
            ));
        }
        let actions = result["data"]["actions"]
            .as_array()
            .filter(|actions| actions.len() == 1)
            .ok_or_else(|| format!("policy fixture {id} must decode exactly one Action"))?;
        let decoded = &actions[0];
        let chain_id = match &input["chain_id"] {
            Value::String(chain_id) => chain_id.clone(),
            Value::Number(chain_id) => chain_id.to_string(),
            _ => return Err(format!("transaction {id} is missing chain_id")),
        };
        // Forward the actual decoded Action, with routing from the request.
        let evaluation_input = json!({
            "action": decoded["body"],
            "meta": decoded["meta"],
            "tx": {
                "chain_id": format!("eip155:{chain_id}"),
                "from": input["submitter"],
                "to": input["to"],
            },
        });
        let mut output = policy(evaluation_input, vec![bundle.clone()])?;
        output["id"] = json!(id);
        output["result"] = result;
        results.push(output);
    }
    Ok(json!({ "installations": installations, "results": results }))
}

fn run() -> Result<Value, String> {
    let mut args = std::env::args().skip(1);
    let mode = args.next().ok_or("expected decoder or policy mode")?;
    if args.next().is_some() {
        return Err("expected one mode argument".into());
    }
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|e| e.to_string())?;
    match mode.as_str() {
        "decoder" => decoder(serde_json::from_str(&input).map_err(|e| e.to_string())?),
        "policy" => {
            let scenario: PolicyScenario =
                serde_json::from_str(&input).map_err(|e| e.to_string())?;
            policy(scenario.input, scenario.bundles)
        }
        _ => Err(format!("unknown fixture mode: {mode}")),
    }
}

fn main() {
    match run() {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("native fixture runner: {error}");
            std::process::exit(1);
        }
    }
}
