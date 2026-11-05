//! Code shared by the NearPortal escrow contracts: the bank rail (`nearportal-escrow`, Monerium
//! sandbox) and the USDC rail (`nearportal-usdc-escrow`, Base Sepolia). This crate holds no
//! contract state of its own.

pub mod assignment;
pub mod errors;
pub mod events;
pub mod evm;
pub mod monerium;
pub mod mpc;
pub mod roles;
pub mod util;

use near_sdk::near;

/// Owner decision on a disputed bounty. Only the verifier can authorize developer payment.
#[near(serializers = [json])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DisputeOutcome {
    /// Reopen verification under the original agreement; does not authorize a payment.
    Resume,
    /// Return the deposit to the client's refund destination fixed at creation.
    Refund,
}

#[cfg(test)]
mod tests;
