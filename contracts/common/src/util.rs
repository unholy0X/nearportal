use near_sdk::{env, require, Gas, Promise};

use crate::errors;

pub const NS_PER_SEC: u64 = 1_000_000_000;
pub const DAY_NS: u64 = 86_400 * NS_PER_SEC;
/// Upper bound on references stored on chain (MPC path prefix, Monerium order ids).
pub const MAX_REF_LEN: usize = 64;

pub fn now_secs() -> u64 {
    env::block_timestamp() / NS_PER_SEC
}

/// 64 lowercase hex characters (a SHA-256 or keccak-256 digest).
pub fn is_sha256_hex(s: &str) -> bool {
    s.len() == 64 && is_lower_hex(s)
}

/// 40 lowercase hex characters (a Git commit SHA-1).
pub fn is_git_commit(s: &str) -> bool {
    s.len() == 40 && is_lower_hex(s)
}

pub fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

pub fn is_valid_ref(s: &str) -> bool {
    !s.is_empty() && s.len() <= MAX_REF_LEN
}

pub fn require_gas(needed: Gas) {
    let remaining = env::prepaid_gas()
        .as_gas()
        .saturating_sub(env::used_gas().as_gas());
    require!(remaining >= needed.as_gas(), errors::NOT_ENOUGH_GAS);
}

/// Requires the attached deposit to cover the storage added since `storage_before` and
/// refunds the rest to the caller.
pub fn charge_storage(storage_before: u64) {
    let used = env::storage_usage().saturating_sub(storage_before);
    let cost = env::storage_byte_cost().saturating_mul(u128::from(used));
    let attached = env::attached_deposit();
    require!(attached >= cost, errors::INSUFFICIENT_STORAGE_DEPOSIT);
    let refund = attached.saturating_sub(cost);
    if !refund.is_zero() {
        let _ = Promise::new(env::predecessor_account_id()).transfer(refund);
    }
}
