use super::*;
use nearportal_common::assignment::RELAY_GRACE_NS;

pub(super) const HEAD: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) const DELIVERY: u32 = 3600;
pub(super) const RECIPIENT_IBAN: &str = "FR76...0189";
const NEXT_IBAN: &str = "EE32...5559";

pub(super) fn assign(c: &mut Contract, id: U64, generation: u32, iban: &str, at: u64) {
    set("verifier.testnet", at);
    c.assign_developer(id, generation, ASSIGNED.into(), U64(200), iban.into());
}

/// Funded bounty with a one-hour window, assigned (generation 1) at `T0 + 2s`.
pub(super) fn assigned(delivery: Option<u32>) -> (Contract, U64, u64) {
    let (mut c, id) = funded(delivery);
    assign(&mut c, id, 1, RECIPIENT_IBAN, T0 + 2 * SEC);
    let due = c
        .get_bounty(id)
        .unwrap()
        .assignment
        .unwrap()
        .deadline_ns
        .map_or(0, |d| d.0);
    (c, id, due)
}

pub(super) fn submit(c: &mut Contract, id: U64, generation: u32, observed: u64, at: u64) {
    set("verifier.testnet", at);
    c.record_submission(id, generation, ASSIGNED.into(), HEAD.into(), U64(observed));
}

#[test]
fn assignment_keeps_economics_and_binds_the_recipient() {
    let (c, id, due) = assigned(Some(DELIVERY));
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.reward_cents, U64(REWARD));
    assert_eq!(b.deposited_cents, U64(REWARD));
    assert_eq!(b.funding_policy_hash, FUND);
    assert_eq!(b.generation, 1);
    let a = b.assignment.unwrap();
    assert_eq!(a.recipient, RECIPIENT_IBAN);
    assert_eq!(a.assignment_hash, ASSIGNED);
    assert_eq!(a.developer_id, U64(200));
    assert_eq!(due, T0 + 2 * SEC + u64::from(DELIVERY) * SEC);
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn client_cannot_assign_developer() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.assign_developer(id, 1, ASSIGNED.into(), U64(200), RECIPIENT_IBAN.into());
}

#[test]
#[should_panic(expected = "Developer already bound")]
fn assignment_is_exclusive_and_recipient_immutable() {
    let (mut c, id, _) = assigned(None);
    assign(&mut c, id, 1, NEXT_IBAN, T0 + 3 * SEC);
}

#[test]
#[should_panic(expected = "Developer already bound")]
fn parallel_assignment_is_rejected() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    assign(&mut c, id, 2, NEXT_IBAN, T0 + 3 * SEC);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn first_assignment_must_be_generation_one() {
    let (mut c, id) = funded(None);
    assign(&mut c, id, 2, RECIPIENT_IBAN, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn assign_requires_full_funding() {
    let (mut c, id) = open(None);
    assign(&mut c, id, 1, RECIPIENT_IBAN, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Invalid assignment hash")]
fn assignment_hash_must_differ_from_funding_hash() {
    let (mut c, id) = funded(None);
    set("verifier.testnet", T0 + 2 * SEC);
    c.assign_developer(id, 1, FUND.into(), U64(200), RECIPIENT_IBAN.into());
}

#[test]
#[should_panic(expected = "Recipient matches client refund")]
fn recipient_cannot_be_the_refund_iban() {
    let (mut c, id) = funded(None);
    assign(&mut c, id, 1, REFUND_IBAN, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Invalid developer identity")]
fn developer_id_must_be_set() {
    let (mut c, id) = funded(None);
    set("verifier.testnet", T0 + 2 * SEC);
    c.assign_developer(id, 1, ASSIGNED.into(), U64(0), RECIPIENT_IBAN.into());
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn dispute_blocks_assignment() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    assign(&mut c, id, 1, RECIPIENT_IBAN, T0 + 3 * SEC);
}

#[test]
fn expiry_keeps_funds_and_reopens_next_generation() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(id, 1);
    let b = c.get_bounty(id).unwrap();
    assert!(b.assignment.is_none(), "the recipient is cleared with it");
    assert_eq!(b.generation, 1);
    assert_eq!(b.deposited_cents, U64(REWARD));
    assert_eq!(b.committed_cents, U64(0));
    assign(&mut c, id, 2, NEXT_IBAN, due + RELAY_GRACE_NS + 2);
    let a = c.get_bounty(id).unwrap().assignment.unwrap();
    assert_eq!(a.generation, 2);
    assert_eq!(a.recipient, NEXT_IBAN);
    assert_eq!(
        a.deadline_ns,
        Some(U64(due + RELAY_GRACE_NS + 2 + u64::from(DELIVERY) * SEC)),
        "the next developer gets a full window"
    );
}

#[test]
#[should_panic(expected = "Delivery or relay window still open")]
fn no_expiry_at_deadline_or_during_grace() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    set("anyone.testnet", due + RELAY_GRACE_NS);
    c.expire_assignment(id, 1);
}

#[test]
#[should_panic(expected = "Assignment has no deadline")]
fn assignment_without_deadline_cannot_expire() {
    let (mut c, id, _) = assigned(None);
    set("anyone.testnet", T0 + 365 * 86_400 * SEC);
    c.expire_assignment(id, 1);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn stale_generation_cannot_rebind() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(id, 1);
    assign(&mut c, id, 1, RECIPIENT_IBAN, due + RELAY_GRACE_NS + 2);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn submit_requires_the_current_generation() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    submit(&mut c, id, 2, T0 + 3 * SEC, T0 + 3 * SEC);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn expire_requires_the_current_generation() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(id, 2);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn withdraw_requires_the_current_generation() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    set("verifier.testnet", T0 + 3 * SEC);
    c.withdraw_assignment(id, 0);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn old_generation_cannot_submit_after_reassignment() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(id, 1);
    assign(&mut c, id, 2, NEXT_IBAN, due + RELAY_GRACE_NS + 2);
    submit(
        &mut c,
        id,
        1,
        due + RELAY_GRACE_NS + 3,
        due + RELAY_GRACE_NS + 4,
    );
}

#[test]
#[should_panic(expected = "Assignment hash mismatch")]
fn submit_requires_the_assignment_hash() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    set("verifier.testnet", T0 + 3 * SEC);
    c.record_submission(id, 1, FUND.into(), HEAD.into(), U64(T0 + 3 * SEC));
}

#[test]
fn submission_observed_at_deadline_relayed_at_end_of_grace_counts() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    submit(&mut c, id, 1, due, due + RELAY_GRACE_NS);
    let a = c.get_bounty(id).unwrap().assignment.unwrap();
    assert_eq!(a.head_sha.as_deref(), Some(HEAD));
    assert_eq!(a.submitted_at_ns, Some(U64(due)));
}

#[test]
#[should_panic(expected = "Submission relay grace expired")]
fn relay_one_ns_after_grace_is_refused() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    submit(&mut c, id, 1, due, due + RELAY_GRACE_NS + 1);
}

#[test]
#[should_panic(expected = "Submission missed deadline")]
fn submission_observed_after_deadline_is_refused() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    submit(&mut c, id, 1, due + 1, due + 10 * SEC);
}

