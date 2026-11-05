use super::*;

#[test]
fn golden_transaction_pins_token_chain_nonce_recipient_price() {
    let mut c = submitted(None);
    settle(&mut c);
    let p = payout(&c);
    assert_eq!(p.kind, PayoutKind::Developer);
    assert_eq!(p.unsigned_tx, GOLDEN_UNSIGNED);
    assert_eq!(p.digest, GOLDEN_DIGEST);
    assert_eq!(p.evidence_hash.as_deref(), Some(EVIDENCE));
    assert_eq!(p.amount_units, U64(REWARD_UNITS));
    assert!(p.signature.is_none());
    assert_eq!(c.get_bounty(ID.into()).unwrap().state, BountyState::Closed);
    // This literal is independent from the crate and ends in 7e, as published by Circle.
    assert!(p
        .unsigned_tx
        .contains("94036cbd53842c5426634e7929541ec2318f3dcf7e"));
}

#[test]
fn overpayment_never_increases_reward() {
    let mut c = funded(None);
    deposit(&mut c, 500_000, 2, T0 + 2 * SEC);
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
    submit(&mut c, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    settle(&mut c);
    assert_eq!(
        c.get_bounty(ID.into()).unwrap().deposited_units,
        U64(1_500_000)
    );
    assert_eq!(payout(&c).unsigned_tx, GOLDEN_UNSIGNED);
}

#[test]
#[should_panic(expected = "Assignment hash mismatch")]
fn settle_rejects_different_assignment_hash() {
    let mut c = submitted(None);
    set("verifier.testnet", T0 + 4 * SEC);
    c.settle_bounty(
        ID.into(),
        1,
        FUND.into(),
        HEAD.into(),
        EVIDENCE.into(),
        U64(1_000_000_000),
        U64(1_000_000),
    );
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn settle_requires_the_current_generation() {
    let mut c = submitted(None);
    set("verifier.testnet", T0 + 4 * SEC);
    c.settle_bounty(
        ID.into(),
        2,
        ASSIGNED.into(),
        HEAD.into(),
        EVIDENCE.into(),
        U64(1_000_000_000),
        U64(1_000_000),
    );
}

#[test]
#[should_panic(expected = "Exact timely submission required")]
fn different_head_cannot_be_paid() {
    let mut c = submitted(None);
    set("verifier.testnet", T0 + 4 * SEC);
    c.settle_bounty(
        ID.into(),
        1,
        ASSIGNED.into(),
        "f".repeat(40),
        EVIDENCE.into(),
        U64(1_000_000_000),
        U64(1_000_000),
    );
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn client_cannot_settle() {
    let mut c = submitted(None);
    set("client.testnet", T0 + 4 * SEC);
    c.settle_bounty(
        ID.into(),
        1,
        ASSIGNED.into(),
        HEAD.into(),
        EVIDENCE.into(),
        U64(1_000_000_000),
        U64(1_000_000),
    );
}

#[test]
#[should_panic(expected = "Settlement already authorized")]
fn settle_cannot_replace_evidence() {
    let mut c = submitted(None);
    settle(&mut c);
    settle_at(&mut c, FUND, 1_000_000_000, 1_000_000, T0 + 5 * SEC);
}

#[test]
fn repeat_settle_keeps_the_same_bytes() {
    let mut c = submitted(None);
    settle(&mut c);
    let before = payout(&c).unsigned_tx;
    settle_at(&mut c, EVIDENCE, 2_000_000_000, 2_000_000, T0 + 5 * SEC);
    assert_eq!(payout(&c).unsigned_tx, before);
}

#[test]
#[should_panic(expected = "Gas fee limit exceeded")]
fn fee_drain_is_bounded() {
    let mut c = submitted(None);
    settle_at(&mut c, EVIDENCE, 100_000_000_001, 1, T0 + 4 * SEC);
}

#[test]
#[should_panic(expected = "Gas fee limit exceeded")]
fn priority_fee_cannot_exceed_max_fee() {
    let mut c = submitted(None);
    settle_at(&mut c, EVIDENCE, 1_000, 1_001, T0 + 4 * SEC);
}

#[test]
#[should_panic(expected = "Exact timely submission required")]
fn settle_requires_recorded_submission() {
    let mut c = funded(Some(24 * 3600));
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
    settle(&mut c);
}

#[test]
#[should_panic(expected = "No active assignment")]
fn settle_requires_active_assignment() {
    let mut c = funded(None);
    settle(&mut c);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn settle_requires_full_funding() {
    let mut c = created(None, true);
    deposit(&mut c, 999_999, 1, T0 + SEC);
    settle(&mut c);
}

#[test]
fn late_review_pays_once() {
    let mut c = funded(Some(24 * 3600));
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
    let due = deadline(&c);
    submit(&mut c, 1, due - SEC, due);
    settle_at(&mut c, EVIDENCE, 1_000_000_000, 1_000_000, due + 50 * HOUR);
    assert_eq!(payout(&c).unsigned_tx, GOLDEN_UNSIGNED);
    settle_at(&mut c, EVIDENCE, 1_000_000_000, 1_000_000, due + 51 * HOUR);
    assert_eq!(payout(&c).digest, GOLDEN_DIGEST);
}
