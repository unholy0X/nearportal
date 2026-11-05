use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};
use nearportal_common::events::{emit, Event};
use nearportal_common::{errors, mpc, util};

use crate::*;

/// A signature request older than this may be repeated (the MPC yield has timed out).
pub const SIGNATURE_RETRY_SECS: u64 = 15 * 60;

#[near]
impl Contract {
    /// The verifier pays the reward to the active assignment's recipient for the exact
    /// recorded head. Builds the bounty's only transaction:
    /// `USDC.transfer(recipient, reward_cents * 10_000)` at nonce 0, fees capped. Repeating the
    /// call with the same evidence is a no-op; the signed bytes never change.
    #[allow(clippy::too_many_arguments)]
    pub fn settle_bounty(
        &mut self,
        bounty_id: String,
        generation: u32,
        assignment_hash: String,
        head_sha: String,
        evidence_hash: String,
        max_fee: U64,
        priority_fee: U64,
    ) {
        self.roles.assert_not_paused();
        let mut b = self.bounty(&bounty_id);
        Self::assert_verifier(&b);
        if let Some(p) = &b.payout {
            require!(
                p.kind == PayoutKind::Developer
                    && p.evidence_hash.as_deref() == Some(evidence_hash.as_str()),
                errors::SETTLEMENT_ALREADY_AUTHORIZED
            );
            return;
        }
        require!(
            util::is_sha256_hex(&evidence_hash),
            errors::INVALID_EVIDENCE_HASH
        );
        require!(
            b.state == BountyState::Funded,
            errors::FUNDED_UNSETTLED_REQUIRED
        );
        let a = b
            .assignment
            .clone()
            .unwrap_or_else(|| env::panic_str(errors::NO_ACTIVE_ASSIGNMENT));
        a.require_matches(generation, &assignment_hash);
        a.require_submitted(&head_sha);
        let units = b.reward_units();
        Self::authorize_payout(
            &bounty_id,
            &mut b,
            PayoutKind::Developer,
            a.recipient,
            units,
            Some(evidence_hash.clone()),
            (max_fee.0, priority_fee.0),
        );
        emit(
            RAIL,
            Event::SettlementAuthorized,
            json!({
                "bounty_id": bounty_id, "generation": generation, "assignment_hash": assignment_hash,
                "head_sha": head_sha, "evidence_hash": evidence_hash,
            }),
        );
        self.bounties.insert(bounty_id.clone(), b);
        self.request_payout_signature(&bounty_id, 0);
    }

    /// Requests a signature again for exactly the frozen transaction, once the previous
    /// request is older than `SIGNATURE_RETRY_SECS` and no signature was stored.
    pub fn retry_payout_signature(&mut self, bounty_id: String) {
        let mut b = self.bounty(&bounty_id);
        let caller = env::predecessor_account_id();
        require!(
            caller == b.verifier || caller == self.roles.owner,
            errors::ONLY_VERIFIER_OR_OWNER
        );
        let p = b
            .payout
            .as_mut()
            .unwrap_or_else(|| env::panic_str(errors::NO_SUCH_PAYOUT));
        require!(
            p.signature.is_none()
                && p.tx_hash.is_none()
                && util::now_secs() > p.requested_at_secs.0 + SIGNATURE_RETRY_SECS,
            errors::SIGNATURE_RETRY_NOT_READY
        );
        p.attempt = p
            .attempt
            .checked_add(1)
            .unwrap_or_else(|| env::panic_str(errors::OVERFLOW));
        p.signing = true;
        p.requested_at_secs = U64(util::now_secs());
        let attempt = p.attempt;
        emit(
            RAIL,
            Event::PayoutScheduled,
            json!({ "bounty_id": bounty_id, "kind": p.kind, "amount_units": p.amount_units, "unsigned_tx": p.unsigned_tx, "attempt": attempt }),
        );
        self.bounties.insert(bounty_id.clone(), b);
        self.request_payout_signature(&bounty_id, attempt);
    }

    /// MPC callback. Never panics. The signature is stored only if it recovers to the escrow
    /// address; callbacks of an earlier attempt are ignored.
    #[private]
    pub fn on_payout_signed(&mut self, bounty_id: String, attempt: u32) {
        let Some(mut b) = self.bounties.get(&bounty_id).cloned() else {
            return;
        };
        let escrow = b.escrow_evm_address.clone();
        let Some(p) = b.payout.as_mut() else {
            return;
        };
        if !p.signing || p.attempt != attempt {
            return;
        }
        let digest = hex::decode(&p.digest)
            .ok()
            .and_then(|d| <[u8; 32]>::try_from(d).ok());
        let outcome = match digest {
            Some(d) => mpc::verified_signature(&d, &escrow),
            None => Err(mpc::REASON_INVALID_PAYLOAD),
        };
        p.signing = false;
        match outcome {
            Ok(sig) => {
                emit(
                    RAIL,
                    Event::PayoutSigned,
                    json!({ "bounty_id": bounty_id, "signature": sig, "attempt": attempt }),
                );
                p.signature = Some(sig);
            }
            Err(reason) => emit(
                RAIL,
                Event::PayoutSignFailed,
                json!({ "bounty_id": bounty_id, "reason": reason, "attempt": attempt }),
            ),
        }
        self.bounties.insert(bounty_id, b);
    }