#[test]
#[should_panic(expected = "Submitted work cannot expire")]
fn timely_submission_never_expires() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    submit(&mut c, id, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    set("anyone.testnet", due + 100 * 3600 * SEC);
    c.expire_assignment(id, 1);
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn only_verifier_records_submission() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    set("client.testnet", T0 + 3 * SEC);
    c.record_submission(id, 1, ASSIGNED.into(), HEAD.into(), U64(T0 + 3 * SEC));
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn dispute_blocks_expiry_and_reassignment() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    set("client.testnet", T0 + 3 * SEC);
    c.open_dispute(id);
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(id, 1);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn dispute_blocks_submission() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    set("client.testnet", T0 + 3 * SEC);
    c.open_dispute(id);
    submit(&mut c, id, 1, T0 + 3 * SEC, T0 + 4 * SEC);
}

#[test]
fn withdrawal_reopens_the_next_generation() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    set("verifier.testnet", T0 + 3 * SEC);
    c.withdraw_assignment(id, 1);
    assert!(c.get_bounty(id).unwrap().assignment.is_none());
    assign(&mut c, id, 2, NEXT_IBAN, T0 + 4 * SEC);
    assert_eq!(c.get_bounty(id).unwrap().generation, 2);
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn only_verifier_withdraws() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    set("anyone.testnet", T0 + 3 * SEC);
    c.withdraw_assignment(id, 1);
}

#[test]
#[should_panic(expected = "Submitted work cannot expire")]
fn submitted_work_cannot_be_withdrawn() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    submit(&mut c, id, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    set("verifier.testnet", T0 + 4 * SEC);
    c.withdraw_assignment(id, 1);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_assignment() {
    let (mut c, id) = funded(None);
    set("owner.testnet", T0 + 2 * SEC);
    c.set_paused(true);
    assign(&mut c, id, 1, RECIPIENT_IBAN, T0 + 2 * SEC);
}

#[test]
fn pause_allows_timely_submission_without_authorizing_payment() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    set("owner.testnet", T0 + 3 * SEC);
    c.set_paused(true);
    submit(&mut c, id, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    let b = c.get_bounty(id).unwrap();
    assert!(b.assignment.unwrap().head_sha.is_some());
    assert!(b.settlement_payout_id.is_none());
}

#[test]
fn pause_does_not_block_expiry() {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    set("owner.testnet", T0 + 3 * SEC);
    c.set_paused(true);
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(id, 1);
    assert!(c.get_bounty(id).unwrap().assignment.is_none());
}

#[test]
fn rpc_timestamps_are_decimal_strings() {
    let (c, id, due) = assigned(Some(DELIVERY));
    let value = near_sdk::serde_json::to_value(c.get_bounty(id).unwrap()).unwrap();
    assert_eq!(value["assignment"]["deadline_ns"], due.to_string());
}
