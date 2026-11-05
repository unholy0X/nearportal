use super::assignment::{assigned, submit, DELIVERY, HEAD, RECIPIENT_IBAN};
use super::*;

fn settle(c: &mut Contract, id: U64, generation: u32, head: &str, at: u64) -> U64 {
    set("verifier.testnet", at);
    c.settle_bounty(
        id,
        generation,
        ASSIGNED.into(),
        head.into(),
        EVIDENCE.into(),
    )
}

/// Assigned with a one-hour window and a submission recorded at `T0 + 3s`.
fn submitted() -> (Contract, U64, u64) {
    let (mut c, id, due) = assigned(Some(DELIVERY));
    submit(&mut c, id, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    (c, id, due)
}

#[test]
fn settle_schedules_one_payout_to_assigned_recipient() {
    let (mut c, id, _) = submitted();
    let p = settle(&mut c, id, 1, HEAD, T0 + 4 * SEC);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.state, BountyState::Closed);
    assert_eq!(b.committed_cents, U64(REWARD));
    assert_eq!(b.settlement_payout_id, Some(p));
    assert_eq!(b.settlement_evidence_hash.as_deref(), Some(EVIDENCE));
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.kind, PayoutKind::Developer);
    assert_eq!(payout.amount_cents, U64(REWARD));
    assert_eq!(payout.short_iban, RECIPIENT_IBAN);
    sign_ok(&mut c, p, T0 + 5 * SEC);
    assert_eq!(c.get_payout(p).unwrap().state, PayoutState::Signed);
    set("relayer.testnet", T0 + 6 * SEC);
    c.mark_payout_processed(p, "redeem-1".into());
    assert_eq!(c.get_payout(p).unwrap().state, PayoutState::Processed);
}

#[test]
fn settlement_without_deadline_pays_the_recorded_head() {
    let (mut c, id, _) = assigned(None);
    submit(&mut c, id, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    let p = settle(&mut c, id, 1, HEAD, T0 + 4 * SEC);
    assert_eq!(
        c.get_payout(p).unwrap().message,
        "Send EUR 720 to FR76...0189 at 2026-10-20T14:26:12Z"
    );
}

#[test]
#[should_panic(expected = "Assignment hash mismatch")]
fn settle_rejects_changed_assignment_hash() {
    let (mut c, id, _) = submitted();
    set("verifier.testnet", T0 + 4 * SEC);
    c.settle_bounty(id, 1, FUND.into(), HEAD.into(), EVIDENCE.into());
}

#[test]
#[should_panic(expected = "Assignment generation mismatch")]
fn settle_requires_the_current_generation() {
    let (mut c, id, _) = submitted();
    settle(&mut c, id, 2, HEAD, T0 + 4 * SEC);
}

#[test]
#[should_panic(expected = "Invalid evidence hash")]
fn settle_rejects_invalid_evidence_hash() {
    let (mut c, id, _) = submitted();
    set("verifier.testnet", T0 + 4 * SEC);
    c.settle_bounty(id, 1, ASSIGNED.into(), HEAD.into(), "not-a-hash".into());
}

#[test]
#[should_panic(expected = "No active assignment")]
fn settle_requires_active_assignment() {
    let (mut c, id) = funded(None);
    settle(&mut c, id, 1, HEAD, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn settle_requires_full_funding() {
    let (mut c, id) = open(None);
    settle(&mut c, id, 1, HEAD, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Exact timely submission required")]
fn settle_requires_recorded_submission() {
    let (mut c, id, _) = assigned(Some(DELIVERY));
    settle(&mut c, id, 1, HEAD, T0 + 4 * SEC);
}

#[test]
#[should_panic(expected = "Exact timely submission required")]
fn different_head_cannot_be_paid() {
    let (mut c, id, _) = submitted();
    settle(&mut c, id, 1, &"b".repeat(40), T0 + 4 * SEC);
}

#[test]
#[should_panic(expected = "Settlement already authorized")]
fn settle_cannot_pay_twice() {
    let (mut c, id, _) = submitted();
    settle(&mut c, id, 1, HEAD, T0 + 4 * SEC);
    settle(&mut c, id, 1, HEAD, T0 + 5 * SEC);
}

#[test]
fn late_review_pays_once() {
    let (mut c, id, due) = submitted();
    let p = settle(&mut c, id, 1, HEAD, due + 50 * 3600 * SEC);
    assert_eq!(c.get_payout(p).unwrap().short_iban, RECIPIENT_IBAN);
    assert_eq!(c.get_bounty(id).unwrap().open_payouts, 1);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn settlement_waits_for_a_surplus_refund_in_flight() {
    let (mut c, id, _) = submitted();
    set("relayer.testnet", T0 + 4 * SEC);
    c.record_deposit(id, U64(1_000), "surplus".into());
    settle(&mut c, id, 1, HEAD, T0 + 5 * SEC);
}

#[test]
fn surplus_after_settlement_is_refunded_once_the_payout_is_processed() {
    let (mut c, id, _) = submitted();
    let p = settle(&mut c, id, 1, HEAD, T0 + 4 * SEC);
    set("relayer.testnet", T0 + 5 * SEC);
    assert!(c.record_deposit(id, U64(2_500), "late".into()).is_none());
    sign_ok(&mut c, p, T0 + 6 * SEC);
    set("relayer.testnet", T0 + 6 * SEC);
    c.mark_payout_processed(p, "redeem-1".into());
    let refund = c.get_payout(U64(p.0 + 1)).unwrap();
    assert_eq!(refund.kind, PayoutKind::SurplusRefund);
    assert_eq!(refund.short_iban, REFUND_IBAN);
    assert_eq!(c.get_bounty(id).unwrap().committed_cents, U64(REWARD));
}

#[test]
fn resumed_dispute_still_needs_verifier_settlement() {
    let (mut c, id, _) = submitted();
    set("client.testnet", T0 + 4 * SEC);
    c.open_dispute(id);
    set("owner.testnet", T0 + 5 * SEC);
    assert_eq!(c.resolve_dispute(id, DisputeOutcome::Resume), None);
    assert!(c.get_bounty(id).unwrap().settlement_payout_id.is_none());
    let p = settle(&mut c, id, 1, HEAD, T0 + 6 * SEC);
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.kind, PayoutKind::Developer);
    assert_eq!(payout.amount_cents, U64(REWARD));
    assert_eq!(payout.short_iban, RECIPIENT_IBAN);
    assert_eq!(c.get_bounty(id).unwrap().state, BountyState::Closed);
}

#[test]
#[should_panic(expected = "Settlement already authorized")]
fn verifier_cannot_settle_after_dispute_resolution() {
    let (mut c, id, _) = submitted();
    set("client.testnet", T0 + 4 * SEC);
    c.open_dispute(id);
    set("owner.testnet", T0 + 5 * SEC);
    c.resolve_dispute(id, DisputeOutcome::Refund);
    settle(&mut c, id, 1, HEAD, T0 + 6 * SEC);
}

#[test]
#[should_panic(expected = "Exact timely submission required")]
fn resumed_dispute_cannot_pay_without_a_recorded_submission() {
    let (mut c, id) = funded(None);
    set("verifier.testnet", T0 + 2 * SEC);
    c.assign_developer(id, 1, ASSIGNED.into(), U64(42), RECIPIENT_IBAN.into());
    set("client.testnet", T0 + 3 * SEC);
    c.open_dispute(id);
    set("owner.testnet", T0 + 4 * SEC);
    c.resolve_dispute(id, DisputeOutcome::Resume);
    settle(&mut c, id, 1, HEAD, T0 + 5 * SEC);
}
