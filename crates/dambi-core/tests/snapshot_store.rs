//! Snapshot publication, instance-owned refresh authority, and lifecycle.

#[path = "support/snapshot.rs"]
mod support;

use dambi_core::{
    bundle::{KeyRole, PolicyUpdate},
    snapshot::SnapshotStore,
};
use serde_json::json;
use std::sync::Arc;
use support::*;

#[test]
fn initialization_publishes_one_complete_pair_and_owns_the_input_data() {
    let mut decoder = artifact(vec![approve_bundle()]);
    let mut policy = day1();
    let original_policy = policy.payload.clone();
    let mut local = config();
    let store = SnapshotStore::new(local.clone(), decoder.input(), policy.input(), NOW).unwrap();
    decoder.bytes.fill(0);
    policy.payload.fill(0);
    policy.signature.clear();
    local.keys.clear();
    let snapshot = store.current(NOW).unwrap();
    assert_eq!(snapshot.policy().sequence(), 42);
    assert_eq!(snapshot.policy().manifests().len(), 5);
    assert_eq!(
        snapshot
            .policy()
            .signature_verified()
            .parsed()
            .payload_bytes(),
        original_policy
    );
    assert_approve(&snapshot, CONTRACT, BUNDLE_ID);
    assert!(Arc::ptr_eq(&snapshot, &store.current(NOW).unwrap()));
}

#[test]
fn replacement_publishes_a_new_arc_and_preserves_retained_snapshot_contents() {
    let mut store = store();
    let old = store.current(NOW).unwrap();
    let old_deadline = old.policy().valid_until_ms();
    let old_payload = old
        .policy()
        .signature_verified()
        .parsed()
        .payload_bytes()
        .to_vec();
    let ticket = store.begin_refresh().unwrap();
    let changed = signed_policy(policy_value(43));
    let prepared = store
        .prepare_refresh(&ticket, changed.input(), NOW)
        .unwrap();
    assert!(Arc::ptr_eq(&old, &store.current(NOW).unwrap()));
    assert_eq!(
        store.commit_refresh(prepared, NOW).unwrap(),
        PolicyUpdate::Replace
    );
    let current = store.current(NOW).unwrap();
    assert!(!Arc::ptr_eq(&old, &current));
    assert_eq!(current.policy().sequence(), 43);
    assert_eq!(old.policy().sequence(), 42);
    assert_eq!(old.policy().valid_until_ms(), old_deadline);
    assert_eq!(
        old.policy().signature_verified().parsed().payload_bytes(),
        old_payload
    );
    assert!(std::ptr::eq(old.decoder(), current.decoder()));
    old.ensure_usable(NOW).unwrap();
    assert_approve(&old, CONTRACT, BUNDLE_ID);
    assert_approve(&current, CONTRACT, BUNDLE_ID);
}

#[test]
fn unchanged_bytes_keep_the_arc_but_rollback_and_same_sequence_changes_fail() {
    let mut store = store();
    let old = store.current(NOW).unwrap();
    let mut identical = day1();
    identical.key_id = Some("different-response-telemetry".into());
    let ticket = store.begin_refresh().unwrap();
    let prepared = store
        .prepare_refresh(&ticket, identical.input(), NOW)
        .unwrap();
    assert_eq!(
        store.commit_refresh(prepared, NOW).unwrap(),
        PolicyUpdate::Unchanged
    );
    assert!(Arc::ptr_eq(&old, &store.current(NOW).unwrap()));
    assert_eq!(
        old.policy().signature_verified().parsed().key_id(),
        Some("d4-test-only-policy")
    );

    let mut changed_bytes = day1().payload;
    changed_bytes.push(b'\n');
    for rejected in [signed_policy(policy_value(41)), signed_raw(changed_bytes)] {
        let ticket = store.begin_refresh().unwrap();
        let prepared = store
            .prepare_refresh(&ticket, rejected.input(), NOW)
            .unwrap();
        expect_code(
            store.commit_refresh(prepared, NOW),
            "POLICY_SEQUENCE_REJECTED",
        );
        assert!(Arc::ptr_eq(&old, &store.current(NOW).unwrap()));
        expect_code(
            store.prepare_refresh(&ticket, day1().input(), NOW),
            "ABORTED",
        );
    }
}

