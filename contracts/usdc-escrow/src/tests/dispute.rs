use super::*;
use nearportal_common::DisputeOutcome;

fn resolve(c: &mut Contract, outcome: DisputeOutcome, at: u64) {
    set("owner.testnet", at);
    c.resolve_dispute(ID.into(), outcome, U64(1_000_000_000), U64(1_000_000));
}

fn dispute(c: &mut Contract, at: u64) {
    set("client.testnet", at);
    c.open_dispute(ID.into());
}

#[test]
#[should_panic(expected = "Nothing deposited to dispute")]
fn dispute_requires_a_deposit() {
    let mut c = created(None, true);
    dispute(&mut c, T0 + SEC);
}

#[test]
#[should_panic(expected = "Only the client or the verifier")]
fn third_party_cannot_dispute() {
    let mut c = funded(None);
    set("stranger.testnet", T0 + 2 * SEC);
    c.open_dispute(ID.into());
}

#[test]
#[should_panic(expected = "Funded unsettled bounty required")]
fn dispute_blocks_settlement() {
    let mut c = submitted(None);
    dispute(&mut c, T0 + 3 * SEC);
    settle(&mut c);
}

#[test]
#[should_panic(expected = "No such payout")]
fn dispute_leaves_nothing_to_retry() {
    let mut c = submitted(None);
    dispute(&mut c, T0 + 3 * SEC);
    set("verifier.testnet", T0 + 4 * SEC);
    c.retry_payout_signature(ID.into());
}

#[test]
#[should_panic(expected = "Settlement already authorized")]
fn no_dispute_after_settlement() {
    let mut c = submitted(None);
    settle(&mut c);
    dispute(&mut c, T0 + 5 * SEC);
}

#[test]
fn refund_sends_every_recorded_unit_to_the_refund_address() {
    let mut c = funded(None);
    deposit(&mut c, 500_000, 2, T0 + 2 * SEC);
    dispute(&mut c, T0 + 3 * SEC);
    resolve(&mut c, DisputeOutcome::Refund, T0 + 4 * SEC);
    let p = payout(&c);
    assert_eq!(p.kind, PayoutKind::Refund);
    assert_eq!(p.recipient, REFUND);
    assert_eq!(p.amount_units, U64(1_500_000));
    assert_eq!(p.unsigned_tx, REFUND_UNSIGNED);
    assert!(p.evidence_hash.is_none());
    assert_eq!(c.get_bounty(ID.into()).unwrap().state, BountyState::Closed);
}

#[test]
fn partially_funded_bounty_can_be_refunded() {
    let mut c = created(None, true);
    deposit(&mut c, 400_000, 1, T0 + SEC);
    dispute(&mut c, T0 + 2 * SEC);
    resolve(&mut c, DisputeOutcome::Refund, T0 + 3 * SEC);
    assert_eq!(payout(&c).amount_units, U64(400_000));
}

#[test]
fn payout_outcome_pays_the_assigned_recipient() {
    let mut c = submitted(None);
    dispute(&mut c, T0 + 4 * SEC);
    resolve(&mut c, DisputeOutcome::Payout, T0 + 5 * SEC);
    let p = payout(&c);
    assert_eq!(p.kind, PayoutKind::Developer);
    assert_eq!(p.unsigned_tx, GOLDEN_UNSIGNED);
}

#[test]
#[should_panic(expected = "No active assignment")]
fn payout_outcome_requires_an_assignment() {
    let mut c = funded(None);
    dispute(&mut c, T0 + 2 * SEC);
    resolve(&mut c, DisputeOutcome::Payout, T0 + 3 * SEC);
}

#[test]
#[should_panic(expected = "Settlement already authorized")]
fn refund_excludes_a_later_payout() {
    let mut c = submitted(None);
    dispute(&mut c, T0 + 4 * SEC);
    resolve(&mut c, DisputeOutcome::Refund, T0 + 5 * SEC);
    settle_at(&mut c, EVIDENCE, 1_000_000_000, 1_000_000, T0 + 6 * SEC);
}

#[test]
#[should_panic(expected = "No open dispute")]
fn dispute_cannot_be_resolved_twice() {
    let mut c = funded(None);
    dispute(&mut c, T0 + 2 * SEC);
    resolve(&mut c, DisputeOutcome::Refund, T0 + 3 * SEC);
    resolve(&mut c, DisputeOutcome::Payout, T0 + 4 * SEC);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_resolves_disputes() {
    let mut c = funded(None);
    dispute(&mut c, T0 + 2 * SEC);
    c.resolve_dispute(
        ID.into(),
        DisputeOutcome::Refund,
        U64(1_000_000_000),
        U64(1_000_000),
    );
}
