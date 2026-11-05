//! Unit tests for the USDC escrow. Golden transaction bytes and hashes were generated with
//! viem (`serializeTransaction`, `signTransaction`, ERC-20 ABI), not with this crate's RLP code.

mod access;
mod assignment;
mod dispute;
mod funding;
mod payout;
mod settlement;

use crate::*;
use k256::ecdsa::SigningKey;
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{test_vm_config, testing_env, Gas, NearToken, PromiseResult, RuntimeFeesConfig};
use std::collections::HashMap;

pub(super) const ID: &str = "89459e8e-44d1-428c-8e90-e278f9e6338e";
pub(super) const FUND: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
pub(super) const ASSIGNED: &str =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
pub(super) const EVIDENCE: &str =
    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
pub(super) const HEAD: &str = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
pub(super) const RECIPIENT: &str = "0x1111111111111111111111111111111111111111";
pub(super) const REFUND: &str = "0x3333333333333333333333333333333333333333";
pub(super) const T0: u64 = 1_800_000_000 * SEC;
pub(super) const SEC: u64 = 1_000_000_000;
pub(super) const HOUR: u64 = 3600 * SEC;
pub(super) const REWARD_UNITS: u64 = 1_000_000;
/// 1 USDC to RECIPIENT, nonce 0, max fee 1 gwei, priority fee 0.001 gwei.
pub(super) const GOLDEN_UNSIGNED: &str = "0x02f86f83014a3480830f4240843b9aca008301d4c094036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000f4240c0";
pub(super) const GOLDEN_DIGEST: &str =
    "9dc5186e4ae26d33995e33068837606d6ace1391ac94a7d55a0cc36011938ee2";
/// keccak256 of GOLDEN_UNSIGNED signed by the test key.
pub(super) const GOLDEN_TX_HASH: &str =
    "0x83d8f40bf0905fd66cf7d73c31fdc99424cbb7b3baf637774807764d4cc29d3d";
/// 1.5 USDC to REFUND, same fees.
pub(super) const REFUND_UNSIGNED: &str = "0x02f86f83014a3480830f4240843b9aca008301d4c094036cbd53842c5426634e7929541ec2318f3dcf7e80b844a9059cbb0000000000000000000000003333333333333333333333333333333333333333000000000000000000000000000000000000000000000000000000000016e360c0";

pub(super) fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

pub(super) fn context(caller: &str, now: u64) -> VMContextBuilder {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("escrow.nearportal.testnet"))
        .predecessor_account_id(acc(caller))
        .signer_account_id(acc(caller))
        .block_timestamp(now)
        .prepaid_gas(Gas::from_tgas(300))
        .attached_deposit(NearToken::from_near(1));
    b
}

pub(super) fn set(caller: &str, now: u64) {
    testing_env!(context(caller, now).build());
}

pub(super) fn result(now: u64, value: PromiseResult) {
    testing_env!(
        context("escrow.nearportal.testnet", now).build(),
        test_vm_config(),
        RuntimeFeesConfig::test(),
        HashMap::default(),
        vec![value]
    );
}

fn key() -> SigningKey {
    SigningKey::from_slice(&[7u8; 32]).unwrap()
}

pub(super) fn address() -> String {
    let p = key().verifying_key().to_encoded_point(false);
    format!(
        "0x{}",
        hex::encode(&near_sdk::env::keccak256_array(&p.as_bytes()[1..])[12..])
    )
}

pub(super) fn public_key() -> Vec<u8> {
    let p = key().verifying_key().to_encoded_point(false);
    format!(
        "\"secp256k1:{}\"",
        bs58::encode(&p.as_bytes()[1..]).into_string()
    )
    .into_bytes()
}

