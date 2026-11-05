//! Unit tests for the bank-rail escrow. A local secp256k1 key stands in for the MPC network,
//! so callbacks are tested with real signatures over the real payout digests.

mod access;
mod dispute;
mod funding;
mod payout;

use crate::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{test_vm_config, testing_env, Gas, NearToken, PromiseResult, RuntimeFeesConfig};
use nearportal_common::DisputeOutcome;
use std::collections::HashMap;

pub(super) const T0: u64 = 1_792_505_768 * SEC; // 2026-10-20T14:16:08Z
pub(super) const SEC: u64 = 1_000_000_000;
pub(super) const REWARD: u64 = 72_000;
pub(super) const FUND: &str = "b77c35c892a1b24b10a2ce49b424e578472333ee8d2456234fff90626332c50f";
pub(super) const ASSIGNED: &str =
    "9249f5080df9823d59aec8a044403df91efce4d219000f9d5e038e656f6e0d06";
pub(super) const EVIDENCE: &str =
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
pub(super) const REFUND_IBAN: &str = "FR14...6789";

pub(super) fn acc(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn key() -> SigningKey {
    SigningKey::from_slice(&[7u8; 32]).unwrap()
}

/// EVM address of the test key (plays the bounty's escrow address).
pub(super) fn escrow_address() -> String {
    let point = key().verifying_key().to_encoded_point(false);
    let hash = env::keccak256_array(&point.as_bytes()[1..]);
    format!("0x{}", hex::encode(&hash[12..]))
}

/// `derived_public_key`-shaped result for the test key.
fn mpc_key() -> Vec<u8> {
    let point = key().verifying_key().to_encoded_point(false);
    format!(
        "\"secp256k1:{}\"",
        bs58::encode(&point.as_bytes()[1..]).into_string()
    )
    .into_bytes()
}

/// MPC-shaped response signing `payload_hash` with the test key.
pub(super) fn mpc_response(payload_hash: &str) -> Vec<u8> {
    let digest = hex::decode(payload_hash).unwrap();
    let (sig, rec) = key().sign_prehash_recoverable(&digest).unwrap();
    let bytes = sig.to_bytes();
    format!(
        r#"{{"big_r":{{"affine_point":"02{}"}},"s":{{"scalar":"{}"}},"recovery_id":{},"scheme":"Secp256k1"}}"#,
        hex::encode(&bytes[..32]),
        hex::encode(&bytes[32..]),
        rec.to_byte()
    )
    .into_bytes()
}

pub(super) fn ctx(caller: &str, now_ns: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("escrow.nearportal.testnet"))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .block_timestamp(now_ns)
        .prepaid_gas(Gas::from_tgas(300))
        .attached_deposit(NearToken::from_near(1));
    b
}

pub(super) fn set(caller: &str, now_ns: u64) {
    testing_env!(ctx(caller, now_ns).build());
}

pub(super) fn with_result(now_ns: u64, result: PromiseResult) {
    testing_env!(
        ctx("escrow.nearportal.testnet", now_ns).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![result]
    );
}

pub(super) fn callback(c: &mut Contract, payout: U64, now_ns: u64, result: PromiseResult) {
    let attempt = c.get_payout(payout).unwrap().attempt;
    with_result(now_ns, result);
    c.on_payout_signed(payout, attempt);
}

pub(super) fn sign_ok(c: &mut Contract, payout: U64, now_ns: u64) {
    let hash = c.get_payout(payout).unwrap().payload_hash;
    callback(
        c,
        payout,
        now_ns,
        PromiseResult::Successful(mpc_response(&hash)),
    );
}

pub(super) fn verify_address(c: &mut Contract, id: U64) {
    with_result(T0, PromiseResult::Successful(mpc_key()));
    c.on_escrow_address_checked(id);
}

pub(super) fn contract() -> Contract {
    set("owner.testnet", T0);
    let mut c = Contract::new(
        acc("owner.testnet"),
        acc("relayer.testnet"),
        acc("verifier.testnet"),
        acc("v1.signer-prod.testnet"),
        "nearportal-escrow".into(),
    );
    c.set_operator(acc("client.testnet"), true);
    c
}

pub(super) fn new_bounty(delivery_seconds: Option<u32>) -> NewBounty {
    NewBounty {
        funding_policy_hash: FUND.into(),
        reward_cents: U64(REWARD),
        delivery_seconds,
        refund_short_iban: REFUND_IBAN.into(),
        escrow_evm_address: escrow_address(),
    }
}

/// Created and address-verified, awaiting deposit.
pub(super) fn open(delivery_seconds: Option<u32>) -> (Contract, U64) {
    let mut c = contract();
    set("client.testnet", T0);
    let id = c.create_bounty(new_bounty(delivery_seconds));
    verify_address(&mut c, id);
    (c, id)
}

/// Fully funded at `T0 + SEC`.
pub(super) fn funded(delivery_seconds: Option<u32>) -> (Contract, U64) {
    let (mut c, id) = open(delivery_seconds);
    set("relayer.testnet", T0 + SEC);
    c.record_deposit(id, U64(REWARD), "order-in-1".into());
    (c, id)
}

/// Funded bounty refunded through a dispute at `T0 + 2s`: a payout in `Signing`.
pub(super) fn refund_payout() -> (Contract, U64, U64, u64) {
    let (mut c, id) = funded(None);
    let t = T0 + 2 * SEC;
    set("client.testnet", t);
    c.open_dispute(id);
    set("owner.testnet", t);
    let p = c.resolve_dispute(id, DisputeOutcome::Refund);
    (c, id, p, t)
}
