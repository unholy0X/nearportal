use super::*;

#[test]
#[should_panic(expected = "Nothing deposited to dispute")]
fn dispute_requires_a_deposit() {
    let (mut c, id) = open(None);
    set("client.testnet", T0);
    c.open_dispute(id);
}

#[test]
#[should_panic(expected = "Only the client or the verifier")]
fn third_party_cannot_dispute() {
    let (mut c, id) = funded(None);
    set("stranger.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
}

#[test]
fn verifier_can_dispute() {
    let (mut c, id) = funded(None);
    set("verifier.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    assert_eq!(c.get_bounty(id).unwrap().state, BountyState::Disputed);
}

#[test]
fn dispute_refund_returns_the_deposit_to_the_refund_iban() {
    let (c, id, p, _) = refund_payout();
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.kind, PayoutKind::Refund);
    assert_eq!(payout.amount_cents, U64(REWARD));
    assert_eq!(payout.short_iban, REFUND_IBAN);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.state, BountyState::Closed);
    assert_eq!(b.settlement_payout_id, Some(p));
    assert_eq!(b.committed_cents, b.deposited_cents);
}

#[test]
fn partially_funded_bounty_can_be_disputed_and_refunded() {
    let (mut c, id) = open(None);
    set("relayer.testnet", T0 + SEC);
    c.record_deposit(id, U64(30_000), "partial".into());
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    set("owner.testnet", T0 + 2 * SEC);
    let p = c.resolve_dispute(id, DisputeOutcome::Refund).unwrap();
    assert_eq!(c.get_payout(p).unwrap().amount_cents, U64(30_000));
}

#[test]
fn resuming_without_assignment_does_not_authorize_a_payout() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    set("owner.testnet", T0 + 2 * SEC);
    assert_eq!(c.resolve_dispute(id, DisputeOutcome::Resume), None);
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.state, BountyState::Funded);
    assert!(b.settlement_payout_id.is_none());
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_resolves_disputes() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    c.resolve_dispute(id, DisputeOutcome::Refund);
}

#[test]
#[should_panic(expected = "No open dispute")]
fn resolution_requires_an_open_dispute() {
    let (mut c, id) = funded(None);
    set("owner.testnet", T0 + 2 * SEC);
    c.resolve_dispute(id, DisputeOutcome::Refund);
}

#[test]
#[should_panic(expected = "No open dispute")]
fn dispute_cannot_be_resolved_twice() {
    let (mut c, id, _, t) = refund_payout();
    set("owner.testnet", t);
    c.resolve_dispute(id, DisputeOutcome::Refund);
}

#[test]
#[should_panic(expected = "Nothing deposited to dispute")]
fn no_dispute_after_close() {
    let (mut c, id, _, t) = refund_payout();
    set("client.testnet", t);
    c.open_dispute(id);
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn no_settlement_during_dispute() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    set("verifier.testnet", T0 + 3 * SEC);
    c.settle_bounty(id, 1, ASSIGNED.into(), "a".repeat(40), EVIDENCE.into());
}

#[test]
#[should_panic(expected = "Not enough gas")]
fn dispute_resolution_requires_gas_for_a_signature() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    let mut b = ctx("owner.testnet", T0 + 2 * SEC);
    b.prepaid_gas(Gas::from_tgas(60));
    testing_env!(b.build());
    c.resolve_dispute(id, DisputeOutcome::Refund);
}

#[test]
fn surplus_is_refunded_after_the_dispute_payout_is_processed() {
    let (mut c, id, p, t) = refund_payout();
    set("relayer.testnet", t);
    assert!(c
        .record_deposit(id, U64(5_000), "late-surplus".into())
        .is_none());
    sign_ok(&mut c, p, t);
    set("relayer.testnet", t);
    c.mark_payout_processed(p, "refund-out".into());
    let surplus = c.get_payout(U64(p.0 + 1)).unwrap();
    assert_eq!(surplus.kind, PayoutKind::SurplusRefund);
    assert_eq!(surplus.amount_cents, U64(5_000));
    assert_eq!(surplus.short_iban, REFUND_IBAN);
}
