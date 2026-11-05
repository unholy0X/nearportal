use super::*;
use nearportal_common::roles::RELAYER_CHANGE_DELAY_NS;
use nearportal_common::util::DAY_NS;

fn settle(c: &mut Contract, id: U64) -> U64 {
    c.settle_bounty(id, 1, ASSIGNED.into(), "a".repeat(40), EVIDENCE.into())
}

#[test]
#[should_panic(expected = "Only an operator")]
fn only_operators_create_bounties() {
    let mut c = contract();
    set("stranger.testnet", T0);
    c.create_bounty(new_bounty(None));
}

#[test]
#[should_panic(expected = "Only an operator")]
fn removed_operator_cannot_create() {
    let mut c = contract();
    set("owner.testnet", T0);
    c.set_operator(acc("client.testnet"), false);
    set("client.testnet", T0);
    c.create_bounty(new_bounty(None));
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_sets_operators() {
    let mut c = contract();
    set("client.testnet", T0);
    c.set_operator(acc("stranger.testnet"), true);
}

#[test]
#[should_panic(expected = "Operator must be independent")]
fn verifier_and_operator_must_be_independent() {
    let mut c = contract();
    set("owner.testnet", T0);
    c.set_operator(acc("verifier.testnet"), true);
}

#[test]
#[should_panic(expected = "Only the relayer")]
fn only_relayer_records_deposits() {
    let (mut c, id) = open(None);
    set("client.testnet", T0);
    c.record_deposit(id, U64(REWARD), "fake".into());
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn settle_rejects_non_verifier() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    settle(&mut c, id);
}

#[test]
fn verifier_is_frozen_per_bounty() {
    let mut c = contract();
    set("client.testnet", T0);
    let first = c.create_bounty(new_bounty(None));
    set("owner.testnet", T0);
    c.set_verifier(acc("verifier2.testnet"));
    set("client.testnet", T0);
    let second = c.create_bounty(new_bounty(None));
    assert_eq!(
        c.get_bounty(first).unwrap().verifier,
        acc("verifier.testnet")
    );
    assert_eq!(
        c.get_bounty(second).unwrap().verifier,
        acc("verifier2.testnet")
    );
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn rotated_verifier_cannot_settle_an_existing_bounty() {
    let (mut c, id) = funded(None);
    set("owner.testnet", T0 + 2 * SEC);
    c.set_verifier(acc("verifier2.testnet"));
    set("verifier2.testnet", T0 + 2 * SEC);
    settle(&mut c, id);
}

#[test]
#[should_panic(expected = "Only the client or the relayer")]
fn third_party_cannot_request_link_signature() {
    let (mut c, id) = open(None);
    set("verifier.testnet", T0);
    let _ = c.link_escrow_address(id);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_pauses() {
    let mut c = contract();
    set("client.testnet", T0);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_proposes_relayer() {
    let mut c = contract();
    set("relayer.testnet", T0);
    c.propose_relayer(acc("evil.testnet"));
}

#[test]
fn relayer_change_is_time_locked() {
    let mut c = contract();
    set("owner.testnet", T0);
    c.propose_relayer(acc("relayer2.testnet"));
    set("owner.testnet", T0 + RELAYER_CHANGE_DELAY_NS);
    c.apply_relayer();
    assert_eq!(c.get_config().relayer, acc("relayer2.testnet"));
}

#[test]
#[should_panic(expected = "Relayer change is time-locked")]
fn relayer_change_cannot_be_applied_early() {
    let mut c = contract();
    set("owner.testnet", T0);
    c.propose_relayer(acc("relayer2.testnet"));
    set("owner.testnet", T0 + DAY_NS);
    c.apply_relayer();
}

#[test]
fn relayer_change_can_be_cancelled() {
    let mut c = contract();
    set("owner.testnet", T0);
    c.propose_relayer(acc("relayer2.testnet"));
    c.cancel_relayer_change();
    assert!(c.get_config().pending_relayer.is_none());
}

#[test]
#[should_panic(expected = "Only the relayer")]
fn old_relayer_is_revoked_after_change() {
    let (mut c, id) = open(None);
    set("owner.testnet", T0);
    c.propose_relayer(acc("relayer2.testnet"));
    set("owner.testnet", T0 + RELAYER_CHANGE_DELAY_NS);
    c.apply_relayer();
    set("relayer.testnet", T0 + RELAYER_CHANGE_DELAY_NS);
    c.record_deposit(id, U64(1), "a".into());
}

#[test]
#[should_panic(expected = "Owner must be independent")]
fn ownership_cannot_go_to_an_operator() {
    let mut c = contract();
    set("owner.testnet", T0);
    c.transfer_ownership(acc("client.testnet"));
}

fn paused(c: &mut Contract, t: u64) {
    set("owner.testnet", t);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_new_bounties() {
    let mut c = contract();
    paused(&mut c, T0);
    set("client.testnet", T0);
    c.create_bounty(new_bounty(None));
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_deposits() {
    let (mut c, id) = open(None);
    paused(&mut c, T0);
    set("relayer.testnet", T0);
    c.record_deposit(id, U64(1), "a".into());
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_settlement() {
    let (mut c, id) = funded(None);
    paused(&mut c, T0 + 2 * SEC);
    set("verifier.testnet", T0 + 2 * SEC);
    settle(&mut c, id);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_dispute_resolution() {
    let (mut c, id) = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    paused(&mut c, T0 + 2 * SEC);
    c.resolve_dispute(id, DisputeOutcome::Refund);
}

#[test]
fn pause_never_blocks_disputes_unpause_or_role_rotation() {
    let (mut c, id) = funded(None);
    paused(&mut c, T0 + 2 * SEC);
    set("verifier.testnet", T0 + 2 * SEC);
    c.open_dispute(id);
    assert_eq!(c.get_bounty(id).unwrap().state, BountyState::Disputed);
    set("owner.testnet", T0 + 2 * SEC);
    c.propose_relayer(acc("relayer2.testnet"));
    c.set_verifier(acc("verifier2.testnet"));
    c.set_operator(acc("client2.testnet"), true);
    c.transfer_ownership(acc("owner2.testnet"));
    set("owner2.testnet", T0 + 2 * SEC);
    c.set_paused(false);
    let config = c.get_config();
    assert!(!config.paused);
    assert_eq!(config.owner, acc("owner2.testnet"));
}
