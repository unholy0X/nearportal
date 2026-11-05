use super::*;
use near_sdk::test_utils::get_logs;

#[test]
fn bounty_records_terms_and_per_bounty_escrow_path() {
    let (c, id) = funded(Some(3600));
    assert_eq!(id, U64(0));
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.state, BountyState::Funded);
    assert_eq!(b.client, acc("client.testnet"));
    assert_eq!(b.verifier, acc("verifier.testnet"));
    assert_eq!(b.reward_cents, U64(REWARD));
    assert_eq!(b.delivery_seconds, Some(3600));
    assert_eq!(b.refund_short_iban, REFUND_IBAN);
    assert_eq!(b.escrow_path, "nearportal-escrow/bounty-0");
    assert_eq!(c.get_escrow_path(U64(1)), "nearportal-escrow/bounty-1");
    assert_eq!(c.get_config().next_bounty_id, U64(1));
}

#[test]
fn reward_ceiling_is_inclusive() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut nb = new_bounty(None);
    nb.reward_cents = U64(MAX_REWARD_CENTS);
    let id = c.create_bounty(nb);
    assert_eq!(c.get_bounty(id).unwrap().reward_cents, U64(100_000));
}

#[test]
#[should_panic(expected = "Invalid reward")]
fn reward_above_ceiling_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut nb = new_bounty(None);
    nb.reward_cents = U64(MAX_REWARD_CENTS + 1);
    c.create_bounty(nb);
}

#[test]
#[should_panic(expected = "Invalid reward")]
fn zero_reward_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut nb = new_bounty(None);
    nb.reward_cents = U64(0);
    c.create_bounty(nb);
}

#[test]
fn deposit_accepted_immediately_after_verification() {
    let (mut c, id) = open(None);
    set("relayer.testnet", T0);
    c.record_deposit(id, U64(REWARD), "order-in-1".into());
    assert_eq!(c.get_bounty(id).unwrap().state, BountyState::Funded);
    assert!(get_logs().iter().any(|l| l.contains("bounty_funded")));
}

#[test]
fn partial_deposits_add_up_to_funded() {
    let (mut c, id) = open(None);
    set("relayer.testnet", T0);
    c.record_deposit(id, U64(50_000), "a".into());
    assert_eq!(
        c.get_bounty(id).unwrap().state,
        BountyState::AwaitingDeposit
    );
    c.record_deposit(id, U64(22_000), "b".into());
    assert_eq!(c.get_bounty(id).unwrap().state, BountyState::Funded);
}

#[test]
#[should_panic(expected = "Order already recorded")]
fn monerium_order_id_cannot_be_replayed() {
    let (mut c, id) = open(None);
    set("relayer.testnet", T0);
    c.record_deposit(id, U64(10_000), "order-in-1".into());
    c.record_deposit(id, U64(10_000), "order-in-1".into());
}

#[test]
#[should_panic(expected = "Order already recorded")]
fn deposit_order_cannot_be_reused_as_surplus() {
    let (mut c, id) = funded(None);
    set("relayer.testnet", T0 + 2 * SEC);
    c.record_deposit(id, U64(10_000), "order-in-1".into());
}

#[test]
#[should_panic(expected = "Escrow address not verified")]
fn deposit_refused_before_address_verification() {
    let mut c = contract();
    set("client.testnet", T0);
    let id = c.create_bounty(new_bounty(None));
    set("relayer.testnet", T0);
    c.record_deposit(id, U64(REWARD), "order-in-1".into());
}

#[test]
fn overpayment_funds_exact_reward_and_refunds_surplus() {
    let (mut c, id) = open(None);
    set("relayer.testnet", T0 + SEC);
    let p = c
        .record_deposit(id, U64(100_000), "oversized".into())
        .unwrap();
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.state, BountyState::Funded);
    assert_eq!(b.deposited_cents, U64(REWARD));
    assert_eq!(b.committed_cents, U64(0));
    assert_eq!(b.surplus_recorded_cents, U64(28_000));
    assert_eq!(b.surplus_refunded_cents, U64(28_000));
    let payout = c.get_payout(p).unwrap();
    assert_eq!(payout.amount_cents, U64(28_000));
    assert_eq!(payout.short_iban, REFUND_IBAN);
    assert_eq!(payout.kind, PayoutKind::SurplusRefund);
}

#[test]
#[should_panic(expected = "Order already recorded")]
fn overpayment_receipt_cannot_be_replayed() {
    let (mut c, id) = open(None);
    set("relayer.testnet", T0 + SEC);
    c.record_deposit(id, U64(100_000), "same-order".into());
    c.record_deposit(id, U64(100_000), "same-order".into());
}

