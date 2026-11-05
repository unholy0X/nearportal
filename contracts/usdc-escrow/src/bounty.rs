use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};
use nearportal_common::assignment::validate_delivery_seconds;
use nearportal_common::events::{emit, Event};
use nearportal_common::evm::BASE_SEPOLIA_CHAIN_ID;
use nearportal_common::{errors, mpc, util, DisputeOutcome};

use crate::*;

#[near]
impl Contract {
    /// Called by an allowlisted operator, who becomes the client. Repeating the call with
    /// identical terms is a no-op (the attached deposit is refunded); different terms panic.
    /// The bounty stays in `VerifyingAddress` until the MPC network confirms the address.
    #[payable]
    pub fn create_bounty(&mut self, bounty_id: String, bounty: NewBounty) {
        self.roles.assert_not_paused();
        Self::assert_testnet();
        self.roles.assert_operator();
        require!(is_valid_bounty_id(&bounty_id), errors::INVALID_BOUNTY_ID);
        let reward = bounty.reward_cents.0;
        require!(
            reward > 0 && reward <= MAX_REWARD_CENTS,
            errors::INVALID_REWARD
        );
        require!(
            util::is_sha256_hex(&bounty.funding_policy_hash),
            errors::INVALID_FUNDING_POLICY_HASH
        );
        validate_delivery_seconds(bounty.delivery_seconds);
        require!(
            evm::is_evm_address(&bounty.escrow_evm_address),
            errors::INVALID_ESCROW_ADDRESS
        );
        require!(
            is_payable_address(&bounty.refund_address, &bounty.escrow_evm_address),
            errors::INVALID_REFUND_ADDRESS
        );
        let client = env::predecessor_account_id();
        if let Some(old) = self.bounties.get(&bounty_id) {
            require!(
                old.client == client
                    && old.verifier == self.roles.verifier
                    && old.funding_policy_hash == bounty.funding_policy_hash
                    && old.reward_cents == bounty.reward_cents
                    && old.delivery_seconds == bounty.delivery_seconds
                    && old.refund_address == bounty.refund_address
                    && old.escrow_evm_address == bounty.escrow_evm_address,
                errors::BOUNTY_ALREADY_EXISTS
            );
            util::charge_storage(env::storage_usage());
            return;
        }
        mpc::require_gas_for_derivation();
        let storage_before = env::storage_usage();
        let record = Bounty {
            client,
            verifier: self.roles.verifier.clone(),
            funding_policy_hash: bounty.funding_policy_hash,
            reward_cents: bounty.reward_cents,
            delivery_seconds: bounty.delivery_seconds,
            refund_address: bounty.refund_address,
            escrow_evm_address: bounty.escrow_evm_address,
            state: BountyState::VerifyingAddress,
            deposited_units: U64(0),
            generation: 0,
            assignment: None,
            payout: None,
        };
        emit(
            RAIL,
            Event::BountyCreated,
            json!({
                "bounty_id": bounty_id, "client": record.client, "verifier": record.verifier,
                "funding_policy_hash": record.funding_policy_hash, "reward_cents": record.reward_cents,
                "delivery_seconds": record.delivery_seconds, "refund_address": record.refund_address,
                "escrow_path": self.escrow_path(&bounty_id), "escrow_evm_address": record.escrow_evm_address,
            }),
        );
        self.bounties.insert(bounty_id.clone(), record);
        self.bounties.flush();
        util::charge_storage(storage_before);
        self.check_escrow_address(bounty_id);
    }

    /// Repeats the MPC address check after a failed or lost callback.
    pub fn retry_address_check(&mut self, bounty_id: String) {
        let b = self.bounty(&bounty_id);
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
        self.check_escrow_address(bounty_id);
    }

    /// MPC callback. Never panics. A transient failure remains retryable; a confirmed mismatch cancels the bounty.
    #[private]
    pub fn on_escrow_address_checked(&mut self, bounty_id: String) {
        let Some(mut b) = self.bounties.get(&bounty_id).cloned() else {
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
            self.bounties.insert(bounty_id, b);
        } else {
            if derived.is_some() {
                b.state = BountyState::Cancelled;
            }
            self.bounties.insert(bounty_id.clone(), b);
            emit(
                RAIL,
                Event::EscrowAddressRejected,
                json!({ "bounty_id": bounty_id, "derived": derived }),
            );
        }
    }