#[test]
fn failed_authentication_or_validation_never_changes_the_active_snapshot() {
    let mut store = store();
    let old = store.current(NOW).unwrap();
    let mut signature_mismatch = day1();
    signature_mismatch.payload.push(b' ');
    let mut wrong_scope = policy_value(43);
    wrong_scope["env"] = json!("production");
    let mut invalid_content = policy_value(43);
    invalid_content["policies"][0]["policy"] = json!("not valid Cedar");
    let mut expired = policy_value(43);
    expired["expires_at"] = json!(NOW / 1000);
    for (candidate, code) in [
        (signature_mismatch, "INVALID_SIGNATURE"),
        (signed_raw(b"{".to_vec()), "INVALID_POLICY_BUNDLE"),
        (signed_policy(wrong_scope), "POLICY_SCOPE_MISMATCH"),
        (signed_policy(invalid_content), "INVALID_POLICY_BUNDLE"),
        (signed_policy(expired), "POLICY_EXPIRED"),
    ] {
        let ticket = store.begin_refresh().unwrap();
        expect_code(store.prepare_refresh(&ticket, candidate.input(), NOW), code);
        store.cancel_refresh(&ticket).unwrap();
        assert!(Arc::ptr_eq(&old, &store.current(NOW).unwrap()));
    }
    assert_approve(&old, CONTRACT, BUNDLE_ID);
}

#[test]
fn latest_begun_request_wins_even_when_completion_order_and_sequence_disagree() {
    let mut store = store();
    let first = store.begin_refresh().unwrap();
    let first_policy = signed_policy(policy_value(100));
    let first_prepared = store
        .prepare_refresh(&first, first_policy.input(), NOW)
        .unwrap();
    let latest = store.begin_refresh().unwrap();
    expect_code(
        store.prepare_refresh(&first, first_policy.input(), NOW),
        "ABORTED",
    );
    let latest_policy = signed_policy(policy_value(43));
    let latest_prepared = store
        .prepare_refresh(&latest, latest_policy.input(), NOW)
        .unwrap();
    let duplicate_prepared = store
        .prepare_refresh(&latest, latest_policy.input(), NOW)
        .unwrap();
    assert_eq!(
        store.commit_refresh(latest_prepared, NOW).unwrap(),
        PolicyUpdate::Replace
    );
    expect_code(store.commit_refresh(first_prepared, NOW), "ABORTED");
    expect_code(store.commit_refresh(duplicate_prepared, NOW), "ABORTED");
    assert_eq!(store.current(NOW).unwrap().policy().sequence(), 43);
}

#[test]
fn a_failed_new_request_does_not_reactivate_an_older_prepared_candidate() {
    let mut store = store();
    let old = store.current(NOW).unwrap();
    let first = store.begin_refresh().unwrap();
    let replacement = signed_policy(policy_value(43));
    let prepared = store
        .prepare_refresh(&first, replacement.input(), NOW)
        .unwrap();
    let latest = store.begin_refresh().unwrap();
    let mut bad = day1();
    bad.payload.push(b'\n');
    expect_code(
        store.prepare_refresh(&latest, bad.input(), NOW),
        "INVALID_SIGNATURE",
    );
    store.cancel_refresh(&latest).unwrap();
    expect_code(store.commit_refresh(prepared, NOW), "ABORTED");
    assert!(Arc::ptr_eq(&old, &store.current(NOW).unwrap()));
}

#[test]
fn foreign_old_cancelled_and_consumed_capabilities_cannot_affect_a_pending_refresh() {
    let mut first_store = store();
    let mut second_store = store();
    let first = first_store.begin_refresh().unwrap();
    let policy = signed_policy(policy_value(43));
    let foreign = first_store
        .prepare_refresh(&first, policy.input(), NOW)
        .unwrap();
    let second = second_store.begin_refresh().unwrap();
    let own = second_store
        .prepare_refresh(&second, policy.input(), NOW)
        .unwrap();
    expect_code(
        second_store.prepare_refresh(&first, policy.input(), NOW),
        "ABORTED",
    );
    expect_code(second_store.cancel_refresh(&first), "ABORTED");
    expect_code(second_store.commit_refresh(foreign, NOW), "ABORTED");
    assert_eq!(
        second_store.commit_refresh(own, NOW).unwrap(),
        PolicyUpdate::Replace
    );
    expect_code(
        second_store.prepare_refresh(&second, policy.input(), NOW),
        "ABORTED",
    );

    let latest = first_store.begin_refresh().unwrap();
    expect_code(first_store.cancel_refresh(&first), "ABORTED");
    let pending = first_store
        .prepare_refresh(&latest, policy.input(), NOW)
        .unwrap();
    first_store.cancel_refresh(&latest).unwrap();
    expect_code(first_store.commit_refresh(pending, NOW), "ABORTED");
    expect_code(
        first_store.prepare_refresh(&latest, policy.input(), NOW),
        "ABORTED",
    );
    assert_eq!(first_store.current(NOW).unwrap().policy().sequence(), 42);
}

