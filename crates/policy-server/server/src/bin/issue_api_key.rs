//! `issue_api_key` — mint or revoke a Policy Hub API key (for `POST /v1/audit`).
//!
//! Stores only the SHA-256 of the key and prints the plaintext ONCE on stdout.
//! Reads DATABASE_URL like the server. Does not run migrations.
//!
//!   cargo run -p policy-server --bin issue_api_key -- --label browser-extension
//!   cargo run -p policy-server --bin issue_api_key -- --revoke <key-uuid>

use std::time::{SystemTime, UNIX_EPOCH};

use policy_server::auth::api_key::{generate_api_key, hash_api_key};
use policy_server::config::ServerConfig;
use policy_server::storage::StorageBackend;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (label, revoke) = parse_args(&args)?;

    let config = ServerConfig::from_env();
    let storage = StorageBackend::open_with_options(&config, false).await?;
    let db = storage.global_db();
    let now = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())?;

    if let Some(id) = revoke {
        let done = policy_db::audit::revoke_api_key(db.pool(), id, now).await?;
        eprintln!(
            "[issue_api_key] {} {id}",
            if done {
                "revoked"
            } else {
                "not found or already revoked:"
            }
        );
        return Ok(());
    }

    let label = label.ok_or("--label <name> is required (or --revoke <uuid>)")?;
    let key = generate_api_key();
    let id = policy_db::audit::create_api_key(db.pool(), &hash_api_key(&key), &label, now).await?;
    eprintln!("[issue_api_key] created key id={id} label={label}");
    eprintln!("[issue_api_key] plaintext below is shown ONCE and is not stored:");
    println!("{key}");
    Ok(())
}

fn parse_args(args: &[String]) -> Result<(Option<String>, Option<Uuid>), String> {
    let mut label = None;
    let mut revoke = None;
    let mut i = 0;
    while i < args.len() {
        match args[i].as_str() {
            "--label" => {
                label = Some(args.get(i + 1).cloned().ok_or("--label needs a value")?);
                i += 2;
            }
            "--revoke" => {
                let raw = args.get(i + 1).ok_or("--revoke needs a key uuid")?;
                revoke = Some(Uuid::parse_str(raw).map_err(|e| format!("bad uuid: {e}"))?);
                i += 2;
            }
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok((label, revoke))
}
