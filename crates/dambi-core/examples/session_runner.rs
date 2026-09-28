//! Native counterpart for the SDK's real WASM parity regression.
//! Reads one local JSON scenario from stdin; performs no external I/O.

use std::io::{self, Read};

use dambi_core::session::CoreSession;
use serde_json::{json, Map, Value};

fn run(input: Value) -> Result<Value, String> {
    let now = input["nowMs"].as_u64().ok_or("missing nowMs")?;
    let mut session = CoreSession::new(
        &input["config"].to_string(),
        &input["policy"].to_string(),
        now,
    )
    .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let plan = session
        .plan(&input["request"].to_string(), now)
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    let mut results = Map::new();
    if let Some(facts) = input["facts"].as_array() {
        let calls = plan["calls"].as_array().ok_or("invalid plan calls")?;
        if facts.len() > calls.len() {
            return Err("more supplied facts than planned calls".into());
        }
        for (call, fact) in calls.iter().zip(facts) {
            if !fact.is_null() {
                results.insert(
                    call["callId"].as_str().ok_or("missing callId")?.into(),
                    fact.clone(),
                );
            }
        }
    }
    let id = plan["planId"].as_str().ok_or("missing planId")?;
    let verdict = session
        .evaluate(
            id,
            &json!({ "planId": id, "results": results }).to_string(),
            now,
        )
        .map_err(|error| format!("{}: {}", error.code, error.message))?;
    Ok(json!({ "plan": plan, "verdict": verdict }))
}

fn main() {
    let result = (|| {
        let mut input = String::new();
        io::stdin()
            .read_to_string(&mut input)
            .map_err(|e| e.to_string())?;
        run(serde_json::from_str(&input).map_err(|e| e.to_string())?)
    })();
    match result {
        Ok(output) => println!("{output}"),
        Err(error) => {
            eprintln!("native session: {error}");
            std::process::exit(1);
        }
    }
}