    /// Called by the relayer for each confirmed USDC transfer to the escrow address.
    /// `reference` is `84532:0x{tx hash}:{log index as 8 hex digits}`. Repeating a receipt
    /// with the same bounty and units is a no-op.
    pub fn record_deposit(&mut self, bounty_id: String, units: U64, reference: String) {
        self.roles.assert_not_paused();
        self.roles.assert_relayer();
        let mut b = self.bounty(&bounty_id);
        require!(
            !matches!(
                b.state,
                BountyState::VerifyingAddress | BountyState::Cancelled
            ),
            errors::ADDRESS_NOT_VERIFIED
        );
        require!(
            units.0 > 0 && is_deposit_reference(&reference),
            errors::INVALID_DEPOSIT_RECEIPT
        );
        let receipt = Receipt {
            bounty_id: bounty_id.clone(),
            units: units.0,
        };
        if let Some(old) = self.receipts.get(&reference) {
            require!(old == &receipt, errors::RECEIPT_ALREADY_CONSUMED);
            return;
        }
        let reward = b.reward_units();
        let before = b.deposited_units.0;
        let total = before
            .checked_add(units.0)
            .unwrap_or_else(|| env::panic_str(errors::OVERFLOW));
        b.deposited_units = U64(total);
        emit(
            RAIL,
            Event::DepositRecorded,
            json!({
                "bounty_id": bounty_id, "amount_units": units, "deposited_units": b.deposited_units,
                "reference": reference,
            }),
        );
        if total > reward {
            emit(
                RAIL,
                Event::SurplusRecorded,
                json!({ "bounty_id": bounty_id, "amount_units": U64(total - before.max(reward)), "reference": reference }),
            );
        }
        if b.state == BountyState::AwaitingDeposit && total >= reward {
            b.state = BountyState::Funded;
            emit(
                RAIL,
                Event::BountyFunded,
                json!({ "bounty_id": bounty_id, "deposited_units": b.deposited_units }),
            );
        }
        self.receipts.insert(reference, receipt);
        self.bounties.insert(bounty_id, b);
    }

    /// Called by the client or the verifier once money has been deposited and before any
    /// transaction is authorized.
    pub fn open_dispute(&mut self, bounty_id: String) {
        let mut b = self.bounty(&bounty_id);
        let caller = env::predecessor_account_id();
        require!(
            caller == b.client || caller == b.verifier,
            errors::ONLY_CLIENT_OR_VERIFIER
        );
        require!(b.payout.is_none(), errors::SETTLEMENT_ALREADY_AUTHORIZED);
        require!(
            b.state == BountyState::Funded
                || (b.state == BountyState::AwaitingDeposit && b.deposited_units.0 > 0),
            errors::NOTHING_TO_DISPUTE
        );
        b.state = BountyState::Disputed;
        emit(
            RAIL,
            Event::DisputeOpened,
            json!({ "bounty_id": bounty_id, "by": caller }),
        );
        self.bounties.insert(bounty_id, b);
    }

    /// Resume verification under the original agreement, or refund every recorded deposit
    /// unit to the fixed refund address. Resume never requests an MPC signature.
    pub fn resolve_dispute(
        &mut self,
        bounty_id: String,
        outcome: DisputeOutcome,
        max_fee: U64,
        priority_fee: U64,
    ) {
        self.roles.assert_owner();
        self.roles.assert_not_paused();
        let mut b = self.bounty(&bounty_id);
        require!(b.state == BountyState::Disputed, errors::NO_OPEN_DISPUTE);
        match outcome {
            DisputeOutcome::Resume => {
                b.state = if b.deposited_units.0 >= b.reward_units() {
                    BountyState::Funded
                } else {
                    BountyState::AwaitingDeposit
                };
            }
            DisputeOutcome::Refund => {
                let recipient = b.refund_address.clone();
                let units = b.deposited_units.0;
                Self::authorize_payout(
                    &bounty_id,
                    &mut b,
                    PayoutKind::Refund,
                    recipient,
                    units,
                    None,
                    (max_fee.0, priority_fee.0),
                );
            }
        }
        emit(
            RAIL,
            Event::DisputeResolved,
            json!({ "bounty_id": bounty_id, "outcome": outcome }),
        );
        self.bounties.insert(bounty_id.clone(), b);
        if outcome == DisputeOutcome::Refund {
            self.request_payout_signature(&bounty_id, 0);
        }
    }

    pub fn get_bounty(&self, bounty_id: String) -> Option<Bounty> {
        self.bounties.get(&bounty_id).cloned()
    }

    /// Derivation path of a bounty's escrow address (for MPC `derived_public_key`).
    pub fn get_escrow_path(&self, bounty_id: String) -> String {
        require!(is_valid_bounty_id(&bounty_id), errors::INVALID_BOUNTY_ID);
        self.escrow_path(&bounty_id)
    }
}

impl Contract {
    fn check_escrow_address(&self, bounty_id: String) {
        let path = self.escrow_path(&bounty_id);
        let _ = mpc::derived_public_key(&self.mpc_contract, &path).then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::GAS_FOR_CALLBACK)
                .on_escrow_address_checked(bounty_id),
        );
    }
}

/// `84532:0x` + 64 lowercase hex (transaction hash) + `:` + 8 lowercase hex (log index).
fn is_deposit_reference(reference: &str) -> bool {
    let prefix = format!("{BASE_SEPOLIA_CHAIN_ID}:0x");
    let Some(rest) = reference.strip_prefix(prefix.as_str()) else {
        return false;
    };
    rest.len() == 73
        && rest.is_ascii()
        && util::is_sha256_hex(&rest[..64])
        && rest.as_bytes()[64] == b':'
        && util::is_lower_hex(&rest[65..])
}