    /// Called by the relayer once the transaction is confirmed. `tx_hash` must be the hash
    /// of the stored unsigned transaction with the stored signature. Idempotent.
    pub fn mark_payout_processed(&mut self, bounty_id: String, tx_hash: String) {
        self.roles.assert_relayer();
        let mut b = self.bounty(&bounty_id);
        let p = b
            .payout
            .as_mut()
            .unwrap_or_else(|| env::panic_str(errors::NO_SUCH_PAYOUT));
        let signature = p
            .signature
            .clone()
            .unwrap_or_else(|| env::panic_str(errors::PAYOUT_NOT_SIGNED));
        let expected = hex::decode(p.unsigned_tx.trim_start_matches("0x"))
            .ok()
            .and_then(|tx| evm::signed_transaction_hash(&tx, &signature))
            .map(|h| format!("0x{}", hex::encode(h)));
        require!(
            expected.as_deref() == Some(tx_hash.as_str()),
            errors::INVALID_PROCESSED_RECEIPT
        );
        if let Some(old) = &p.tx_hash {
            require!(old == &tx_hash, errors::PAYOUT_ALREADY_PROCESSED);
            return;
        }
        p.tx_hash = Some(tx_hash.clone());
        emit(
            RAIL,
            Event::PayoutProcessed,
            json!({ "bounty_id": bounty_id, "tx_hash": tx_hash }),
        );
        self.bounties.insert(bounty_id, b);
    }
}

impl Contract {
    /// Freezes the bounty's single transaction and closes the bounty. `fees` is
    /// `(max_fee_per_gas, max_priority_fee_per_gas)` in wei.
    pub(crate) fn authorize_payout(
        bounty_id: &str,
        b: &mut Bounty,
        kind: PayoutKind,
        recipient: String,
        units: u64,
        evidence_hash: Option<String>,
        fees: (u64, u64),
    ) {
        let (max_fee, priority_fee) = fees;
        require!(
            max_fee > 0 && max_fee <= evm::MAX_FEE_PER_GAS_WEI && priority_fee <= max_fee,
            errors::GAS_FEE_LIMIT
        );
        require!(units > 0, errors::PAYOUT_NOT_POSITIVE);
        mpc::require_gas_for_signatures(1);
        let unsigned = evm::erc20_transfer_eip1559(&recipient, units, max_fee, priority_fee);
        let digest = env::keccak256_array(&unsigned);
        let payout = UsdcPayout {
            kind,
            recipient,
            amount_units: U64(units),
            unsigned_tx: format!("0x{}", hex::encode(unsigned)),
            digest: hex::encode(digest),
            evidence_hash,
            signature: None,
            signing: true,
            attempt: 0,
            requested_at_secs: U64(util::now_secs()),
            tx_hash: None,
        };
        emit(
            RAIL,
            Event::PayoutScheduled,
            json!({
                "bounty_id": bounty_id, "kind": payout.kind, "recipient": payout.recipient,
                "amount_units": payout.amount_units, "unsigned_tx": payout.unsigned_tx, "attempt": 0,
            }),
        );
        b.payout = Some(payout);
        b.state = BountyState::Closed;
        emit(
            RAIL,
            Event::BountyClosed,
            json!({ "bounty_id": bounty_id, "deposited_units": b.deposited_units }),
        );
    }

    /// Detached: the signature arrives in `on_payout_signed`.
    pub(crate) fn request_payout_signature(&self, bounty_id: &str, attempt: u32) {
        let b = self.bounty(bounty_id);
        let digest = b
            .payout
            .as_ref()
            .and_then(|p| hex::decode(&p.digest).ok())
            .and_then(|d| <[u8; 32]>::try_from(d).ok())
            .unwrap_or_else(|| env::panic_str(errors::NO_SUCH_PAYOUT));
        let _ = mpc::sign(&self.mpc_contract, &self.escrow_path(bounty_id), digest).then(
            Self::ext(env::current_account_id())
                .with_static_gas(mpc::GAS_FOR_CALLBACK)
                .on_payout_signed(bounty_id.to_string(), attempt),
        );
    }
}
