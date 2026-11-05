use super::*;
use near_sdk::test_utils::get_logs;

#[test]
fn partial_deposits_and_duplicate_receipts_counted_once() {
    let mut c = created(None, true);
    deposit(&mut c, 400_000, 1, T0 + SEC);
    deposit(&mut c, 400_000, 1, T0 + SEC);
    let b = c.get_bounty(ID.into()).unwrap();
    assert_eq!(b.deposited_units, U64(400_000));
    assert_eq!(b.state, BountyState::AwaitingDeposit);
    deposit(&mut c, 600_000, 2, T0 + 2 * SEC);
    let b = c.get_bounty(ID.into()).unwrap();
    assert_eq!(b.deposited_units, U64(REWARD_UNITS));
    assert_eq!(b.state, BountyState::Funded);
}

#[test]
#[should_panic(expected = "Receipt already consumed")]
fn duplicate_receipt_cannot_change_units() {
    let mut c = funded(None);
    deposit(&mut c, 2_000_000, 1, T0 + 2 * SEC);
}

#[test]
#[should_panic(expected = "Receipt already consumed")]
fn receipt_cannot_be_reused_across_bounties() {
    let mut c = funded(None);
    let second = "11111111-2222-3333-4444-555555555555";
    set("client.testnet", T0 + 2 * SEC);
    c.create_bounty(second.into(), terms(None));
    verify(&mut c, second, T0 + 2 * SEC);
    set("relayer.testnet", T0 + 3 * SEC);
    c.record_deposit(second.into(), U64(REWARD_UNITS), receipt(1));
}

#[test]
#[should_panic(expected = "Escrow address not verified")]
fn unverified_address_cannot_receive_credit() {
    let mut c = created(None, false);
    deposit(&mut c, REWARD_UNITS, 1, T0 + SEC);
}

#[test]
#[should_panic(expected = "Invalid deposit receipt")]
fn malformed_receipt_reference_is_refused() {
    let mut c = created(None, true);
    set("relayer.testnet", T0 + SEC);
    c.record_deposit(
        ID.into(),
        U64(1),
        format!("1:0x{}:00000001", "d".repeat(64)),
    );
}

#[test]
fn surplus_is_recorded_and_never_changes_the_reward() {
    let mut c = funded(None);
    deposit(&mut c, 500_000, 2, T0 + 2 * SEC);
    let b = c.get_bounty(ID.into()).unwrap();
    assert_eq!(b.deposited_units, U64(1_500_000));
    assert_eq!(b.reward_cents, U64(100));
    assert!(get_logs()
        .iter()
        .any(|l| l.contains("surplus_recorded") && l.contains("\"amount_units\":\"500000\"")));
}

#[test]
fn transient_derivation_failure_is_retryable() {
    let mut c = created(None, false);
    result(T0, PromiseResult::Failed);
    c.on_escrow_address_checked(ID.into());
    assert_eq!(
        c.get_bounty(ID.into()).unwrap().state,
        BountyState::VerifyingAddress
    );
    set("client.testnet", T0 + SEC);
    c.retry_address_check(ID.into());
    verify(&mut c, ID, T0 + SEC);
    assert_eq!(
        c.get_bounty(ID.into()).unwrap().state,
        BountyState::AwaitingDeposit
    );
}

#[test]
#[should_panic(expected = "Escrow address already verified")]
fn verified_address_is_not_checked_again() {
    let mut c = created(None, true);
    set("client.testnet", T0 + SEC);
    c.retry_address_check(ID.into());
}

#[test]
fn reward_ceiling_is_inclusive() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut t = terms(None);
    t.reward_cents = U64(MAX_REWARD_CENTS);
    c.create_bounty(ID.into(), t);
    assert_eq!(
        c.get_bounty(ID.into()).unwrap().reward_units(),
        1_000_000_000
    );
}

#[test]
#[should_panic(expected = "Invalid reward")]
fn reward_above_ceiling_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut t = terms(None);
    t.reward_cents = U64(MAX_REWARD_CENTS + 1);
    c.create_bounty(ID.into(), t);
}