#[test]
fn late_surplus_queues_after_existing_refund_without_touching_reward() {
    let (mut c, id) = open(None);
    set("relayer.testnet", T0 + SEC);
    let first = c
        .record_deposit(id, U64(100_000), "first-oversized".into())
        .unwrap();
    assert!(c
        .record_deposit(id, U64(10_000), "late-oversized".into())
        .is_none());
    assert_eq!(c.get_bounty(id).unwrap().open_payouts, 1);
    sign_ok(&mut c, first, T0 + 2 * SEC);
    set("relayer.testnet", T0 + 2 * SEC);
    c.mark_payout_processed(first, "refund-processed".into());
    let b = c.get_bounty(id).unwrap();
    assert_eq!(b.open_payouts, 1);
    assert_eq!(b.deposited_cents, U64(REWARD));
    assert_eq!(b.committed_cents, U64(0));
    assert_eq!(b.surplus_refunded_cents, U64(38_000));
    let second = c.get_payout(U64(first.0 + 1)).unwrap();
    assert_eq!(second.amount_cents, U64(10_000));
    assert_eq!(second.short_iban, REFUND_IBAN);
}

#[test]
fn wrong_escrow_address_cancels_the_bounty() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut nb = new_bounty(None);
    nb.escrow_evm_address = "0x91c098fc987eec6c82d3fb202044f1d0399ba9e7".into();
    let id = c.create_bounty(nb);
    assert_eq!(
        c.get_bounty(id).unwrap().state,
        BountyState::VerifyingAddress
    );
    verify_address(&mut c, id);
    assert_eq!(c.get_bounty(id).unwrap().state, BountyState::Cancelled);
}

#[test]
fn failed_derivation_cancels_the_bounty() {
    let mut c = contract();
    set("client.testnet", T0);
    let id = c.create_bounty(new_bounty(None));
    with_result(T0, PromiseResult::Failed);
    c.on_escrow_address_checked(id);
    assert_eq!(c.get_bounty(id).unwrap().state, BountyState::Cancelled);
}

#[test]
#[should_panic(expected = "Invalid funding policy hash")]
fn uppercase_hash_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut nb = new_bounty(None);
    nb.funding_policy_hash = FUND.to_uppercase();
    c.create_bounty(nb);
}

#[test]
#[should_panic(expected = "Invalid escrow EVM address")]
fn invalid_escrow_address_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut nb = new_bounty(None);
    nb.escrow_evm_address = "0x1234".into();
    c.create_bounty(nb);
}

#[test]
#[should_panic(expected = "Invalid short IBAN")]
fn invalid_refund_iban_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    let mut nb = new_bounty(None);
    nb.refund_short_iban = "FR7630006000011234567890189".into();
    c.create_bounty(nb);
}

#[test]
#[should_panic(expected = "Invalid delivery window")]
fn delivery_window_above_90_days_is_refused() {
    let mut c = contract();
    set("client.testnet", T0);
    c.create_bounty(new_bounty(Some(90 * 86_400 + 1)));
}

#[test]
#[should_panic(expected = "Insufficient storage deposit")]
fn create_bounty_requires_storage_deposit() {
    let mut c = contract();
    let mut b = ctx("client.testnet", T0);
    b.attached_deposit(NearToken::from_yoctonear(0));
    testing_env!(b.build());
    c.create_bounty(new_bounty(None));
}

#[test]
fn escrow_address_ownership_signature_is_verified() {
    let (mut c, id) = open(None);
    set("client.testnet", T0);
    let _ = c.link_escrow_address(id);
    assert_eq!(c.get_bounty(id).unwrap().link, LinkState::Signing);
    let digest = hex::encode(nearportal_common::evm::eip191_hash(
        nearportal_common::monerium::OWNERSHIP_MESSAGE,
    ));
    with_result(T0, PromiseResult::Successful(mpc_response(&digest)));
    c.on_link_signed(id);
    match c.get_bounty(id).unwrap().link {
        LinkState::Signed(sig) => {
            let d =
                nearportal_common::evm::eip191_hash(nearportal_common::monerium::OWNERSHIP_MESSAGE);
            assert_eq!(
                nearportal_common::mpc::recover_evm_address(&d, &sig),
                Some(escrow_address())
            );
        }
        other => panic!("unexpected link state {other:?}"),
    }
}

#[test]
fn rpc_numbers_are_decimal_strings() {
    let (c, id) = funded(None);
    let v = near_sdk::serde_json::to_value(c.get_bounty(id).unwrap()).unwrap();
    assert_eq!(v["reward_cents"], REWARD.to_string());
    assert_eq!(v["created_at_ns"], T0.to_string());
    let config = near_sdk::serde_json::to_value(c.get_config()).unwrap();
    assert_eq!(config["max_reward_cents"], "100000");
}

#[test]
#[should_panic(expected = "Invalid mpc_path")]
fn invalid_mpc_path_is_refused() {
    set("owner.testnet", T0);
    Contract::new(
        acc("owner.testnet"),
        acc("relayer.testnet"),
        acc("verifier.testnet"),
        acc("v1.signer-prod.testnet"),
        String::new(),
    );
}
