//! NearPortal USDC-rail escrow on Base Sepolia. Each bounty has its own escrow address,
//! derived from this contract through NEAR Chain Signatures. That address signs exactly one
//! transaction, at nonce 0: the developer payout or, after a dispute, the refund. The
//! contract builds that transaction itself (fixed chain, token, nonce, gas limit and fee cap),
//! so no caller can make the MPC network sign anything else.
//!
//! Trust assumptions: the relayer reports confirmed USDC transfers truthfully; the verifier
//! attests GitHub identity, submission time and merge evidence; the owner resolves disputes.
//! Limits: surplus beyond the reward is not refunded on chain after a developer payout, and
//! fees cannot be bumped after signing.

mod assignment;
mod bounty;
mod payout;
mod types;

pub use types::*;

use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, require, AccountId, IntoStorageKey, PanicOnDefault};
use nearportal_common::events::Rail;
use nearportal_common::roles::Roles;
use nearportal_common::{errors, evm, util};

/// 1,000 USDC: the testnet reward ceiling, enforced at creation.
pub const MAX_REWARD_CENTS: u64 = 100_000;
const RAIL: Rail = Rail::Usdc;

enum StorageKey {
    Bounties,
    Receipts,
    Operators,
}

impl IntoStorageKey for StorageKey {
    fn into_storage_key(self) -> Vec<u8> {
        match self {
            StorageKey::Bounties => b"b".to_vec(),
            StorageKey::Receipts => b"d".to_vec(),
            StorageKey::Operators => b"r".to_vec(),
        }
    }
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    roles: Roles,
    mpc_contract: AccountId,
    /// Prefix of every derivation path (`{mpc_path}/crypto/base-sepolia/usdc/{id}`).
    mpc_path: String,
    bounties: LookupMap<String, Bounty>,
    /// Deposit receipt (`84532:0x{tx}:{log index}`) -> the bounty and units it credited.
    receipts: LookupMap<String, Receipt>,
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
            receipts: LookupMap::new(StorageKey::Receipts),
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
    /// and dispute resolution. It never blocks disputes, signature retries, processed
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
            chain_id: U64(evm::BASE_SEPOLIA_CHAIN_ID),
            token: evm::USDC_TOKEN.into(),
            max_reward_cents: U64(MAX_REWARD_CENTS),
        }
    }
}

impl Contract {
    fn bounty(&self, bounty_id: &str) -> Bounty {
        self.bounties
            .get(bounty_id)
            .cloned()
            .unwrap_or_else(|| env::panic_str(errors::NO_SUCH_BOUNTY))
    }

    fn assert_verifier(bounty: &Bounty) {
        require!(
            env::predecessor_account_id() == bounty.verifier,
            errors::ONLY_VERIFIER
        );
    }

    /// This build only runs on NEAR testnet accounts (Base Sepolia constants are compiled in).
    fn assert_testnet() {
        require!(
            env::current_account_id().as_str().ends_with(".testnet"),
            errors::TESTNET_ONLY
        );
    }

    fn escrow_path(&self, bounty_id: &str) -> String {
        format!("{}/crypto/base-sepolia/usdc/{bounty_id}", self.mpc_path)
    }
}

/// UUID-shaped: 36 characters of hex digits and dashes.
fn is_valid_bounty_id(id: &str) -> bool {
    id.len() == 36 && id.bytes().all(|c| c.is_ascii_hexdigit() || c == b'-')
}

/// Not the escrow address itself and not the token contract.
fn is_payable_address(address: &str, escrow: &str) -> bool {
    evm::is_evm_address(address) && address != escrow && address != evm::USDC_TOKEN
}
