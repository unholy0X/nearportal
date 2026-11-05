//! NearPortal bank-rail escrow (Monerium sandbox). The money never touches this contract: it
//! sits as EURe on an EVM address derived from this contract through NEAR Chain Signatures,
//! one address per bounty. Money leaves that address only through a Monerium redeem order
//! signed by the MPC network at this contract's request, so this contract decides when and to
//! whom a bounty is paid.
//!
//! Trust assumptions: the relayer reports Monerium deposits and processed orders truthfully;
//! the verifier attests GitHub identity, submission time and merge evidence; the owner
//! resolves disputes and recovers stuck MPC signatures. The contract bounds all of them by
//! the reward ceiling, the frozen reward, recipient and verifier, generations and deadlines,
//! and single settlement.

mod assignment;
mod bounty;
mod payout;
mod types;

pub use types::*;

use near_sdk::json_types::U64;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, require, AccountId, IntoStorageKey, PanicOnDefault};
use nearportal_common::events::Rail;
use nearportal_common::roles::Roles;
use nearportal_common::{errors, util};

/// €1,000: the sandbox reward ceiling, enforced at creation.
pub const MAX_REWARD_CENTS: u64 = 100_000;
const RAIL: Rail = Rail::Bank;

enum StorageKey {
    Bounties,
    Payouts,
    OrderRefs,
    Operators,
}

impl IntoStorageKey for StorageKey {
    fn into_storage_key(self) -> Vec<u8> {
        match self {
            StorageKey::Bounties => b"b".to_vec(),
            StorageKey::Payouts => b"p".to_vec(),
            StorageKey::OrderRefs => b"o".to_vec(),
            StorageKey::Operators => b"r".to_vec(),
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    roles: Roles,
    mpc_contract: AccountId,
    /// Prefix of every bounty's derivation path (`{mpc_path}/bounty-{id}`); fixed at init.
    mpc_path: String,
    bounties: LookupMap<BountyId, Bounty>,
    payouts: LookupMap<PayoutId, Payout>,
    /// Monerium order ids already recorded, to block webhook replays.
    order_refs: LookupSet<String>,
    next_bounty_id: BountyId,
    next_payout_id: PayoutId,
}

#[near]
impl Contract {
    #[init]
    pub fn new(
        owner: AccountId,
        relayer: AccountId,
        verifier: AccountId,
        mpc_contract: AccountId,
        mpc_path: String,
    ) -> Self {
        require!(util::is_valid_ref(&mpc_path), errors::INVALID_MPC_PATH);
        Self {
            roles: Roles::new(owner, relayer, verifier, StorageKey::Operators),
            mpc_contract,
            mpc_path,
            bounties: LookupMap::new(StorageKey::Bounties),
            payouts: LookupMap::new(StorageKey::Payouts),
            order_refs: LookupSet::new(StorageKey::OrderRefs),
            next_bounty_id: 0,
            next_payout_id: 0,
        }
    }

    /// Starts a relayer change that can be applied two days later.
    pub fn propose_relayer(&mut self, relayer: AccountId) {
        self.roles.propose_relayer(RAIL, relayer);
    }

    pub fn apply_relayer(&mut self) {
        self.roles.apply_relayer(RAIL);
    }

    pub fn cancel_relayer_change(&mut self) {
        self.roles.cancel_relayer_change(RAIL);
    }

    /// Pausing blocks bounty creation, deposit recording, assignment, submission, settlement
    /// and dispute resolution. It never blocks disputes, payout signing recovery, processed
    /// receipts, expiry, withdrawal, unpausing or role rotation.
    pub fn set_paused(&mut self, paused: bool) {
        self.roles.set_paused(RAIL, paused);
    }

    pub fn transfer_ownership(&mut self, new_owner: AccountId) {
        self.roles.transfer_ownership(RAIL, new_owner);
    }

    /// Applies to bounties created afterwards; existing bounties keep their verifier.
    pub fn set_verifier(&mut self, verifier: AccountId) {
        self.roles.set_verifier(RAIL, verifier);
    }

    pub fn set_operator(&mut self, operator: AccountId, allowed: bool) {
        self.roles.set_operator(RAIL, operator, allowed);
    }

    pub fn get_config(&self) -> Config {
        Config {
            owner: self.roles.owner.clone(),
            relayer: self.roles.relayer.clone(),
            pending_relayer: self.roles.pending_relayer.clone(),
            verifier: self.roles.verifier.clone(),
            operators: self.roles.operator_list(),
            mpc_contract: self.mpc_contract.clone(),
            mpc_path: self.mpc_path.clone(),
            paused: self.roles.paused,
            next_bounty_id: U64(self.next_bounty_id),
            next_payout_id: U64(self.next_payout_id),
            max_reward_cents: U64(MAX_REWARD_CENTS),
        }
    }
}

impl Contract {
    fn bounty(&self, bounty_id: BountyId) -> Bounty {
        self.bounties
            .get(&bounty_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(errors::NO_SUCH_BOUNTY))
    }

    fn payout(&self, payout_id: PayoutId) -> Payout {
        self.payouts
            .get(&payout_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(errors::NO_SUCH_PAYOUT))
    }

    fn assert_verifier(bounty: &Bounty) {
        require!(
            env::predecessor_account_id() == bounty.verifier,
            errors::ONLY_VERIFIER
        );
    }

    fn escrow_path(&self, bounty_id: BountyId) -> String {
        format!("{}/bounty-{}", self.mpc_path, bounty_id)
    }
}

#[cfg(test)]
mod tests;