#[test]
#[should_panic(expected = "Invalid reward")]
fn zero_reward_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut t = terms(None);
    t.reward_cents = U64(0);
    c.create_bounty(ID.into(), t);
}

#[test]
#[should_panic(expected = "Invalid refund address")]
fn refund_address_cannot_be_the_token() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut t = terms(None);
    t.refund_address = nearportal_common::evm::USDC_TOKEN.into();
    c.create_bounty(ID.into(), t);
}

#[test]
#[should_panic(expected = "Invalid refund address")]
fn refund_address_cannot_be_the_escrow() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut t = terms(None);
    t.refund_address = address();
    c.create_bounty(ID.into(), t);
}

#[test]
#[should_panic(expected = "Invalid bounty id")]
fn bounty_id_must_be_uuid_shaped() {
    let mut c = contract();
    set("client.testnet", T0);
    c.create_bounty("bounty-1".into(), terms(None));
}

#[test]
fn identical_create_is_a_no_op() {
    let mut c = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    c.create_bounty(ID.into(), terms(None));
    assert_eq!(c.get_bounty(ID.into()).unwrap().state, BountyState::Funded);
}

#[test]
#[should_panic(expected = "Bounty already exists")]
fn create_cannot_change_existing_terms() {
    let mut c = funded(None);
    set("client.testnet", T0 + 2 * SEC);
    let mut t = terms(None);
    t.refund_address = RECIPIENT.into();
    c.create_bounty(ID.into(), t);
}

#[test]
#[should_panic(expected = "Testnet only")]
fn mainnet_account_is_refused() {
    let mut c = contract();
    let mut b = context("client.testnet", T0);
    b.current_account_id(acc("escrow.nearportal.near"));
    testing_env!(b.build());
    c.create_bounty(ID.into(), terms(None));
}

#[test]
#[should_panic(expected = "Insufficient storage deposit")]
fn create_requires_storage_deposit() {
    let mut c = contract();
    let mut b = context("client.testnet", T0);
    b.attached_deposit(NearToken::from_yoctonear(0));
    testing_env!(b.build());
    c.create_bounty(ID.into(), terms(None));
}

#[test]
fn escrow_path_and_config_expose_the_compiled_network() {
    let c = contract();
    assert_eq!(
        c.get_escrow_path(ID.into()),
        format!("nearportal-escrow/crypto/base-sepolia/usdc/{ID}")
    );
    let v = near_sdk::serde_json::to_value(c.get_config()).unwrap();
    assert_eq!(v["chain_id"], "84532");
    assert_eq!(v["token"], "0x036cbd53842c5426634e7929541ec2318f3dcf7e");
    assert_eq!(v["max_reward_cents"], "100000");
}

#[test]
#[should_panic(expected = "Invalid mpc_path")]
fn invalid_mpc_path_is_refused() {
    set("owner.testnet", T0);
    Contract::new(
        acc("owner.testnet"),
        acc("relayer.testnet"),
        acc("verifier.testnet"),
        acc("mpc.testnet"),
        "x".repeat(65),
    );
}

#[test]
fn confirmed_address_mismatch_is_terminal() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut t = terms(None);
    t.escrow_evm_address = RECIPIENT.into();
    c.create_bounty(ID.into(), t);
    verify(&mut c, ID, T0 + SEC);
    assert_eq!(
        c.get_bounty(ID.into()).unwrap().state,
        BountyState::Cancelled
    );
}

#[test]
#[should_panic(expected = "Escrow address not verified")]
fn cancelled_bounty_never_accepts_deposit_receipts() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut t = terms(None);
    t.escrow_evm_address = RECIPIENT.into();
    c.create_bounty(ID.into(), t);
    verify(&mut c, ID, T0 + SEC);
    deposit(&mut c, REWARD_UNITS, 1, T0 + 2 * SEC);
}
