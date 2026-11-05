use super::{set, SEC, T0};
use crate::assignment::*;
use near_sdk::json_types::U64;

const HASH: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const DAY: u32 = 86_400;

fn assigned(delivery: Option<u32>) -> Assignment {
    set("verifier.testnet", T0);
    Assignment::new(1, U64(42), HASH.into(), "FR76...0189".into(), delivery)
}

fn due(a: &Assignment) -> u64 {
    a.deadline_ns.unwrap().0
}

#[test]
fn deadline_starts_at_the_assignment_block() {
    let a = assigned(Some(DAY));
    assert_eq!(a.assigned_at_ns.0, T0);
    assert_eq!(due(&a), T0 + u64::from(DAY) * SEC);
    assert!(assigned(None).deadline_ns.is_none());
}

#[test]
fn submission_observed_exactly_at_deadline_relayed_at_end_of_grace_counts() {
    let mut a = assigned(Some(DAY));
    let d = due(&a);
    set("verifier.testnet", d + RELAY_GRACE_NS);
    a.record_submission(HEAD.into(), d);
    assert_eq!(a.submitted_at_ns, Some(U64(d)));
}

#[test]
#[should_panic(expected = "Submission missed deadline")]
fn submission_observed_one_ns_after_deadline_is_refused() {
    let mut a = assigned(Some(DAY));
    let d = due(&a);
    set("verifier.testnet", d + 1);
    a.record_submission(HEAD.into(), d + 1);
}

#[test]
#[should_panic(expected = "Submission relay grace expired")]
fn relay_one_ns_after_grace_is_refused() {
    let mut a = assigned(Some(DAY));
    let d = due(&a);
    set("verifier.testnet", d + RELAY_GRACE_NS + 1);
    a.record_submission(HEAD.into(), d);
}

#[test]
#[should_panic(expected = "Invalid submission observation time")]
fn observation_in_the_future_is_refused() {
    let mut a = assigned(Some(DAY));
    set("verifier.testnet", T0 + SEC);
    a.record_submission(HEAD.into(), T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Invalid submission observation time")]
fn observation_before_assignment_is_refused() {
    let mut a = assigned(Some(DAY));
    set("verifier.testnet", T0 + SEC);
    a.record_submission(HEAD.into(), T0 - 1);
}

#[test]
#[should_panic(expected = "Invalid submission observation time")]
fn observations_are_monotonic() {
    let mut a = assigned(None);
    set("verifier.testnet", T0 + 10 * SEC);
    a.record_submission(HEAD.into(), T0 + 5 * SEC);
    a.record_submission(HEAD.into(), T0 + 4 * SEC);
}

#[test]
#[should_panic(expected = "Invalid GitHub commit")]
fn uppercase_commit_is_refused() {
    let mut a = assigned(None);
    a.record_submission(HEAD.to_uppercase(), T0);
}

#[test]
#[should_panic(expected = "Delivery or relay window still open")]
fn expiry_exactly_at_end_of_grace_is_refused() {
    let a = assigned(Some(DAY));
    set("anyone.testnet", due(&a) + RELAY_GRACE_NS);
    a.require_expirable();
}

#[test]
fn expiry_one_ns_after_grace_is_allowed() {
    let a = assigned(Some(DAY));
    set("anyone.testnet", due(&a) + RELAY_GRACE_NS + 1);
    a.require_expirable();
}

#[test]
#[should_panic(expected = "Assignment has no deadline")]
fn assignment_without_deadline_never_expires() {
    let a = assigned(None);
    set("anyone.testnet", T0 + 1000 * u64::from(DAY) * SEC);
    a.require_expirable();
}

#[test]
#[should_panic(expected = "Submitted work cannot expire")]
fn submitted_work_cannot_expire() {
    let mut a = assigned(Some(DAY));
    set("verifier.testnet", T0 + SEC);
    a.record_submission(HEAD.into(), T0 + SEC);
    set("anyone.testnet", due(&a) + RELAY_GRACE_NS + 1);
    a.require_expirable();
}

#[test]
fn generations_are_sequential() {
    require_next_generation(0, 1);
    require_next_generation(7, 8);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn skipped_generation_is_refused() {
    require_next_generation(0, 2);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn generation_overflow_is_refused() {
    require_next_generation(u32::MAX, 0);
}

#[test]
#[should_panic(expected = "Assignment hash mismatch")]
fn settlement_requires_the_assignment_hash() {
    assigned(None).require_matches(1, &"c".repeat(64));
}

#[test]
#[should_panic(expected = "Exact timely submission required")]
fn settlement_requires_the_recorded_head() {
    let mut a = assigned(None);
    set("verifier.testnet", T0 + SEC);
    a.record_submission(HEAD.into(), T0 + SEC);
    a.require_submitted(&"a".repeat(40));
}

#[test]
fn delivery_window_bounds() {
    validate_delivery_seconds(None);
    validate_delivery_seconds(Some(MIN_DELIVERY_SECONDS));
    validate_delivery_seconds(Some(MAX_DELIVERY_SECONDS));
}

#[test]
#[should_panic(expected = "Invalid delivery window")]
fn delivery_window_below_one_hour_is_refused() {
    validate_delivery_seconds(Some(MIN_DELIVERY_SECONDS - 1));
}

#[test]
fn timestamps_serialize_as_decimal_strings() {
    let a = assigned(Some(DAY));
    let v = near_sdk::serde_json::to_value(&a).unwrap();
    assert_eq!(v["deadline_ns"], due(&a).to_string());
    assert_eq!(v["assigned_at_ns"], T0.to_string());
    assert_eq!(v["developer_id"], "42");
}
