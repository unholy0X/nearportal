use super::{set, T0};
use crate::events::*;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::get_logs;

#[test]
fn events_follow_nep297_with_rail_and_string_numbers() {
    set("escrow.nearportal.testnet", T0);
    emit(
        Rail::Usdc,
        Event::DeveloperAssigned,
        json!({ "bounty_id": "7", "deadline_ns": T0.to_string() }),
    );
    let log = get_logs().pop().unwrap();
    let body: Value = serde_json::from_str(log.strip_prefix("EVENT_JSON:").unwrap()).unwrap();
    assert_eq!(body["standard"], "nearportal");
    assert_eq!(body["version"], "1.0.0");
    assert_eq!(body["event"], "developer_assigned");
    assert_eq!(body["data"][0]["rail"], "usdc");
    assert_eq!(body["data"][0]["deadline_ns"], T0.to_string());
}
