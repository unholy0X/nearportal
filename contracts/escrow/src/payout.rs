use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, Promise};
use nearportal_common::events::{emit, Event};
use nearportal_common::monerium::{self, MESSAGE_LEAD_SECS, MONERIUM_TOLERANCE_SECS};
use nearportal_common::{errors, evm, mpc, util};

use crate::*;

#[near]
impl Contract {
    /// Signs a payout again with a fresh timestamp, always after the previous message expired.
    /// Without owner approval only when the MPC call itself failed (no signature can exist);
    /// otherwise the owner must first confirm off chain that no order was executed.
    /// Amount and destination never change.
    pub fn retry_payout(&mut self, payout_id: U64) -> Promise {
        let mut p = self.payout(payout_id.0);
        let b = self.bounty(p.bounty_id.0);
        let caller = env::predecessor_account_id();
        require!(
            caller == b.client || caller == self.roles.owner || caller == self.roles.relayer,
            errors::ONLY_CLIENT_OWNER_OR_RELAYER
        );
        require!(
            util::now_secs() > p.message_unix_secs.0 + MONERIUM_TOLERANCE_SECS,
            errors::PREVIOUS_MESSAGE_NOT_EXPIRED
        );
        let no_signature_possible = p.state == PayoutState::SignFailed
            && p.failure_reason.as_deref() == Some(mpc::REASON_MPC_FAILED);
        require!(
            matches!(p.state, PayoutState::SignFailed | PayoutState::Signed)
                && (no_signature_possible || p.resign_authorized),
            errors::PAYOUT_CANNOT_BE_RESIGNED
        );
        mpc::require_gas_for_signatures(1);
        p.message_unix_secs = U64(util::now_secs() + MESSAGE_LEAD_SECS);
        p.message =
            monerium::redeem_message(p.amount_cents.0, &p.short_iban, p.message_unix_secs.0);
        let digest = evm::eip191_hash(&p.message);
        p.payload_hash = hex::encode(digest);
        p.signature = None;
        p.failure_reason = None;
        p.resign_authorized = false;
        p.attempt = p
            .attempt
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str(errors::OVERFLOW));
        p.state = PayoutState::Signing;
        Self::emit_scheduled(payout_id.0, &p);
        let attempt = p.attempt;
        self.payouts.insert(payout_id.0, p);
        self.request_payout_signature(payout_id.0, attempt, &b.escrow_path, digest)
    }

    /// Owner recovery, after checking off chain (Monerium, Base explorer) that an expired
    /// message was never executed and no order is pending.
    pub fn authorize_resign(&mut self, payout_id: U64) {
        self.roles.assert_owner();
        let mut p = self.payout(payout_id.0);
        require!(
            matches!(p.state, PayoutState::Signed | PayoutState::SignFailed),
            errors::PAYOUT_NOT_SIGNED_OR_FAILED
        );
        require!(
            util::now_secs() > p.message_unix_secs.0 + MONERIUM_TOLERANCE_SECS,
            errors::MESSAGE_NOT_EXPIRED
        );
        p.resign_authorized = true;
        emit(
            RAIL,
            Event::PayoutResignAuthorized,
            json!({ "payout_id": payout_id, "bounty_id": p.bounty_id }),
        );
        self.payouts.insert(payout_id.0, p);
    }

    /// Owner recovery for a payout stuck in `Signing` (the MPC callback never completed),
    /// only after the message expired plus the MPC timeout margin.
    pub fn mark_sign_failed(&mut self, payout_id: U64) {
        self.roles.assert_owner();
        let mut p = self.payout(payout_id.0);
        require!(p.state == PayoutState::Signing, errors::PAYOUT_NOT_SIGNING);
        require!(
            util::now_secs()
                > p.message_unix_secs.0 + MONERIUM_TOLERANCE_SECS + mpc::MPC_TIMEOUT_SECS,
            errors::SIGNING_NOT_TIMED_OUT
        );
        p.state = PayoutState::SignFailed;
        p.failure_reason = Some(mpc::REASON_TIMEOUT.into());
        emit(
            RAIL,
            Event::PayoutSignFailed,
            json!({ "payout_id": payout_id, "bounty_id": p.bounty_id, "reason": mpc::REASON_TIMEOUT }),
        );
        self.payouts.insert(payout_id.0, p);
    }

    /// MPC callback for payouts. Never panics. The signature is stored only if it recovers to
    /// the bounty's escrow address; callbacks of an earlier attempt are ignored.
    #[private]
    pub fn on_payout_signed(&mut self, payout_id: U64, attempt: u32) {
        let Some(mut p) = self.payouts.get(&payout_id.0).cloned() else {
            return;
        };
        if p.state != PayoutState::Signing || p.attempt != attempt {
            return;
        }
        let Some(b) = self.bounties.get(&p.bounty_id.0) else {
            return;
        };
        let digest = hex::decode(&p.payload_hash)
            .ok()
            .and_then(|d| <[u8; 32]>::try_from(d).ok());
        let outcome = match digest {
            Some(d) => mpc::verified_signature(&d, &b.escrow_evm_address),
            None => Err(mpc::REASON_INVALID_PAYLOAD),
        };
        match outcome {
            Ok(sig) => {
                emit(
                    RAIL,
                    Event::PayoutSigned,
                    json!({
                        "payout_id": payout_id, "bounty_id": p.bounty_id, "message": p.message,
                        "signature": sig, "attempt": attempt,
                    }),
                );
                p.signature = Some(sig);
                p.state = PayoutState::Signed;
            }
            Err(reason) => {
                emit(
                    RAIL,
                    Event::PayoutSignFailed,
                    json!({ "payout_id": payout_id, "bounty_id": p.bounty_id, "reason": reason }),
                );
                p.state = PayoutState::SignFailed;
                p.failure_reason = Some(reason.into());
            }
        }
        self.payouts.insert(payout_id.0, p);
    }

    /// Called by the relayer after Monerium processed the redeem order.
    pub fn mark_payout_processed(&mut self, payout_id: U64, monerium_order_id: String) {
        self.roles.assert_relayer();
        require!(
            util::is_valid_ref(&monerium_order_id),
            errors::INVALID_ORDER_ID
        );
        let mut p = self.payout(payout_id.0);
        require!(p.state == PayoutState::Signed, errors::PAYOUT_NOT_SIGNED);
        p.state = PayoutState::Processed;
        p.monerium_order_id = Some(monerium_order_id.clone());
        let bounty_id = p.bounty_id.0;
        let mut b = self.bounty(bounty_id);
        b.open_payouts -= 1;
        emit(
            RAIL,
            Event::PayoutProcessed,
            json!({ "payout_id": payout_id, "bounty_id": p.bounty_id, "monerium_order_id": monerium_order_id }),
        );
        self.payouts.insert(payout_id.0, p);
        self.schedule_surplus_refund_if_due(bounty_id, &mut b);
        self.bounties.insert(bounty_id, b);
    }

    pub fn get_payout(&self, payout_id: U64) -> Option<Payout> {
        self.payouts.get(&payout_id.0).cloned()
    }
}

