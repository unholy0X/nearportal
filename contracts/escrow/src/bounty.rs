use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, Promise};
use nearportal_common::events::{emit, Event};
use nearportal_common::{errors, evm, monerium, mpc, util, DisputeOutcome};

use crate::*;

#[near]
impl Contract {
    /// Called by an allowlisted operator, who becomes the client. Attach NEAR for storage;
    /// the excess is refunded. The bounty stays in `VerifyingAddress` until the MPC network
    /// confirms that `escrow_evm_address` is derived for `get_escrow_path(id)`.
    #[payable]
    pub fn create_bounty(&mut self, bounty: NewBounty) -> U64 {
        self.roles.assert_not_paused();
        self.roles.assert_operator();
        let reward = bounty.reward_cents.0;
        require!(
            reward > 0 && reward <= MAX_REWARD_CENTS,
            errors::INVALID_REWARD
        );
        require!(
            util::is_sha256_hex(&bounty.funding_policy_hash),
            errors::INVALID_FUNDING_POLICY_HASH
        );
        nearportal_common::assignment::validate_delivery_seconds(bounty.delivery_seconds);
        require!(
            monerium::is_valid_short_iban(&bounty.refund_short_iban),
            errors::INVALID_SHORT_IBAN
        );
        require!(
            evm::is_evm_address(&bounty.escrow_evm_address),
            errors::INVALID_ESCROW_ADDRESS
        );
        mpc::require_gas_for_derivation();

        let storage_before = env::storage_usage();
        let id = self.next_bounty_id;
        self.next_bounty_id += 1;
        let escrow_path = self.escrow_path(id);
        let record = Bounty {
            client: env::predecessor_account_id(),
            verifier: self.roles.verifier.clone(),
            funding_policy_hash: bounty.funding_policy_hash,
            reward_cents: bounty.reward_cents,
            delivery_seconds: bounty.delivery_seconds,
            refund_short_iban: bounty.refund_short_iban,
            escrow_path: escrow_path.clone(),
            escrow_evm_address: bounty.escrow_evm_address,
            state: BountyState::VerifyingAddress,
            link: LinkState::None,
            created_at_ns: U64(env::block_timestamp()),
            deposited_cents: U64(0),
            committed_cents: U64(0),
            surplus_recorded_cents: U64(0),
            surplus_refunded_cents: U64(0),
            open_payouts: 0,
            generation: 0,
            assignment: None,
            settlement_payout_id: None,
            settlement_evidence_hash: None,
        };
        emit(
            RAIL,
            Event::BountyCreated,
            json!({
                "bounty_id": U64(id), "client": record.client, "verifier": record.verifier,
                "funding_policy_hash": record.funding_policy_hash, "reward_cents": record.reward_cents,
                "delivery_seconds": record.delivery_seconds, "escrow_path": escrow_path,
                "escrow_evm_address": record.escrow_evm_address,
            }),
        );
        self.bounties.insert(id, record);
        self.bounties.flush();
        util::charge_storage(storage_before);

        let _ = mpc::derived_public_key(&self.mpc_contract, &escrow_path).then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::GAS_FOR_CALLBACK)
                .on_escrow_address_checked(U64(id)),
        );
        U64(id)
    }

    /// Retry a transient MPC failure using the same immutable path and expected address.
    pub fn retry_address_check(&mut self, bounty_id: U64) {
        let b = self.bounty(bounty_id.0);
        let caller = env::predecessor_account_id();
        require!(
            caller == b.client || caller == b.verifier,
            errors::ONLY_CLIENT_OR_VERIFIER
        );
        require!(
            b.state == BountyState::VerifyingAddress,
            errors::ADDRESS_ALREADY_VERIFIED
        );
        mpc::require_gas_for_derivation();
        let _ = mpc::derived_public_key(&self.mpc_contract, &b.escrow_path).then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::GAS_FOR_CALLBACK)
                .on_escrow_address_checked(bounty_id),
        );
    }

    /// MPC callback of `create_bounty`. Never panics.
    #[private]
    pub fn on_escrow_address_checked(&mut self, bounty_id: U64) {
        let Some(mut b) = self.bounties.get(&bounty_id.0).cloned() else {
            return;
        };
        if b.state != BountyState::VerifyingAddress {
            return;
        }
        let derived = mpc::derived_address();
        if derived.as_deref() == Some(b.escrow_evm_address.as_str()) {
            b.state = BountyState::AwaitingDeposit;
            emit(
                RAIL,
                Event::EscrowAddressVerified,
                json!({ "bounty_id": bounty_id, "escrow_evm_address": b.escrow_evm_address }),
            );
        } else {
            if derived.is_some() {
                b.state = BountyState::Cancelled;
            }
            emit(
                RAIL,
                Event::EscrowAddressRejected,
                json!({ "bounty_id": bounty_id, "derived": derived }),
            );
        }
        self.bounties.insert(bounty_id.0, b);
    }

    /// Called by the relayer for each Monerium order minted to the bounty's escrow address.
    /// The reward is filled first; anything beyond it is surplus, which is refunded to the
    /// client once no payout of the bounty is in flight. Returns a scheduled surplus refund.
    pub fn record_deposit(
        &mut self,
        bounty_id: U64,
        amount_cents: U64,
        monerium_order_id: String,
    ) -> Option<U64> {
        self.roles.assert_not_paused();
        self.roles.assert_relayer();
        let amount = amount_cents.0;
        require!(amount > 0, errors::AMOUNT_NOT_POSITIVE);
        let mut b = self.bounty(bounty_id.0);
        require!(
            !matches!(
                b.state,
                BountyState::VerifyingAddress | BountyState::Cancelled
            ),
            errors::ADDRESS_NOT_VERIFIED
        );
        self.use_order_ref(&monerium_order_id);
        let allocated = if b.state == BountyState::AwaitingDeposit {
            amount.min(b.reward_cents.0 - b.deposited_cents.0)
        } else {
            0
        };
        if allocated > 0 {
            b.deposited_cents = U64(b.deposited_cents.0 + allocated);
            emit(
                RAIL,
                Event::DepositRecorded,
                json!({
                    "bounty_id": bounty_id, "amount_cents": U64(allocated),
                    "deposited_cents": b.deposited_cents, "monerium_order_id": monerium_order_id,
                }),
            );
            if b.deposited_cents == b.reward_cents {
                b.state = BountyState::Funded;
                emit(
                    RAIL,
                    Event::BountyFunded,
                    json!({ "bounty_id": bounty_id, "deposited_cents": b.deposited_cents }),
                );
            }
        }
        let surplus = amount - allocated;
        if surplus > 0 {
            b.surplus_recorded_cents = U64(b
                .surplus_recorded_cents
                .0
                .checked_add(surplus)
                .unwrap_or_else(|| env::panic_str(errors::OVERFLOW)));
            emit(
                RAIL,
                Event::SurplusRecorded,
                json!({
                    "bounty_id": bounty_id, "amount_cents": U64(surplus),
                    "monerium_order_id": monerium_order_id,
                }),
            );
        }
        let refund = self.schedule_surplus_refund_if_due(bounty_id.0, &mut b);
        self.bounties.insert(bounty_id.0, b);
        refund.map(U64)
    }

    /// Asks the MPC network to sign Monerium's ownership message for the escrow address, so
    /// it can be linked to a Monerium profile and IBAN. This message cannot move funds.
    pub fn link_escrow_address(&mut self, bounty_id: U64) -> Promise {
        let mut b = self.bounty(bounty_id.0);
        let caller = env::predecessor_account_id();
        require!(
            caller == b.client || caller == self.roles.relayer,
            errors::ONLY_CLIENT_OR_RELAYER
        );
        require!(
            matches!(
                b.state,
                BountyState::AwaitingDeposit | BountyState::Funded | BountyState::Disputed
            ),
            errors::LINK_NOT_AVAILABLE
        );
        require!(b.link != LinkState::Signing, errors::LINK_ALREADY_REQUESTED);
        mpc::require_gas_for_signatures(1);
        b.link = LinkState::Signing;
        let path = b.escrow_path.clone();
        self.bounties.insert(bounty_id.0, b);
        let digest = evm::eip191_hash(monerium::OWNERSHIP_MESSAGE);
        mpc::sign(&self.mpc_contract, &path, digest).then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::GAS_FOR_CALLBACK)
                .on_link_signed(bounty_id),
        )
    }

    /// MPC callback of `link_escrow_address`. Never panics.
    #[private]
    pub fn on_link_signed(&mut self, bounty_id: U64) {
        let Some(mut b) = self.bounties.get(&bounty_id.0).cloned() else {
            return;
        };
        if b.link != LinkState::Signing {
            return;
        }
        let digest = evm::eip191_hash(monerium::OWNERSHIP_MESSAGE);
        match mpc::verified_signature(&digest, &b.escrow_evm_address) {
            Ok(sig) => {
                emit(
                    RAIL,
                    Event::EscrowLinkSigned,
                    json!({
                        "bounty_id": bounty_id, "message": monerium::OWNERSHIP_MESSAGE, "signature": sig,
                    }),
                );
                b.link = LinkState::Signed(sig);
            }
            Err(reason) => {
                emit(
                    RAIL,
                    Event::EscrowLinkFailed,
                    json!({ "bounty_id": bounty_id, "reason": reason }),
                );
                b.link = LinkState::Failed;
            }
        }
        self.bounties.insert(bounty_id.0, b);
    }

    /// The verifier pays the reward to the active assignment's recipient for the exact
    /// recorded head. Exactly one settlement per bounty; the bounty closes.
    pub fn settle_bounty(
        &mut self,
        bounty_id: U64,
        generation: u32,
        assignment_hash: String,
        head_sha: String,
        evidence_hash: String,
    ) -> U64 {
        self.roles.assert_not_paused();
        let mut b = self.bounty(bounty_id.0);
        Self::assert_verifier(&b);
        require!(
            b.settlement_payout_id.is_none(),
            errors::SETTLEMENT_ALREADY_AUTHORIZED
        );
        require!(
            util::is_sha256_hex(&evidence_hash),
            errors::INVALID_EVIDENCE_HASH
        );
        require!(b.is_idle_funded(), errors::FUNDED_UNSETTLED_REQUIRED);
        let a = b
            .assignment
            .clone()
            .unwrap_or_else(|| env::panic_str(errors::NO_ACTIVE_ASSIGNMENT));
        a.require_matches(generation, &assignment_hash);
        a.require_submitted(&head_sha);
        let reward = b.reward_cents.0;
        let payout = self.schedule_payout(
            bounty_id.0,
            &mut b,
            PayoutKind::Developer,
            reward,
            a.recipient,
            true,
        );
        b.settlement_payout_id = Some(U64(payout));
        b.settlement_evidence_hash = Some(evidence_hash.clone());
        emit(
            RAIL,
            Event::SettlementAuthorized,
            json!({
                "bounty_id": bounty_id, "generation": generation, "assignment_hash": assignment_hash,
                "head_sha": head_sha, "evidence_hash": evidence_hash, "payout_id": U64(payout),
            }),
        );
        Self::close(bounty_id.0, &mut b);
        self.bounties.insert(bounty_id.0, b);
        U64(payout)
    }

    /// Called by the client or the verifier once money has been deposited. Freezes
    /// assignment, submission, expiry and settlement until the owner resolves it.
    pub fn open_dispute(&mut self, bounty_id: U64) {
        let mut b = self.bounty(bounty_id.0);
        let caller = env::predecessor_account_id();
        require!(
            caller == b.client || caller == b.verifier,
            errors::ONLY_CLIENT_OR_VERIFIER
        );
        require!(
            b.state == BountyState::Funded
                || (b.state == BountyState::AwaitingDeposit && b.deposited_cents.0 > 0),
            errors::NOTHING_TO_DISPUTE
        );
        b.state = BountyState::Disputed;
        emit(
            RAIL,
            Event::DisputeOpened,
            json!({ "bounty_id": bounty_id, "by": caller }),
        );
        self.bounties.insert(bounty_id.0, b);
    }

    /// Resume the original agreement without authorizing a developer payment, or refund
    /// every uncommitted deposit to the refund IBAN fixed at creation.
    pub fn resolve_dispute(&mut self, bounty_id: U64, outcome: DisputeOutcome) -> Option<U64> {
        self.roles.assert_owner();
        self.roles.assert_not_paused();
        let mut b = self.bounty(bounty_id.0);
        require!(b.state == BountyState::Disputed, errors::NO_OPEN_DISPUTE);
        let payout = match outcome {
            DisputeOutcome::Resume => {
                b.state = if b.deposited_cents.0 >= b.reward_cents.0 {
                    BountyState::Funded
                } else {
                    BountyState::AwaitingDeposit
                };
                None
            }
            DisputeOutcome::Refund => {
                let amount = b.uncommitted_cents();
                let destination = b.refund_short_iban.clone();
                let id = self.schedule_payout(
                    bounty_id.0,
                    &mut b,
                    PayoutKind::Refund,
                    amount,
                    destination,
                    true,
                );
                b.settlement_payout_id = Some(U64(id));
                Self::close(bounty_id.0, &mut b);
                Some(U64(id))
            }
        };
        emit(
            RAIL,
            Event::DisputeResolved,
            json!({ "bounty_id": bounty_id, "outcome": outcome, "payout_id": payout }),
        );
        self.bounties.insert(bounty_id.0, b);
        payout
    }

    pub fn get_bounty(&self, bounty_id: U64) -> Option<Bounty> {
        self.bounties.get(&bounty_id.0).cloned()
    }

    /// Derivation path of a bounty's escrow address (for MPC `derived_public_key`).
    pub fn get_escrow_path(&self, bounty_id: U64) -> String {
        self.escrow_path(bounty_id.0)
    }
}

