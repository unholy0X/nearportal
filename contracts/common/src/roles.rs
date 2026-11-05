//! Roles shared by both contracts.
//! - owner: pause, role rotation, dispute resolution and MPC signing recovery;
//! - relayer: reports deposits and processed payouts (time-locked rotation);
//! - verifier: copied into each bounty at creation and frozen there; rotation applies to new
//!   bounties only;
//! - operators: allowlisted accounts that create bounties as the client. The funder behind an
//!   operator is identified off chain (GitHub OAuth), which is a trust assumption.
//!
//! Owner, verifier and operators must be distinct accounts.

use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::store::IterableSet;
use near_sdk::{env, near, require, AccountId, IntoStorageKey};

use crate::errors;
use crate::events::{emit, Event, Rail};
use crate::util::DAY_NS;

pub const RELAYER_CHANGE_DELAY_NS: u64 = 2 * DAY_NS;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingRelayer {
    pub relayer: AccountId,
    /// Earliest block time at which the change can be applied.
    pub not_before_ns: U64,
}

#[near(serializers = [borsh])]
pub struct Roles {
    pub owner: AccountId,
    pub relayer: AccountId,
    pub pending_relayer: Option<PendingRelayer>,
    pub verifier: AccountId,
    pub operators: IterableSet<AccountId>,
    pub paused: bool,
}

impl Roles {
    pub fn new<S: IntoStorageKey>(
        owner: AccountId,
        relayer: AccountId,
        verifier: AccountId,
        operators_prefix: S,
    ) -> Self {
        require!(owner != verifier, errors::VERIFIER_NOT_INDEPENDENT);
        Self {
            owner,
            relayer,
            pending_relayer: None,
            verifier,
            operators: IterableSet::new(operators_prefix),
            paused: false,
        }
    }

    pub fn assert_owner(&self) {
        require!(
            env::predecessor_account_id() == self.owner,
            errors::ONLY_OWNER
        );
    }

    pub fn assert_relayer(&self) {
        require!(
            env::predecessor_account_id() == self.relayer,
            errors::ONLY_RELAYER
        );
    }

    pub fn assert_not_paused(&self) {
        require!(!self.paused, errors::PAUSED);
    }

    pub fn assert_operator(&self) {
        require!(
            self.operators.contains(&env::predecessor_account_id()),
            errors::ONLY_OPERATOR
        );
    }

    pub fn operator_list(&self) -> Vec<AccountId> {
        self.operators.iter().cloned().collect()
    }

    pub fn propose_relayer(&mut self, rail: Rail, relayer: AccountId) {
        self.assert_owner();
        let not_before_ns = U64(env::block_timestamp().saturating_add(RELAYER_CHANGE_DELAY_NS));
        emit(
            rail,
            Event::RelayerProposed,
            json!({ "relayer": relayer, "not_before_ns": not_before_ns }),
        );
        self.pending_relayer = Some(PendingRelayer {
            relayer,
            not_before_ns,
        });
    }

    pub fn apply_relayer(&mut self, rail: Rail) {
        self.assert_owner();
        let pending = self
            .pending_relayer
            .take()
            .unwrap_or_else(|| env::panic_str(errors::NO_PENDING_RELAYER));
        require!(
            env::block_timestamp() >= pending.not_before_ns.0,
            errors::RELAYER_TIME_LOCKED
        );
        emit(
            rail,
            Event::RelayerSet,
            json!({ "relayer": pending.relayer }),
        );
        self.relayer = pending.relayer;
    }

    pub fn cancel_relayer_change(&mut self, rail: Rail) {
        self.assert_owner();
        self.pending_relayer = None;
        emit(rail, Event::RelayerChangeCancelled, json!({}));
    }

    pub fn set_paused(&mut self, rail: Rail, paused: bool) {
        self.assert_owner();
        emit(rail, Event::PausedSet, json!({ "paused": paused }));
        self.paused = paused;
    }

    pub fn transfer_ownership(&mut self, rail: Rail, new_owner: AccountId) {
        self.assert_owner();
        require!(
            new_owner != self.verifier && !self.operators.contains(&new_owner),
            errors::OWNER_NOT_INDEPENDENT
        );
        emit(rail, Event::OwnerSet, json!({ "owner": new_owner }));
        self.owner = new_owner;
    }

    pub fn set_verifier(&mut self, rail: Rail, verifier: AccountId) {
        self.assert_owner();
        require!(
            verifier != self.owner && !self.operators.contains(&verifier),
            errors::VERIFIER_NOT_INDEPENDENT
        );
        emit(rail, Event::VerifierSet, json!({ "verifier": verifier }));
        self.verifier = verifier;
    }

    pub fn set_operator(&mut self, rail: Rail, operator: AccountId, allowed: bool) {
        self.assert_owner();
        if allowed {
            require!(
                operator != self.owner && operator != self.verifier,
                errors::OPERATOR_NOT_INDEPENDENT
            );
            self.operators.insert(operator.clone());
        } else {
            self.operators.remove(&operator);
        }
        emit(
            rail,
            Event::OperatorSet,
            json!({ "operator": operator, "allowed": allowed }),
        );
    }
}
