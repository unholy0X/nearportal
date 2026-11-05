use super::*;
use nearportal_common::assignment::RELAY_GRACE_NS;

const DAY_WINDOW: u32 = 24 * 3600;
const RECIPIENT2: &str = "0x2222222222222222222222222222222222222222";
const ASSIGNED2: &str = "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

fn window() -> Contract {
    let mut c = funded(Some(DAY_WINDOW));
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
    c
}

fn assign2(c: &mut Contract, at: u64) {
    set("verifier.testnet", at);
    c.assign_developer(ID.into(), 2, ASSIGNED2.into(), U64(43), RECIPIENT2.into());
}

#[test]
fn deadline_starts_at_assignment_block_and_binds_the_recipient() {
    let mut c = funded(Some(DAY_WINDOW));
    assign(&mut c, 1, RECIPIENT, T0 + 10 * SEC);
    assert_eq!(deadline(&c), T0 + 10 * SEC + 24 * HOUR);
    let a = c.get_bounty(ID.into()).unwrap().assignment.unwrap();
    assert_eq!(a.recipient, RECIPIENT);
    assert_eq!(a.assignment_hash, ASSIGNED);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn partial_funding_cannot_be_assigned() {
    let mut c = created(None, true);
    deposit(&mut c, 999_999, 1, T0 + SEC);
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn assign_requires_full_funding() {
    let mut c = created(Some(DAY_WINDOW), true);
    deposit(&mut c, 400_000, 1, T0 + SEC);
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn client_cannot_assign_developer() {
    let mut c = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.assign_developer(ID.into(), 1, ASSIGNED.into(), U64(42), RECIPIENT.into());
}

#[test]
#[should_panic(expected = "Developer already bound")]
fn recipient_immutable_after_assignment() {
    let mut c = funded(None);
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
    assign(&mut c, 1, RECIPIENT2, T0 + 3 * SEC);
}

#[test]
#[should_panic(expected = "Developer already bound")]
fn assignment_is_exclusive() {
    let mut c = window();
    assign2(&mut c, T0 + 3 * SEC);
}

#[test]
#[should_panic(expected = "Invalid recipient")]
fn token_contract_cannot_be_recipient() {
    let mut c = funded(None);
    assign(&mut c, 1, nearportal_common::evm::USDC_TOKEN, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Invalid recipient")]
fn escrow_address_cannot_be_recipient() {
    let mut c = funded(None);
    let escrow = address();
    assign(&mut c, 1, &escrow, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Recipient matches client refund")]
fn recipient_cannot_be_the_refund_address() {
    let mut c = funded(None);
    assign(&mut c, 1, REFUND, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Invalid assignment hash")]
fn assignment_cannot_replace_funding_hash() {
    let mut c = funded(None);
    set("verifier.testnet", T0 + 2 * SEC);
    c.assign_developer(ID.into(), 1, FUND.into(), U64(42), RECIPIENT.into());
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn generations_are_sequential() {
    let mut c = funded(Some(DAY_WINDOW));
    assign(&mut c, 2, RECIPIENT, T0 + 2 * SEC);
}

#[test]
fn submission_at_deadline_is_timely() {
    let mut c = window();
    let due = deadline(&c);
    submit(&mut c, 1, due, due + RELAY_GRACE_NS);
    let a = c.get_bounty(ID.into()).unwrap().assignment.unwrap();
    assert_eq!(a.head_sha.as_deref(), Some(HEAD));
    assert_eq!(a.submitted_at_ns, Some(U64(due)));
}

#[test]
#[should_panic(expected = "Submission missed deadline")]
fn submission_after_deadline_refused() {
    let mut c = window();
    let due = deadline(&c);
    submit(&mut c, 1, due + 1, due + 2);
}

#[test]
#[should_panic(expected = "Submission relay grace expired")]
fn late_relay_of_timely_submission_is_refused() {
    let mut c = window();
    let due = deadline(&c);
    submit(&mut c, 1, due - SEC, due + 72 * HOUR);
}

#[test]
#[should_panic(expected = "Submission relay grace expired")]
fn relay_one_ns_after_grace_is_refused() {
    let mut c = window();
    let due = deadline(&c);
    submit(&mut c, 1, due, due + RELAY_GRACE_NS + 1);
}

#[test]
#[should_panic(expected = "Delivery or relay window still open")]
fn expiry_waits_for_deadline_plus_grace() {
    let mut c = window();
    let due = deadline(&c);
    set("anyone.testnet", due + RELAY_GRACE_NS);
    c.expire_assignment(ID.into(), 1);
}

#[test]
fn third_party_can_expire_after_grace_and_funds_stay() {
    let mut c = window();
    let due = deadline(&c);
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(ID.into(), 1);
    let b = c.get_bounty(ID.into()).unwrap();
    assert!(b.assignment.is_none() && b.payout.is_none());
    assert_eq!(b.deposited_units, U64(REWARD_UNITS), "funds stay locked");
    assign2(&mut c, due + RELAY_GRACE_NS + 2);
    let a = c.get_bounty(ID.into()).unwrap().assignment.unwrap();
    assert_eq!(a.recipient, RECIPIENT2);
    assert_eq!(
        deadline(&c),
        due + RELAY_GRACE_NS + 2 + 24 * HOUR,
        "the next developer gets a full window"
    );
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn old_generation_cannot_submit() {
    let mut c = window();
    let due = deadline(&c);
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(ID.into(), 1);
    assign2(&mut c, due + RELAY_GRACE_NS + 2);
    submit(
        &mut c,
        1,
        due + RELAY_GRACE_NS + 3,
        due + RELAY_GRACE_NS + 4,
    );
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn expire_requires_the_current_generation() {
    let mut c = window();
    let due = deadline(&c);
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(ID.into(), 2);
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn withdraw_requires_the_current_generation() {
    let mut c = window();
    set("verifier.testnet", T0 + 3 * SEC);
    c.withdraw_assignment(ID.into(), 2);
}

#[test]
#[should_panic(expected = "Submitted work cannot expire")]
fn timely_submission_never_expires() {
    let mut c = window();
    let due = deadline(&c);
    submit(&mut c, 1, due - SEC, due);
    set("anyone.testnet", due + 100 * HOUR);
    c.expire_assignment(ID.into(), 1);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn dispute_blocks_expiry_and_reassignment() {
    let mut c = window();
    set("client.testnet", T0 + 3 * SEC);
    c.open_dispute(ID.into());
    let due = deadline(&c);
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(ID.into(), 1);
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn only_verifier_records_submission() {
    let mut c = window();
    set("client.testnet", T0 + 3 * SEC);
    c.record_submission(
        ID.into(),
        1,
        ASSIGNED.into(),
        HEAD.into(),
        U64(T0 + 3 * SEC),
    );
}

#[test]
fn withdrawal_reopens_the_next_generation() {
    let mut c = window();
    set("verifier.testnet", T0 + 3 * SEC);
    c.withdraw_assignment(ID.into(), 1);
    assign2(&mut c, T0 + 4 * SEC);
    assert_eq!(c.get_bounty(ID.into()).unwrap().generation, 2);
}

#[test]
#[should_panic(expected = "Submitted work cannot expire")]
fn submitted_work_cannot_be_withdrawn() {
    let mut c = window();
    submit(&mut c, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    set("verifier.testnet", T0 + 4 * SEC);
    c.withdraw_assignment(ID.into(), 1);
}

#[test]
fn pause_does_not_block_expiry() {
    let mut c = window();
    let due = deadline(&c);
    set("owner.testnet", T0 + 3 * SEC);
    c.set_paused(true);
    set("anyone.testnet", due + RELAY_GRACE_NS + 1);
    c.expire_assignment(ID.into(), 1);
    assert!(c.get_bounty(ID.into()).unwrap().assignment.is_none());
}

#[test]
fn rpc_timestamps_are_decimal_strings() {
    let c = window();
    let v = near_sdk::serde_json::to_value(c.get_bounty(ID.into()).unwrap()).unwrap();
    assert_eq!(v["assignment"]["deadline_ns"], deadline(&c).to_string());
    assert_eq!(v["deposited_units"], REWARD_UNITS.to_string());
}
