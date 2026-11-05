use super::*;
use nearportal_common::roles::RELAYER_CHANGE_DELAY_NS;

#[test]
#[should_panic(expected = "Only the relayer")]
fn owner_cannot_forge_deposit() {
    let mut c = created(None, true);
    set("owner.testnet", T0 + SEC);
    c.record_deposit(ID.into(), U64(REWARD_UNITS), receipt(1));
}

#[test]
#[should_panic(expected = "Only an operator")]
fn attacker_cannot_precreate_bounty_id() {
    let mut c = contract();
    set("attacker.testnet", T0 + SEC);
    c.create_bounty(ID.into(), terms(None));
}

#[test]
fn bounty_freezes_the_global_verifier() {
    let mut c = created(None, true);
    set("owner.testnet", T0 + SEC);
    c.set_verifier(acc("verifier2.testnet"));
    let second = "11111111-2222-3333-4444-555555555555";
    set("client.testnet", T0 + SEC);
    c.create_bounty(second.into(), terms(None));
    assert_eq!(
        c.get_bounty(ID.into()).unwrap().verifier,
        acc("verifier.testnet")
    );
    assert_eq!(
        c.get_bounty(second.into()).unwrap().verifier,
        acc("verifier2.testnet")
    );
}

#[test]
#[should_panic(expected = "Only the verifier")]
fn rotated_verifier_cannot_act_on_existing_bounty() {
    let mut c = funded(None);
    set("owner.testnet", T0 + SEC);
    c.set_verifier(acc("verifier2.testnet"));
    set("verifier2.testnet", T0 + 2 * SEC);
    c.assign_developer(ID.into(), 1, ASSIGNED.into(), U64(42), RECIPIENT.into());
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_sets_operators() {
    let mut c = created(None, true);
    set("attacker.testnet", T0 + SEC);
    c.set_operator(acc("attacker.testnet"), true);
}

#[test]
fn relayer_change_is_time_locked() {
    let mut c = contract();
    c.propose_relayer(acc("relayer2.testnet"));
    set("owner.testnet", T0 + RELAYER_CHANGE_DELAY_NS);
    c.apply_relayer();
    assert_eq!(c.get_config().relayer, acc("relayer2.testnet"));
}

#[test]
#[should_panic(expected = "Relayer change is time-locked")]
fn relayer_change_cannot_be_applied_early() {
    let mut c = contract();
    c.propose_relayer(acc("relayer2.testnet"));
    set("owner.testnet", T0 + RELAYER_CHANGE_DELAY_NS - 1);
    c.apply_relayer();
}

#[test]
fn relayer_change_can_be_cancelled() {
    let mut c = contract();
    c.propose_relayer(acc("relayer2.testnet"));
    c.cancel_relayer_change();
    assert!(c.get_config().pending_relayer.is_none());
}

#[test]
#[should_panic(expected = "Only the relayer")]
fn old_relayer_is_revoked_after_change() {
    let mut c = created(None, true);
    set("owner.testnet", T0);
    c.propose_relayer(acc("relayer2.testnet"));
    set("owner.testnet", T0 + RELAYER_CHANGE_DELAY_NS);
    c.apply_relayer();
    deposit(&mut c, REWARD_UNITS, 1, T0 + RELAYER_CHANGE_DELAY_NS);
}

#[test]
#[should_panic(expected = "Only the owner")]
fn only_owner_transfers_ownership() {
    let mut c = contract();
    set("relayer.testnet", T0);
    c.transfer_ownership(acc("relayer.testnet"));
}

fn pause(c: &mut Contract, at: u64) {
    set("owner.testnet", at);
    c.set_paused(true);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_new_bounties() {
    let mut c = contract();
    pause(&mut c, T0);
    set("client.testnet", T0);
    c.create_bounty(ID.into(), terms(None));
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_deposits() {
    let mut c = created(None, true);
    pause(&mut c, T0);
    deposit(&mut c, REWARD_UNITS, 1, T0 + SEC);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_assignment() {
    let mut c = funded(None);
    pause(&mut c, T0 + SEC);
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_submission() {
    let mut c = funded(None);
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
    pause(&mut c, T0 + 2 * SEC);
    submit(&mut c, 1, T0 + 3 * SEC, T0 + 3 * SEC);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_settlement() {
    let mut c = submitted(None);
    pause(&mut c, T0 + 3 * SEC);
    settle(&mut c);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn pause_blocks_dispute_resolution() {
    let mut c = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(ID.into());
    pause(&mut c, T0 + 2 * SEC);
    c.resolve_dispute(
        ID.into(),
        nearportal_common::DisputeOutcome::Refund,
        U64(1_000_000_000),
        U64(1_000_000),
    );
}

#[test]
fn pause_never_blocks_disputes_unpause_or_role_rotation() {
    let mut c = funded(None);
    pause(&mut c, T0 + 2 * SEC);
    set("client.testnet", T0 + 2 * SEC);
    c.open_dispute(ID.into());
    set("owner.testnet", T0 + 2 * SEC);
    c.propose_relayer(acc("relayer2.testnet"));
    c.set_verifier(acc("verifier2.testnet"));
    c.set_operator(acc("client2.testnet"), true);
    c.transfer_ownership(acc("owner2.testnet"));
    set("owner2.testnet", T0 + 2 * SEC);
    c.set_paused(false);
    assert!(!c.get_config().paused);
    assert_eq!(
        c.get_bounty(ID.into()).unwrap().state,
        BountyState::Disputed
    );
}