#[test]
fn commit_rechecks_expiry_and_an_expired_active_snapshot_keeps_its_sequence_floor() {
    let mut initial = policy_value(42);
    initial["expires_at"] = json!(NOW / 1000 + 2);
    let initial = signed_policy(initial);
    let mut store = SnapshotStore::new(
        config(),
        artifact(vec![approve_bundle()]).input(),
        initial.input(),
        NOW,
    )
    .unwrap();
    let old = store.current(NOW).unwrap();
    let mut short_lived = policy_value(43);
    short_lived["expires_at"] = json!(NOW / 1000 + 1);
    let short_lived = signed_policy(short_lived);
    let ticket = store.begin_refresh().unwrap();
    let prepared = store
        .prepare_refresh(&ticket, short_lived.input(), NOW)
        .unwrap();
    expect_code(store.commit_refresh(prepared, NOW + 1000), "POLICY_EXPIRED");
    assert!(Arc::ptr_eq(&old, &store.current(NOW + 1000).unwrap()));
    expect_code(store.current(NOW + 2000), "POLICY_EXPIRED");
    expect_code(old.ensure_usable(NOW + 2000), "POLICY_EXPIRED");

    for (sequence, code) in [(41, Some("POLICY_SEQUENCE_REJECTED")), (43, None)] {
        let mut candidate = policy_value(sequence);
        candidate["issued_at"] = json!(NOW / 1000 + 2);
        let candidate = signed_policy(candidate);
        let ticket = store.begin_refresh().unwrap();
        let prepared = store
            .prepare_refresh(&ticket, candidate.input(), NOW + 2000)
            .unwrap();
        let result = store.commit_refresh(prepared, NOW + 2000);
        if let Some(code) = code {
            expect_code(result, code);
        } else {
            assert_eq!(result.unwrap(), PolicyUpdate::Replace);
        }
    }
    assert_eq!(store.current(NOW + 2000).unwrap().policy().sequence(), 43);
    assert_eq!(old.policy().sequence(), 42);
    expect_code(old.ensure_usable(NOW + 2000), "POLICY_EXPIRED");
}

#[test]
fn independent_stores_keep_their_own_trust_registry_and_lifecycle() {
    let mut first = store();
    let mut other_bundle = approve_bundle();
    other_bundle["id"] = json!("test/second@1");
    other_bundle["match"]["chain_to_addresses"] = json!({"1":[SECOND_CONTRACT]});
    let mut other_config = config();
    other_config.keys = vec![key("decoder", KeyRole::Policy)];
    let mut other_policy = day1();
    other_policy.signature = sign("decoder", &other_policy.payload);
    let second = SnapshotStore::new(
        other_config,
        artifact(vec![other_bundle]).input(),
        other_policy.input(),
        NOW,
    )
    .unwrap();
    let old_first = first.current(NOW).unwrap();
    let second_snapshot = second.current(NOW).unwrap();
    assert_approve(&old_first, CONTRACT, BUNDLE_ID);
    assert_approve(&second_snapshot, SECOND_CONTRACT, "test/second@1");
    assert!(old_first
        .decoder()
        .registry()
        .route_request(&approve_request(SECOND_CONTRACT))
        .is_err());
    assert!(second_snapshot
        .decoder()
        .registry()
        .route_request(&approve_request(CONTRACT))
        .is_err());
    let ticket = first.begin_refresh().unwrap();
    expect_code(
        first.prepare_refresh(&ticket, other_policy.input(), NOW),
        "INVALID_SIGNATURE",
    );
    first.dispose();
    expect_code(old_first.ensure_usable(NOW), "DISPOSED");
    second_snapshot.ensure_usable(NOW).unwrap();
    assert_approve(
        &second.current(NOW).unwrap(),
        SECOND_CONTRACT,
        "test/second@1",
    );
}

#[test]
fn dispose_and_drop_invalidate_pending_work_and_retained_snapshots() {
    let mut store = store();
    let snapshot = store.current(NOW).unwrap();
    let ticket = store.begin_refresh().unwrap();
    let policy = signed_policy(policy_value(43));
    let prepared = store.prepare_refresh(&ticket, policy.input(), NOW).unwrap();
    store.dispose();
    store.dispose();
    assert!(store.is_disposed());
    expect_code(store.current(NOW), "DISPOSED");
    expect_code(store.begin_refresh(), "DISPOSED");
    expect_code(
        store.prepare_refresh(&ticket, policy.input(), NOW),
        "DISPOSED",
    );
    expect_code(store.commit_refresh(prepared, NOW), "DISPOSED");
    expect_code(store.cancel_refresh(&ticket), "DISPOSED");
    expect_code(snapshot.ensure_usable(NOW), "DISPOSED");
    // Data remains immutable/readable, but the lifecycle guard forbids use.
    assert_eq!(snapshot.policy().sequence(), 42);
    let retained_after_drop = {
        let temporary = support::store();
        temporary.current(NOW).unwrap()
    };
    expect_code(retained_after_drop.ensure_usable(NOW), "DISPOSED");
}
