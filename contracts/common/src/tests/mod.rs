//! Unit tests for the shared modules. The MPC and Monerium values are public sandbox and
//! testnet vectors recorded on 2026-10-20.

mod assignment;
mod events;
mod evm;
mod monerium;
mod mpc;
mod roles;

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{testing_env, AccountId};

pub(crate) const SEC: u64 = 1_000_000_000;
pub(crate) const T0: u64 = 1_800_000_000 * SEC;

pub(crate) fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}

pub(crate) fn set(caller: &str, now: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("escrow.nearportal.testnet"))
        .predecessor_account_id(acc(caller))
        .block_timestamp(now);
    testing_env!(b.build());
}