impl Contract {
    fn close(bounty_id: BountyId, b: &mut Bounty) {
        b.state = BountyState::Closed;
        emit(
            RAIL,
            Event::BountyClosed,
            json!({ "bounty_id": U64(bounty_id), "committed_cents": b.committed_cents }),
        );
    }

    fn use_order_ref(&mut self, monerium_order_id: &str) {
        require!(
            util::is_valid_ref(monerium_order_id),
            errors::INVALID_ORDER_ID
        );
        require!(
            self.order_refs.insert(monerium_order_id.to_string()),
            errors::ORDER_ALREADY_RECORDED
        );
    }

    /// Refunds all unrefunded surplus to the client once the reward is funded or settled and
    /// no payout of the bounty is in flight, so surplus never competes with a settlement.
    pub(crate) fn schedule_surplus_refund_if_due(
        &mut self,
        bounty_id: BountyId,
        b: &mut Bounty,
    ) -> Option<PayoutId> {
        let available = b.surplus_recorded_cents.0 - b.surplus_refunded_cents.0;
        if available == 0
            || b.open_payouts > 0
            || !matches!(b.state, BountyState::Funded | BountyState::Closed)
        {
            return None;
        }
        b.surplus_refunded_cents = U64(b.surplus_refunded_cents.0 + available);
        let destination = b.refund_short_iban.clone();
        Some(self.schedule_payout(
            bounty_id,
            b,
            PayoutKind::SurplusRefund,
            available,
            destination,
            false,
        ))
    }
}
