//! The assignment model shared by both rails. A funded bounty is assigned to one developer at
//! a time. Each assignment has a generation number (1, 2, ...); every entry point that acts on
//! an assignment must name its generation, so a stale caller can never act on a newer one.
//!
//! Deadline rule (both rails): a submission counts only if the verifier observed it at or
//! before the deadline (inclusive) and relays it at or before `deadline + RELAY_GRACE_NS`.
//! An unsubmitted assignment may be expired by anyone strictly after `deadline + RELAY_GRACE_NS`.
//! Trust assumption: `observed_at_ns` is asserted by the verifier, bounded only by block time.

use near_sdk::json_types::U64;
use near_sdk::{env, near, require};

use crate::errors;
use crate::util::{is_git_commit, NS_PER_SEC};

pub const RELAY_GRACE_NS: u64 = 15 * 60 * NS_PER_SEC;
pub const MIN_DELIVERY_SECONDS: u32 = 3_600;
pub const MAX_DELIVERY_SECONDS: u32 = 90 * 86_400;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Assignment {
    pub generation: u32,
    /// GitHub numeric user id, attested by the verifier.
    pub developer_id: U64,
    pub assignment_hash: String,
    /// Short IBAN (bank rail) or lowercase EVM address (USDC rail). Fixed for the life of the
    /// assignment; a new developer needs a new generation.
    pub recipient: String,
    pub assigned_at_ns: U64,
    /// `None` when the bounty has no delivery window.
    pub deadline_ns: Option<U64>,
    pub head_sha: Option<String>,
    pub submitted_at_ns: Option<U64>,
}

pub fn validate_delivery_seconds(delivery_seconds: Option<u32>) {
    require!(
        delivery_seconds.is_none_or(|s| (MIN_DELIVERY_SECONDS..=MAX_DELIVERY_SECONDS).contains(&s)),
        errors::INVALID_DELIVERY_WINDOW
    );
}

/// The next assignment must use exactly `current + 1`.
pub fn require_next_generation(current: u32, requested: u32) {
    require!(
        current.checked_add(1) == Some(requested),
        errors::GENERATION_MISMATCH
    );
}

impl Assignment {
    /// Starts the delivery window at the current block time.
    pub fn new(
        generation: u32,
        developer_id: U64,
        assignment_hash: String,
        recipient: String,
        delivery_seconds: Option<u32>,
    ) -> Self {
        let now = env::block_timestamp();
        let deadline_ns = delivery_seconds.map(|s| {
            U64(now
                .checked_add(u64::from(s) * NS_PER_SEC)
                .unwrap_or_else(|| env::panic_str(errors::OVERFLOW)))
        });
        Self {
            generation,
            developer_id,
            assignment_hash,
            recipient,
            assigned_at_ns: U64(now),
            deadline_ns,
            head_sha: None,
            submitted_at_ns: None,
        }
    }

    pub fn require_generation(&self, generation: u32) {
        require!(self.generation == generation, errors::GENERATION_MISMATCH);
    }

    pub fn require_matches(&self, generation: u32, assignment_hash: &str) {
        self.require_generation(generation);
        require!(
            self.assignment_hash == assignment_hash,
            errors::ASSIGNMENT_HASH_MISMATCH
        );
    }

    /// Records (or replaces with a later observation) the submitted head.
    pub fn record_submission(&mut self, head_sha: String, observed_at_ns: u64) {
        let now = env::block_timestamp();
        require!(is_git_commit(&head_sha), errors::INVALID_COMMIT);
        require!(observed_at_ns <= now, errors::INVALID_OBSERVATION_TIME);
        if let Some(deadline) = self.deadline_ns {
            require!(
                observed_at_ns <= deadline.0,
                errors::SUBMISSION_MISSED_DEADLINE
            );
            require!(
                now <= deadline.0.saturating_add(RELAY_GRACE_NS),
                errors::RELAY_GRACE_EXPIRED
            );
        }
        require!(
            observed_at_ns >= self.assigned_at_ns.0
                && self
                    .submitted_at_ns
                    .is_none_or(|old| observed_at_ns >= old.0),
            errors::INVALID_OBSERVATION_TIME
        );
        self.head_sha = Some(head_sha);
        self.submitted_at_ns = Some(U64(observed_at_ns));
    }

    /// Settlement pays only the exact recorded head.
    pub fn require_submitted(&self, head_sha: &str) {
        require!(
            self.head_sha.as_deref() == Some(head_sha) && self.submitted_at_ns.is_some(),
            errors::TIMELY_SUBMISSION_REQUIRED
        );
    }

    /// Withdrawal and expiry never remove recorded work.
    pub fn require_reopenable(&self) {
        require!(
            self.head_sha.is_none(),
            errors::SUBMITTED_WORK_CANNOT_EXPIRE
        );
    }

    pub fn require_expirable(&self) {
        let deadline = self
            .deadline_ns
            .unwrap_or_else(|| env::panic_str(errors::NO_DEADLINE));
        self.require_reopenable();
        require!(
            env::block_timestamp() > deadline.0.saturating_add(RELAY_GRACE_NS),
            errors::WINDOW_STILL_OPEN
        );
    }
}
