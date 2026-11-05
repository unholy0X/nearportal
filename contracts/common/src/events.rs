//! NEP-297 events: `EVENT_JSON:{"standard":"nearportal","version":"1.0.0","event":..,"data":[{..}]}`.
//! Every `data` object carries `"rail"`. u64 values (ids, amounts, timestamps) are decimal strings.

use near_sdk::env;
use near_sdk::serde_json::{json, Value};

pub const STANDARD: &str = "nearportal";
pub const VERSION: &str = "1.0.0";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rail {
    Bank,
    Usdc,
}

impl Rail {
    pub fn as_str(self) -> &'static str {
        match self {
            Rail::Bank => "bank",
            Rail::Usdc => "usdc",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Event {
    BountyCreated,
    EscrowAddressVerified,
    EscrowAddressRejected,
    EscrowLinkSigned,
    EscrowLinkFailed,
    DepositRecorded,
    SurplusRecorded,
    BountyFunded,
    DeveloperAssigned,
    SubmissionRecorded,
    AssignmentExpired,
    AssignmentWithdrawn,
    DisputeOpened,
    DisputeResolved,
    SettlementAuthorized,
    PayoutScheduled,
    PayoutSigned,
    PayoutSignFailed,
    PayoutResignAuthorized,
    PayoutProcessed,
    BountyClosed,
    RelayerProposed,
    RelayerSet,
    RelayerChangeCancelled,
    PausedSet,
    OwnerSet,
    VerifierSet,
    OperatorSet,
}

impl Event {
    pub fn name(self) -> &'static str {
        match self {
            Event::BountyCreated => "bounty_created",
            Event::EscrowAddressVerified => "escrow_address_verified",
            Event::EscrowAddressRejected => "escrow_address_rejected",
            Event::EscrowLinkSigned => "escrow_link_signed",
            Event::EscrowLinkFailed => "escrow_link_failed",
            Event::DepositRecorded => "deposit_recorded",
            Event::SurplusRecorded => "surplus_recorded",
            Event::BountyFunded => "bounty_funded",
            Event::DeveloperAssigned => "developer_assigned",
            Event::SubmissionRecorded => "submission_recorded",
            Event::AssignmentExpired => "assignment_expired",
            Event::AssignmentWithdrawn => "assignment_withdrawn",
            Event::DisputeOpened => "dispute_opened",
            Event::DisputeResolved => "dispute_resolved",
            Event::SettlementAuthorized => "settlement_authorized",
            Event::PayoutScheduled => "payout_scheduled",
            Event::PayoutSigned => "payout_signed",
            Event::PayoutSignFailed => "payout_sign_failed",
            Event::PayoutResignAuthorized => "payout_resign_authorized",
            Event::PayoutProcessed => "payout_processed",
            Event::BountyClosed => "bounty_closed",
            Event::RelayerProposed => "relayer_proposed",
            Event::RelayerSet => "relayer_set",
            Event::RelayerChangeCancelled => "relayer_change_cancelled",
            Event::PausedSet => "paused_set",
            Event::OwnerSet => "owner_set",
            Event::VerifierSet => "verifier_set",
            Event::OperatorSet => "operator_set",
        }
    }
}

/// `data` must be a JSON object; `"rail"` is added to it.
pub fn emit(rail: Rail, event: Event, data: Value) {
    let mut data = data;
    if let Value::Object(map) = &mut data {
        map.insert("rail".into(), Value::String(rail.as_str().into()));
    }
    let log = json!({
        "standard": STANDARD,
        "version": VERSION,
        "event": event.name(),
        "data": [data],
    });
    env::log_str(&format!("EVENT_JSON:{log}"));
}
