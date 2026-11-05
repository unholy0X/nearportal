use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require};
use nearportal_common::assignment::{require_next_generation, Assignment};
use nearportal_common::events::{emit, Event};
use nearportal_common::{errors, util};

use crate::*;

#[near]
impl Contract {
    /// The verifier assigns the funded bounty to one developer. `generation` must be the
    /// previous generation + 1. The delivery window, if any, starts at this block. The
    /// recipient cannot change for this generation.
    pub fn assign_developer(
        &mut self,
        bounty_id: String,
        generation: u32,
        assignment_hash: String,
        developer_id: U64,
        recipient_address: String,
    ) {
        self.roles.assert_not_paused();
        let mut b = self.bounty(&bounty_id);
        Self::assert_verifier(&b);
        require!(
            b.state == BountyState::Funded,
            errors::FUNDED_UNSETTLED_REQUIRED
        );
        require!(b.assignment.is_none(), errors::DEVELOPER_ALREADY_BOUND);
        require_next_generation(b.generation, generation);
        require!(
            util::is_sha256_hex(&assignment_hash) && assignment_hash != b.funding_policy_hash,
            errors::INVALID_ASSIGNMENT_HASH
        );
        require!(developer_id.0 > 0, errors::INVALID_DEVELOPER);
        require!(
            is_payable_address(&recipient_address, &b.escrow_evm_address),
            errors::INVALID_RECIPIENT
        );
        require!(
            recipient_address != b.refund_address,
            errors::RECIPIENT_MATCHES_REFUND
        );
        let a = Assignment::new(
            generation,
            developer_id,
            assignment_hash,
            recipient_address,
            b.delivery_seconds,
        );
        emit(
            RAIL,
            Event::DeveloperAssigned,
            json!({
                "bounty_id": bounty_id, "generation": generation, "developer_id": developer_id,
                "assignment_hash": a.assignment_hash, "deadline_ns": a.deadline_ns,
            }),
        );
        b.generation = generation;
        b.assignment = Some(a);
        self.bounties.insert(bounty_id, b);
    }

    /// The verifier records the head it observed at `observed_at_ns` (see
    /// `nearportal_common::assignment` for the deadline and relay-grace rule).
    pub fn record_submission(
        &mut self,
        bounty_id: String,
        generation: u32,
        assignment_hash: String,
        head_sha: String,
        observed_at_ns: U64,
    ) {
        // Recording evidence moves no funds and remains available during a financial pause.
        let mut b = self.bounty(&bounty_id);
        Self::assert_verifier(&b);
        require!(
            b.state == BountyState::Funded,
            errors::FUNDED_UNSETTLED_REQUIRED
        );
        let a = b
            .assignment
            .as_mut()
            .unwrap_or_else(|| env::panic_str(errors::NO_ACTIVE_ASSIGNMENT));
        a.require_matches(generation, &assignment_hash);
        a.record_submission(head_sha.clone(), observed_at_ns.0);
        emit(
            RAIL,
            Event::SubmissionRecorded,
            json!({
                "bounty_id": bounty_id, "generation": generation, "head_sha": head_sha,
                "observed_at_ns": observed_at_ns,
            }),
        );
        self.bounties.insert(bounty_id, b);
    }

    /// Permissionless, strictly after `deadline + relay grace`, only without a recorded
    /// submission. Moves no money; the bounty reopens for the next generation.
    pub fn expire_assignment(&mut self, bounty_id: String, generation: u32) {
        let mut b = self.bounty(&bounty_id);
        Self::reopenable_assignment(&b, generation).require_expirable();
        b.assignment = None;
        emit(
            RAIL,
            Event::AssignmentExpired,
            json!({ "bounty_id": bounty_id, "generation": generation }),
        );
        self.bounties.insert(bounty_id, b);
    }

    /// The verifier attests the developer's voluntary withdrawal before any submission.
    pub fn withdraw_assignment(&mut self, bounty_id: String, generation: u32) {
        let mut b = self.bounty(&bounty_id);
        Self::assert_verifier(&b);
        Self::reopenable_assignment(&b, generation).require_reopenable();
        b.assignment = None;
        emit(
            RAIL,
            Event::AssignmentWithdrawn,
            json!({ "bounty_id": bounty_id, "generation": generation }),
        );
        self.bounties.insert(bounty_id, b);
    }
}

impl Contract {
    fn reopenable_assignment(b: &Bounty, generation: u32) -> &Assignment {
        require!(
            b.state == BountyState::Funded,
            errors::FUNDED_UNSETTLED_REQUIRED
        );
        let a = b
            .assignment
            .as_ref()
            .unwrap_or_else(|| env::panic_str(errors::NO_ACTIVE_ASSIGNMENT));
        a.require_generation(generation);
        a
    }
}