impl Contract {
    /// `from_deposits`: the amount is taken from allocated deposits and counted in
    /// `committed_cents`; surplus refunds are not.
    pub(crate) fn schedule_payout(
        &mut self,
        bounty_id: BountyId,
        b: &mut Bounty,
        kind: PayoutKind,
        amount_cents: u64,
        short_iban: String,
        from_deposits: bool,
    ) -> PayoutId {
        require!(amount_cents > 0, errors::PAYOUT_NOT_POSITIVE);
        if from_deposits {
            require!(
                amount_cents <= b.uncommitted_cents(),
                errors::PAYOUT_EXCEEDS_UNCOMMITTED
            );
            b.committed_cents = U64(b.committed_cents.0 + amount_cents);
        }
        mpc::require_gas_for_signatures(1);
        b.open_payouts += 1;

        let id = self.next_payout_id;
        self.next_payout_id += 1;
        let message_unix_secs = util::now_secs() + MESSAGE_LEAD_SECS;
        let message = monerium::redeem_message(amount_cents, &short_iban, message_unix_secs);
        let digest = evm::eip191_hash(&message);
        let p = Payout {
            bounty_id: U64(bounty_id),
            kind,
            amount_cents: U64(amount_cents),
            short_iban,
            message_unix_secs: U64(message_unix_secs),
            message,
            payload_hash: hex::encode(digest),
            signature: None,
            state: PayoutState::Signing,
            failure_reason: None,
            resign_authorized: false,
            attempt: 0,
            monerium_order_id: None,
        };
        Self::emit_scheduled(id, &p);
        self.payouts.insert(id, p);
        // Detached: the signature arrives in `on_payout_signed`.
        let _ = self.request_payout_signature(id, 0, &b.escrow_path, digest);
        id
    }

    fn emit_scheduled(payout_id: PayoutId, p: &Payout) {
        emit(
            RAIL,
            Event::PayoutScheduled,
            json!({
                "payout_id": U64(payout_id), "bounty_id": p.bounty_id, "kind": p.kind,
                "amount_cents": p.amount_cents, "message": p.message, "attempt": p.attempt,
            }),
        );
    }

    fn request_payout_signature(
        &self,
        payout_id: PayoutId,
        attempt: u32,
        path: &str,
        digest: [u8; 32],
    ) -> Promise {
        mpc::sign(&self.mpc_contract, path, digest).then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::GAS_FOR_CALLBACK)
                .on_payout_signed(U64(payout_id), attempt),
        )
    }
}