pub(super) fn signature_response(digest: &str) -> Vec<u8> {
    let bytes = hex::decode(digest).unwrap();
    let (signature, recovery) = key().sign_prehash_recoverable(&bytes).unwrap();
    let raw = signature.to_bytes();
    format!(
        r#"{{"big_r":{{"affine_point":"02{}"}},"s":{{"scalar":"{}"}},"recovery_id":{}}}"#,
        hex::encode(&raw[..32]),
        hex::encode(&raw[32..]),
        recovery.to_byte()
    )
    .into_bytes()
}

pub(super) fn receipt(index: u32) -> String {
    format!("84532:0x{}:{index:08x}", "d".repeat(64))
}

pub(super) fn contract() -> Contract {
    set("owner.testnet", T0);
    let mut c = Contract::new(
        acc("owner.testnet"),
        acc("relayer.testnet"),
        acc("verifier.testnet"),
        acc("mpc.testnet"),
        "nearportal-escrow".into(),
    );
    c.set_operator(acc("client.testnet"), true);
    c
}

pub(super) fn terms(delivery_seconds: Option<u32>) -> NewBounty {
    NewBounty {
        funding_policy_hash: FUND.into(),
        reward_cents: U64(100),
        delivery_seconds,
        refund_address: REFUND.into(),
        escrow_evm_address: address(),
    }
}

pub(super) fn verify(c: &mut Contract, id: &str, at: u64) {
    result(at, PromiseResult::Successful(public_key()));
    c.on_escrow_address_checked(id.into());
}

pub(super) fn created(delivery_seconds: Option<u32>, verified: bool) -> Contract {
    let mut c = contract();
    set("client.testnet", T0);
    c.create_bounty(ID.into(), terms(delivery_seconds));
    if verified {
        verify(&mut c, ID, T0);
    }
    c
}

pub(super) fn deposit(c: &mut Contract, units: u64, index: u32, at: u64) {
    set("relayer.testnet", at);
    c.record_deposit(ID.into(), U64(units), receipt(index));
}

/// Fully funded at `T0 + 1s`.
pub(super) fn funded(delivery_seconds: Option<u32>) -> Contract {
    let mut c = created(delivery_seconds, true);
    deposit(&mut c, REWARD_UNITS, 1, T0 + SEC);
    c
}

pub(super) fn assign(c: &mut Contract, generation: u32, recipient: &str, at: u64) {
    set("verifier.testnet", at);
    c.assign_developer(
        ID.into(),
        generation,
        ASSIGNED.into(),
        U64(42),
        recipient.into(),
    );
}

pub(super) fn submit(c: &mut Contract, generation: u32, observed: u64, at: u64) {
    set("verifier.testnet", at);
    c.record_submission(
        ID.into(),
        generation,
        ASSIGNED.into(),
        HEAD.into(),
        U64(observed),
    );
}

/// Assigned at `T0 + 2s` and submitted at `T0 + 3s`.
pub(super) fn submitted(delivery_seconds: Option<u32>) -> Contract {
    let mut c = funded(delivery_seconds);
    assign(&mut c, 1, RECIPIENT, T0 + 2 * SEC);
    submit(&mut c, 1, T0 + 3 * SEC, T0 + 3 * SEC);
    c
}

pub(super) fn settle_at(c: &mut Contract, evidence: &str, max_fee: u64, priority: u64, at: u64) {
    set("verifier.testnet", at);
    c.settle_bounty(
        ID.into(),
        1,
        ASSIGNED.into(),
        HEAD.into(),
        evidence.into(),
        U64(max_fee),
        U64(priority),
    );
}

pub(super) fn settle(c: &mut Contract) {
    settle_at(c, EVIDENCE, 1_000_000_000, 1_000_000, T0 + 4 * SEC);
}

pub(super) fn deadline(c: &Contract) -> u64 {
    c.get_bounty(ID.into())
        .unwrap()
        .assignment
        .unwrap()
        .deadline_ns
        .unwrap()
        .0
}

pub(super) fn payout(c: &Contract) -> UsdcPayout {
    c.get_bounty(ID.into()).unwrap().payout.unwrap()
}
